/**
 * Pi Mono agent runtime implementation.
 *
 * Implements AgentRuntime for the Pi coding agent (@mariozechner/pi-coding-agent).
 * Pi Mono supports a non-interactive print mode (-p) so no TTY/expect is needed.
 *
 * Session files: ~/.pi/agent/sessions/--<encoded-cwd>--/*.jsonl
 * CWD encoding: /Users/foo/bar → --Users-foo-bar-- (double-dash delimited)
 *
 * Session JSONL format (version 3):
 *   Line 1: {type:"session", version:3, ...metadata}
 *   Lines N: {id, parentId, role, content, ...} forming a message tree
 *   Roles: "user", "assistant", "toolResult", "bashExecution"
 *   Assistant content blocks: {type:"text"}, {type:"thinking"}, {type:"toolCall"}
 *   stopReason: "stop" | "length" | "toolUse" | "error" | "aborted"
 *   usage: {input, output, totalTokens}
 */

import { execFile, execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { createLogger } from "./logger.js";
import type { AgentRuntime, AgentCapabilities } from "./agent-runtime.js";
import { registerRuntime } from "./agent-runtime.js";
import type { TimelineNode } from "./jsonl-parser.js";
import type { FailureReason } from "./plan-db.js";
import type { ContextPressure, SessionAnalysis } from "./jsonl-parser.js";

const log = createLogger("agent-pimono");

const EXEC_TIMEOUT = 30 * 60 * 1000; // 30 minutes per node

// ─── Binary resolution ──────────────────────────────────────

/**
 * Resolve the path to the Pi CLI binary.
 * Priority: PI_PATH env → common install locations → PATH lookup via `which` → npx fallback.
 */
function resolvePiPath(): string {
  if (process.env.PI_PATH) {
    return process.env.PI_PATH;
  }

  // Common install locations
  const candidates = [
    join(homedir(), ".local", "bin", "pi"),
    "/usr/local/bin/pi",
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  // PATH lookup via `which`
  try {
    const resolved = execFileSync("/usr/bin/which", ["pi"], { encoding: "utf-8" }).trim();
    if (resolved) return resolved;
  } catch {
    // `which` failed — pi not in PATH
  }

  // Check if npx can find it
  try {
    execFileSync("/usr/bin/which", ["npx"], { encoding: "utf-8" }).trim();
    // npx is available — caller will use npx @mariozechner/pi-coding-agent
    return "npx";
  } catch {
    // npx not found either
  }

  // Last resort: bare command name (will fail at runtime if not in PATH)
  return "pi";
}

/** Resolved path to Pi CLI binary (or "npx" for npx-based invocation). */
const PI_PATH = resolvePiPath();

// ─── Session JSONL types ────────────────────────────────────

interface PiMessage {
  id: string;
  parentId?: string;
  role: "user" | "assistant" | "toolResult" | "bashExecution";
  content: string | PiContentBlock[];
  timestamp?: string;
  stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted";
  usage?: { input?: number; output?: number; totalTokens?: number };
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  command?: string;
  output?: string;
  exitCode?: number;
}

type PiContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "toolCall"; toolCallId: string; toolName: string; input: unknown };

// ─── Session parsing ────────────────────────────────────────

/**
 * Reconstruct a linear timeline from Pi Mono's tree-structured messages.
 * Pi uses id/parentId to form a message tree; we follow the active branch
 * (the path ending at the last message) to produce a linear timeline.
 */
function linearizeBranch(messages: PiMessage[]): PiMessage[] {
  if (messages.length === 0) return [];

  // Build parent→children map
  const childrenOf = new Map<string, PiMessage[]>();
  const byId = new Map<string, PiMessage>();

  for (const msg of messages) {
    byId.set(msg.id, msg);
    const parentKey = msg.parentId ?? "__root__";
    const siblings = childrenOf.get(parentKey) ?? [];
    siblings.push(msg);
    childrenOf.set(parentKey, siblings);
  }

  // Find leaf nodes (messages with no children)
  const hasChildren = new Set<string>();
  for (const msg of messages) {
    if (msg.parentId) hasChildren.add(msg.parentId);
  }
  const leaves = messages.filter((m) => !hasChildren.has(m.id));

  // Pick the last leaf (most recent message in the active branch)
  const lastLeaf = leaves[leaves.length - 1];
  if (!lastLeaf) return messages; // fallback: return all

  // Walk from leaf to root to build the active branch
  const branch: PiMessage[] = [];
  let current: PiMessage | undefined = lastLeaf;
  const visited = new Set<string>();

  while (current) {
    if (visited.has(current.id)) break; // cycle guard
    visited.add(current.id);
    branch.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }

  return branch;
}

/**
 * Parse a Pi Mono session JSONL file into ClawUI TimelineNode[].
 *
 * Handles the version 3 session format:
 * - First line is a session header ({type:"session", version:3})
 * - Subsequent lines are messages with id/parentId tree structure
 * - Roles: user, assistant, toolResult, bashExecution
 */
export function parsePiSessionFile(filePath: string, rawContent?: string): TimelineNode[] {
  const raw = rawContent ?? readFileSync(filePath, "utf-8");
  const lines = raw.trim().split("\n");
  const nodes: TimelineNode[] = [];
  const messages: PiMessage[] = [];
  // First pass: parse all lines
  for (const line of lines) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    // Skip session header and non-message metadata lines
    if (obj.type === "session") {
      continue;
    }

    // Skip non-message lines (compaction, metadata, etc.)
    if (!obj.role && !obj.command) continue;

    messages.push(obj as unknown as PiMessage);
  }

  // Linearize the message tree to the active branch
  const branch = linearizeBranch(messages);

  // Track tool calls for matching with tool results
  const toolCallMap = new Map<string, { name: string; input: unknown }>();

  // Second pass: convert to TimelineNode[]
  for (const msg of branch) {
    const timestamp = msg.timestamp ?? "";

    if (msg.role === "user") {
      const text = extractPiText(msg.content);
      if (text.trim()) {
        nodes.push({
          id: msg.id,
          type: "user",
          timestamp,
          title: summarize(text),
          content: text,
        });
      }
    } else if (msg.role === "assistant") {
      const blocks = normalizeContent(msg.content);
      let assistantText = "";

      for (const block of blocks) {
        if (block.type === "text") {
          assistantText += block.text + "\n";
        } else if (block.type === "toolCall") {
          toolCallMap.set(block.toolCallId, {
            name: block.toolName,
            input: block.input,
          });

          const inputStr = JSON.stringify(block.input ?? {}, null, 2);
          nodes.push({
            id: `${msg.id}-tool-${block.toolCallId}`,
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
          id: msg.id,
          type: "assistant",
          timestamp,
          title: summarize(cleanText),
          content: cleanText,
        });
      }
    } else if (msg.role === "toolResult") {
      const resultText = extractPiText(msg.content);
      const toolInfo = msg.toolCallId ? toolCallMap.get(msg.toolCallId) : undefined;

      nodes.push({
        id: msg.id,
        type: "tool_result",
        timestamp,
        title: toolInfo ? `${toolInfo.name} result` : (msg.toolName ? `${msg.toolName} result` : "Tool result"),
        content: resultText,
        toolName: toolInfo?.name ?? msg.toolName,
        toolResult: resultText,
        toolUseId: msg.toolCallId,
      });
    } else if (msg.role === "bashExecution") {
      // bashExecution has command, output, exitCode at top level
      const command = msg.command ?? "";
      const output = msg.output ?? "";
      const exitCode = msg.exitCode ?? 0;

      // Represent as a tool_use + tool_result pair
      nodes.push({
        id: `${msg.id}-bash-use`,
        type: "tool_use",
        timestamp,
        title: "Bash",
        content: command,
        toolName: "Bash",
        toolInput: JSON.stringify({ command }, null, 2),
        toolUseId: msg.id,
      });

      nodes.push({
        id: msg.id,
        type: "tool_result",
        timestamp,
        title: `Bash result (exit ${exitCode})`,
        content: output,
        toolName: "Bash",
        toolResult: output,
        toolUseId: msg.id,
      });
    }
  }

  return nodes;
}

// ─── Content helpers ────────────────────────────────────────

/** Extract text from Pi content (string or content block array). */
function extractPiText(content: string | PiContentBlock[] | unknown): string {
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
function normalizeContent(content: string | PiContentBlock[] | unknown): PiContentBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (Array.isArray(content)) return content as PiContentBlock[];
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
 * Analyze a Pi Mono session JSONL file for health indicators.
 * Checks for compaction events, error stop reasons, and token usage.
 */
export function analyzePiSessionHealth(sessionId: string, knownFilePath?: string): SessionAnalysis | null {
  let filePath: string | null = knownFilePath ?? null;

  if (!filePath) {
    const sessionsDir = join(homedir(), ".pi", "agent", "sessions");
    if (!existsSync(sessionsDir)) return null;

    // Scan all project directories
    const entries = readdirSync(sessionsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = join(sessionsDir, entry.name, `${sessionId}.jsonl`);
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
    if (obj.type === "compaction") {
      compactCount++;
      lastCompactLineIdx = i;
      responsesAfterLastCompact = 0;
    }

    // Count successful assistant responses after last compaction
    if (lastCompactLineIdx >= 0 && obj.role === "assistant" && obj.stopReason !== "error") {
      responsesAfterLastCompact++;
    }

    // Track errors from assistant messages
    if (obj.role === "assistant" && obj.stopReason === "error") {
      const text = extractPiText(obj.content as string | PiContentBlock[]);
      if (text) lastApiError = text;
    }

    // Track peak token usage from assistant messages
    if (obj.role === "assistant" && obj.stopReason !== "error") {
      const usage = obj.usage as { input?: number; output?: number; totalTokens?: number } | undefined;
      if (usage) {
        const total = (usage.input ?? 0) + (usage.output ?? 0);
        if (total > peakTokens) peakTokens = total;
        if (usage.totalTokens && usage.totalTokens > peakTokens) {
          peakTokens = usage.totalTokens;
        }
      }
    }
  }

  const endedAfterCompaction = lastCompactLineIdx >= 0 && responsesAfterLastCompact <= 1;

  // Determine context pressure level (same thresholds as Claude)
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

export class PiMonoAgentRuntime implements AgentRuntime {
  readonly type = "pi" as const;

  readonly capabilities: AgentCapabilities = {
    supportsResume: true,
    supportsInteractive: false, // Pi print mode handles tool use natively
    supportsTextOutput: true,   // -p flag = print mode
    supportsDangerousMode: false, // Pi has no permission system to skip
  };

  getSessionsDir(): string {
    return join(homedir(), ".pi", "agent", "sessions");
  }

  encodeProjectCwd(cwd: string): string {
    // Pi Mono encoding: /Users/foo/bar → --Users-foo-bar--
    const encoded = cwd.replace(/\//g, "-");
    return `-${encoded}-`;
  }

  cleanEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    // Strip env vars that could interfere with Pi subprocess
    delete env.CLAUDECODE;
    return env;
  }

  /**
   * Build the CLI args and binary path for Pi invocation.
   * Handles both direct `pi` binary and `npx @mariozechner/pi-coding-agent` fallback.
   */
  private buildCommand(): { binary: string; baseArgs: string[] } {
    if (PI_PATH === "npx") {
      return {
        binary: "npx",
        baseArgs: ["@mariozechner/pi-coding-agent"],
      };
    }
    return { binary: PI_PATH, baseArgs: [] };
  }

  /**
   * Run Pi Mono in print mode (-p) for text output.
   * No TTY/expect needed — Pi outputs plain text directly in -p mode.
   */
  runSession(prompt: string, cwd?: string, onPid?: (pid: number) => void): Promise<string> {
    return new Promise((resolve, reject) => {
      const { binary, baseArgs } = this.buildCommand();
      const args = [...baseArgs, "-p", prompt];

      log.debug(`Running Pi Mono: ${binary} ${args.map((a) => a.length > 50 ? a.slice(0, 50) + "..." : a).join(" ")}`);

      const child = execFile(
        binary,
        args,
        {
          timeout: EXEC_TIMEOUT,
          maxBuffer: 10 * 1024 * 1024,
          cwd: cwd || process.cwd(),
          env: this.cleanEnv(),
        },
        (error, stdout, stderr) => {
          if (error) {
            log.error(`Pi Mono CLI error: ${error.message}`);
            if (stderr) log.debug(`Pi Mono stderr: ${stderr.slice(0, 500)}`);
            // If we got output despite the error, return it
            if (stdout && stdout.trim().length > 0) {
              resolve(stdout.trim());
              return;
            }
            reject(new Error(`Pi Mono CLI error: ${error.message}`));
            return;
          }
          resolve((stdout || "").trim());
        },
      );

      if (child.pid && onPid) {
        onPid(child.pid);
      }
    });
  }

  /**
   * Run Pi Mono in print mode for "interactive" tasks.
   * Pi's print mode handles tool use natively, so this is the same as runSession.
   * Used for tasks where the agent calls API endpoints via curl.
   */
  runSessionInteractive(prompt: string, cwd?: string): Promise<string> {
    return this.runSession(prompt, cwd);
  }

  /**
   * Resume an existing Pi Mono session by session file path.
   * Uses --session <path> to continue from a specific session file.
   */
  resumeSession(sessionId: string, prompt: string, cwd?: string, onPid?: (pid: number) => void): Promise<string> {
    return new Promise((resolve, reject) => {
      // Find the session file from the session ID
      const sessionPath = this.findSessionFile(sessionId);
      if (!sessionPath) {
        reject(new Error(`Pi Mono session file not found for ID: ${sessionId}`));
        return;
      }

      const { binary, baseArgs } = this.buildCommand();
      const args = [...baseArgs, "-p", prompt, "--session", sessionPath];

      log.debug(`Resuming Pi Mono session: ${sessionId}`);

      const child = execFile(
        binary,
        args,
        {
          timeout: EXEC_TIMEOUT,
          maxBuffer: 10 * 1024 * 1024,
          cwd: cwd || process.cwd(),
          env: this.cleanEnv(),
        },
        (error, stdout, stderr) => {
          if (error) {
            log.error(`Pi Mono resume error: ${error.message}`);
            if (stderr) log.debug(`Pi Mono stderr: ${stderr.slice(0, 500)}`);
            if (stdout && stdout.trim().length > 0) {
              resolve(stdout.trim());
              return;
            }
            reject(new Error(`Pi Mono resume error: ${error.message}`));
            return;
          }
          resolve((stdout || "").trim());
        },
      );

      if (child.pid && onPid) {
        onPid(child.pid);
      }
    });
  }

  /**
   * Detect the newest session file created after `beforeTimestamp`
   * in the Pi sessions directory matching `projectCwd`.
   *
   * Pi encodes CWD: /Users/foo/bar → --Users-foo-bar-- (double-dash delimited)
   */
  detectNewSession(projectCwd: string, beforeTimestamp: Date): string | null {
    const encodedDir = this.encodeProjectCwd(projectCwd);
    const projDir = join(this.getSessionsDir(), encodedDir);

    if (!existsSync(projDir)) return null;

    let newestId: string | null = null;
    let newestMtime = beforeTimestamp.getTime();

    for (const file of readdirSync(projDir)) {
      if (!file.endsWith(".jsonl")) continue;
      const filePath = join(projDir, file);
      const stat = statSync(filePath);
      if (stat.mtime.getTime() > newestMtime) {
        newestMtime = stat.mtime.getTime();
        newestId = basename(file, ".jsonl");
      }
    }

    return newestId;
  }

  /**
   * Find a session JSONL file by ID across all project directories.
   */
  private findSessionFile(sessionId: string): string | null {
    const sessionsDir = this.getSessionsDir();
    if (!existsSync(sessionsDir)) return null;

    const entries = readdirSync(sessionsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = join(sessionsDir, entry.name, `${sessionId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }

    return null;
  }
}

// ─── Self-registration ───────────────────────────────────────

registerRuntime("pi", () => new PiMonoAgentRuntime());
