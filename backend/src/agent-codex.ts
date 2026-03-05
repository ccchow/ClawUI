/**
 * Codex CLI agent runtime implementation.
 *
 * Implements AgentRuntime for OpenAI's Codex CLI agent.
 * Codex outputs clean JSONL — no TTY/expect needed.
 *
 * Session files: ~/.codex/sessions/YYYY/MM/DD/rollout-<datetime>-<UUID>.jsonl
 *
 * Session JSONL format:
 *   Line 1: {type:"session_meta", payload:{id, cwd, cli_version, ...}}
 *   Lines N: response_item (messages, function_call, function_call_output),
 *            event_msg (task_started, agent_message, task_complete, ...),
 *            turn_context
 */

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "./logger.js";
import type { AgentRuntime, AgentCapabilities } from "./agent-runtime.js";
import { registerRuntime } from "./agent-runtime.js";
import type { TimelineNode } from "./jsonl-parser.js";
import type { FailureReason } from "./plan-db.js";
import type { ContextPressure, SessionAnalysis } from "./jsonl-parser.js";
import { readSessionHeader } from "./session-header.js";
import { CODEX_PATH as CONFIG_CODEX_PATH } from "./config.js";

const log = createLogger("agent-codex");

const EXEC_TIMEOUT = 30 * 60 * 1000; // 30 minutes per node

// ─── Binary resolution ──────────────────────────────────────

/** Resolved path to Codex CLI binary (from config.ts, with bare-command fallback). */
const CODEX_PATH = CONFIG_CODEX_PATH ?? "codex";

// ─── Session JSONL types ────────────────────────────────────

interface CodexSessionMeta {
  type: "session_meta";
  payload: {
    id: string;
    cwd?: string;
    timestamp?: string;
    cli_version?: string;
    source?: string;
    model_provider?: string;
  };
}

interface CodexResponseItem {
  type: "response_item";
  timestamp?: string;
  payload: CodexResponsePayload;
}

type CodexResponsePayload =
  | CodexMessagePayload
  | CodexFunctionCallPayload
  | CodexFunctionCallOutputPayload;

interface CodexMessagePayload {
  type: "message";
  role: "user" | "assistant" | "developer";
  content: CodexContentBlock[] | string;
}

interface CodexFunctionCallPayload {
  type: "function_call";
  name: string;
  call_id: string;
  arguments?: string;
}

interface CodexFunctionCallOutputPayload {
  type: "function_call_output";
  call_id: string;
  output?: string;
}

interface CodexEventMsg {
  type: "event_msg";
  timestamp?: string;
  payload: {
    type: string;
    message?: string;
    last_agent_message?: string;
    turn_id?: string;
    [key: string]: unknown;
  };
}

interface CodexTurnContext {
  type: "turn_context";
  timestamp?: string;
  payload: {
    turn_id?: string;
    cwd?: string;
    model?: string;
    [key: string]: unknown;
  };
}

type CodexEvent =
  | CodexSessionMeta
  | CodexResponseItem
  | CodexEventMsg
  | CodexTurnContext;

type CodexContentBlock =
  | { type: "input_text"; text: string }
  | { type: "output_text"; text: string }
  | { type: "reasoning"; text: string };

// ─── Session parsing ────────────────────────────────────────

/**
 * Parse a Codex session JSONL file into ClawUI TimelineNode[].
 *
 * Handles the session format:
 * - First line is session_meta ({type:"session_meta", payload:{id, cwd, ...}})
 * - Subsequent lines are response_item (messages, function calls) and event_msg events
 */
