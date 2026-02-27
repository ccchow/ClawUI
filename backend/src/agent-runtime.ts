import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import type { TimelineNode, SessionAnalysis } from "./jsonl-parser.js";

// ─── Types ──────────────────────────────────────────────────

export type AgentType = "claude" | "openclaw" | "pi-mono";

export interface AgentCapabilities {
  supportsResume: boolean;
  supportsTTY: boolean;
  supportsToolUse: boolean;
  supportsJsonOutput: boolean;
}

export interface AgentConfig {
  name: string;
  type: AgentType;
  binaryPath: string;
  sessionsPath: string;
  features: AgentCapabilities;
}

// ─── AgentRuntime interface ─────────────────────────────────

export interface AgentRuntime {
  /** Display name for this runtime (e.g. "Claude Code", "OpenClaw", "Pi Mono") */
  name: string;

  /** Resolved path to the agent's CLI binary */
  binaryPath: string;

  /** Feature capabilities of this runtime */
  capabilities: AgentCapabilities;

  // ── Execution modes ──

  /** Run a one-shot prompt in a new session */
  runSession(prompt: string, cwd?: string): Promise<string>;

  /** Run a prompt in interactive mode (full tool usage, no structured output) */
  runSessionInteractive(prompt: string, cwd?: string): Promise<string>;

  /** Resume an existing session with a continuation prompt */
  resumeSession(
    sessionId: string,
    prompt: string,
    cwd?: string,
    onPid?: (pid: number) => void,
  ): Promise<string>;

  // ── Session discovery ──

  /** Detect the newest session file created after `beforeTimestamp` for a project */
  detectNewSession(projectCwd: string, beforeTimestamp: Date): Promise<string | null>;

  /** Return the base directory where this runtime stores session files */
  getSessionsDir(): string;

  /** Encode a project CWD into the directory name format used by this runtime */
  encodeProjectCwd(cwd: string): string;

  // ── Session parsing ──

  /** Parse a session file into timeline nodes */
  parseSessionFile(filePath: string, rawContent?: string): TimelineNode[];

  /** Analyze a session for health metrics (compaction, errors, token usage) */
  analyzeSessionHealth(sessionId: string, knownFilePath?: string): SessionAnalysis | null;
}

// ─── Binary auto-detection ──────────────────────────────────

/**
 * Try to resolve a CLI binary by checking common locations then PATH.
 * Returns the resolved path, or null if not found.
 */
export function resolveAgentBinary(type: AgentType): string | null {
  const binaryName = agentBinaryName(type);
  const candidates = agentBinaryCandidates(type);

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  // Fallback: check PATH via `which`
  try {
    const resolved = execFileSync("/usr/bin/which", [binaryName], {
      encoding: "utf-8",
    }).trim();
    if (resolved) return resolved;
  } catch {
    // not in PATH
  }

  return null;
}

function agentBinaryName(type: AgentType): string {
  switch (type) {
    case "claude":
      return "claude";
    case "openclaw":
      return "openclaw";
    case "pi-mono":
      return "pi-mono";
  }
}

function agentBinaryCandidates(type: AgentType): string[] {
  const home = homedir();
  switch (type) {
    case "claude":
      return [
        join(home, ".local", "bin", "claude"),
        "/usr/local/bin/claude",
      ];
    case "openclaw":
      return [
        join(home, ".local", "bin", "openclaw"),
        "/usr/local/bin/openclaw",
      ];
    case "pi-mono":
      return [
        join(home, ".local", "bin", "pi-mono"),
        "/usr/local/bin/pi-mono",
      ];
  }
}

// ─── Runtime factory ────────────────────────────────────────

/**
 * Registry of runtime constructors, keyed by AgentType.
 * Initially only "claude" is registered; other runtimes are added
 * when their implementation modules call `registerRuntime()`.
 */
const runtimeRegistry = new Map<AgentType, () => AgentRuntime>();

export function registerRuntime(type: AgentType, factory: () => AgentRuntime): void {
  runtimeRegistry.set(type, factory);
}

/** Configured agent type from env / config. Imported lazily to avoid circular deps. */
let activeType: AgentType = "claude";

export function setActiveAgentType(type: AgentType): void {
  activeType = type;
}

/**
 * Get the currently active AgentRuntime.
 * Throws if the configured agent type has no registered implementation.
 */
export function getActiveRuntime(): AgentRuntime {
  const factory = runtimeRegistry.get(activeType);
  if (!factory) {
    throw new Error(
      `No runtime registered for agent type "${activeType}". ` +
      `Available: ${[...runtimeRegistry.keys()].join(", ") || "(none)"}`,
    );
  }
  return factory();
}

/**
 * Get the default sessions directory for a given agent type.
 * Claude: ~/.claude/projects/
 * OpenClaw: ~/.openclaw/sessions/
 * Pi Mono: ~/.pi-mono/sessions/
 */
export function getDefaultSessionsDir(type: AgentType): string {
  const home = homedir();
  switch (type) {
    case "claude":
      return join(home, ".claude", "projects");
    case "openclaw":
      return join(home, ".openclaw", "sessions");
    case "pi-mono":
      return join(home, ".pi-mono", "sessions");
  }
}
