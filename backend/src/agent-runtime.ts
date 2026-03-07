/**
 * Agent Runtime abstraction layer.
 *
 * Defines the interface that all AI agent backends (Claude Code, OpenClaw, Pi Mono, Codex CLI)
 * must implement, plus a registry/factory for runtime selection.
 */

import type { SessionAnalysis } from "./jsonl-parser.js";
import { createLogger } from "./logger.js";

const runtimeLog = createLogger("agent-runtime");

// ─── Types ───────────────────────────────────────────────────

export type AgentType = "claude" | "openclaw" | "pi" | "codex";

export interface AgentCapabilities {
  /** Supports --resume flag for session continuation */
  supportsResume: boolean;
  /** Supports interactive mode (full tool use, no --output-format text) */
  supportsInteractive: boolean;
  /** Supports --output-format text for text-only output */
  supportsTextOutput: boolean;
  /** Supports a permission-bypass flag (e.g. --dangerously-skip-permissions, --dangerously-bypass-approvals-and-sandbox) */
  supportsDangerousMode: boolean;
}

export interface AgentConfig {
  type: AgentType;
  binaryPath: string;
  expectPath: string;
  sessionsDir: string;
}

/**
 * Core interface that all agent runtimes must implement.
 *
 * Each method corresponds to a different CLI invocation pattern used
 * throughout the plan system (executor, generator, cli-runner).
 */
export interface AgentRuntime {
  readonly type: AgentType;
  readonly capabilities: AgentCapabilities;

  /**
   * Get the directory where this agent stores session JSONL files.
   * e.g. ~/.claude/projects/ for Claude Code
   */
  getSessionsDir(): string;

  /**
   * Run the agent in text output mode (--output-format text).
   * Used for simple tasks that only need text output (artifact generation, etc.)
   * Returns the cleaned text output.
   */
  runSession(prompt: string, cwd?: string, onPid?: (pid: number) => void, extraArgs?: string[]): Promise<string>;

  /**
   * Run the agent in interactive mode (full tool use, no --output-format text).
   * Used for tasks where the agent directly calls API endpoints via curl.
   * Returns raw stdout (usually ignored — side effects happen via API calls).
   */
  runSessionInteractive(prompt: string, cwd?: string, extraArgs?: string[]): Promise<string>;

  /**
   * Resume an existing session by ID with a continuation prompt.
   * Used for retrying failed executions.
   * Returns the cleaned text output.
   */
  resumeSession(sessionId: string, prompt: string, cwd?: string, onPid?: (pid: number) => void, extraArgs?: string[]): Promise<string>;

  /**
   * Encode a project CWD to match the agent's directory naming convention.
   * e.g. /Users/foo/project → -Users-foo-project for Claude Code
   */
  encodeProjectCwd(cwd: string): string;

  /**
   * Detect the newest session file created after `beforeTimestamp`
   * in the agent's projects directory matching `projectCwd`.
   * Returns the session ID or null.
   */
  detectNewSession(projectCwd: string, beforeTimestamp: Date): string | null;

  /**
   * Build a clean environment for spawning agent CLI subprocesses.
   * Strips agent-specific env vars that could cause conflicts.
   */
  cleanEnv(): NodeJS.ProcessEnv;

  /**
   * Analyze a session's JSONL file for health indicators.
   * Checks for compaction events, API errors, token usage, and context pressure.
   * Returns null if the session file doesn't exist.
   */
  analyzeSessionHealth(sessionId: string, knownFilePath?: string): SessionAnalysis | null;
}

// ─── Runtime Registry ────────────────────────────────────────

const runtimeRegistry = new Map<AgentType, () => AgentRuntime>();
let activeRuntime: AgentRuntime | null = null;

/**
 * Register an agent runtime factory for a given agent type.
 * Called during module initialization (e.g. in agent-claude.ts).
 */
export function registerRuntime(type: AgentType, factory: () => AgentRuntime): void {
  runtimeRegistry.set(type, factory);
}

/**
 * Get the active agent runtime. Creates it lazily on first call
 * using the configured AGENT_TYPE from config.ts.
 *
 * Falls back to "claude" if the configured type has no registered factory.
 */
export function getActiveRuntime(): AgentRuntime {
  if (activeRuntime) return activeRuntime;

  // Import config lazily to avoid circular dependencies
  const agentType = (process.env.AGENT_TYPE || "claude") as AgentType;
  const factory = runtimeRegistry.get(agentType) ?? runtimeRegistry.get("claude");

  if (!factory) {
    throw new Error(`No agent runtime registered for type "${agentType}". Available: ${[...runtimeRegistry.keys()].join(", ")}`);
  }

  activeRuntime = new LoggingRuntimeWrapper(factory());
  return activeRuntime;
}

/**
 * Get all registered runtime factories with availability info.
 * Used for multi-agent session discovery and the /api/agents endpoint.
 */
export function getRegisteredRuntimes(): Map<AgentType, () => AgentRuntime> {
  return new Map(runtimeRegistry);
}

/**
 * Get an agent runtime by type. Creates a fresh instance each time.
 * Useful when you need a specific runtime (e.g., by session agent type)
 * rather than the globally configured active runtime.
 *
 * Returns null if no runtime is registered for the given type.
 */
export function getRuntimeByType(type: AgentType): AgentRuntime | null {
  const factory = runtimeRegistry.get(type);
  return factory ? factory() : null;
}

/**
 * Reset the active runtime (for testing purposes).
 */
export function resetActiveRuntime(): void {
  activeRuntime = null;
}