export function parseCodexSessionFile(filePath: string, rawContent?: string): TimelineNode[] {
  const raw = rawContent ?? readFileSync(filePath, "utf-8");
  const lines = raw.trim().split("\n");
  const nodes: TimelineNode[] = [];

  // Extract session ID from first line (session_meta) to use as prefix for node IDs.
  // Node IDs must be globally unique across all sessions (timeline_nodes PK constraint).
  let sessionPrefix = "";
  try {
    const firstLine = JSON.parse(lines[0]) as CodexSessionMeta;
    if (firstLine.type === "session_meta" && firstLine.payload?.id) {
      sessionPrefix = firstLine.payload.id.slice(0, 12);
    }
  } catch {
    // fallback: use file path hash
  }
  if (!sessionPrefix) {
    // Derive from file path for uniqueness if no session ID
    sessionPrefix = filePath.replace(/[^a-zA-Z0-9]/g, "").slice(-12);
  }

  for (let i = 0; i < lines.length; i++) {
    let event: CodexEvent;
    try {
      event = JSON.parse(lines[i]) as CodexEvent;
    } catch {
      continue;
    }

    const timestamp = (event as unknown as Record<string, unknown>).timestamp as string | undefined ?? "";

    switch (event.type) {
      case "session_meta":
        // Skip session header — metadata only
        break;

      case "response_item": {
        const item = event as CodexResponseItem;
        const payload = item.payload;

        if (payload.type === "message") {
          const msg = payload as CodexMessagePayload;

          // Skip developer messages (system/permissions instructions)
          if (msg.role === "developer") break;

          if (msg.role === "user") {
            const text = extractCodexText(msg.content);
            if (text.trim()) {
              nodes.push({
                id: `${sessionPrefix}-${i}`,
                type: "user",
                timestamp,
                title: summarize(text),
                content: text,
              });
            }
          } else if (msg.role === "assistant") {
            const text = extractCodexText(msg.content);
            if (text.trim()) {
              nodes.push({
                id: `${sessionPrefix}-${i}`,
                type: "assistant",
                timestamp,
                title: summarize(text),
                content: text,
              });
            }
          }
        } else if (payload.type === "function_call") {
          const fc = payload as CodexFunctionCallPayload;
          const inputStr = fc.arguments ?? "{}";
          nodes.push({
            id: `${sessionPrefix}-${i}-use`,
            type: "tool_use",
            timestamp,
            title: fc.name,
            content: inputStr,
            toolName: fc.name,
            toolInput: inputStr,
            toolUseId: fc.call_id,
          });
        } else if (payload.type === "function_call_output") {
          const fco = payload as CodexFunctionCallOutputPayload;
          const resultText = fco.output ?? "";
          if (resultText) {
            nodes.push({
              id: `${sessionPrefix}-${i}-result`,
              type: "tool_result",
              timestamp,
              title: `result`,
              content: resultText,
              toolResult: resultText,
              toolUseId: fco.call_id,
            });
          }
        }
        break;
      }

      case "event_msg": {
        const evt = event as CodexEventMsg;
        // agent_message events contain the assistant's final text output
        if (evt.payload.type === "agent_message" && evt.payload.message) {
          nodes.push({
            id: `${sessionPrefix}-${i}`,
            type: "assistant",
            timestamp,
            title: summarize(evt.payload.message),
            content: evt.payload.message,
          });
        } else if (evt.payload.type === "turn_aborted") {
          nodes.push({
            id: `${sessionPrefix}-${i}`,
            type: "system",
            timestamp,
            title: "Turn aborted",
            content: evt.payload.message ?? "Session turn was aborted",
          });
        }
        // token_count events are metadata — handled by health analysis, not timeline nodes
        break;
      }

      // turn_context — metadata, not shown in timeline
      default:
        break;
    }
  }

  return nodes;
}

// ─── Content helpers ────────────────────────────────────────

/** Extract text from Codex content (string or content block array). */
function extractCodexText(content: string | CodexContentBlock[] | unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as CodexContentBlock[])
      .filter((b): b is { type: "input_text" | "output_text"; text: string } =>
        b.type === "input_text" || b.type === "output_text"
      )
      .map((b) => b.text)
      .join("\n");
  }
  return String(content ?? "");
}

