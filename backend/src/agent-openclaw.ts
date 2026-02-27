/**
 * OpenClaw agent runtime implementation.
 *
 * Implements AgentRuntime for the OpenClaw coding agent.
 * OpenClaw outputs clean JSON — no TTY/expect needed.
 *
 * Session files: ~/.openclaw/agents/<agent-name>/sessions/*.jsonl
 *
 * Session JSONL format:
 *   Line 1: {type:"session", version:3, cwd:"...", timestamp:"..."}
 *   Lines N: message events, tool calls, model changes, etc.
 *   Message types: "message", "skill_call", "tool_call", "model_change", "thinking_level_change"
 */

import { execFile, execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { createLogger } from "./logger.js";
import type { AgentRuntime, AgentCapabilities } from "./agent-runtime.js";
import { registerRuntime } from "./agent-runtime.js";
import type { TimelineNode } from "./jsonl-parser.js";
import type { FailureReason } from "./plan-db.js";
import type { ContextPressure, SessionAnalysis } from "./jsonl-parser.js";

const log = createLogger("agent-openclaw");

const EXEC_TIMEOUT = 30 * 60 * 1000; // 30 minutes per node

// ─── Binary resolution ──────────────────────────────────────

/**
 * Resolve the path to the OpenClaw CLI binary.
 * Priority: OPENCLAW_PATH env → common install locations → PATH lookup via `which`.
 */
function resolveOpenClawPath(): string {
  if (process.env.OPENCLAW_PATH) {
    return process.env.OPENCLAW_PATH;
  }

  // Common install locations
  const candidates = [
    join(homedir(), ".local", "bin", "openclaw"),
    "/usr/local/bin/openclaw",
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  // PATH lookup via `which`
  try {
    const resolved = execFileSync("/usr/bin/which", ["openclaw"], { encoding: "utf-8" }).trim();
    if (resolved) return resolved;
  } catch {
    // `which` failed — openclaw not in PATH
  }

  // Last resort: bare command name (will fail at runtime if not in PATH)
  return "openclaw";
}

/** Resolved path to OpenClaw CLI binary. */
const OPENCLAW_PATH = resolveOpenClawPath();

// ─── Session JSONL types ────────────────────────────────────

interface OpenClawSessionHeader {
  type: "session";
  version: number;
  cwd?: string;
  timestamp?: string;
  agentName?: string;
}

interface OpenClawMessage {
  type: "message";
  message: {
    role: "user" | "assistant";
    content: string | OpenClawContentBlock[];
    usage?: { input?: number; output?: number; totalTokens?: number };
  };
  timestamp?: string;
  id?: string;
}

interface OpenClawToolCall {
  type: "tool_call" | "skill_call";
  toolName?: string;
  skillName?: string;
  toolCallId?: string;
  input?: unknown;
  output?: string;
  result?: string;
  isError?: boolean;
  timestamp?: string;
  id?: string;
}

interface OpenClawModelChange {
  type: "model_change";
  model?: string;
  timestamp?: string;
}

interface OpenClawThinkingChange {
  type: "thinking_level_change";
  level?: string;
  timestamp?: string;
}

interface OpenClawCompaction {
  type: "compaction" | "compact_boundary";
  preTokens?: number;
  timestamp?: string;
}

interface OpenClawError {
  type: "error";
  message?: string;
  timestamp?: string;
  isApiError?: boolean;
}

type OpenClawEvent =
  | OpenClawSessionHeader
  | OpenClawMessage
  | OpenClawToolCall
  | OpenClawModelChange
  | OpenClawThinkingChange
  | OpenClawCompaction
  | OpenClawError;

type OpenClawContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; toolCallId: string; toolName: string; input: unknown };

// ─── Session parsing ────────────────────────────────────────

/**
 * Parse an OpenClaw session JSONL file into ClawUI TimelineNode[].
 *
 * Handles the session format:
 * - First line is a session header ({type:"session", version:3})
 * - Subsequent lines are events: messages, tool calls, etc.
 */
export function parseOpenClawSessionFile(filePath: string, rawContent?: string): TimelineNode[] {
  const raw = rawContent ?? readFileSync(filePath, "utf-8");
  const lines = raw.trim().split("\n");
  const nodes: TimelineNode[] = [];

  for (let i = 0; i < lines.length; i++) {
    let event: OpenClawEvent;
    try {
      event = JSON.parse(lines[i]) as OpenClawEvent;
    } catch {
      continue;
    }

    const id = (event as unknown as Record<string, unknown>).id as string | undefined ?? `line-${i}`;
    const timestamp = (event as unknown as Record<string, unknown>).timestamp as string | undefined ?? "";

    switch (event.type) {
      case "session":
        // Skip session header — metadata only
        break;

      case "message": {
        const msg = event as OpenClawMessage;
        const role = msg.message.role;
        const text = extractOpenClawText(msg.message.content);

        if (role === "user" && text.trim()) {
          nodes.push({
            id,
            type: "user",
            timestamp,
            title: summarize(text),
            content: text,
          });
        } else if (role === "assistant") {
          // Extract tool_use blocks from content array
          const blocks = normalizeContent(msg.message.content);
          let assistantText = "";

          for (const block of blocks) {
            if (block.type === "text") {
              assistantText += block.text + "\n";
            } else if (block.type === "tool_use") {
              const inputStr = JSON.stringify(block.input ?? {}, null, 2);
              nodes.push({
                id: `${id}-tool-${block.toolCallId}`,
                type: "tool_use",
                timestamp,
                title: block.toolName,
                content: inputStr,
                toolName: block.toolName,
                toolInput: inputStr,
                toolUseId: block.toolCallId,
              });
            }
            // thinking blocks are skipped — not shown in timeline
          }

          const cleanText = assistantText.trim();
          if (cleanText) {
            nodes.push({
              id,
              type: "assistant",
              timestamp,
              title: summarize(cleanText),
              content: cleanText,
            });
          }
        }
        break;
      }

      case "tool_call":
      case "skill_call": {
        const tc = event as OpenClawToolCall;
        const toolName = tc.toolName ?? tc.skillName ?? "unknown_tool";
        const toolCallId = tc.toolCallId ?? id;

        // Emit tool_use node
        const inputStr = JSON.stringify(tc.input ?? {}, null, 2);
        nodes.push({
          id: `${id}-use`,
          type: "tool_use",
          timestamp,
          title: toolName,
          content: inputStr,
          toolName,
          toolInput: inputStr,
          toolUseId: toolCallId,
        });

        // Emit tool_result node if output/result is present
        const resultText = tc.output ?? tc.result ?? "";
        if (resultText) {
          nodes.push({
            id: `${id}-result`,
            type: "tool_result",
            timestamp,
            title: `${toolName} result${tc.isError ? " (error)" : ""}`,
            content: resultText,
            toolName,
            toolResult: resultText,
            toolUseId: toolCallId,
          });
        }
        break;
      }

      case "error": {
        const err = event as OpenClawError;
        nodes.push({
          id,
          type: "error",
          timestamp,
          title: "Error",
          content: err.message ?? "Unknown error",
        });
        break;
      }

      // model_change, thinking_level_change, compaction — metadata, not shown in timeline
      default:
        break;
    }
  }

  return nodes;
}

// ─── Content helpers ────────────────────────────────────────

/** Extract text from OpenClaw content (string or content block array). */
function extractOpenClawText(content: string | OpenClawContentBlock[] | unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  }
  return String(content ?? "");
}