// ─── Prompt Token Estimation ────────────────────────────────

/**
 * Estimate token count from a prompt string.
 * Uses ~4 characters per token as a rough approximation (standard for English + code).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─── Agent Call Stats (in-memory accumulator) ────────────────

export interface AgentCallRecord {
  method: "runSession" | "runSessionInteractive" | "resumeSession";
  promptChars: number;
  estimatedTokens: number;
  durationMs: number;
  agentType: AgentType;
  timestamp: string;
}

const agentCallHistory: AgentCallRecord[] = [];
let totalPromptTokens = 0;
let totalCalls = 0;
let totalDurationMs = 0;

function recordAgentCall(record: AgentCallRecord): void {
  agentCallHistory.push(record);
  totalPromptTokens += record.estimatedTokens;
  totalCalls++;
  totalDurationMs += record.durationMs;

  runtimeLog.info(
    `[${record.method}] prompt=${record.promptChars} chars (~${record.estimatedTokens} tokens), ` +
    `duration=${(record.durationMs / 1000).toFixed(1)}s, ` +
    `agent=${record.agentType}, ` +
    `cumulative: ${totalCalls} calls, ~${totalPromptTokens} tokens total`,
  );
}

export interface AgentCallStats {
  totalCalls: number;
  totalPromptTokens: number;
  totalDurationMs: number;
  /** Per-method breakdown */
  byMethod: Record<string, { calls: number; promptTokens: number; durationMs: number }>;
  /** Last N calls for debugging */
  recentCalls: AgentCallRecord[];
}

/**
 * Get aggregate stats about agent calls since process start.
 */
export function getAgentCallStats(recentCount = 20): AgentCallStats {
  const byMethod: Record<string, { calls: number; promptTokens: number; durationMs: number }> = {};
  for (const record of agentCallHistory) {
    if (!byMethod[record.method]) {
      byMethod[record.method] = { calls: 0, promptTokens: 0, durationMs: 0 };
    }
    byMethod[record.method].calls++;
    byMethod[record.method].promptTokens += record.estimatedTokens;
    byMethod[record.method].durationMs += record.durationMs;
  }

  return {
    totalCalls,
    totalPromptTokens,
    totalDurationMs,
    byMethod,
    recentCalls: agentCallHistory.slice(-recentCount),
  };
}

/**
 * Reset agent call stats (for testing).
 */
export function resetAgentCallStats(): void {
  agentCallHistory.length = 0;
  totalPromptTokens = 0;
  totalCalls = 0;
  totalDurationMs = 0;
}

// ─── Logging Runtime Wrapper ─────────────────────────────────

/**
 * Wraps an AgentRuntime to automatically log prompt token counts
 * and call duration for runSession, runSessionInteractive, and resumeSession.
 */
class LoggingRuntimeWrapper implements AgentRuntime {
  constructor(private inner: AgentRuntime) {}

  get type() { return this.inner.type; }
  get capabilities() { return this.inner.capabilities; }

  getSessionsDir() { return this.inner.getSessionsDir(); }
  encodeProjectCwd(cwd: string) { return this.inner.encodeProjectCwd(cwd); }
  detectNewSession(projectCwd: string, beforeTimestamp: Date) { return this.inner.detectNewSession(projectCwd, beforeTimestamp); }
  cleanEnv() { return this.inner.cleanEnv(); }
  analyzeSessionHealth(sessionId: string, knownFilePath?: string) { return this.inner.analyzeSessionHealth(sessionId, knownFilePath); }

  async runSession(prompt: string, cwd?: string, onPid?: (pid: number) => void, extraArgs?: string[]): Promise<string> {
    const start = Date.now();
    const tokens = estimateTokens(prompt);
    runtimeLog.debug(`[runSession] starting: ~${tokens} tokens (${prompt.length} chars)`);
    try {
      return await this.inner.runSession(prompt, cwd, onPid, extraArgs);
    } finally {
      recordAgentCall({
        method: "runSession",
        promptChars: prompt.length,
        estimatedTokens: tokens,
        durationMs: Date.now() - start,
        agentType: this.inner.type,
        timestamp: new Date().toISOString(),
      });
    }
  }

  async runSessionInteractive(prompt: string, cwd?: string, extraArgs?: string[]): Promise<string> {
    const start = Date.now();
    const tokens = estimateTokens(prompt);
    runtimeLog.debug(`[runSessionInteractive] starting: ~${tokens} tokens (${prompt.length} chars)`);
    try {
      return await this.inner.runSessionInteractive(prompt, cwd, extraArgs);
    } finally {
      recordAgentCall({
        method: "runSessionInteractive",
        promptChars: prompt.length,
        estimatedTokens: tokens,
        durationMs: Date.now() - start,
        agentType: this.inner.type,
        timestamp: new Date().toISOString(),
      });
    }
  }

  async resumeSession(sessionId: string, prompt: string, cwd?: string, onPid?: (pid: number) => void, extraArgs?: string[]): Promise<string> {
    const start = Date.now();
    const tokens = estimateTokens(prompt);
    runtimeLog.debug(`[resumeSession] starting: ~${tokens} tokens (${prompt.length} chars), session=${sessionId}`);
    try {
      return await this.inner.resumeSession(sessionId, prompt, cwd, onPid, extraArgs);
    } finally {
      recordAgentCall({
        method: "resumeSession",
        promptChars: prompt.length,
        estimatedTokens: tokens,
        durationMs: Date.now() - start,
        agentType: this.inner.type,
        timestamp: new Date().toISOString(),
      });
    }
  }
}
