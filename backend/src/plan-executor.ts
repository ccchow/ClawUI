import { execFile } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import {
  getBlueprint,
  updateBlueprint,
  updateMacroNode,
  createMacroNode,
  createExecution,
  updateExecution,
  getExecution,
  createArtifact,
  getArtifactsForNode,
  getOrphanedQueuedNodes,
  getStaleRunningExecutions,
  getRecentRestartFailedExecutions,
  getExecutionBySession,
  recoverStaleExecutions,
  createRelatedSession,
} from "./plan-db.js";
import { syncSession } from "./db.js";
import type { Blueprint, MacroNode, NodeExecution, Artifact, StaleExecution, FailureReason } from "./plan-db.js";
import { runClaudeInteractiveGen, getApiBase, getAuthParam } from "./plan-generator.js";
import { analyzeSessionHealth } from "./jsonl-parser.js";

// ─── Pending task tracking (in-memory, for queue status API) ─

export interface PendingTask {
  type: "run" | "reevaluate" | "enrich" | "generate" | "split";
  nodeId?: string;
  queuedAt: string;
}

export interface QueueInfo {
  running: boolean;
  queueLength: number;
  pendingTasks: PendingTask[];
}

const blueprintPendingTasks = new Map<string, PendingTask[]>();

export function addPendingTask(blueprintId: string, task: PendingTask): void {
  const tasks = blueprintPendingTasks.get(blueprintId) ?? [];
  tasks.push(task);
  blueprintPendingTasks.set(blueprintId, tasks);
}

export function removePendingTask(blueprintId: string, nodeId?: string, type?: string): void {
  const tasks = blueprintPendingTasks.get(blueprintId) ?? [];
  const idx = tasks.findIndex(
    (t) => (!nodeId || t.nodeId === nodeId) && (!type || t.type === type),
  );
  if (idx >= 0) tasks.splice(idx, 1);
  if (tasks.length === 0) blueprintPendingTasks.delete(blueprintId);
  else blueprintPendingTasks.set(blueprintId, tasks);
}

export function getQueueInfo(blueprintId: string): QueueInfo {
  return {
    running: blueprintRunning.has(blueprintId),
    queueLength: (blueprintQueues.get(blueprintId) ?? []).length,
    pendingTasks: blueprintPendingTasks.get(blueprintId) ?? [],
  };
}

export interface GlobalQueueTask {
  blueprintId: string;
  type: string;
  nodeId?: string;
  nodeTitle?: string;
  blueprintTitle?: string;
  sessionId?: string;
}

export interface GlobalQueueInfo {
  active: boolean;
  totalPending: number;
  tasks: GlobalQueueTask[];
}

export function getGlobalQueueInfo(): GlobalQueueInfo {
  const tasks: GlobalQueueTask[] = [];
  // Include currently running blueprints (pending task is removed when execution starts)
  for (const blueprintId of blueprintRunning) {
    tasks.push({ blueprintId, type: "running", nodeId: blueprintRunningNodeId.get(blueprintId) });
  }
  // Include queued/pending tasks
  for (const [blueprintId, pending] of blueprintPendingTasks) {
    for (const t of pending) {
      tasks.push({ blueprintId, type: t.type, nodeId: t.nodeId });
    }
  }
  const active = tasks.length > 0;

  // Enrich tasks with titles and session IDs from SQLite
  const blueprintCache = new Map<string, Blueprint | null>();
  for (const task of tasks) {
    // Look up blueprint (cached per blueprint)
    if (!blueprintCache.has(task.blueprintId)) {
      try {
        blueprintCache.set(task.blueprintId, getBlueprint(task.blueprintId));
      } catch {
        blueprintCache.set(task.blueprintId, null);
      }
    }
    const blueprint = blueprintCache.get(task.blueprintId);
    if (blueprint) {
      task.blueprintTitle = blueprint.title;
      if (task.nodeId) {
        const node = blueprint.nodes.find((n) => n.id === task.nodeId);
        if (node) {
          task.nodeTitle = node.title;
          // Find latest running execution's sessionId
          const runningExec = node.executions?.find((e) => e.status === "running");
          if (runningExec?.sessionId) {
            task.sessionId = runningExec.sessionId;
          } else if (node.executions?.length) {
            // Fallback: latest execution with a sessionId
            const latest = [...node.executions].reverse().find((e) => e.sessionId);
            if (latest?.sessionId) task.sessionId = latest.sessionId;
          }
        }
      }
    }
  }

  return { active, totalPending: tasks.length, tasks };
}

/**
 * Remove a queued task from the in-memory blueprint queue by nodeId.
 * Returns false if the task is not found or is currently running.
 */
export function removeQueuedTask(blueprintId: string, nodeId: string): { removed: boolean; running: boolean } {
  // If the blueprint is currently running, check if this node's task is the active one
  // (the active task has already been shifted from the queue, so if it's not in the queue
  // and the blueprint is running, it might be the active one — but we can't be sure which
  // node is active. We rely on the caller checking node.status !== "running" before calling.)
  const queue = blueprintQueues.get(blueprintId);
  if (!queue) return { removed: false, running: false };
  const idx = queue.findIndex(item => item.nodeId === nodeId);
  if (idx === -1) return { removed: false, running: false };
  const [removed] = queue.splice(idx, 1);
  removed.resolve(null as unknown as never);
  return { removed: true, running: false };
}

import { CLAUDE_PATH, EXPECT_PATH } from "./config.js";
import { createLogger } from "./logger.js";

const log = createLogger("plan-executor");
const recoveryLog = createLogger("recovery");

const EXEC_TIMEOUT = 30 * 60 * 1000; // 30 minutes per node

/**
 * Build a clean environment for spawning Claude CLI subprocesses.
 * Strips CLAUDECODE to prevent "cannot be launched inside another Claude Code session"
 * error when the backend itself was started from within a Claude Code session.
 */
function cleanEnvForClaude(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  return env;
}

// ─── Failure classification ──────────────────────────────────

/**
 * Classify the reason for an execution failure by analyzing:
 * 1. The CLI error message (timeout, signal, etc.)
 * 2. The CLI output (for error patterns)
 * 3. The session's JSONL file (for API errors and context compaction)
 *
 * Priority: JSONL analysis > output analysis > error message analysis
 */
function classifyFailure(
  errorMsg: string,
  output: string | undefined,
  sessionId: string | undefined,
): { reason: FailureReason; detail: string } {
  // 1. Check CLI error for timeout patterns
  const isTimeout = /killed|timeout|timed out|SIGTERM|ETIMEDOUT/i.test(errorMsg);

  // 2. Check CLI output and error message for context-related patterns
  const combinedText = [errorMsg, output || ""].join("\n");
  if (output) {
    if (output.includes("exceeded") && output.includes("output token maximum")) {
      return {
        reason: "output_token_limit",
        detail: "Claude's response exceeded the output token limit. The task may need to be broken into smaller steps.",
      };
    }
  }
  // Check for context-full CLI error patterns (may appear in error or output)
  if (
    /context.?window|context.?length.?exceeded|maximum context length/i.test(combinedText) ||
    /input.*token.*limit|max_tokens_exceeded/i.test(combinedText) ||
    /conversation is too long|too many tokens/i.test(combinedText)
  ) {
    return {
      reason: "context_exhausted",
      detail: `Context window exceeded: ${errorMsg.slice(0, 200)}`,
    };
  }

  // 3. Analyze the JSONL session file for deeper diagnostics
  if (sessionId) {
    const analysis = analyzeSessionHealth(sessionId);
    if (analysis) {
      // API error in JSONL takes priority
      if (analysis.failureReason === "output_token_limit") {
        return {
          reason: "output_token_limit",
          detail: analysis.detail,
        };
      }
      if (analysis.failureReason === "context_exhausted") {
        return {
          reason: "context_exhausted",
          detail: analysis.detail,
        };
      }
      // Session ended right after compaction — strong signal of context exhaustion
      if (analysis.endedAfterCompaction && analysis.compactCount >= 1) {
        return {
          reason: "context_exhausted",
          detail: `Session compacted ${analysis.compactCount} time(s) and ended immediately after (peak ${analysis.peakTokens} tokens). Context was likely full.`,
        };
      }
      // High compaction count even without a specific error suggests context pressure
      if (analysis.compactCount >= 2 && isTimeout) {
        return {
          reason: "context_exhausted",
          detail: `Session timed out after ${analysis.compactCount} context compactions (peak ${analysis.peakTokens} tokens). Context pressure likely caused the session to stall.`,
        };
      }
      if (analysis.lastApiError) {
        return {
          reason: "error",
          detail: `API error: ${analysis.lastApiError}`,
        };
      }
    }
  }

  // 4. Classify based on error message
  if (isTimeout) {
    return {
      reason: "timeout",
      detail: `Execution timed out: ${errorMsg}`,
    };
  }

  return {
    reason: "error",
    detail: errorMsg,
  };
}