/** Normalize content to a block array. */
function normalizeContent(content: string | OpenClawContentBlock[] | unknown): OpenClawContentBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (Array.isArray(content)) return content as OpenClawContentBlock[];
  return [{ type: "text", text: String(content ?? "") }];
}

/** Create a short summary from text (first line, truncated). */
function summarize(text: string, maxLen = 120): string {
  const firstLine = text.split("\n")[0]?.trim() ?? "";
  if (firstLine.length <= maxLen) return firstLine;
  return firstLine.slice(0, maxLen - 1) + "…";
}

// ─── Session health analysis ────────────────────────────────

/**
 * Analyze an OpenClaw session JSONL file for health indicators.
 * Checks for compaction events, error events, and token usage.
 */
export function analyzeOpenClawSessionHealth(sessionId: string, knownFilePath?: string): SessionAnalysis | null {
  let filePath: string | null = knownFilePath ?? null;

  if (!filePath) {
    const agentsDir = join(homedir(), ".openclaw", "agents");
    if (!existsSync(agentsDir)) return null;

    // Scan all agent directories for session files
    const agents = readdirSync(agentsDir, { withFileTypes: true });
    for (const agent of agents) {
      if (!agent.isDirectory()) continue;
      const sessionsDir = join(agentsDir, agent.name, "sessions");
      if (!existsSync(sessionsDir)) continue;
      const candidate = join(sessionsDir, `${sessionId}.jsonl`);
      if (existsSync(candidate)) {
        filePath = candidate;
        break;
      }
    }
  }

  if (!filePath) return null;

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  const lines = raw.trim().split("\n");
  let compactCount = 0;
  let peakTokens = 0;
  let lastApiError: string | null = null;
  let messageCount = 0;
  let lastCompactLineIdx = -1;
  let responsesAfterLastCompact = 0;

  for (let i = 0; i < lines.length; i++) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      continue;
    }

    messageCount++;

    // Detect compaction events
    if (obj.type === "compaction" || obj.type === "compact_boundary") {
      compactCount++;
      lastCompactLineIdx = i;
      responsesAfterLastCompact = 0;
      // Track pre-compaction token count
      const preTokens = (obj as unknown as OpenClawCompaction).preTokens;
      if (preTokens && preTokens > peakTokens) {
        peakTokens = preTokens;
      }
    }

    // Count successful assistant messages after last compaction
    if (lastCompactLineIdx >= 0 && obj.type === "message") {
      const msg = obj as unknown as OpenClawMessage;
      if (msg.message?.role === "assistant") {
        responsesAfterLastCompact++;
      }
    }

    // Track errors
    if (obj.type === "error") {
      const err = obj as unknown as OpenClawError;
      lastApiError = err.message ?? "Unknown error";
    }

    // Track peak token usage from assistant messages
    if (obj.type === "message") {
      const msg = obj as unknown as OpenClawMessage;
      if (msg.message?.role === "assistant" && msg.message.usage) {
        const usage = msg.message.usage;
        const total = (usage.input ?? 0) + (usage.output ?? 0);
        if (total > peakTokens) peakTokens = total;
        if (usage.totalTokens && usage.totalTokens > peakTokens) {
          peakTokens = usage.totalTokens;
        }
      }
    }
  }

  const endedAfterCompaction = lastCompactLineIdx >= 0 && responsesAfterLastCompact <= 1;

  // Determine context pressure level (same thresholds as Claude/Pi)
  let contextPressure: ContextPressure = "none";
  if (compactCount >= 3 || (compactCount >= 2 && endedAfterCompaction)) {
    contextPressure = "critical";
  } else if (compactCount >= 2 || (compactCount >= 1 && peakTokens > 150_000)) {
    contextPressure = "high";
  } else if (compactCount >= 1 || peakTokens > 120_000) {
    contextPressure = "moderate";
  }

  // Determine failure reason
  let failureReason: FailureReason = null;
  let detail = "";

  if (lastApiError) {
    if (lastApiError.includes("context") || lastApiError.includes("token limit")) {
      failureReason = "context_exhausted";
      detail = `Session ended with context error: ${lastApiError}`;
    } else if (lastApiError.includes("output") && lastApiError.includes("token")) {
      failureReason = "output_token_limit";
      detail = `Session ended with output token limit error: ${lastApiError}`;
    } else {
      failureReason = "error";
      detail = `API error: ${lastApiError}`;
    }
  } else if (endedAfterCompaction && compactCount >= 2) {
    failureReason = "context_exhausted";
    detail = `Session compacted ${compactCount} times and ended immediately after the last compaction (peak ${peakTokens} tokens).`;
  } else if (compactCount >= 3) {
    failureReason = "context_exhausted";
    detail = `Session compacted ${compactCount} times (peak ${peakTokens} tokens).`;
  }

  return {
    failureReason,
    detail,
    compactCount,
    peakTokens,
    lastApiError,
    messageCount,
    contextPressure,
    endedAfterCompaction,
    responsesAfterLastCompact,
  };
}