/** Create a short summary from text (first line, truncated). */
function summarize(text: string, maxLen = 120): string {
  const firstLine = text.split("\n")[0]?.trim() ?? "";
  if (firstLine.length <= maxLen) return firstLine;
  return firstLine.slice(0, maxLen - 1) + "\u2026";
}

// ─── File helpers ────────────────────────────────────────────

/**
 * Find a Codex session file by UUID across the date-organized directory.
 * Session files: ~/.codex/sessions/YYYY/MM/DD/rollout-<datetime>-<UUID>.jsonl
 */
function findCodexSessionFile(sessionId: string): string | null {
  const sessionsDir = join(homedir(), ".codex", "sessions");
  if (!existsSync(sessionsDir)) return null;

  return walkForSession(sessionsDir, sessionId);
}

/**
 * Recursively walk directory tree looking for a session file matching the UUID.
 */
function walkForSession(dir: string, sessionId: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      const found = walkForSession(fullPath, sessionId);
      if (found) return found;
    } else if (entry.endsWith(".jsonl") && entry.includes(sessionId)) {
      return fullPath;
    }
  }

  return null;
}

// ─── Runtime class ──────────────────────────────────────────

export class CodexAgentRuntime implements AgentRuntime {
  readonly type = "codex" as const;

  readonly capabilities: AgentCapabilities = {
    supportsResume: true,
    supportsInteractive: true,   // Codex supports tool use natively
    supportsTextOutput: true,    // --json flag for structured output
    supportsDangerousMode: true,  // Uses --dangerously-bypass-approvals-and-sandbox
  };

  getSessionsDir(): string {
    return join(homedir(), ".codex", "sessions");
  }

  encodeProjectCwd(cwd: string): string {
    // Codex sessions are date-organized, not path-organized.
    // Cross-platform: handle both / and \ separators, plus drive letter colons.
    return cwd
      .replace(/:/g, "-")          // drive letter colon (C: → C-)
      .replace(/[/\\]\./g, "/-")   // encode leading dots in path components
      .replace(/[/\\]/g, "-")      // both / and \ separators
      .replace(/^-/, "");           // strip leading dash
  }

  cleanEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    // Strip env vars that could interfere with subprocess
    delete env.CODEX_HOME;
    delete env.CODEX_SESSION; // Prevent session nesting
    return env;
  }

  /**
   * Run Codex agent with a prompt and capture JSON output.
   * Uses `codex exec --json --dangerously-bypass-approvals-and-sandbox -C <cwd> "<prompt>"`.
   * No TTY/expect needed — Codex exec outputs clean JSONL to stdout.
   *
   * Uses --dangerously-bypass-approvals-and-sandbox instead of --full-auto
   * because execution prompts include API callback URLs (report-status,
   * task-summary, report-blocker) that require localhost network access.
   * The --full-auto flag forces workspace-write sandbox which blocks these calls.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  runSession(prompt: string, cwd?: string, onPid?: (pid: number) => void, _extraArgs?: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = [
        "exec",
        "--json",
        "--dangerously-bypass-approvals-and-sandbox",
      ];

      if (cwd) {
        args.push("-C", cwd);
      }

      args.push(prompt);

      log.debug(`Running Codex: ${CODEX_PATH} exec --json --dangerously-bypass-approvals-and-sandbox`);

      const child = execFile(
        CODEX_PATH,
        args,
        {
          timeout: EXEC_TIMEOUT,
          maxBuffer: 10 * 1024 * 1024,
          cwd: cwd || process.cwd(),
          env: this.cleanEnv(),
        },
        (error, stdout, stderr) => {
          if (error) {
            log.error(`Codex CLI error: ${error.message}`);
            if (stderr) log.debug(`Codex stderr: ${stderr.slice(0, 500)}`);
            // If we got output despite the error, return it
            if (stdout && stdout.trim().length > 0) {
              resolve(this.extractOutput(stdout));
              return;
            }
            reject(new Error(`Codex CLI error: ${error.message}`));
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
   * Run Codex in interactive mode (full tool use, no --json).
   * Used for tasks where the agent directly calls API endpoints via curl.
   *
   * Uses --dangerously-bypass-approvals-and-sandbox instead of --full-auto
   * because interactive mode requires network access to call back to ClawUI
   * API endpoints (e.g., batch-create, report-status). The --full-auto flag
   * forces workspace-write sandbox which blocks localhost network calls.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  runSessionInteractive(prompt: string, cwd?: string, _extraArgs?: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = [
        "exec",
        "--dangerously-bypass-approvals-and-sandbox",
      ];

      if (cwd) {
        args.push("-C", cwd);
      }

      args.push(prompt);

      log.debug(`Running Codex interactive`);

      execFile(
        CODEX_PATH,
        args,
        {
          timeout: EXEC_TIMEOUT,
          maxBuffer: 10 * 1024 * 1024,
          cwd: cwd || process.cwd(),
          env: this.cleanEnv(),
        },
        (error, stdout, stderr) => {
          if (error) {
            log.error(`Codex interactive error: ${error.message}`);
            if (stderr) log.debug(`Codex stderr: ${stderr.slice(0, 500)}`);
            reject(new Error(`Codex interactive failed: ${error.message}`));
            return;
          }
          resolve(stdout || "");
        },
      );
    });
  }

  /**
   * Resume an existing Codex session by session ID.
   * Uses `codex exec resume <sessionId> "<prompt>" --json --dangerously-bypass-approvals-and-sandbox`.
   *
   * Uses --dangerously-bypass-approvals-and-sandbox instead of --full-auto
   * because execution prompts include API callback URLs (report-status,
   * task-summary, report-blocker) that require localhost network access.
   * The --full-auto flag forces workspace-write sandbox which blocks these calls.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  resumeSession(sessionId: string, prompt: string, cwd?: string, onPid?: (pid: number) => void, _extraArgs?: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = [
        "exec",
        "resume",
        sessionId,
        prompt,
        "--json",
        "--dangerously-bypass-approvals-and-sandbox",
      ];

      log.debug(`Resuming Codex session: ${sessionId.slice(0, 8)}...`);

      const child = execFile(
        CODEX_PATH,
        args,
        {
          timeout: EXEC_TIMEOUT,
          maxBuffer: 10 * 1024 * 1024,
          cwd: cwd || process.cwd(),
          env: this.cleanEnv(),
        },
        (error, stdout, stderr) => {
          if (error) {
            log.error(`Codex resume error: ${error.message}`);
            if (stderr) log.debug(`Codex stderr: ${stderr.slice(0, 500)}`);
            if (stdout && stdout.trim().length > 0) {
              resolve(this.extractOutput(stdout));
              return;
            }
            reject(new Error(`Codex resume error: ${error.message}`));
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
   * in the Codex sessions directory matching `projectCwd`.
   *
   * Codex stores sessions in date-organized dirs: ~/.codex/sessions/YYYY/MM/DD/*.jsonl
   * We walk recursively and match sessions by reading the session_meta cwd field.
   */
  detectNewSession(projectCwd: string, beforeTimestamp: Date): string | null {
    const sessionsDir = this.getSessionsDir();
    if (!existsSync(sessionsDir)) return null;

    let newestId: string | null = null;
    let newestMtime = beforeTimestamp.getTime();

    this.walkSessionFiles(sessionsDir, (filePath) => {
      let stat;
      try {
        stat = statSync(filePath);
      } catch {
        return;
      }

      if (stat.mtime.getTime() <= beforeTimestamp.getTime()) return;

      // Check if this session's cwd matches the project
      const header = readSessionHeader(filePath);
      if (header?.cwd === projectCwd) {
        if (stat.mtime.getTime() > newestMtime) {
          newestMtime = stat.mtime.getTime();
          newestId = header.id ?? null;
        }
      }
    });

    return newestId;
  }

  /**
   * Extract the final agent message from Codex --json JSONL output.
   * Looks for the last `event_msg` with type "agent_message" or "task_complete".
   */
  private extractOutput(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) return "";

    // Parse JSONL lines and find the last agent message
    const lines = trimmed.split("\n");
    let lastMessage = "";

    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as CodexEvent;
        if (obj.type === "event_msg") {
          const evt = obj as CodexEventMsg;
          if (evt.payload.type === "task_complete" && evt.payload.last_agent_message) {
            lastMessage = evt.payload.last_agent_message;
          } else if (evt.payload.type === "agent_message" && evt.payload.message) {
            lastMessage = evt.payload.message;
          }
        } else if (obj.type === "response_item") {
          const item = obj as CodexResponseItem;
          if (item.payload.type === "message") {
            const msg = item.payload as CodexMessagePayload;
            if (msg.role === "assistant") {
              const text = extractCodexText(msg.content);
              if (text.trim()) lastMessage = text;
            }
          }
        }
      } catch {
        // Skip unparseable lines
      }
    }

    return lastMessage || trimmed;
  }

  /**
   * Walk the Codex sessions directory recursively, calling `callback` for each .jsonl file.
   */
  private walkSessionFiles(dir: string, callback: (filePath: string) => void): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        this.walkSessionFiles(fullPath, callback);
      } else if (entry.endsWith(".jsonl")) {
        callback(fullPath);
      }
    }
  }

  /**
   * Find a session JSONL file by ID across the date-organized directory.
   */
  findSessionFile(sessionId: string): string | null {
    return findCodexSessionFile(sessionId);
  }

  /**
   * Analyze a Codex session JSONL file for health indicators.
   * Checks for error events and token usage.
   */
  analyzeSessionHealth(sessionId: string, knownFilePath?: string): SessionAnalysis | null {
    let filePath: string | null = knownFilePath ?? null;

    if (!filePath) {
      filePath = findCodexSessionFile(sessionId);
    }

    if (!filePath) return null;

    let raw: string;
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch {
      return null;
    }

    const lines = raw.trim().split("\n");
    let messageCount = 0;
    let lastApiError: string | null = null;
    let peakTokens = 0;
    let turnAborted = false;

    for (let i = 0; i < lines.length; i++) {
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(lines[i]);
      } catch {
        continue;
      }

      messageCount++;

      // Track errors from event_msg
      if (obj.type === "event_msg") {
        const payload = obj.payload as Record<string, unknown> | undefined;
        if (payload?.type === "error" || payload?.type === "api_error") {
          lastApiError = (payload.message as string) ?? "Unknown error";
        }

        // Track token counts
        if (payload?.type === "token_count") {
          const tokens = (payload.total_tokens as number) ?? 0;
          if (tokens > peakTokens) peakTokens = tokens;
        }

        // Track aborted turns
        if (payload?.type === "turn_aborted") {
          turnAborted = true;
        }
      }
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
    } else if (turnAborted) {
      failureReason = "error";
      detail = "Session turn was aborted";
    }

    // Codex doesn't have compaction like Claude/OpenClaw
    const contextPressure: ContextPressure = "none";

    return {
      failureReason,
      detail,
      compactCount: 0,
      peakTokens,
      lastApiError,
      messageCount,
      contextPressure,
      endedAfterCompaction: false,
      responsesAfterLastCompact: 0,
    };
  }
}

/**
 * Standalone wrapper for backward compatibility.
 * Delegates to CodexAgentRuntime.analyzeSessionHealth().
 */
export function analyzeCodexSessionHealth(sessionId: string, knownFilePath?: string): SessionAnalysis | null {
  return new CodexAgentRuntime().analyzeSessionHealth(sessionId, knownFilePath);
}

// ─── Self-registration ───────────────────────────────────────

registerRuntime("codex", () => new CodexAgentRuntime());