/**
 * Classify a "short output" failure (output < 50 chars).
 * Checks JSONL session data to determine if it was context-related.
 */
function classifyHungFailure(
  sessionId: string | undefined,
): { reason: FailureReason; detail: string } {
  if (sessionId) {
    const analysis = analyzeSessionHealth(sessionId);
    if (analysis) {
      if (analysis.failureReason === "output_token_limit") {
        return {
          reason: "output_token_limit",
          detail: analysis.detail,
        };
      }
      if (analysis.failureReason === "context_exhausted" || analysis.compactCount >= 2) {
        return {
          reason: "context_exhausted",
          detail: analysis.detail || `Session compacted ${analysis.compactCount} times — context exhaustion likely caused the hang.`,
        };
      }
      // Session ended right after compaction with no output — context full
      if (analysis.endedAfterCompaction && analysis.compactCount >= 1) {
        return {
          reason: "context_exhausted",
          detail: `Session compacted ${analysis.compactCount} time(s) and produced no output after last compaction (peak ${analysis.peakTokens} tokens). Context was likely full.`,
        };
      }
    }
  }
  return {
    reason: "hung",
    detail: "Execution produced no meaningful output (Claude may have hung or timed out)",
  };
}

/**
 * Store context health metrics from JSONL session analysis on an execution record.
 * Called after execution completes (success or failure) when a sessionId is available.
 */