// ─── Runtime class ──────────────────────────────────────────

export class OpenClawAgentRuntime implements AgentRuntime {
  readonly type = "openclaw" as const;

  readonly capabilities: AgentCapabilities = {
    supportsResume: true,
    supportsInteractive: true,   // OpenClaw supports tool use natively
    supportsTextOutput: true,    // --json flag for structured output
    supportsDangerousMode: false, // OpenClaw has no permission skip flag
  };

  getSessionsDir(): string {
    return join(homedir(), ".openclaw", "agents");
  }

  encodeProjectCwd(cwd: string): string {
    // OpenClaw uses agent-name-based dirs, not path encoding.
    // Return a sanitized version of the path for directory matching.
    return cwd.replace(/\//g, "-").replace(/^-/, "");
  }

  cleanEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    // Strip env vars that could interfere with subprocess
    delete env.CLAUDECODE;
    delete env.OPENCLAW_SESSION; // Prevent session nesting
    return env;
  }

  /**
   * Run OpenClaw agent with a prompt and capture JSON output.
   * No TTY/expect needed — OpenClaw outputs clean text/JSON.
   */
  runSession(prompt: string, cwd?: string, onPid?: (pid: number) => void): Promise<string> {
    return new Promise((resolve, reject) => {
      const sessionId = randomUUID();
      const args = [
        "agent",
        "--session-id", sessionId,
        "--message", prompt,
        "--json",
      ];

      log.debug(`Running OpenClaw: ${OPENCLAW_PATH} agent --session-id ${sessionId.slice(0, 8)}...`);

      const child = execFile(
        OPENCLAW_PATH,
        args,
        {
          timeout: EXEC_TIMEOUT,
          maxBuffer: 10 * 1024 * 1024,
          cwd: cwd || process.cwd(),
          env: this.cleanEnv(),
        },
        (error, stdout, stderr) => {
          if (error) {
            log.error(`OpenClaw CLI error: ${error.message}`);
            if (stderr) log.debug(`OpenClaw stderr: ${stderr.slice(0, 500)}`);
            // If we got output despite the error, return it
            if (stdout && stdout.trim().length > 0) {
              resolve(this.extractOutput(stdout));
              return;
            }
            reject(new Error(`OpenClaw CLI error: ${error.message}`));
            return;
          }
          resolve(this.extractOutput(stdout || ""));
        },
      );

      if (child.pid && onPid) {
        onPid(child.pid);
      }
    });
  }

