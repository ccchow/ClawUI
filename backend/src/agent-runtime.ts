/**
 * Agent Runtime abstraction layer.
 *
 * Defines the interface that all AI agent backends (Claude Code, OpenClaw, Pi Mono)
 * must implement, plus a registry/factory for runtime selection.
 */

// ─── Types ───────────────────────────────────────────────────

export type AgentType = "claude" | "openclaw" | "pi";

export interface AgentCapabilities {
  /** Supports --resume flag for session continuation */
  supportsResume: boolean;
  /** Supports interactive mode (full tool use, no --output-format text) */
  supportsInteractive: boolean;
  /** Supports --output-format text for text-only output */
  supportsTextOutput: boolean;
  /** Supports --dangerously-skip-permissions flag */
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
  runSession(prompt: string, cwd?: string, onPid?: (pid: number) => void): Promise<string>;

  /**
   * Run the agent in interactive mode (full tool use, no --output-format text).
   * Used for tasks where the agent directly calls API endpoints via curl.
   * Returns raw stdout (usually ignored — side effects happen via API calls).
   */
  runSessionInteractive(prompt: string, cwd?: string): Promise<string>;

  /**
   * Resume an existing session by ID with a continuation prompt.
   * Used for retrying failed executions.
   * Returns the cleaned text output.
   */
  resumeSession(sessionId: string, prompt: string, cwd?: string, onPid?: (pid: number) => void): Promise<string>;

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

  activeRuntime = factory();
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
 * Reset the active runtime (for testing purposes).
 */
export function resetActiveRuntime(): void {
  activeRuntime = null;
}