function storeContextHealth(executionId: string, sessionId: string): void {
  try {
    const analysis = analyzeSessionHealth(sessionId);
    if (analysis) {
      updateExecution(executionId, {
        compactCount: analysis.compactCount,
        peakTokens: analysis.peakTokens,
        contextPressure: analysis.contextPressure,
        contextTokensUsed: analysis.peakTokens || undefined,
      });
    }
  } catch (err) {
    log.warn(`Failed to store context health for execution ${executionId.slice(0, 8)}: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Wraps a promise with a timeout. If the promise doesn't settle within `ms`,
 * rejects with the given message. Prevents tasks from hanging indefinitely.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}
const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

// ─── Blueprint-level serial queue (prevents concurrent Claude calls) ─

interface QueueItem<T = unknown> {
  task: () => Promise<T>;
  resolve: (val: T) => void;
  reject: (err: Error) => void;
  nodeId?: string;
}

const blueprintQueues = new Map<string, QueueItem[]>();
const blueprintRunning = new Set<string>();
const blueprintRunningNodeId = new Map<string, string | undefined>();

/**
 * Enqueue any async task for serial execution within a blueprint.
 * All Claude-calling operations (run, reevaluate, enrich, generate) should use this.
 */
export function enqueueBlueprintTask<T>(blueprintId: string, task: () => Promise<T>, nodeId?: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const queue = blueprintQueues.get(blueprintId) ?? [];
    queue.push({ task, resolve: resolve as (val: unknown) => void, reject, nodeId });
    blueprintQueues.set(blueprintId, queue);
    log.debug(`Enqueued task for blueprint ${blueprintId.slice(0, 8)}, queue depth: ${queue.length}`);
    drainQueue(blueprintId);
  });
}

async function drainQueue(blueprintId: string): Promise<void> {
  if (blueprintRunning.has(blueprintId)) return;

  const queue = blueprintQueues.get(blueprintId);
  if (!queue || queue.length === 0) return;

  blueprintRunning.add(blueprintId);

  while (queue.length > 0) {
    const item = queue.shift()!;
    blueprintRunningNodeId.set(blueprintId, item.nodeId);
    try {
      const result = await item.task();
      item.resolve(result);
    } catch (err) {
      item.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  blueprintRunning.delete(blueprintId);
  blueprintRunningNodeId.delete(blueprintId);
  blueprintQueues.delete(blueprintId);
}

// ─── Session detection ─────────────────────────────────────

/**
 * Find the newest JSONL session file created after `beforeTimestamp`
 * in the Claude projects directory matching `projectCwd`.
 * Returns the session ID (filename minus .jsonl) or null.
 */
export function detectNewSession(
  projectCwd: string,
  beforeTimestamp: Date,
): string | null {
  // Claude encodes CWD as path with / replaced by -
  // e.g. /home/you/projects/MyApp → -home-you-projects-MyApp
  const encodedDir = projectCwd.replace(/\//g, "-");
  const projDir = join(CLAUDE_PROJECTS_DIR, encodedDir);

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

// ─── Low-level Claude runner (no --resume) ─────────────────

export function runClaudeInteractive(prompt: string, cwd?: string): Promise<string> {
  // Run Claude Code without --output-format text, allowing full tool usage.
  // Output is not parsed — used for tasks where Claude directly calls APIs.
  return new Promise((resolve, reject) => {
    const tmpFile = join(tmpdir(), `clawui-plan-prompt-${randomUUID()}.txt`);
    writeFileSync(tmpFile, prompt, "utf-8");

    // Use Tcl file read for prompt
    const fullScript = `
set timeout 1800
set stty_init "columns 2000"
set fp [open "${tmpFile}" r]
set prompt [read -nonewline $fp]
close $fp
file delete "${tmpFile}"
spawn ${CLAUDE_PATH} --dangerously-skip-permissions --max-turns 200 -p $prompt
expect eof
catch {wait}
`;

    const tmpExpect = join(tmpdir(), `clawui-plan-expect-${randomUUID()}.exp`);
    writeFileSync(tmpExpect, fullScript, "utf-8");

    execFile(
      EXPECT_PATH,
      [tmpExpect],
      {
        timeout: EXEC_TIMEOUT,
        maxBuffer: 10 * 1024 * 1024,
        cwd: cwd || process.cwd(),
        env: cleanEnvForClaude(),
      },
      (error, stdout) => {
        try { unlinkSync(tmpExpect); } catch { /* ignore */ }
        try { unlinkSync(tmpFile); } catch { /* ignore */ }

        if (error) {
          // Reject on timeout or other critical errors so callers can handle failures
          reject(new Error(`Claude interactive failed: ${error.message}`));
          return;
        }

        // We don't care about the output content for interactive mode
        resolve(stdout || "");
      },
    );
  });
}

function runClaude(prompt: string, cwd?: string, onPid?: (pid: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const tmpFile = join(tmpdir(), `clawui-plan-prompt-${randomUUID()}.txt`);
    writeFileSync(tmpFile, prompt, "utf-8");

    // Read prompt via Tcl file read, pass to claude via sh -c with single quotes
    // Single quotes in prompt are escaped as: '\''
    const outputFile = join(tmpdir(), `clawui-plan-output-${randomUUID()}.out`);
    const expectScript = `
log_user 0
set timeout 1800
set stty_init "columns 2000"
match_max 1000000

set fp [open "${tmpFile}" r]
set prompt [read -nonewline $fp]
close $fp
file delete "${tmpFile}"

set of [open "${outputFile}" w]
set output ""

spawn ${CLAUDE_PATH} --dangerously-skip-permissions --output-format text --max-turns 200 -p $prompt
expect {
  -re ".+" {
    append output $expect_out(0,string)
    exp_continue
  }
  eof {}
  timeout {
    puts -nonewline $of $output
    close $of
    exit 1
  }
}

# Wait for the spawned process to fully exit
catch {wait}

puts -nonewline $of $output
close $of
`;

    const tmpExpect = join(tmpdir(), `clawui-plan-expect-${randomUUID()}.exp`);
    writeFileSync(tmpExpect, expectScript, "utf-8");

    const child = execFile(
      EXPECT_PATH,
      [tmpExpect],
      {
        timeout: EXEC_TIMEOUT,
        maxBuffer: 10 * 1024 * 1024,
        cwd: cwd || process.cwd(),
        env: cleanEnvForClaude(),
      },
      (error, _stdout, _stderr) => {
        // Read output from file (avoids TTY echo contamination)
        let clean = "";
        try {
          clean = readFileSync(outputFile, "utf-8")
            .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "")
            .replace(/\x1B\][^\x07]*\x07/g, "")
            .replace(/\r/g, "")
            .trim();
        } catch { /* no output file */ }

        // Cleanup
        try { unlinkSync(tmpExpect); } catch { /* ignore */ }
        try { unlinkSync(tmpFile); } catch { /* ignore */ }
        try { unlinkSync(outputFile); } catch { /* ignore */ }

        if (clean.length > 0) {
          resolve(clean);
          return;
        }
        if (error) {
          reject(new Error(`Claude CLI error: ${error.message}`));
          return;
        }
        resolve(clean);
      },
    );

    // Notify caller of the expect process PID for liveness tracking
    if (child.pid && onPid) {
      onPid(child.pid);
    }
  });
}

function runClaudeResume(sessionId: string, prompt: string, cwd?: string, onPid?: (pid: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const tmpFile = join(tmpdir(), `clawui-plan-prompt-${randomUUID()}.txt`);
    writeFileSync(tmpFile, prompt, "utf-8");

    const outputFile = join(tmpdir(), `clawui-plan-output-${randomUUID()}.out`);
    const expectScript = `
log_user 0
set timeout 1800
set stty_init "columns 2000"
match_max 1000000

set fp [open "${tmpFile}" r]
set prompt [read -nonewline $fp]
close $fp
file delete "${tmpFile}"

set of [open "${outputFile}" w]
set output ""

spawn ${CLAUDE_PATH} --dangerously-skip-permissions --output-format text --max-turns 200 --resume ${sessionId} -p $prompt
expect {
  -re ".+" {
    append output $expect_out(0,string)
    exp_continue
  }
  eof {}
  timeout {
    puts -nonewline $of $output
    close $of
    exit 1
  }
}

# Wait for the spawned process to fully exit
catch {wait}

puts -nonewline $of $output
close $of
`;

    const tmpExpect = join(tmpdir(), `clawui-plan-expect-${randomUUID()}.exp`);
    writeFileSync(tmpExpect, expectScript, "utf-8");

    const child = execFile(
      EXPECT_PATH,
      [tmpExpect],
      {
        timeout: EXEC_TIMEOUT,
        maxBuffer: 10 * 1024 * 1024,
        cwd: cwd || process.cwd(),
        env: cleanEnvForClaude(),
      },
      (error, _stdout, _stderr) => {
        let clean = "";
        try {
          clean = readFileSync(outputFile, "utf-8")
            .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "")
            .replace(/\x1B\][^\x07]*\x07/g, "")
            .replace(/\r/g, "")
            .trim();
        } catch { /* no output file */ }

        try { unlinkSync(tmpExpect); } catch { /* ignore */ }
        try { unlinkSync(tmpFile); } catch { /* ignore */ }
        try { unlinkSync(outputFile); } catch { /* ignore */ }

        if (clean.length > 0) {
          resolve(clean);
          return;
        }
        if (error) {
          reject(new Error(`Claude CLI resume error: ${error.message}`));
          return;
        }
        resolve(clean);
      },
    );

    if (child.pid && onPid) {
      onPid(child.pid);
    }
  });
}

// ─── Prompt builders ────────────────────────────────────────

function buildNodePrompt(
  blueprint: Blueprint,
  node: MacroNode,
  inputArtifacts: { node: MacroNode; artifact: Artifact }[],
  executionId: string,
): string {
  const apiBase = getApiBase();
  const authParam = getAuthParam();
  const blockerUrl = `${apiBase}/api/blueprints/${blueprint.id}/executions/${executionId}/report-blocker?${authParam}`;
  const summaryUrl = `${apiBase}/api/blueprints/${blueprint.id}/executions/${executionId}/task-summary?${authParam}`;
  const statusUrl = `${apiBase}/api/blueprints/${blueprint.id}/executions/${executionId}/report-status?${authParam}`;

  const total = blueprint.nodes.length;
  let prompt = `You are executing step ${node.order + 1}/${total} of a development plan: "${blueprint.title}"\n\n`;

  if (blueprint.description) {
    prompt += `## Plan Description\n${blueprint.description}\n\n`;
  }

  if (inputArtifacts.length > 0) {
    prompt += `## Context from previous steps:\n`;
    for (const { node: depNode, artifact } of inputArtifacts) {
      prompt += `### Step ${depNode.order + 1}: ${depNode.title}\n${artifact.content}\n\n`;
    }
  }

  prompt += `## Your Task (Step ${node.order + 1}): ${node.title}\n`;
  if (node.description) {
    prompt += `${node.description}\n\n`;
  }
  if (node.prompt) {
    prompt += `${node.prompt}\n\n`;
  }

  if (blueprint.projectCwd) {
    prompt += `## Working Directory: ${blueprint.projectCwd}\n\n`;
  }

  prompt += `## Instructions
- Complete this step thoroughly. Focus only on THIS step.
- DO NOT ask for confirmation or clarification. Just write the code directly.
- You have access to additional MCP tools (e.g. Playwright for browser testing, Serena for semantic code analysis, Context7 for library docs, Linear for issue tracking) via ToolSearch. Use \`ToolSearch\` to discover and load them when built-in tools are insufficient for the task.
- If you encounter a blocker you cannot resolve, report it by running this curl command:

curl -s -X POST '${blockerUrl}' -H 'Content-Type: application/json' -d '{"type": "<one of: missing_dependency, unclear_requirement, access_issue, technical_limitation>", "description": "<describe the actual problem>", "suggestion": "<what the human could do to help>"}'

- After completing, verify your changes by running the project's appropriate check commands (typecheck, lint, build, or tests as applicable).
- IMPORTANT: After completing and verifying, run the skill command /claude-md-management:revise-claude-md to update CLAUDE.md with any learnings from this step. Do NOT ask for confirmation — apply updates directly without user interaction.
- IMPORTANT: After ALL work above is complete (including CLAUDE.md updates), report your task completion summary by running this curl command:

curl -s -X POST '${summaryUrl}' -H 'Content-Type: application/json' -d '{"summary": "<2-3 sentence summary of what was accomplished in this step>"}'

- IMPORTANT: As the ABSOLUTE LAST action, report your execution status. If the task was completed successfully:

curl -s -X POST '${statusUrl}' -H 'Content-Type: application/json' -d '{"status": "done"}'

  If the task cannot be completed (e.g., tests don't pass, build broken, requirements unclear), report failure instead:

curl -s -X POST '${statusUrl}' -H 'Content-Type: application/json' -d '{"status": "failed", "reason": "<why the task could not be completed>"}'`;
  return prompt;
}

const ARTIFACT_PROMPT = `Summarize what was accomplished in the previous coding step.
Start your response with exactly "**What was done:**" and include ONLY the completed work.
Format:

**What was done:**
<2-3 sentences summarizing completed work>

**Files changed:**
<list of file paths created or modified>

**Decisions:**
<key decisions made, if any>

Keep it under 200 words. Be specific and factual. Do NOT include plans, next steps, or things still to do.`;

// ─── Artifact generation ────────────────────────────────────

/**
 * @deprecated Use API callback-based task summary instead. Kept as fallback for legacy executions.
 * Strip the echoed prompt from CLI output to isolate Claude's actual response.
 * The prompt is echoed by the terminal before Claude's response appears.
 * We look for known prompt-end markers and take everything after them.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function stripEchoedPrompt(output: string): string {
  log.debug(`stripEchoedPrompt: input length=${output.length}`);
  const markers = [
    "===EXECUTION_BLOCKER===",
    "verify your changes by running the project",
    "Focus only on THIS step.",
    "the LAST thing you write",
    "as the LAST thing you do",
  ];
  let bestIdx = -1;
  for (const marker of markers) {
    const idx = output.indexOf(marker);
    if (idx > bestIdx) {
      const lineEnd = output.indexOf("\n", idx + marker.length);
      if (lineEnd > bestIdx) bestIdx = lineEnd;
    }
  }
  if (bestIdx > 0 && bestIdx < output.length - 100) {
    const result = output.slice(bestIdx).trim();
    log.debug(`stripEchoedPrompt: marker-based strip, output length=${result.length}`);
    return result;
  }
  const cutoff = Math.floor(output.length * 0.4);
  const result = output.slice(cutoff).trim();
  log.debug(`stripEchoedPrompt: fallback strip at 40%, output length=${result.length}`);
  return result;
}


/**
 * Extract the task completion summary from between ===TASK_COMPLETE=== and ===END_TASK=== markers.
 * Uses lastIndexOf to find the LAST occurrence (in case the echoed prompt wasn't fully stripped).
 * Returns null if markers not found, allowing fallback to the existing tail-based approach.
 */
function extractTaskCompleteSummary(output: string): string | null {
  const startMarker = "===TASK_COMPLETE===";
  const endMarker = "===END_TASK===";
  const startIdx = output.lastIndexOf(startMarker);
  if (startIdx === -1) return null;
  const endIdx = output.indexOf(endMarker, startIdx);
  if (endIdx === -1) return null;
  const content = output.slice(startIdx + startMarker.length, endIdx).trim();
  return content.length > 0 ? content : null;
}

async function generateArtifact(
  blueprintId: string,
  nodeId: string,
  executionOutput: string,
  cwd?: string,
  taskSummaryFromDb?: string,
): Promise<void> {
  log.debug(`Generating artifact for node ${nodeId}, output length: ${executionOutput.length}`);
  // Prefer DB-stored task summary (API callback), then marker-based extraction (deprecated),
  // then fall back to last 4000 chars of output
  const taskSummary = taskSummaryFromDb
    || extractTaskCompleteSummary(executionOutput)
    || null;
  const tail = taskSummary
    ? taskSummary
    : (executionOutput.length > 4000 ? executionOutput.slice(-4000) : executionOutput);
  const summaryPrompt = `Here is the output from a coding step:\n\n---\n${tail}\n---\n\n${ARTIFACT_PROMPT}`;

  let summary: string;
  try {
    summary = await runClaude(summaryPrompt, cwd);
  } catch {
    // Fallback: use last 500 chars of the response (not the prompt)
    summary = tail.slice(-500);
  }

  // Strip anything before the "**What was done:**" marker (echoed prompt, preamble, etc.)
  const marker = "**What was done:**";
  const markerIdx = summary.indexOf(marker);
  if (markerIdx > 0) {
    summary = summary.slice(markerIdx);
  }

  // Find downstream nodes that depend on this node
  const blueprint = getBlueprint(blueprintId);
  const dependents = blueprint?.nodes.filter(n => n.dependencies.includes(nodeId)) ?? [];

  if (dependents.length === 0) {
    // No downstream nodes — create a single artifact for audit/output purposes
    createArtifact(blueprintId, nodeId, "handoff_summary", summary);
  } else {
    // Create one artifact per dependent with targetNodeId set
    for (const dep of dependents) {
      createArtifact(blueprintId, nodeId, "handoff_summary", summary, dep.id);
    }
  }
}

// ─── Post-completion evaluation & graph mutations ────────────

export interface GraphMutation {
  action: "INSERT_BETWEEN" | "ADD_SIBLING";
  new_node: {
    title: string;
    description: string;
  };
}

export interface CompletionEvaluation {
  evaluation: string;
  status: "COMPLETE" | "NEEDS_REFINEMENT" | "HAS_BLOCKER";
  mutations: GraphMutation[];
}

export interface EvaluationAppliedResult {
  evaluation: CompletionEvaluation;
  createdNodes: MacroNode[];
  rewiredDependencies: { nodeId: string; oldDeps: string[]; newDeps: string[] }[];
}

function buildEvaluationPrompt(
  blueprint: Blueprint,
  node: MacroNode,
  artifactContent: string,
  dependents: MacroNode[],
  blueprintId: string,
  nodeId: string,
): string {
  const apiBase = getApiBase();
  const authParam = getAuthParam();
  const callbackUrl = `${apiBase}/api/blueprints/${blueprintId}/nodes/${nodeId}/evaluation-callback?${authParam}`;

  let prompt = `You are evaluating whether a completed development task needs follow-up work.

## Completed Task
- Title: ${node.title}
- Description: ${node.description || "(none)"}

## Handoff Summary
${artifactContent}

## Blueprint Context
- Blueprint: "${blueprint.title}"
${blueprint.description ? `- Description: ${blueprint.description}` : ""}`;

  if (dependents.length > 0) {
    prompt += `\n\n## Downstream Tasks (depend on this completed task):\n`;
    for (const dep of dependents) {
      prompt += `- "${dep.title}": ${dep.description?.slice(0, 200) || "(no description)"}\n`;
    }
  }

  prompt += `

## Instructions
Evaluate the completion based on the handoff summary. Determine one of three outcomes:

1. **COMPLETE** — Task is fully done. All stated goals achieved. No gaps.
2. **NEEDS_REFINEMENT** — Task mostly done but something concrete was missed/skipped (e.g., missing validation, incomplete error handling, untested edge case). A follow-up node should be inserted BETWEEN this completed node and its downstream dependents.
3. **HAS_BLOCKER** — An external dependency blocks progress (e.g., needs human credentials, external API key, manual approval). A sibling blocker node should be created.

IMPORTANT: Be conservative. Most tasks ARE complete. Only flag NEEDS_REFINEMENT for specific, concrete gaps that would cause downstream tasks to fail or result in broken functionality. Do NOT flag stylistic preferences, nice-to-haves, or minor improvements.

After evaluating, call the evaluation callback endpoint using curl with your result:

curl -s -X POST '${callbackUrl}' -H 'Content-Type: application/json' -d '<JSON_BODY>'

Where <JSON_BODY> is one of:

For COMPLETE:
{"status": "COMPLETE", "evaluation": "Brief assessment", "mutations": []}

For NEEDS_REFINEMENT:
{"status": "NEEDS_REFINEMENT", "evaluation": "Missing password strength validation", "mutations": [{"action": "INSERT_BETWEEN", "new_node": {"title": "Add password validation", "description": "Detailed description..."}}]}

For HAS_BLOCKER:
{"status": "HAS_BLOCKER", "evaluation": "Needs AWS credentials from ops team", "mutations": [{"action": "ADD_SIBLING", "new_node": {"title": "Waiting for AWS credentials", "description": "Contact ops team..."}}]}

Make ONE curl call with your evaluation result. Do not output anything else.`;
  return prompt;
}

/**
 * Apply graph mutations after completion evaluation.
 *
 * INSERT_BETWEEN: Creates a new node depending on completedNode,
 * then rewires all dependents to depend on the new node instead.
 *
 * ADD_SIBLING: Creates a blocked sibling node inheriting completedNode's
 * dependencies, and adds it as a dependency for all downstream nodes.
 */
export function applyGraphMutations(
  blueprintId: string,
  completedNodeId: string,
  evaluation: CompletionEvaluation,
  blueprint: Blueprint,
): { createdNodes: MacroNode[]; rewiredDependencies: { nodeId: string; oldDeps: string[]; newDeps: string[] }[] } {
  const completedNode = blueprint.nodes.find(n => n.id === completedNodeId);
  if (!completedNode) return { createdNodes: [], rewiredDependencies: [] };

  const dependents = blueprint.nodes.filter(n => n.dependencies.includes(completedNodeId));
  const createdNodes: MacroNode[] = [];
  const rewiredDependencies: { nodeId: string; oldDeps: string[]; newDeps: string[] }[] = [];

  for (const mutation of evaluation.mutations) {
    if (mutation.action === "INSERT_BETWEEN") {
      // Create new node depending on completedNode
      const newNode = createMacroNode(blueprintId, {
        title: mutation.new_node.title,
        description: mutation.new_node.description,
        order: completedNode.order + 1,
        dependencies: [completedNodeId],
      });
      createdNodes.push(newNode);

      // Rewire: each dependent that depended on completedNode now depends on newNode instead
      for (const dep of dependents) {
        const oldDeps = [...dep.dependencies];
        const newDeps = dep.dependencies.map(d => d === completedNodeId ? newNode.id : d);
        updateMacroNode(blueprintId, dep.id, { dependencies: newDeps });
        rewiredDependencies.push({ nodeId: dep.id, oldDeps, newDeps });
      }

      log.info(`INSERT_BETWEEN: Created node "${newNode.title}" (${newNode.id.slice(0, 8)}) between ${completedNodeId.slice(0, 8)} and ${dependents.length} dependent(s)`);

    } else if (mutation.action === "ADD_SIBLING") {
      // Create sibling node inheriting completedNode's dependencies
      const newNode = createMacroNode(blueprintId, {
        title: mutation.new_node.title,
        description: mutation.new_node.description,
        order: completedNode.order + 1,
        dependencies: [...completedNode.dependencies],
      });
      // Mark as blocked (needs human intervention)
      updateMacroNode(blueprintId, newNode.id, { status: "blocked" });
      createdNodes.push(newNode);

      // Add newNode as a dependency for all downstream dependents
      for (const dep of dependents) {
        if (!dep.dependencies.includes(newNode.id)) {
          const oldDeps = [...dep.dependencies];
          const newDeps = [...dep.dependencies, newNode.id];
          updateMacroNode(blueprintId, dep.id, { dependencies: newDeps });
          rewiredDependencies.push({ nodeId: dep.id, oldDeps, newDeps });
        }
      }

      log.info(`ADD_SIBLING: Created blocker node "${newNode.title}" (${newNode.id.slice(0, 8)}) as sibling of ${completedNodeId.slice(0, 8)}`);
    }
  }

  return { createdNodes, rewiredDependencies };
}

/**
 * Evaluate a completed node's handoff artifact and apply graph mutations if needed.
 * Called automatically after artifact generation in executeNodeInternal(),
 * or manually via the evaluate API endpoint.
 *
 * Returns the evaluation result and any mutations applied, or null if evaluation
 * was skipped or failed (failures are logged but don't affect node status).
 */
export async function evaluateNodeCompletion(
  blueprintId: string,
  nodeId: string,
  cwd?: string,
): Promise<EvaluationAppliedResult | null> {
  const blueprint = getBlueprint(blueprintId);
  if (!blueprint) return null;

  const node = blueprint.nodes.find(n => n.id === nodeId);
  if (!node || node.status !== "done") return null;

  // Get the latest output artifact
  const artifacts = getArtifactsForNode(nodeId, "output");
  if (artifacts.length === 0) {
    log.debug(`Skipping evaluation for node ${nodeId}: no output artifacts`);
    return null;
  }
  const latestArtifact = artifacts[artifacts.length - 1];

  // Find downstream dependents
  const dependents = blueprint.nodes.filter(n => n.dependencies.includes(nodeId));

  // Build evaluation prompt (includes callback URL — Claude calls endpoint directly)
  const prompt = buildEvaluationPrompt(blueprint, node, latestArtifact.content, dependents, blueprintId, nodeId);

  // Call Claude in interactive mode — evaluation result is applied via the callback endpoint
  const evalBefore = new Date();
  try {
    await runClaudeInteractiveGen(prompt, cwd);
  } catch (err) {
    log.error(`Evaluation Claude call failed for node ${nodeId.slice(0, 8)}: ${err instanceof Error ? err.message : err}`);
    return null;
  }

  // Capture the evaluation session
  if (cwd) {
    const evalSessionId = detectNewSession(cwd, evalBefore);
    if (evalSessionId) {
      const now = new Date().toISOString();
      createRelatedSession(nodeId, blueprintId, evalSessionId, "evaluate", evalBefore.toISOString(), now);
      log.debug(`Captured evaluate session ${evalSessionId.slice(0, 8)} for node ${nodeId.slice(0, 8)}`);
    }
  }

  log.info(`Evaluation for node ${nodeId.slice(0, 8)} "${node.title}" completed (result applied via callback)`);
  return null;
}

// ─── Node execution ─────────────────────────────────────────

export async function executeNode(
  blueprintId: string,
  nodeId: string,
): Promise<NodeExecution> {
  // Only mark as queued and add pending task if not already queued (e.g., by executeAllNodes pre-marking)
  const bp = getBlueprint(blueprintId);
  const existing = bp?.nodes.find((n) => n.id === nodeId);
  if (!existing || existing.status !== "queued") {
    updateMacroNode(blueprintId, nodeId, { status: "queued" });
    addPendingTask(blueprintId, { type: "run", nodeId, queuedAt: new Date().toISOString() });
  }

  return enqueueBlueprintTask(blueprintId, async () => {
    removePendingTask(blueprintId, nodeId, "run");
    return executeNodeInternal(blueprintId, nodeId);
  }, nodeId);
}

async function executeNodeInternal(
  blueprintId: string,
  nodeId: string,
): Promise<NodeExecution> {
  const blueprint = getBlueprint(blueprintId);
  if (!blueprint) throw new Error("Blueprint not found");

  const node = blueprint.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error("Node not found");

  log.debug(`Starting node execution: nodeId=${nodeId}, blueprintId=${blueprintId}, title="${node.title}"`);

  if (node.status !== "pending" && node.status !== "failed" && node.status !== "queued") {
    throw new Error(`Node status is "${node.status}", must be "pending", "failed", or "queued" to run`);
  }

  // Check dependencies
  for (const depId of node.dependencies) {
    const depNode = blueprint.nodes.find((n) => n.id === depId);
    if (!depNode || (depNode.status !== "done" && depNode.status !== "skipped")) {
      throw new Error(`Dependency "${depNode?.title ?? depId}" is not done/skipped (status: ${depNode?.status ?? "missing"})`);
    }
  }

  // Collect input artifacts from explicit dependency nodes only
  const inputArtifacts: { node: MacroNode; artifact: Artifact }[] = [];
  for (const depId of node.dependencies) {
    const depNode = blueprint.nodes.find((n) => n.id === depId)!;
    const arts = getArtifactsForNode(depId, "output");
    if (arts.length > 0) {
      inputArtifacts.push({ node: depNode, artifact: arts[arts.length - 1] });
    }
  }

  // Update statuses — check execution history for retry detection
  // (node.status may be "queued" by the time we get here)
  const hasFailedExecution = node.executions.some((e) => e.status === "failed");
  const isRetry = hasFailedExecution;
  updateMacroNode(blueprintId, nodeId, { status: "running", error: "" });
  updateBlueprint(blueprintId, { status: "running" });

  // Create execution record first (buildNodePrompt needs the execution ID for callback URLs)
  const execution = createExecution(
    nodeId,
    blueprintId,
    undefined,
    isRetry ? "retry" : "primary",
  );

  // Build prompt (requires execution ID for API callback URLs)
  const prompt = buildNodePrompt(blueprint, node, inputArtifacts, execution.id);
  log.debug(`Built prompt for node ${nodeId}: length=${prompt.length}, inputArtifacts=${inputArtifacts.length}`);

  const startTime = Date.now();
  const beforeTimestamp = new Date();

  // Start background polling for the session file while Claude runs.
  // The CLI creates a JSONL file at the start; detecting it early lets the
  // frontend show progress during execution instead of only after completion.
  let sessionId: string | undefined;
  let sessionPollTimer: ReturnType<typeof setInterval> | null = null;

  if (blueprint.projectCwd) {
    const pollCwd = blueprint.projectCwd;
    sessionPollTimer = setInterval(() => {
      if (sessionId) return; // already found
      const detected = detectNewSession(pollCwd, beforeTimestamp);
      if (detected) {
        sessionId = detected;
        log.debug(`Session detected during poll: sessionId=${detected}, nodeId=${nodeId}`);
        syncSession(detected);
        updateExecution(execution.id, { sessionId: detected });
        if (sessionPollTimer) {
          clearInterval(sessionPollTimer);
          sessionPollTimer = null;
        }
      }
    }, 3000);
  }

  try {
    const output = await runClaude(prompt, blueprint.projectCwd, (pid) => {
      log.debug(`CLI process spawned: pid=${pid}, executionId=${execution.id.slice(0, 8)}`);
      // Store CLI PID in execution record for liveness tracking across restarts
      updateExecution(execution.id, { cliPid: pid });
    });

    // Stop session polling if still active
    if (sessionPollTimer) {
      clearInterval(sessionPollTimer);
      sessionPollTimer = null;
    }

    const elapsed = (Date.now() - startTime) / 60_000;

    // Final session detection attempt (in case polling missed it)
    if (!sessionId && blueprint.projectCwd) {
      const detected = detectNewSession(blueprint.projectCwd, beforeTimestamp);
      if (detected) {
        sessionId = detected;
        syncSession(detected);
      }
    }

    // Re-read execution from DB to check for API callback data (blocker_info, task_summary, reported_status)
    const updatedExec = getExecution(execution.id);
    const dbBlockerInfo = updatedExec?.blockerInfo;
    const dbTaskSummary = updatedExec?.taskSummary;
    const dbReportedStatus = updatedExec?.reportedStatus;
    const dbReportedReason = updatedExec?.reportedReason;

    // ── Authoritative status: if Claude explicitly reported status via API callback, use it ──
    if (dbReportedStatus) {
      log.info(`Node ${nodeId.slice(0, 8)} reported status via API: ${dbReportedStatus}${dbReportedReason ? ` (reason: ${dbReportedReason.slice(0, 100)})` : ""}`);

      if (dbReportedStatus === "done") {
        const taskCompleteSummary = dbTaskSummary || extractTaskCompleteSummary(output) || null;
        const outputSummary = taskCompleteSummary
          ? taskCompleteSummary.slice(0, 2000)
          : output.slice(-2000);

        updateExecution(execution.id, {
          status: "done",
          outputSummary,
          completedAt: new Date().toISOString(),
          ...(sessionId ? { sessionId } : {}),
        });
        updateMacroNode(blueprintId, nodeId, {
          status: "done",
          actualMinutes: Math.round(elapsed * 10) / 10,
        });

        await generateArtifact(blueprintId, nodeId, output, blueprint.projectCwd, dbTaskSummary ?? undefined);
        try {
          await evaluateNodeCompletion(blueprintId, nodeId, blueprint.projectCwd);
        } catch (evalErr) {
          log.error(`Post-completion evaluation failed for node ${nodeId.slice(0, 8)}: ${evalErr instanceof Error ? evalErr.message : evalErr}`);
        }
        return updateExecution(execution.id, {})!;
      }

      if (dbReportedStatus === "failed") {
        const reason = dbReportedReason || "Task reported as failed by Claude";
        updateExecution(execution.id, {
          status: "failed",
          outputSummary: reason,
          failureReason: "error",
          completedAt: new Date().toISOString(),
          ...(sessionId ? { sessionId } : {}),
        });
        updateMacroNode(blueprintId, nodeId, {
          status: "failed",
          error: reason,
          actualMinutes: Math.round(elapsed * 10) / 10,
        });
        return updateExecution(execution.id, {})!;
      }

      if (dbReportedStatus === "blocked") {
        const reason = dbReportedReason || "Task reported as blocked by Claude";
        updateExecution(execution.id, {
          status: "done",
          outputSummary: `BLOCKER: ${reason}\n\n${output.slice(-1500)}`,
          completedAt: new Date().toISOString(),
          ...(sessionId ? { sessionId } : {}),
        });
        updateMacroNode(blueprintId, nodeId, {
          status: "blocked",
          error: `Blocker: ${reason}`,
          actualMinutes: Math.round(elapsed * 10) / 10,
        });
        await generateArtifact(blueprintId, nodeId, output, blueprint.projectCwd);
        return updateExecution(execution.id, {})!;
      }
    }

    // ── Fallback: no reported_status — use inference logic for backward compatibility ──

    // Check for blocker: prefer DB callback, fall back to output marker parsing (deprecated)
    let blockerInfo: string | null = null;
    if (dbBlockerInfo) {
      // Blocker reported via API callback — no template echo issues
      try {
        const parsed = JSON.parse(dbBlockerInfo);
        blockerInfo = `[${parsed.type}] ${parsed.description}. Suggestion: ${parsed.suggestion}`;
      } catch {
        blockerInfo = dbBlockerInfo;
      }
    } else {
      // Fallback: legacy marker-based detection (deprecated)
      const blockerMatch = output.match(/^===EXECUTION_BLOCKER===\s*\n([\s\S]*?)$/m)
        || output.match(/^---BLOCKER---\s*\n([\s\S]*?)$/m);
      if (blockerMatch) {
        const blockerText = blockerMatch[1].trim();
        let isRealBlocker = true;
        try {
          const parsed = JSON.parse(blockerText);
          const templatePatterns = [
            /^missing_dependency\s*\|/,
            /^<one of/,
            /^<describe/,
            /What is blocking you/,
            /What the human could do/,
          ];
          const allValues = [parsed.type, parsed.description, parsed.suggestion].filter(Boolean).join(" ");
          if (templatePatterns.some(p => p.test(allValues))) {
            isRealBlocker = false;
          }
          if (isRealBlocker) {
            blockerInfo = `[${parsed.type}] ${parsed.description}. Suggestion: ${parsed.suggestion}`;
          }
        } catch {
          if (/missing_dependency\s*\|.*unclear_requirement/.test(blockerText) ||
              /What is blocking you/.test(blockerText)) {
            isRealBlocker = false;
          }
          if (isRealBlocker) {
            blockerInfo = blockerText;
          }
        }
        if (!isRealBlocker) {
          log.info(`Ignoring template blocker echo for node ${nodeId}`);
        }
      }
    }

    if (blockerInfo) {
      updateExecution(execution.id, {
        status: "done",
        outputSummary: `BLOCKER: ${blockerInfo}\n\n${output.slice(-1500)}`,
        completedAt: new Date().toISOString(),
        ...(sessionId ? { sessionId } : {}),
      });
      updateMacroNode(blueprintId, nodeId, {
        status: "blocked",
        error: `Blocker: ${blockerInfo}`,
        actualMinutes: Math.round(elapsed * 10) / 10,
      });

      await generateArtifact(blueprintId, nodeId, output, blueprint.projectCwd);
      return updateExecution(execution.id, {})!;
    }

    // Success — no blocker
    // Guard: if output is too short, Claude likely hung without doing real work
    if (output.length < 50) {
      const { reason, detail } = classifyHungFailure(sessionId);
      log.warn(`Short output for node ${nodeId.slice(0, 8)}: failureReason=${reason}, detail=${detail.slice(0, 100)}`);
      updateExecution(execution.id, {
        status: "failed",
        outputSummary: detail,
        failureReason: reason,
        completedAt: new Date().toISOString(),
        ...(sessionId ? { sessionId } : {}),
      });
      updateMacroNode(blueprintId, nodeId, {
        status: "failed",
        error: detail,
        actualMinutes: Math.round(elapsed * 10) / 10,
      });
      return updateExecution(execution.id, {})!;
    }

    // Prefer DB-stored task summary (via API callback), then marker-based extraction (deprecated),
    // then fall back to raw output tail
    const taskCompleteSummary = dbTaskSummary
      || extractTaskCompleteSummary(output)
      || null;
    const outputSummary = taskCompleteSummary
      ? taskCompleteSummary.slice(0, 2000)
      : output.slice(-2000);

    updateExecution(execution.id, {
      status: "done",
      outputSummary,
      completedAt: new Date().toISOString(),
      ...(sessionId ? { sessionId } : {}),
    });
    updateMacroNode(blueprintId, nodeId, {
      status: "done",
      actualMinutes: Math.round(elapsed * 10) / 10,
    });

    // Generate handoff artifact — pass DB task summary if available
    await generateArtifact(blueprintId, nodeId, output, blueprint.projectCwd, dbTaskSummary ?? undefined);

    // Evaluate completion and apply graph mutations if needed.
    // Runs after artifact generation so the evaluation has handoff context.
    // Failures are logged but don't affect the node's done status.
    try {
      await evaluateNodeCompletion(blueprintId, nodeId, blueprint.projectCwd);
    } catch (evalErr) {
      log.error(`Post-completion evaluation failed for node ${nodeId.slice(0, 8)}: ${evalErr instanceof Error ? evalErr.message : evalErr}`);
    }

    return updateExecution(execution.id, {})!;
  } catch (err) {
    // Stop session polling on error
    if (sessionPollTimer) {
      clearInterval(sessionPollTimer);
      sessionPollTimer = null;
    }

    const errorMsg = err instanceof Error ? err.message : String(err);
    const { reason, detail } = classifyFailure(errorMsg, undefined, sessionId);
    log.warn(`Node ${nodeId.slice(0, 8)} execution failed: failureReason=${reason}, detail=${detail.slice(0, 100)}`);

    updateExecution(execution.id, {
      status: "failed",
      outputSummary: detail,
      failureReason: reason,
      completedAt: new Date().toISOString(),
      ...(sessionId ? { sessionId } : {}),
    });
    updateMacroNode(blueprintId, nodeId, {
      status: "failed",
      error: detail,
    });

    return updateExecution(execution.id, {})!;
  } finally {
    // Store context health metrics from JSONL analysis (runs on both success and failure)
    if (sessionId) {
      storeContextHealth(execution.id, sessionId);
    }
  }
}

// ─── Session resumption ─────────────────────────────────────

export async function resumeNodeSession(
  blueprintId: string,
  nodeId: string,
  executionId: string,
): Promise<void> {
  const blueprint = getBlueprint(blueprintId);
  if (!blueprint) throw new Error("Blueprint not found");

  const node = blueprint.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error("Node not found");

  const failedExec = getExecution(executionId);
  if (!failedExec) throw new Error("Execution not found");
  if (!failedExec.sessionId) throw new Error("Execution has no session to resume");

  const resumeSessionId = failedExec.sessionId;

  log.info(`Resuming session ${resumeSessionId.slice(0, 8)} for node ${nodeId.slice(0, 8)} "${node.title}"`);

  // Mark node as running
  updateMacroNode(blueprintId, nodeId, { status: "running", error: "" });
  updateBlueprint(blueprintId, { status: "running" });

  // Create a new execution record of type "continuation"
  const execution = createExecution(nodeId, blueprintId, resumeSessionId, "continuation");

  const startTime = Date.now();
  const resumePrompt = `Continue where you left off. The previous session was interrupted. Complete the remaining work for: ${node.title}`;

  try {
    const output = await runClaudeResume(resumeSessionId, resumePrompt, blueprint.projectCwd, (pid) => {
      log.debug(`CLI resume process spawned: pid=${pid}, executionId=${execution.id.slice(0, 8)}`);
      updateExecution(execution.id, { cliPid: pid });
    });

    const elapsed = (Date.now() - startTime) / 60_000;

    // Sync the session to pick up new entries
    syncSession(resumeSessionId);

    // Re-read execution from DB to check for API callback data
    const updatedExec = getExecution(execution.id);
    const dbTaskSummary = updatedExec?.taskSummary;
    const dbReportedStatus = updatedExec?.reportedStatus;
    const dbReportedReason = updatedExec?.reportedReason;

    // ── Authoritative status: if Claude explicitly reported status via API callback, use it ──
    if (dbReportedStatus) {
      log.info(`Resumed node ${nodeId.slice(0, 8)} reported status via API: ${dbReportedStatus}${dbReportedReason ? ` (reason: ${dbReportedReason.slice(0, 100)})` : ""}`);

      if (dbReportedStatus === "done") {
        const taskCompleteSummary = dbTaskSummary || extractTaskCompleteSummary(output) || null;
        const outSummary = taskCompleteSummary
          ? taskCompleteSummary.slice(0, 2000)
          : output.slice(-2000);
        updateExecution(execution.id, {
          status: "done",
          outputSummary: outSummary,
          completedAt: new Date().toISOString(),
        });
        updateMacroNode(blueprintId, nodeId, {
          status: "done",
          actualMinutes: Math.round(elapsed * 10) / 10,
        });
        await generateArtifact(blueprintId, nodeId, output, blueprint.projectCwd, dbTaskSummary ?? undefined);
        try {
          await evaluateNodeCompletion(blueprintId, nodeId, blueprint.projectCwd);
        } catch (evalErr) {
          log.error(`Post-resume evaluation failed for node ${nodeId.slice(0, 8)}: ${evalErr instanceof Error ? evalErr.message : evalErr}`);
        }
        return;
      }

      if (dbReportedStatus === "failed") {
        const reason = dbReportedReason || "Task reported as failed by Claude";
        updateExecution(execution.id, {
          status: "failed",
          outputSummary: reason,
          failureReason: "error",
          completedAt: new Date().toISOString(),
        });
        updateMacroNode(blueprintId, nodeId, {
          status: "failed",
          error: reason,
          actualMinutes: Math.round(elapsed * 10) / 10,
        });
        return;
      }

      if (dbReportedStatus === "blocked") {
        const reason = dbReportedReason || "Task reported as blocked by Claude";
        updateExecution(execution.id, {
          status: "done",
          outputSummary: `BLOCKER: ${reason}\n\n${output.slice(-1500)}`,
          completedAt: new Date().toISOString(),
        });
        updateMacroNode(blueprintId, nodeId, {
          status: "blocked",
          error: `Blocker: ${reason}`,
          actualMinutes: Math.round(elapsed * 10) / 10,
        });
        await generateArtifact(blueprintId, nodeId, output, blueprint.projectCwd);
        return;
      }
    }

    // ── Fallback: no reported_status — use inference logic for backward compatibility ──

    // Guard: if output is too short, Claude likely hung
    if (output.length < 50) {
      const { reason, detail } = classifyHungFailure(resumeSessionId);
      log.warn(`Short resume output for node ${nodeId.slice(0, 8)}: failureReason=${reason}`);
      updateExecution(execution.id, {
        status: "failed",
        outputSummary: detail,
        failureReason: reason,
        completedAt: new Date().toISOString(),
      });
      updateMacroNode(blueprintId, nodeId, {
        status: "failed",
        error: detail,
        actualMinutes: Math.round(elapsed * 10) / 10,
      });
      return;
    }

    // Success
    const taskCompleteSummary = dbTaskSummary
      || extractTaskCompleteSummary(output)
      || null;
    const outputSummary = taskCompleteSummary
      ? taskCompleteSummary.slice(0, 2000)
      : output.slice(-2000);

    updateExecution(execution.id, {
      status: "done",
      outputSummary,
      completedAt: new Date().toISOString(),
    });
    updateMacroNode(blueprintId, nodeId, {
      status: "done",
      actualMinutes: Math.round(elapsed * 10) / 10,
    });

    // Generate handoff artifact
    await generateArtifact(blueprintId, nodeId, output, blueprint.projectCwd, dbTaskSummary ?? undefined);

    // Evaluate completion
    try {
      await evaluateNodeCompletion(blueprintId, nodeId, blueprint.projectCwd);
    } catch (evalErr) {
      log.error(`Post-resume evaluation failed for node ${nodeId.slice(0, 8)}: ${evalErr instanceof Error ? evalErr.message : evalErr}`);
    }

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const { reason, detail } = classifyFailure(errorMsg, undefined, resumeSessionId);
    log.warn(`Node ${nodeId.slice(0, 8)} resume failed: failureReason=${reason}`);
    updateExecution(execution.id, {
      status: "failed",
      outputSummary: detail,
      failureReason: reason,
      completedAt: new Date().toISOString(),
    });
    updateMacroNode(blueprintId, nodeId, {
      status: "failed",
      error: detail,
    });
  } finally {
    // Store context health metrics from JSONL analysis
    storeContextHealth(execution.id, resumeSessionId);
  }
}

// ─── Sequential execution ───────────────────────────────────

export async function executeNextNode(
  blueprintId: string,
): Promise<NodeExecution | null> {
  const blueprint = getBlueprint(blueprintId);
  if (!blueprint) throw new Error("Blueprint not found");

  // Find first pending/queued node whose dependencies are all done or skipped
  const candidate = blueprint.nodes.find((node) => {
    if (node.status !== "pending" && node.status !== "queued") return false;
    return node.dependencies.every((depId) => {
      const dep = blueprint.nodes.find((n) => n.id === depId);
      return dep?.status === "done" || dep?.status === "skipped";
    });
  });

  if (!candidate) {
    // Check if all nodes are done
    const allDone = blueprint.nodes.every((n) => n.status === "done" || n.status === "skipped");
    if (allDone) {
      updateBlueprint(blueprintId, { status: "done" });
    }
    return null;
  }

  return executeNode(blueprintId, candidate.id);
}

export async function executeAllNodes(
  blueprintId: string,
): Promise<void> {
  updateBlueprint(blueprintId, { status: "running" });

  // Pre-mark all eligible pending nodes as "queued" so the frontend reflects the full execution plan.
  // A node is eligible if all its dependencies are already done/skipped or are themselves
  // pending/queued (i.e., will be satisfied by this RunAll chain). Nodes with failed/blocked
  // dependencies are left as pending since they can't run.
  const blueprint = getBlueprint(blueprintId);
  const preQueuedNodeIds: string[] = [];
  if (blueprint) {
    for (const node of blueprint.nodes) {
      if (node.status !== "pending") continue;
      const allDepsEligible = node.dependencies.every((depId) => {
        const dep = blueprint.nodes.find((n) => n.id === depId);
        if (!dep) return false;
        const s = dep.status;
        return s === "done" || s === "skipped" || s === "pending" || s === "queued";
      });
      if (allDepsEligible) {
        updateMacroNode(blueprintId, node.id, { status: "queued" });
        addPendingTask(blueprintId, { type: "run", nodeId: node.id, queuedAt: new Date().toISOString() });
        preQueuedNodeIds.push(node.id);
      }
    }
  }

  while (true) {
    const execution = await executeNextNode(blueprintId);
    if (!execution) break;

    // Remove the node from pre-queued tracking since it has been picked up
    const idx = preQueuedNodeIds.indexOf(execution.nodeId);
    if (idx >= 0) preQueuedNodeIds.splice(idx, 1);

    // Stop on failure — reset remaining pre-queued nodes back to pending
    if (execution.status === "failed") {
      for (const remainingNodeId of preQueuedNodeIds) {
        updateMacroNode(blueprintId, remainingNodeId, { status: "pending" });
        removePendingTask(blueprintId, remainingNodeId, "run");
      }
      preQueuedNodeIds.length = 0;
      updateBlueprint(blueprintId, { status: "failed" });
      break;
    }
  }
}

// ─── Startup recovery ───────────────────────────────────────

/**
 * Re-enqueue nodes that were left in "queued" status from a previous server process.
 * The in-memory queue is lost on restart, so we need to re-enqueue them.
 * Called once from index.ts after server initialization.
 */
export function requeueOrphanedNodes(): void {
  const orphaned = getOrphanedQueuedNodes();
  if (orphaned.length === 0) return;

  log.info(`Re-enqueueing ${orphaned.length} orphaned queued node(s)...`);

  for (const { id: nodeId, blueprintId } of orphaned) {
    // The node is already "queued" in SQLite — just re-add to the in-memory queue
    addPendingTask(blueprintId, { type: "run", nodeId, queuedAt: new Date().toISOString() });

    enqueueBlueprintTask(blueprintId, async () => {
      removePendingTask(blueprintId, nodeId, "run");
      return executeNodeInternal(blueprintId, nodeId);
    }, nodeId).catch((err) => {
      log.error(`Re-queued node ${nodeId} failed: ${err instanceof Error ? err.message : err}`);
    });
  }
}

// ─── Smart execution recovery (resilient to server restarts) ─

/**
 * Check if a process is still alive by sending signal 0.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the mtime (in ms since epoch) of a session's JSONL file.
 * Returns null if the file doesn't exist.
 */
function getSessionFileMtime(projectCwd: string, sessionId: string): number | null {
  const encodedDir = projectCwd.replace(/\//g, "-");
  const filePath = join(CLAUDE_PROJECTS_DIR, encodedDir, `${sessionId}.jsonl`);
  try {
    return statSync(filePath).mtime.getTime();
  } catch {
    return null;
  }
}

// Recovery monitor state
interface RecoveryEntry {
  executionId: string;
  nodeId: string;
  blueprintId: string;
  projectCwd: string;
  sessionId: string | null;
  cliPid: number | null;
  startedAt: string;
  lastMtime: number | null;
  checkCount: number;
}

const recoveryEntries = new Map<string, RecoveryEntry>();
let recoveryTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Smart recovery for stale executions on server startup.
 * Instead of blindly marking all running executions as failed,
 * checks if the CLI process or session file is still active.
 *
 * - Still-alive executions: monitored in background until they finish
 * - Dead executions with a completed session: recovered immediately
 * - Truly dead executions: marked as failed
 *
 * Also checks recently-failed "server restart" executions in case
 * a previous restart already incorrectly marked them.
 */
export function smartRecoverStaleExecutions(): void {
  const staleExecs = getStaleRunningExecutions();
  const recentFailed = getRecentRestartFailedExecutions(10); // 10 min lookback

  if (staleExecs.length === 0 && recentFailed.length === 0) {
    recoveryLog.info("No stale executions found.");
    return;
  }

  const skipIds = new Set<string>();

  // ── Check each currently-running execution ──
  for (const exec of staleExecs) {
    if (!exec.projectCwd) continue; // can't check without project path

    const pidAlive = exec.cliPid ? isProcessAlive(exec.cliPid) : false;

    // Try to detect session if not already linked
    let sessionId = exec.sessionId;
    if (!sessionId) {
      const detected = detectNewSession(exec.projectCwd, new Date(exec.startedAt));
      if (detected) {
        sessionId = detected;
        updateExecution(exec.id, { sessionId: detected });
      }
    }

    // Check session file activity
    let sessionActive = false;
    let mtime: number | null = null;
    if (sessionId) {
      mtime = getSessionFileMtime(exec.projectCwd, sessionId);
      if (mtime) {
        sessionActive = (Date.now() - mtime) < 60_000; // active within last 60s
      }
    }

    if (pidAlive || sessionActive) {
      // Still alive — defer to background monitor
      skipIds.add(exec.id);
      recoveryEntries.set(exec.id, {
        executionId: exec.id,
        nodeId: exec.nodeId,
        blueprintId: exec.blueprintId,
        projectCwd: exec.projectCwd,
        sessionId,
        cliPid: exec.cliPid,
        startedAt: exec.startedAt,
        lastMtime: mtime,
        checkCount: 0,
      });
      recoveryLog.info(`Execution ${exec.id.slice(0, 8)} still alive (pid=${pidAlive}, session=${sessionActive}), monitoring...`);
    } else if (sessionId && mtime) {
      // Process dead, session exists but stopped — likely completed
      skipIds.add(exec.id);
      finalizeRecoveredExecution(exec.id, exec.nodeId, exec.blueprintId, sessionId, exec.projectCwd, exec.startedAt);
    }
    // else: truly dead, let recoverStaleExecutions mark it as failed
  }

  // ── Check recently-failed "server restart" executions ──
  for (const exec of recentFailed) {
    if (!exec.projectCwd) continue;

    let sessionId = exec.sessionId;
    if (!sessionId) {
      const detected = detectNewSession(exec.projectCwd, new Date(exec.startedAt));
      if (detected) {
        sessionId = detected;
        // Don't claim a session that belongs to another execution
        const existing = getExecutionBySession(detected);
        if (existing && existing.id !== exec.id) continue;
      }
    }

    if (!sessionId) continue;

    const mtime = getSessionFileMtime(exec.projectCwd, sessionId);
    if (mtime && (Date.now() - mtime) < 60_000) {
      // Session still active — revert to running and monitor
      recoveryEntries.set(exec.id, {
        executionId: exec.id,
        nodeId: exec.nodeId,
        blueprintId: exec.blueprintId,
        projectCwd: exec.projectCwd,
        sessionId,
        cliPid: exec.cliPid,
        startedAt: exec.startedAt,
        lastMtime: mtime,
        checkCount: 0,
      });
      updateExecution(exec.id, { status: "running", sessionId });
      updateMacroNode(exec.blueprintId, exec.nodeId, { status: "running", error: "" });
      recoveryLog.info(`Reverting false-failed execution ${exec.id.slice(0, 8)} — session still active`);
    } else if (mtime) {
      // Session exists but stopped — recover immediately
      finalizeRecoveredExecution(exec.id, exec.nodeId, exec.blueprintId, sessionId, exec.projectCwd, exec.startedAt);
    }
  }

  // Mark remaining stale executions as truly failed
  recoverStaleExecutions(skipIds);

  // Start background monitor if we have alive executions
  if (recoveryEntries.size > 0) {
    startRecoveryMonitor();
  }
}

/**
 * Finalize a recovered execution: mark as done, link session, generate artifact.
 */
function finalizeRecoveredExecution(
  executionId: string,
  nodeId: string,
  blueprintId: string,
  sessionId: string,
  projectCwd: string,
  startedAt: string,
): void {
  recoveryLog.info(`Finalizing execution ${executionId.slice(0, 8)} with session ${sessionId.slice(0, 8)}`);

  try { syncSession(sessionId); } catch { /* ignore */ }

  const elapsed = (Date.now() - new Date(startedAt).getTime()) / 60_000;

  updateExecution(executionId, {
    status: "done",
    sessionId,
    completedAt: new Date().toISOString(),
    outputSummary: "Recovered after server restart — session completed successfully",
  });

  updateMacroNode(blueprintId, nodeId, {
    status: "done",
    error: "",
    actualMinutes: Math.round(elapsed * 10) / 10,
  });

  // Try to generate handoff artifact from the session's JSONL content
  generateArtifactFromSession(blueprintId, nodeId, projectCwd, sessionId).catch(err => {
    recoveryLog.error(`Artifact generation failed for node ${nodeId.slice(0, 8)}: ${err instanceof Error ? err.message : err}`);
  });
}

/**
 * Read a session's JSONL file and extract the last assistant response,
 * then use it to generate a handoff artifact.
 */
async function generateArtifactFromSession(
  blueprintId: string,
  nodeId: string,
  projectCwd: string,
  sessionId: string,
): Promise<void> {
  const encodedDir = projectCwd.replace(/\//g, "-");
  const filePath = join(CLAUDE_PROJECTS_DIR, encodedDir, `${sessionId}.jsonl`);

  let lastAssistantContent = "";
  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.trim().split("\n");

    // Find the last substantial assistant message
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type === "assistant" && entry.message?.content) {
          const textBlocks = Array.isArray(entry.message.content)
            ? entry.message.content
                .filter((b: { type: string }) => b.type === "text")
                .map((b: { text: string }) => b.text)
                .join("\n")
            : String(entry.message.content);
          if (textBlocks.length > 100) {
            lastAssistantContent = textBlocks;
            break;
          }
        }
      } catch { continue; }
    }
  } catch (err) {
    recoveryLog.error(`Could not read session JSONL for artifact: ${err instanceof Error ? err.message : err}`);
    return;
  }

  if (lastAssistantContent.length > 0) {
    await generateArtifact(blueprintId, nodeId, lastAssistantContent, projectCwd);
  }
}