  /**
   * Run OpenClaw in interactive mode (full tool use, no --json).
   * Used for tasks where the agent directly calls API endpoints via curl.
   */
  runSessionInteractive(prompt: string, cwd?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const sessionId = randomUUID();
      const args = [
        "agent",
        "--session-id", sessionId,
        "--message", prompt,
      ];

      log.debug(`Running OpenClaw interactive: session ${sessionId.slice(0, 8)}...`);

      execFile(
        OPENCLAW_PATH,
        args,
        {
          timeout: EXEC_TIMEOUT,
          maxBuffer: 10 * 1024 * 1024,
          cwd: cwd || process.cwd(),
          env: this.cleanEnv(),
        },
        (error, stdout, stderr) => {
          if (error) {
            log.error(`OpenClaw interactive error: ${error.message}`);
            if (stderr) log.debug(`OpenClaw stderr: ${stderr.slice(0, 500)}`);
            reject(new Error(`OpenClaw interactive failed: ${error.message}`));
            return;
          }
          resolve(stdout || "");
        },
      );
    });
  }

  /**
   * Resume an existing OpenClaw session by session ID.
   * Uses --session-id to continue an existing session.
   */
  resumeSession(sessionId: string, prompt: string, cwd?: string, onPid?: (pid: number) => void): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = [
        "agent",
        "--session-id", sessionId,
        "--message", prompt,
        "--json",
      ];

      log.debug(`Resuming OpenClaw session: ${sessionId.slice(0, 8)}...`);

      const child = execFile(
        OPENCLAW_PATH,
        args,
        {
          timeout: EXEC_TIMEOUT,
          maxBuffer: 10 * 1024 * 1024,
          cwd: cwd || process.cwd(),
          env: this.cleanEnv(),
        },
        (error, stdout, stderr) => {
          if (error) {
            log.error(`OpenClaw resume error: ${error.message}`);
            if (stderr) log.debug(`OpenClaw stderr: ${stderr.slice(0, 500)}`);
            if (stdout && stdout.trim().length > 0) {
              resolve(this.extractOutput(stdout));
              return;
            }
            reject(new Error(`OpenClaw resume error: ${error.message}`));
            return;
          }
          resolve(this.extractOutput(stdout || ""));
        },
      );

      if (child.pid && onPid) {
        onPid(child.pid);
      }
    });
  }

  /**
   * Detect the newest session file created after `beforeTimestamp`
   * in the OpenClaw agents directory matching `projectCwd`.
   *
   * OpenClaw stores sessions in agent subdirs: ~/.openclaw/agents/<agent>/sessions/*.jsonl
   * We scan all agent dirs and match sessions by reading the session header's cwd field.
   */
  detectNewSession(projectCwd: string, beforeTimestamp: Date): string | null {
    const agentsDir = this.getSessionsDir();
    if (!existsSync(agentsDir)) return null;

    let newestId: string | null = null;
    let newestMtime = beforeTimestamp.getTime();

    // Scan all agent directories
    let agents: string[];
    try {
      agents = readdirSync(agentsDir);
    } catch {
      return null;
    }

    for (const agentName of agents) {
      const sessionsDir = join(agentsDir, agentName, "sessions");
      if (!existsSync(sessionsDir)) continue;

      let files: string[];
      try {
        files = readdirSync(sessionsDir);
      } catch {
        continue;
      }

      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        const filePath = join(sessionsDir, file);
        const stat = statSync(filePath);
        if (stat.mtime.getTime() <= beforeTimestamp.getTime()) continue;

        // Check if this session's cwd matches the project
        if (this.matchesProjectCwd(filePath, projectCwd)) {
          if (stat.mtime.getTime() > newestMtime) {
            newestMtime = stat.mtime.getTime();
            newestId = basename(file, ".jsonl");
          }
        }
      }
    }

    return newestId;
  }

  /**
   * Check if a session file's header cwd matches the given project cwd.
   * Reads only the first line of the file for efficiency.
   */
  private matchesProjectCwd(filePath: string, projectCwd: string): boolean {
    try {
      const raw = readFileSync(filePath, "utf-8");
      const firstNewline = raw.indexOf("\n");
      const firstLine = firstNewline >= 0 ? raw.slice(0, firstNewline) : raw;
      const header = JSON.parse(firstLine) as OpenClawSessionHeader;
      if (header.type === "session" && header.cwd) {
        return header.cwd === projectCwd;
      }
    } catch {
      // Can't read or parse — skip
    }
    return false;
  }

  /**
   * Extract the message content from OpenClaw JSON output.
   * OpenClaw --json output format: { status, session_id, message: { role, content, usage } }
   */
  private extractOutput(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) return "";

    // Try to parse as JSON response
    try {
      const parsed = JSON.parse(trimmed) as {
        status?: string;
        session_id?: string;
        message?: { role?: string; content?: string | OpenClawContentBlock[] };
      };

      if (parsed.message?.content) {
        return extractOpenClawText(parsed.message.content);
      }
    } catch {
      // Not valid JSON — return as-is (may be plain text mode)
    }

    return trimmed;
  }

  /**
   * Find a session JSONL file by ID across all agent directories.
   */
  findSessionFile(sessionId: string): string | null {
    const agentsDir = this.getSessionsDir();
    if (!existsSync(agentsDir)) return null;

    let agents: string[];
    try {
      agents = readdirSync(agentsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return null;
    }

    for (const agentName of agents) {
      const candidate = join(agentsDir, agentName, "sessions", `${sessionId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }

    return null;
  }
}

// ─── Self-registration ───────────────────────────────────────

registerRuntime("openclaw", () => new OpenClawAgentRuntime());