/**
 * Mark a monitored execution as failed (process dead, no session found).
 */
function markRecoveryFailed(entry: RecoveryEntry): void {
  const now = new Date().toISOString();
  updateExecution(entry.executionId, {
    status: "failed",
    completedAt: now,
    outputSummary: "Server restarted while execution was running",
  });
  updateMacroNode(entry.blueprintId, entry.nodeId, {
    status: "failed",
    error: "Execution interrupted by server restart",
  });
}

/**
 * Background monitor that periodically checks still-alive executions.
 * When a session stops growing and the process is dead, finalizes recovery.
 * Gives up after 45 minutes from execution start time.
 */
function startRecoveryMonitor(): void {
  if (recoveryTimer) return;

  recoveryLog.info(`Starting background monitor for ${recoveryEntries.size} execution(s)`);

  recoveryTimer = setInterval(() => {
    if (recoveryEntries.size === 0) {
      clearInterval(recoveryTimer!);
      recoveryTimer = null;
      recoveryLog.info("All monitored executions resolved, stopping monitor");
      return;
    }

    for (const [execId, entry] of recoveryEntries) {
      entry.checkCount++;

      // Safety limit: 45 min from execution start (30 min timeout + 15 min grace)
      const elapsedMs = Date.now() - new Date(entry.startedAt).getTime();
      if (elapsedMs > 45 * 60 * 1000) {
        recoveryLog.warn(`Execution ${execId.slice(0, 8)} timed out after ${Math.round(elapsedMs / 60000)}min`);
        if (entry.sessionId) {
          finalizeRecoveredExecution(execId, entry.nodeId, entry.blueprintId, entry.sessionId, entry.projectCwd, entry.startedAt);
        } else {
          markRecoveryFailed(entry);
        }
        recoveryEntries.delete(execId);
        continue;
      }

      // Check PID liveness
      const pidAlive = entry.cliPid ? isProcessAlive(entry.cliPid) : false;

      // Try to detect session if not found yet
      if (!entry.sessionId) {
        const detected = detectNewSession(entry.projectCwd, new Date(entry.startedAt));
        if (detected) {
          entry.sessionId = detected;
          try { syncSession(detected); } catch { /* ignore */ }
          updateExecution(execId, { sessionId: detected });
        }
      }

      // Check session file mtime
      let sessionActive = false;
      let currentMtime: number | null = null;
      if (entry.sessionId) {
        currentMtime = getSessionFileMtime(entry.projectCwd, entry.sessionId);
        if (currentMtime) {
          sessionActive = (Date.now() - currentMtime) < 30_000; // active within 30s
        }
      }

      if (!pidAlive && !sessionActive) {
        // Both dead — finalize
        if (entry.sessionId) {
          finalizeRecoveredExecution(execId, entry.nodeId, entry.blueprintId, entry.sessionId, entry.projectCwd, entry.startedAt);
        } else {
          markRecoveryFailed(entry);
        }
        recoveryEntries.delete(execId);
      } else {
        entry.lastMtime = currentMtime;
      }
    }
  }, 10_000); // Check every 10 seconds
}
