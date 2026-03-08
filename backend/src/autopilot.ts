import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import {
  getBlueprint,
  getSuggestionsForNode,
  getInsightsForBlueprint,
  updateBlueprint,
  createMacroNode,
  updateMacroNode,
  reorderMacroNodes,
  markInsightRead,
  dismissInsight,
  markSuggestionUsed,
  getExecutionsForNode,
  getAutopilotLog,
  setAutopilotMemory,
  getAutopilotMemory,
  getUnacknowledgedMessages,
  createAutopilotMessage,
  getArtifactsForNode,
  clearBlueprintSuggestions,
  createBlueprintSuggestion,
  createSuggestion,
  createInsight,
} from "./plan-db.js";
import { CLAWUI_DB_DIR } from "./config.js";
import type {
  BlueprintStatus,
  MacroNodeStatus,
  InsightSeverity,
  NodeSuggestion,
  BlueprintInsight,
  MacroNode,
} from "./plan-db.js";
import {
  getQueueInfo,
  executeNodeDirect,
  resumeNodeSession,
  addPendingTask,
  removePendingTask,
  enqueueBlueprintTask,
} from "./plan-executor.js";
import type { PendingTask } from "./plan-executor.js";
import { getActiveRuntime } from "./agent-runtime.js";
import { coordinateBlueprint } from "./plan-coordinator.js";
// plan-operations.js imports removed — sub-agent AI operations (enrich, split,
// smart deps, reevaluate) are now handled by the autopilot via read tools + CRUD.
import { getDb } from "./db.js";
import { createLogger } from "./logger.js";

// Side-effect imports: ensure all runtimes are registered
import "./agent-claude.js";
import "./agent-pimono.js";
import "./agent-openclaw.js";
import "./agent-codex.js";

// Side-effect: auto-discovers and registers all roles
import "./roles/load-all-roles.js";
import { getAllRoles } from "./roles/role-registry.js";

const log = createLogger("autopilot");

// ─── Autopilot Memory Constants ──────────────────────────────

export const GLOBAL_MEMORY_PATH = path.join(CLAWUI_DB_DIR, "autopilot-strategy.md");
export const BLUEPRINT_MEMORY_MAX_CHARS = 2000;
export const GLOBAL_MEMORY_MAX_CHARS = 3000;
export const REFLECT_EVERY_N = 5;

// ─── Global Memory File Helpers ──────────────────────────────

export function readGlobalMemory(): string | null {
  if (!existsSync(GLOBAL_MEMORY_PATH)) return null;
  return readFileSync(GLOBAL_MEMORY_PATH, "utf-8");
}

export function writeGlobalMemory(content: string): void {
  const dir = path.dirname(GLOBAL_MEMORY_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(GLOBAL_MEMORY_PATH, content, "utf-8");
}

// ─── Tool Usage Stats ────────────────────────────────────────

/** All known autopilot tool names (derived from TOOL_DESCRIPTIONS). */
const ALL_TOOL_NAMES = [
  "run_node", "resume_node",
  "get_node_titles", "get_node_details", "get_node_handoff",
  "run_direct",
  "create_node", "update_node", "skip_node", "batch_create_nodes", "reorder_nodes",
  "coordinate", "convene",
  "create_insight", "create_node_suggestion", "create_blueprint_suggestion",
  "clear_blueprint_suggestions",
  "mark_insight_read", "dismiss_insight", "mark_suggestion_used",
  "batch_mark_suggestions_used", "batch_dismiss_insights",
  "pause",
];

export interface ToolUsageStats {
  totalIterations: number;
  actionCounts: Record<string, number>;
  successRate: Record<string, number>;
  neverUsedTools: string[];
  consecutiveRunNodeCount: number;
  averageIterationsBetweenNonRunActions: number;
}

/**
 * Compute tool usage statistics from the autopilot_log table.
 * Pure SQL computation — no LLM call needed.
 */
export function computeToolUsageStats(
  blueprintId: string,
  sinceIteration?: number,
): ToolUsageStats {
  const db = getDb();

  // Total iterations
  const iterationFilter = sinceIteration != null ? " AND iteration >= ?" : "";
  const iterationParams: unknown[] = sinceIteration != null
    ? [blueprintId, sinceIteration]
    : [blueprintId];

  const totalRow = db.prepare(
    `SELECT COUNT(*) as cnt FROM autopilot_log WHERE blueprint_id = ?${iterationFilter}`,
  ).get(...iterationParams) as { cnt: number } | undefined;
  const totalIterations = totalRow?.cnt ?? 0;

  // Action counts and success counts
  const rows = db.prepare(
    `SELECT action, COUNT(*) as cnt, SUM(CASE WHEN result NOT LIKE 'ERROR%' THEN 1 ELSE 0 END) as success_cnt
     FROM autopilot_log WHERE blueprint_id = ?${iterationFilter}
     GROUP BY action`,
  ).all(...iterationParams) as Array<{ action: string; cnt: number; success_cnt: number }>;

  const actionCounts: Record<string, number> = {};
  const successRate: Record<string, number> = {};
  const usedActions = new Set<string>();

  for (const row of rows) {
    actionCounts[row.action] = row.cnt;
    successRate[row.action] = row.cnt > 0 ? row.success_cnt / row.cnt : 0;
    usedActions.add(row.action);
  }

  // Never-used tools
  const neverUsedTools = ALL_TOOL_NAMES.filter((t) => !usedActions.has(t));

  // Consecutive run_node count at the end of the log
  const recentActions = db.prepare(
    `SELECT action FROM autopilot_log WHERE blueprint_id = ?${iterationFilter}
     ORDER BY iteration DESC, created_at DESC`,
  ).all(...iterationParams) as Array<{ action: string }>;

  let consecutiveRunNodeCount = 0;
  for (const row of recentActions) {
    if (row.action === "run_node") {
      consecutiveRunNodeCount++;
    } else {
      break;
    }
  }

  // Average iterations between non-run_node actions
  const allActions = db.prepare(
    `SELECT action, iteration FROM autopilot_log WHERE blueprint_id = ?${iterationFilter}
     ORDER BY iteration ASC, created_at ASC`,
  ).all(...iterationParams) as Array<{ action: string; iteration: number }>;

  let lastNonRunIteration: number | null = null;
  const gaps: number[] = [];
  for (const row of allActions) {
    if (row.action !== "run_node") {
      if (lastNonRunIteration !== null) {
        gaps.push(row.iteration - lastNonRunIteration);
      }
      lastNonRunIteration = row.iteration;
    }
  }
  const averageIterationsBetweenNonRunActions =
    gaps.length > 0 ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;

  return {
    totalIterations,
    actionCounts,
    successRate,
    neverUsedTools,
    consecutiveRunNodeCount,
    averageIterationsBetweenNonRunActions,
  };
}

// ─── Reflection Functions ───────────────────────────────────

/**
 * Per-blueprint reflection: analyze recent actions and update memory.
 * Non-fatal — on failure, logs warning and returns currentMemory unchanged.
 */
export async function reflectAndUpdateMemory(
  blueprintId: string,
  sinceIteration: number,
  currentIteration: number,
  currentMemory: string | null,
): Promise<string | null> {
  try {
    // Fetch recent log entries since last reflection
    const allLog = getAutopilotLog(blueprintId, 1000, 0);
    const recentLog = allLog.filter((e) => e.iteration > sinceIteration && e.iteration <= currentIteration);

    // Compute all-time tool stats
    const toolStats = computeToolUsageStats(blueprintId);

    // Build blueprint summary
    const blueprint = getBlueprint(blueprintId);
    const blueprintSummary = blueprint
      ? `Title: ${blueprint.title}\nDescription: ${blueprint.description}\nStatus: ${blueprint.status}\nNodes: ${blueprint.nodes.length} total (${blueprint.nodes.filter((n) => n.status === "done").length} done, ${blueprint.nodes.filter((n) => n.status === "failed").length} failed, ${blueprint.nodes.filter((n) => n.status === "skipped").length} skipped, ${blueprint.nodes.filter((n) => n.status === "pending").length} pending, ${blueprint.nodes.filter((n) => n.status === "running").length} running)`
      : `Blueprint ${blueprintId}`;

    // Format recent log as table
    let recentLogTable = "| Iter | Action | Result |\n|------|--------|--------|\n";
    for (const entry of recentLog) {
      const result = entry.result ? entry.result.slice(0, 80) : "—";
      recentLogTable += `| ${entry.iteration} | ${entry.action} | ${result} |\n`;
    }
    if (recentLog.length === 0) {
      recentLogTable += "| (no actions since last reflection) | | |\n";
    }

    // Format tool stats
    const statsLines: string[] = [];
    for (const [action, count] of Object.entries(toolStats.actionCounts)) {
      const rate = toolStats.successRate[action];
      statsLines.push(`- ${action}: ${count} uses, ${(rate * 100).toFixed(0)}% success`);
    }
    const toolStatsText = statsLines.length > 0 ? statsLines.join("\n") : "(no actions recorded yet)";

    // Build reflection prompt per spec section 5.4
    const prompt = `You are reflecting on an autopilot run to update its memory.

## Blueprint Context
${blueprintSummary}

## Recent Actions (since last reflection)
${recentLogTable}

## Tool Usage Statistics (all-time for this blueprint)
Total iterations: ${toolStats.totalIterations}
Consecutive run_node at end: ${toolStats.consecutiveRunNodeCount}
Avg iterations between non-run_node actions: ${toolStats.averageIterationsBetweenNonRunActions.toFixed(1)}
${toolStatsText}

## Tools Never Used
${toolStats.neverUsedTools.length > 0 ? toolStats.neverUsedTools.join(", ") : "(all tools have been used)"} -- Consider whether any of these could improve outcomes.

## Current Memory
${currentMemory || "(empty -- first reflection)"}

## Instructions
Update the memory based on what you've observed. The memory will be injected
into future autopilot decision prompts, so write actionable guidance.

Rules:
- Keep total length under 2000 characters.
- Structure as: Strategy, Tool Effectiveness, Patterns Learned, Avoid.
- UPDATE existing entries rather than appending -- memory should stay concise.
- Remove advice that turned out wrong or is no longer relevant.
- Focus on actionable, specific guidance -- not generic platitudes.
- If a tool was never used but could help, note when to use it.
- If a tool was used but ineffective, note when to avoid it.

Respond with ONLY the updated memory markdown. No preamble, no explanation.`;

    const runtime = getActiveRuntime();
    let updatedMemory = await runtime.runSession(prompt, blueprint?.projectCwd);

    // Truncate if exceeded
    if (updatedMemory.length > BLUEPRINT_MEMORY_MAX_CHARS) {
      updatedMemory = updatedMemory.slice(0, BLUEPRINT_MEMORY_MAX_CHARS);
    }

    // Save to DB
    setAutopilotMemory(blueprintId, updatedMemory);
    return updatedMemory;
  } catch (err) {
    log.warn("Reflection LLM call failed, keeping existing memory: %s", err);
    return currentMemory;
  }
}

/**
 * Global reflection: distill cross-blueprint learnings at blueprint completion.
 * Non-fatal — on failure, logs warning and continues.
 */
export async function updateGlobalMemory(
  blueprintId: string,
  blueprintMemory: string | null,
  currentGlobalMemory: string | null,
): Promise<void> {
  try {
    const blueprint = getBlueprint(blueprintId);
    if (!blueprint) {
      log.warn("Cannot update global memory: blueprint %s not found", blueprintId);
      return;
    }

    // Build outcome summary
    const doneNodes = blueprint.nodes.filter((n) => n.status === "done").length;
    const failedNodes = blueprint.nodes.filter((n) => n.status === "failed").length;
    const skippedNodes = blueprint.nodes.filter((n) => n.status === "skipped").length;
    const totalNodes = blueprint.nodes.length;
    const outcome = blueprint.status === "done" ? "done" : "paused";

    // Get iteration count from log
    const logEntries = getAutopilotLog(blueprintId, 1, 0);
    const iterations = logEntries.length > 0 ? logEntries[0].iteration : 0;

    // Build global reflection prompt per spec section 5.5
    const prompt = `You are updating the global autopilot strategy based on a completed blueprint run.

## Completed Blueprint
Title: ${blueprint.title}
Outcome: ${outcome} after ${iterations} iterations
Nodes: ${doneNodes}/${totalNodes} completed, ${failedNodes} failed, ${skippedNodes} skipped

## Per-Blueprint Memory (learnings from this run)
${blueprintMemory || "(no per-blueprint memory)"}

## Current Global Strategy
${currentGlobalMemory || "(empty -- first blueprint completion)"}

## Instructions
Distill cross-blueprint learnings into the global strategy.
This will be shown to autopilot on ALL future blueprints.

Rules:
- Keep total length under 3000 characters.
- Only add patterns that are likely generalizable (not blueprint-specific).
- Update/refine existing entries based on new evidence.
- Remove advice contradicted by this run's experience.
- Structure as: General Patterns, Tool Usage Guidelines, Anti-Patterns.

Respond with ONLY the updated global strategy markdown.`;

    const runtime = getActiveRuntime();
    let updatedGlobal = await runtime.runSession(prompt, blueprint.projectCwd);

    // Truncate if exceeded
    if (updatedGlobal.length > GLOBAL_MEMORY_MAX_CHARS) {
      updatedGlobal = updatedGlobal.slice(0, GLOBAL_MEMORY_MAX_CHARS);
    }

    writeGlobalMemory(updatedGlobal);
  } catch (err) {
    log.warn("Global reflection LLM call failed, continuing: %s", err);
  }
}

// ─── State Snapshot Types (spec §4.4) ────────────────────────

export interface AutopilotState {
  blueprint: {
    id: string;
    title: string;
    description: string;
    status: BlueprintStatus;
    enabledRoles: string[];
  };
  nodes: AutopilotNodeState[];
  insights: AutopilotInsightState[];
  queueInfo: {
    running: boolean;
    pendingTasks: PendingTask[];
  };
  allNodesDone: boolean;
  summary: string;
}

export interface AutopilotNodeState {
  id: string;
  seq: number;
  title: string;
  status: MacroNodeStatus;
  dependencies: string[];
  roles?: string[];
  error?: string;
  resumeCount: number;
}

export interface AutopilotInsightState {
  id: string;
  severity: InsightSeverity;
  message: string;
  sourceNodeId?: string;
  read: boolean;
}

// Decision format the AI returns (spec §4.6)
export interface AutopilotDecision {
  reasoning: string;
  action: string;
  params: Record<string, unknown>;
}

// ─── Per-run resume tracking (in-memory) ─────────────────────

const autopilotResumeCounts = new Map<string, Map<string, number>>();

export function getResumeCount(blueprintId: string, nodeId: string): number {
  return autopilotResumeCounts.get(blueprintId)?.get(nodeId) ?? 0;
}

export function incrementResumeCount(blueprintId: string, nodeId: string): number {
  if (!autopilotResumeCounts.has(blueprintId)) {
    autopilotResumeCounts.set(blueprintId, new Map());
  }
  const counts = autopilotResumeCounts.get(blueprintId)!;
  const next = (counts.get(nodeId) ?? 0) + 1;
  counts.set(nodeId, next);
  return next;
}

export function clearResumeCounts(blueprintId: string): void {
  autopilotResumeCounts.delete(blueprintId);
}

// ─── Per-run seen suggestions tracking (in-memory) ────────────

const autopilotSeenSuggestions = new Map<string, Set<string>>();

/** Record suggestion IDs the autopilot has seen in a snapshot. */
export function markSuggestionsSeen(blueprintId: string, suggestionIds: string[]): void {
  if (!autopilotSeenSuggestions.has(blueprintId)) {
    autopilotSeenSuggestions.set(blueprintId, new Set());
  }
  const seen = autopilotSeenSuggestions.get(blueprintId)!;
  for (const id of suggestionIds) seen.add(id);
}

/** Check if there are unused suggestions the autopilot hasn't seen yet. */
export function hasUnseenSuggestions(blueprintId: string, unusedSuggestionIds: string[]): boolean {
  const seen = autopilotSeenSuggestions.get(blueprintId);
  if (!seen) return unusedSuggestionIds.length > 0;
  return unusedSuggestionIds.some((id) => !seen.has(id));
}

export function clearSeenSuggestions(blueprintId: string): void {
  autopilotSeenSuggestions.delete(blueprintId);
}

// ─── Helpers ─────────────────────────────────────────────────

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

// ─── State Snapshot Builder (spec §4.4) ──────────────────────

/**
 * Build a complete state snapshot for the autopilot agent.
 * Collects blueprint metadata, nodes with suggestions, insights, and queue info.
 * Token-efficient: truncates descriptions, excludes used suggestions,
 * and for large blueprints (>20 nodes) only includes active nodes + dependency context.
 */
export function buildStateSnapshot(blueprintId: string): AutopilotState {
  const blueprint = getBlueprint(blueprintId);
  if (!blueprint) {
    throw new Error(`Blueprint ${blueprintId} not found`);
  }

  const allNodes = blueprint.nodes;
  const isLargeBlueprint = allNodes.length > 20;

  // For large blueprints, only include non-done/non-skipped nodes
  // plus their immediate dependency context
  let includedNodeIds: Set<string>;
  if (isLargeBlueprint) {
    includedNodeIds = new Set<string>();
    // First pass: active nodes
    for (const node of allNodes) {
      if (node.status !== "done" && node.status !== "skipped") {
        includedNodeIds.add(node.id);
      }
    }
    // Second pass: add immediate dependencies of active nodes for context
    const depIds = new Set<string>();
    for (const node of allNodes) {
      if (includedNodeIds.has(node.id)) {
        for (const depId of node.dependencies) {
          depIds.add(depId);
        }
      }
    }
    for (const depId of depIds) {
      includedNodeIds.add(depId);
    }
  } else {
    includedNodeIds = new Set(allNodes.map((n) => n.id));
  }

  // Build lightweight node snapshots (description and suggestions fetched on-demand via read tools)
  const nodes: AutopilotNodeState[] = [];
  const allUnusedSuggestionIds: string[] = [];
  let totalUnusedSuggestions = 0;
  for (const node of allNodes) {
    // Count unused suggestions for summary stats (all nodes)
    const allSuggestions = getSuggestionsForNode(node.id);
    const unusedIds = allSuggestions
      .filter((s: NodeSuggestion) => !s.used)
      .map((s: NodeSuggestion) => s.id);
    totalUnusedSuggestions += unusedIds.length;

    if (!includedNodeIds.has(node.id)) continue;

    allUnusedSuggestionIds.push(...unusedIds);

    const nodeState: AutopilotNodeState = {
      id: node.id,
      seq: node.seq,
      title: node.title,
      status: node.status,
      dependencies: node.dependencies,
      resumeCount: getResumeCount(blueprintId, node.id),
    };
    if (node.roles && node.roles.length > 0) nodeState.roles = node.roles;
    if (node.error) nodeState.error = node.error;

    nodes.push(nodeState);
  }

  // Only include unread, non-dismissed insights — auto-mark as read after snapshot
  const allInsights = getInsightsForBlueprint(blueprintId);
  const unreadInsights = allInsights.filter((i: BlueprintInsight) => !i.dismissed && !i.read);
  const insights: AutopilotInsightState[] = unreadInsights
    .map((i: BlueprintInsight) => ({
      id: i.id,
      severity: i.severity,
      message: truncate(i.message, 200),
      ...(i.sourceNodeId ? { sourceNodeId: i.sourceNodeId } : {}),
      read: false,
    }));
  // Mark as read — autopilot has now "seen" them in this iteration
  for (const i of unreadInsights) {
    markInsightRead(i.id);
  }

  // Queue info
  const queue = getQueueInfo(blueprintId);

  // Summary stats (computed over ALL nodes, not just included subset)
  let doneCount = 0;
  let failedCount = 0;
  let pendingCount = 0;
  let skippedCount = 0;
  for (const node of allNodes) {
    if (node.status === "done") doneCount++;
    else if (node.status === "failed") failedCount++;
    else if (node.status === "skipped") skippedCount++;
    else if (node.status === "pending") pendingCount++;
  }

  const allNodesDone =
    allNodes.length > 0 &&
    allNodes.every((n) => n.status === "done" || n.status === "skipped");

  const unreadInsightCount = unreadInsights.length;

  const summaryParts: string[] = [`${doneCount}/${allNodes.length} nodes done`];
  if (failedCount > 0) summaryParts.push(`${failedCount} failed`);
  if (pendingCount > 0) summaryParts.push(`${pendingCount} pending`);
  if (skippedCount > 0) summaryParts.push(`${skippedCount} skipped`);
  if (totalUnusedSuggestions > 0) summaryParts.push(`${totalUnusedSuggestions} unused suggestions`);
  if (unreadInsightCount > 0) summaryParts.push(`${unreadInsightCount} unread insights`);
  const summary = summaryParts.join(", ");

  log.debug(`State snapshot for ${blueprintId.slice(0, 8)}: ${summary}`);

  return {
    blueprint: {
      id: blueprint.id,
      title: blueprint.title,
      description: blueprint.description,
      status: blueprint.status,
      enabledRoles: blueprint.enabledRoles ?? [],
    },
    nodes,
    insights,
    queueInfo: {
      running: queue.running,
      pendingTasks: queue.pendingTasks,
    },
    allNodesDone,
    summary,
  };
}

// ─── Tool Descriptions (spec §4.2) ──────────────────────────

const TOOL_DESCRIPTIONS = `### Context Gathering (Read Tools)
- **get_node_titles()** — Returns all nodes with {id, seq, title, status, roles, deps}. Use to understand current plan structure before creating or modifying nodes.
- **get_node_details(nodeId)** — Returns full node context: description, prompt, error, resolved dependency titles+statuses, latest handoff content, unused suggestions. Use before modifying any node.
- **get_node_handoff(nodeId)** — Returns just the latest handoff artifact content for a completed node. Lightweight alternative to get_node_details when you only need the output.

### Direct Execution (Simple Tasks)
- **run_direct(prompt)** — Run a prompt directly as a one-shot agent session in the blueprint's project directory. The agent has full access to shell commands, git, file operations, etc. ONLY use for non-code tasks: git operations, answering questions, status checks, running tests, reading files. NEVER use for writing or modifying code — always create a node for code changes, no matter how small. The output is automatically sent as a reply visible to the user.

### Node Execution (Complex Tasks)
- **run_node(nodeId)** — Execute a single pending/queued node. Dependencies must be done first.
- **resume_node(nodeId, feedback?)** — Resume a node's session with optional guidance/feedback string.

### Node CRUD
- **create_node(title, description, dependsOn?, roles?)** — Create a new node. dependsOn is an array of node IDs. roles is an array of role IDs.
- **update_node(nodeId, {title?, description?, prompt?})** — Modify an existing node's title, description, or prompt.
- **skip_node(nodeId, reason)** — Skip a node that's no longer needed. Provide a reason string.
- **batch_create_nodes([{title, description, dependsOn?, roles?}])** — Create multiple nodes at once.
- **reorder_nodes([{id, order}])** — Change execution order of nodes.

### Blueprint Intelligence
- **coordinate()** — Run the coordinator to process unread insights and take corrective actions.
- **convene(topic, roleIds)** — Start a multi-role discussion on a specific topic. roleIds is an array of role ID strings.

### Retrospective (Review & Create)
- **create_insight(severity, message, sourceNodeId?)** — Create a blueprint-level insight. severity: "info"|"warning"|"critical". sourceNodeId is optional (links to a specific node).
- **create_node_suggestion(nodeId, title, description)** — Create a follow-up suggestion for a specific node.
- **create_blueprint_suggestion(title, description)** — Create a blueprint-level suggestion for what the user could do next.
- **clear_blueprint_suggestions()** — Clear all existing blueprint suggestions before generating new ones.

### Insight & Suggestion Management
- **mark_insight_read(insightId)** — Acknowledge an insight without taking action.
- **dismiss_insight(insightId)** — Dismiss an irrelevant insight.
- **mark_suggestion_used(nodeId, suggestionId)** — Mark a suggestion as acted upon/addressed.
- **batch_mark_suggestions_used(suggestionIds)** — Mark multiple suggestions as used at once. suggestionIds is an array of suggestion ID strings.
- **batch_dismiss_insights(insightIds)** — Dismiss multiple insights at once. insightIds is an array of insight ID strings.

### Control Flow
- **pause(reason)** — Pause autopilot and request human input. Use when you encounter ambiguous requirements, architectural decisions, or external dependencies that need human judgment.`;

// ─── Role Descriptions for Prompt ────────────────────────────

/**
 * Build a description of available roles for inclusion in the autopilot prompt.
 * Helps the LLM assign appropriate roles when creating nodes.
 */
function buildRoleDescriptions(enabledRoleIds: string[]): string {
  const allRoles = getAllRoles();
  if (allRoles.length === 0) return "";

  const enabledSet = new Set(enabledRoleIds);
  const enabled = allRoles.filter((r) => enabledSet.has(r.id));
  const available = allRoles.filter((r) => !enabledSet.has(r.id));

  let section = "## Available Roles\n";
  section += "When creating nodes, assign appropriate roles to ensure the right expertise is applied.\n\n";

  if (enabled.length > 0) {
    section += "**Enabled on this blueprint:**\n";
    for (const role of enabled) {
      section += `- \`${role.id}\` — **${role.label}**: ${role.description}\n`;
    }
  }

  if (available.length > 0) {
    section += "\n**Other available roles** (can still be assigned to individual nodes):\n";
    for (const role of available) {
      section += `- \`${role.id}\` — **${role.label}**: ${role.description}\n`;
    }
  }

  section += `\n**Role assignment guidelines:**
- Implementation/coding tasks → \`sde\`
- Testing/QA tasks → \`qa\`
- UI/UX design tasks → \`uxd\`
- Architecture/system design → \`sa\`
- Requirements/planning → \`pm\`
- ML/data science → \`mle\`
- When unsure, use the role(s) enabled on the blueprint
- A node can have multiple roles for cross-cutting work\n`;

  return section;
}

// ─── Autopilot Memory for Prompt Injection ───────────────────

export interface AutopilotMemory {
  blueprint: string | null;
  global: string | null;
}

// ─── Autopilot Prompt Builder (spec §4.5) ────────────────────

/**
 * Build the prompt sent to the AI agent for each autopilot iteration.
 * Includes the full state snapshot, tool descriptions, and guidelines.
 */
export function buildAutopilotPrompt(
  state: AutopilotState,
  iteration: number,
  maxIterations: number,
  memory: AutopilotMemory = { blueprint: null, global: null },
  fsdMode: boolean = false,
  completedThisRound: string[] = [],
): string {
  const remaining = maxIterations === Infinity ? Infinity : maxIterations - iteration;

  // Build memory sections to inject between state and tools
  let memorySections = "";
  if (memory.global) {
    memorySections += `\n## Global Strategy (from previous blueprints)\n${memory.global}\n`;
  }
  if (memory.blueprint) {
    memorySections += `\n## Blueprint Memory (your notes from earlier iterations)\n${memory.blueprint}\n`;
  }

  // Completed nodes this round — tells the LLM what to review in retrospective
  let completedSection = "";
  if (completedThisRound.length > 0) {
    completedSection = `\n## Nodes Completed This Round\n${completedThisRound.map((entry) => `- ${entry}`).join("\n")}\nReview these using get_node_details to check outcomes. Create insights/suggestions as needed.\n`;
  }

  const workflowSection = fsdMode
    ? `## FSD Mode (Full Speed Drive)
You are running in FSD mode — no safeguards, no throttling. Execute as fast and efficiently as possible.
Focus on running nodes to completion. Use get_node_details only when needed for context before running complex nodes.
Don't hesitate to run nodes back-to-back. Maximize throughput.

### Retrospective
After completing a batch of nodes, review your work before moving on:
- Use **get_node_details(nodeId)** to read the outcome/handoff of completed nodes
- **create_insight** for important observations (architectural issues, quality concerns, cross-cutting patterns)
- **create_node_suggestion** for follow-up work on specific nodes
- **create_blueprint_suggestion** for overall next steps the user should consider
- If a node's work is incomplete, create a follow-up node with **create_node**

Don't review every node exhaustively — focus on nodes where the outcome matters for downstream work or where you notice issues. Check "Nodes completed this round" in the state for what to review.`
    : `## Recommended Workflow Rhythm
Follow this read-before-act pattern:

1. **Read before modifying**: Before modifying any node, use get_node_details(nodeId) to understand its full context. Before creating nodes, use get_node_titles() to understand the current plan structure.
2. **Before running a node**: Use get_node_details to check if its description is adequate. If it's short or vague, use update_node to improve the description/prompt yourself — you have the context to write good prompts.
3. **After completing nodes**: Review outcomes using get_node_details. Create insights for important observations, suggestions for follow-up work. If work is incomplete, create follow-up nodes.
4. **Every ~5 completed nodes**: Use coordinate() to detect cross-cutting concerns across the blueprint.
5. **When suggestions accumulate**: Review them via get_node_details — create_node for real issues, batch_mark_suggestions_used for minor/addressed ones.
6. **When multiple roles are enabled and a design decision is ambiguous**: Use convene(topic, roleIds) to get multi-perspective input.

A good rhythm: read context → improve prompt if needed → run → review outcomes → create insights/suggestions → repeat. Not every node needs all steps, but never do 5+ run_node calls in a row without reviewing outcomes or triaging suggestions.`;

  const guidelinesSection = fsdMode
    ? `## Guidelines
- Execute nodes in dependency order. Don't run a node whose dependencies aren't done.
- If a node failed, try resume with feedback or skip it — don't get stuck on any single node.
- The loop exits automatically when all nodes are done. Just focus on running nodes.
- No iteration limit — keep going until all nodes are done.`
    : `## Guidelines
- Execute nodes in dependency order. Don't run a node whose dependencies aren't done.
- If a node failed, use get_node_details to analyze the error. Consider: resume with feedback, update its description/prompt, create sub-nodes to break it down, or skip it if non-critical.
- If a node seems too complex, create sub-nodes to break it down using create_node with appropriate dependencies.
- If a node has been resumed multiple times (check resumeCount), consider breaking it down or skipping it instead of retrying.
- When creating nodes, always set appropriate roles and dependencies:
  - Assign roles matching the task type (e.g. \`sde\` for implementation, \`qa\` for testing — see Available Roles section).
  - Set dependsOn for nodes that require output from other nodes. Use get_node_titles() to find existing node IDs to depend on.
  - For multi-step feature requests, decompose into separate nodes with dependency chains (e.g. design → implement → test).
- If critical insights exist (severity: "critical"), address them before proceeding with normal execution.
- If warning insights exist, consider addressing them when convenient but don't block progress.
- If you're stuck or need a human decision (architectural choice, ambiguous requirement, external dependency), use pause(reason).
- You have ${remaining === Infinity ? "unlimited" : remaining} iterations left. Balance quality (coordinate, suggestion triage) with progress (run_node).
- The loop exits automatically when all nodes are done. Just focus on making progress.`;

  // Build role descriptions
  const roleSection = buildRoleDescriptions(state.blueprint.enabledRoles);

  return `You are the Autopilot agent for a software blueprint. Your goal is to drive this blueprint to completion by choosing the best next action at each step. You can also create new nodes when the user requests additional work — even if all existing nodes are done.

## Current Blueprint State
${JSON.stringify(state, null, 2)}

## Iteration ${iteration}${maxIterations === Infinity ? "" : ` of ${maxIterations}`}
${memorySections}${completedSection}## Available Tools
${TOOL_DESCRIPTIONS}

${roleSection}
${workflowSection}

${guidelinesSection}

## Decision Format
Respond with exactly one JSON object:
{
  "reasoning": "Brief explanation of why this action",
  "action": "<tool_name>",
  "params": { ... tool-specific parameters ... }
}

Pick the single highest-priority action. You'll be called again for the next action.`;
}

// ─── Execution Result Type ───────────────────────────────────

export interface ExecutionResult {
  success: boolean;
  message: string;
  error?: string;
}

// ─── Execute Decision (spec §4.6) ────────────────────────────

export async function executeDecision(
  blueprintId: string,
  decision: AutopilotDecision,
): Promise<ExecutionResult> {
  const p = decision.params;
  try {
    switch (decision.action) {
      case "run_node": {
        const nodeId = p.nodeId as string;
        try {
          await executeNodeDirect(blueprintId, nodeId);
        } catch (err) {
          log.error(`Autopilot run_node ${nodeId} failed: ${err instanceof Error ? err.message : err}`);
        }
        return { success: true, message: `Executed node ${nodeId}` };
      }

      case "resume_node": {
        const nodeId = p.nodeId as string;
        const feedback = p.feedback as string | undefined;
        const executions = getExecutionsForNode(nodeId);
        const latestWithSession = executions
          .filter((e) => e.sessionId)
          .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
        if (!latestWithSession) {
          return { success: false, message: `No resumable session found for node ${nodeId}`, error: "no_session" };
        }
        incrementResumeCount(blueprintId, nodeId);
        if (feedback) {
          updateMacroNode(blueprintId, nodeId, { prompt: feedback });
        }
        addPendingTask(blueprintId, { type: "run", nodeId, queuedAt: new Date().toISOString() });
        updateMacroNode(blueprintId, nodeId, { status: "queued" });
        try {
          await resumeNodeSession(blueprintId, nodeId, latestWithSession.id);
        } catch (err) {
          log.error(`Autopilot resume_node ${nodeId} failed: ${err instanceof Error ? err.message : err}`);
        } finally {
          removePendingTask(blueprintId, nodeId, "run");
        }
        return { success: true, message: `Resumed node ${nodeId}` };
      }

      case "create_insight": {
        const severity = p.severity as string;
        const message = p.message as string;
        const sourceNodeId = (p.sourceNodeId as string) || null;
        if (!["info", "warning", "critical"].includes(severity)) {
          return { success: false, message: `Invalid severity "${severity}". Must be info, warning, or critical.`, error: "invalid_params" };
        }
        if (!message) return { success: false, message: "message is required", error: "invalid_params" };
        createInsight(blueprintId, sourceNodeId, "autopilot", severity as InsightSeverity, message);
        return { success: true, message: `Created ${severity} insight` };
      }

      case "create_node_suggestion": {
        const nodeId = p.nodeId as string;
        const title = p.title as string;
        const description = p.description as string;
        if (!nodeId || !title) return { success: false, message: "nodeId and title are required", error: "invalid_params" };
        createSuggestion(blueprintId, nodeId, title, description || "");
        return { success: true, message: `Created suggestion for node ${nodeId}` };
      }

      case "create_blueprint_suggestion": {
        const title = p.title as string;
        const description = p.description as string;
        if (!title) return { success: false, message: "title is required", error: "invalid_params" };
        createBlueprintSuggestion(blueprintId, title, description || "");
        return { success: true, message: "Created blueprint suggestion" };
      }

      case "clear_blueprint_suggestions": {
        clearBlueprintSuggestions(blueprintId);
        return { success: true, message: "Cleared all blueprint suggestions" };
      }

      case "get_node_titles": {
        const bp = getBlueprint(blueprintId);
        if (!bp) return { success: false, message: "Blueprint not found", error: "not_found" };
        const titles = bp.nodes.map((n) => ({
          id: n.id,
          seq: n.seq,
          title: n.title,
          status: n.status,
          roles: n.roles ?? [],
          deps: n.dependencies,
        }));
        return { success: true, message: JSON.stringify(titles) };
      }

      case "get_node_details": {
        const nodeId = p.nodeId as string;
        const bp = getBlueprint(blueprintId);
        if (!bp) return { success: false, message: "Blueprint not found", error: "not_found" };
        const node = bp.nodes.find((n) => n.id === nodeId);
        if (!node) return { success: false, message: `Node ${nodeId} not found`, error: "not_found" };

        // Resolve dependencies with titles and statuses
        const resolvedDeps = node.dependencies.map((depId) => {
          const dep = bp.nodes.find((n) => n.id === depId);
          return dep ? { id: dep.id, seq: dep.seq, title: dep.title, status: dep.status } : { id: depId, seq: 0, title: "(unknown)", status: "pending" };
        });

        // Get latest handoff artifact
        const outputArtifacts = getArtifactsForNode(nodeId, "output");
        const latestHandoff = outputArtifacts
          .filter((a) => a.type === "handoff_summary")
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

        // Get unused suggestions
        const allSuggestions = getSuggestionsForNode(nodeId);
        const unusedSuggestions = allSuggestions
          .filter((s) => !s.used)
          .map((s) => ({ id: s.id, title: s.title, description: s.description, roles: s.roles }));

        const details = {
          id: node.id,
          seq: node.seq,
          title: node.title,
          description: node.description,
          prompt: node.prompt ?? null,
          status: node.status,
          error: node.error ?? null,
          roles: node.roles ?? [],
          dependencies: resolvedDeps,
          latestHandoff: latestHandoff ? latestHandoff.content : null,
          unusedSuggestions,
          resumeCount: getResumeCount(blueprintId, nodeId),
        };
        return { success: true, message: JSON.stringify(details) };
      }

      case "get_node_handoff": {
        const nodeId = p.nodeId as string;
        const outputArtifacts = getArtifactsForNode(nodeId, "output");
        const latestHandoff = outputArtifacts
          .filter((a) => a.type === "handoff_summary")
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        if (!latestHandoff) {
          return { success: true, message: JSON.stringify({ nodeId, handoff: null }) };
        }
        return { success: true, message: JSON.stringify({ nodeId, handoff: latestHandoff.content }) };
      }

      case "run_direct": {
        const directPrompt = p.prompt as string;
        if (!directPrompt || directPrompt.trim().length === 0) {
          return { success: false, message: "Prompt is required", error: "invalid_params" };
        }
        const blueprint = getBlueprint(blueprintId);
        const cwd = blueprint?.projectCwd;
        try {
          const runtime = getActiveRuntime();
          const output = await runtime.runSession(directPrompt.trim(), cwd);
          // Send the output as an assistant message visible to the user
          const trimmedOutput = output.trim();
          if (trimmedOutput.length > 0) {
            createAutopilotMessage(blueprintId, "assistant", trimmedOutput);
          }
          return { success: true, message: `Direct execution complete (${trimmedOutput.length} chars output)` };
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          createAutopilotMessage(blueprintId, "assistant", `Error running direct task: ${errMsg}`);
          return { success: false, message: errMsg, error: "execution_error" };
        }
      }

      case "create_node": {
        const blueprint = getBlueprint(blueprintId);
        if (!blueprint) return { success: false, message: "Blueprint not found", error: "not_found" };
        const maxOrder = Math.max(0, ...blueprint.nodes.map((n) => n.order));
        const deps = (p.dependsOn as string[] | undefined) ?? [];
        const roles = p.roles as string[] | undefined;
        // Fall back to blueprint's defaultRole when LLM doesn't specify roles
        const effectiveRoles = roles && roles.length > 0 ? roles : [blueprint.defaultRole ?? "sde"];
        const node = createMacroNode(blueprintId, {
          title: p.title as string,
          description: p.description as string | undefined,
          order: maxOrder + 1,
          dependencies: deps,
          roles: effectiveRoles,
        });
        return { success: true, message: `Created node ${node.id} "${node.title}"` };
      }

      case "update_node": {
        const nodeId = p.nodeId as string;
        const patch: Record<string, unknown> = {};
        if (p.title) patch.title = p.title;
        if (p.description) patch.description = p.description;
        if (p.prompt) patch.prompt = p.prompt;
        const updated = updateMacroNode(blueprintId, nodeId, patch as Partial<Pick<MacroNode, "title" | "description" | "prompt">>);
        if (!updated) return { success: false, message: `Node ${nodeId} not found`, error: "not_found" };
        return { success: true, message: `Updated node ${nodeId}` };
      }

      case "skip_node": {
        const nodeId = p.nodeId as string;
        const reason = p.reason as string | undefined;
        const updated = updateMacroNode(blueprintId, nodeId, {
          status: "skipped" as MacroNodeStatus,
          ...(reason ? { error: `Skipped: ${reason}` } : {}),
        });
        if (!updated) return { success: false, message: `Node ${nodeId} not found`, error: "not_found" };
        return { success: true, message: `Skipped node ${nodeId}` };
      }

      case "batch_create_nodes": {
        const blueprint = getBlueprint(blueprintId);
        if (!blueprint) return { success: false, message: "Blueprint not found", error: "not_found" };
        const nodes = p.nodes as Array<{ title: string; description?: string; dependsOn?: (string | number)[]; roles?: string[] }>;
        if (!Array.isArray(nodes) || nodes.length === 0) {
          return { success: false, message: "nodes must be a non-empty array", error: "invalid_params" };
        }
        const existingNodeIds = new Set(blueprint.nodes.map((n) => n.id));
        const maxOrder = Math.max(0, ...blueprint.nodes.map((n) => n.order));
        const createdNodes: MacroNode[] = [];
        for (let i = 0; i < nodes.length; i++) {
          const item = nodes[i];
          const depIds = (item.dependsOn ?? [])
            .map((dep) => {
              if (typeof dep === "number") {
                return dep >= 0 && dep < createdNodes.length ? createdNodes[dep].id : null;
              }
              return typeof dep === "string" && (existingNodeIds.has(dep) || createdNodes.some((n) => n.id === dep)) ? dep : null;
            })
            .filter((id): id is string => id !== null);
          // Fall back to blueprint's defaultRole when LLM doesn't specify roles
          const itemRoles = item.roles && item.roles.length > 0 ? item.roles : [blueprint.defaultRole ?? "sde"];
          const created = createMacroNode(blueprintId, {
            title: item.title,
            description: item.description,
            order: maxOrder + i + 1,
            dependencies: depIds,
            roles: itemRoles,
          });
          createdNodes.push(created);
        }
        return { success: true, message: `Created ${createdNodes.length} nodes` };
      }

      case "reorder_nodes": {
        const ordering = p.ordering as Array<{ id: string; order: number }>;
        if (!Array.isArray(ordering)) {
          return { success: false, message: "ordering must be an array", error: "invalid_params" };
        }
        reorderMacroNodes(blueprintId, ordering);
        return { success: true, message: `Reordered ${ordering.length} nodes` };
      }

      case "coordinate": {
        addPendingTask(blueprintId, { type: "coordinate", queuedAt: new Date().toISOString() });
        try {
          await coordinateBlueprint(blueprintId);
        } catch (err) {
          log.error(`Autopilot coordinate failed: ${err instanceof Error ? err.message : err}`);
        } finally {
          removePendingTask(blueprintId, undefined, "coordinate");
        }
        return { success: true, message: "Coordination complete" };
      }

      case "convene": {
        addPendingTask(blueprintId, { type: "convene", queuedAt: new Date().toISOString() });
        try {
          const { createConveneSession } = await import("./plan-db.js");
          const { executeConveneSession } = await import("./plan-convene.js");
          const topic = p.topic as string;
          const roleIds = p.roleIds as string[];
          const session = createConveneSession(blueprintId, topic, roleIds);
          await executeConveneSession(session.id);
        } catch (err) {
          log.error(`Autopilot convene failed: ${err instanceof Error ? err.message : err}`);
        } finally {
          removePendingTask(blueprintId, undefined, "convene");
        }
        return { success: true, message: "Convene session complete" };
      }

      case "mark_insight_read": {
        const insightId = p.insightId as string;
        const result = markInsightRead(insightId);
        if (!result) return { success: false, message: `Insight ${insightId} not found`, error: "not_found" };
        return { success: true, message: `Marked insight ${insightId} as read` };
      }

      case "dismiss_insight": {
        const insightId = p.insightId as string;
        dismissInsight(insightId);
        return { success: true, message: `Dismissed insight ${insightId}` };
      }

      case "mark_suggestion_used": {
        const suggestionId = p.suggestionId as string;
        const result = markSuggestionUsed(suggestionId);
        if (!result) return { success: false, message: `Suggestion ${suggestionId} not found`, error: "not_found" };
        return { success: true, message: `Marked suggestion ${suggestionId} as used` };
      }

      case "batch_mark_suggestions_used": {
        const ids = p.suggestionIds as string[];
        let marked = 0;
        for (const id of ids) {
          if (markSuggestionUsed(id)) marked++;
        }
        return { success: true, message: `Marked ${marked}/${ids.length} suggestions as used` };
      }

      case "batch_dismiss_insights": {
        const ids = p.insightIds as string[];
        for (const id of ids) {
          dismissInsight(id);
        }
        return { success: true, message: `Dismissed ${ids.length} insights` };
      }

      case "pause": {
        const reason = (p.reason as string) || "Autopilot paused by AI decision";
        // Only set pauseReason — blueprint status is user-managed only
        updateBlueprint(blueprintId, { pauseReason: reason });
        return { success: true, message: `Paused: ${reason}` };
      }

      case "loop_exit":
      case "complete": {
        // No-op for blueprint status — status is user-managed only.
        // Just signals the loop to exit gracefully.
        return { success: true, message: "Loop exit signaled" };
      }

      default:
        return { success: false, message: `Unknown action: ${decision.action}`, error: "unknown_action" };
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error(`executeDecision error for ${decision.action}: ${errMsg}`);
    return { success: false, message: `Error executing ${decision.action}: ${errMsg}`, error: errMsg };
  }
}

// ─── Call Agent for Decision (spec §4.6) ─────────────────────

export async function callAgentForDecision(
  prompt: string,
  projectCwd?: string,
): Promise<AutopilotDecision> {
  const runtime = getActiveRuntime();
  const output = await runtime.runSession(prompt, projectCwd);

  // Try to parse JSON decision from the output
  const parsed = parseDecisionFromOutput(output);
  if (parsed) return parsed;

  // Retry once with a corrective prompt
  log.warn("Failed to parse autopilot decision, retrying with corrective prompt");
  const retryPrompt = `Your previous response was not valid JSON. Please respond with ONLY a JSON object in this exact format:
{
  "reasoning": "Brief explanation",
  "action": "<tool_name>",
  "params": { ... }
}

Previous response (invalid):
${output.slice(0, 500)}

Try again — respond with ONLY the JSON object, nothing else.`;

  const retryOutput = await runtime.runSession(retryPrompt, projectCwd);
  const retryParsed = parseDecisionFromOutput(retryOutput);
  if (retryParsed) return retryParsed;

  // If both attempts fail, return a pause decision
  log.error("Failed to parse autopilot decision after retry");
  return {
    reasoning: "Failed to parse AI response after retry — pausing for human review",
    action: "pause",
    params: { reason: "AI response was not valid JSON after 2 attempts" },
  };
}

function parseDecisionFromOutput(output: string): AutopilotDecision | null {
  // Try to extract JSON from the output (may be wrapped in markdown code blocks)
  const jsonPatterns = [
    /```json\s*\n?([\s\S]*?)\n?\s*```/,
    /```\s*\n?([\s\S]*?)\n?\s*```/,
    /(\{[\s\S]*\})/,
  ];

  for (const pattern of jsonPatterns) {
    const match = output.match(pattern);
    if (match) {
      try {
        const parsed = JSON.parse(match[1]);
        if (parsed.action && typeof parsed.action === "string") {
          return {
            reasoning: parsed.reasoning || "",
            action: parsed.action,
            params: parsed.params || {},
          };
        }
      } catch {
        // Try next pattern
      }
    }
  }
  return null;
}

// ─── Autopilot Logging ───────────────────────────────────────

function logAutopilot(
  blueprintId: string,
  iteration: number,
  observation: string,
  decision: AutopilotDecision | string,
  result: ExecutionResult | string,
): void {
  try {
    const db = getDb();
    const id = randomUUID();
    const now = new Date().toISOString();
    const decisionStr = typeof decision === "string"
      ? decision
      : `${decision.reasoning} → ${decision.action}`;
    const actionStr = typeof decision === "string"
      ? decision
      : decision.action;
    const actionParams = typeof decision === "string"
      ? null
      : JSON.stringify(decision.params);
    const resultStr = typeof result === "string"
      ? result
      : result.success ? result.message : `ERROR: ${result.error || result.message}`;

    db.prepare(`
      INSERT INTO autopilot_log (id, blueprint_id, iteration, observation, decision, action, action_params, result, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, blueprintId, iteration, observation, decisionStr, actionStr, actionParams, resultStr, now);
  } catch (err) {
    log.error(`Failed to log autopilot entry: ${err instanceof Error ? err.message : err}`);
  }
}

// ─── Infinite Loop Safeguards (spec §5) ──────────────────────

interface LoopSafeguardState {
  recentActions: Array<{ action: string; params: string }>;
  lastNodeStatuses: Map<string, MacroNodeStatus>;
  noProgressCount: number;
  graceIterations: number;
}

function checkSameActionRepeat(state: LoopSafeguardState, decision: AutopilotDecision): string | null {
  const current = { action: decision.action, params: JSON.stringify(decision.params) };
  state.recentActions.push(current);

  // Keep only last 3
  if (state.recentActions.length > 3) {
    state.recentActions.shift();
  }

  // Check if last 3 are identical
  if (state.recentActions.length >= 3) {
    const [a, b, c] = state.recentActions.slice(-3);
    if (a.action === b.action && b.action === c.action &&
        a.params === b.params && b.params === c.params) {
      return "Autopilot appears stuck — repeating the same action 3 times consecutively.";
    }
  }
  return null;
}

function checkNoProgress(
  safeguardState: LoopSafeguardState,
  currentState: AutopilotState,
): string | null {
  const currentStatuses = new Map<string, MacroNodeStatus>();
  for (const node of currentState.nodes) {
    currentStatuses.set(node.id, node.status);
  }

  // Compare with previous iteration's statuses
  if (safeguardState.lastNodeStatuses.size > 0) {
    let changed = false;
    for (const [id, status] of currentStatuses) {
      if (safeguardState.lastNodeStatuses.get(id) !== status) {
        changed = true;
        break;
      }
    }
    // Also check if new nodes were added
    if (!changed && currentStatuses.size !== safeguardState.lastNodeStatuses.size) {
      changed = true;
    }
    if (!changed) {
      safeguardState.noProgressCount++;
    } else {
      safeguardState.noProgressCount = 0;
    }
  }

  safeguardState.lastNodeStatuses = currentStatuses;

  if (safeguardState.noProgressCount >= 5) {
    return "No progress detected after 5 consecutive iterations.";
  }
  return null;
}

function checkResumeCapExceeded(blueprintId: string, state: AutopilotState): string | null {
  for (const node of state.nodes) {
    if (node.resumeCount > 5) {
      return `Node #${node.seq} "${node.title}" has been resumed ${node.resumeCount} times — force pausing.`;
    }
  }
  return null;
}

// ─── Main Autopilot Loop (spec §4.3) ─────────────────────────

export interface AutopilotLoopOptions {
  /** Skip safeguard checks for this many iterations (used when user resumes from safeguard pause) */
  safeguardGrace?: number;
}

export async function runAutopilotLoop(blueprintId: string, options?: AutopilotLoopOptions): Promise<void> {
  const blueprint = getBlueprint(blueprintId);
  if (!blueprint) {
    log.error(`Autopilot: Blueprint ${blueprintId} not found`);
    return;
  }

  // Clear pauseReason only — blueprint status is user-managed
  updateBlueprint(blueprintId, { pauseReason: "" });
  addPendingTask(blueprintId, { type: "autopilot" as PendingTask["type"], queuedAt: new Date().toISOString() });
  clearResumeCounts(blueprintId);
  clearSeenSuggestions(blueprintId);

  const isFsdAtStart = blueprint.executionMode === "fsd";
  // FSD mode: no hard iteration limit (Infinity) unless user explicitly set one
  const maxIterations = blueprint.maxIterations ?? (isFsdAtStart ? Infinity : 50);
  let iteration = 0;

  // Memory: read existing per-blueprint and global memory at loop start
  let blueprintMemory = getAutopilotMemory(blueprintId);
  const globalMemory = readGlobalMemory();
  let lastReflectionIteration = 0;
  const completedThisRound: string[] = [];

  const safeguardState: LoopSafeguardState = {
    recentActions: [],
    lastNodeStatuses: new Map(),
    noProgressCount: 0,
    graceIterations: options?.safeguardGrace ?? 0,
  };

  log.info(`Autopilot starting for blueprint ${blueprintId.slice(0, 8)} (max ${maxIterations === Infinity ? "unlimited" : maxIterations} iterations, mode: ${isFsdAtStart ? "fsd" : "autopilot"})`);

  try {
    while (iteration < maxIterations) {
      iteration++;

      // 1. OBSERVE — Build current state snapshot
      const state = buildStateSnapshot(blueprintId);

      // 2. CHECK EXIT CONDITIONS
      // Exit when all nodes are done.
      if (state.allNodesDone) {
        logAutopilot(blueprintId, iteration, state.summary, "All nodes complete", "loop_exit");
        log.info(`FSD loop exiting for ${blueprintId.slice(0, 8)} at iteration ${iteration} (all nodes done)`);
        break;
      }

      // Yield: if user sent new messages, break so User Agent can process them.
      // The User Agent will re-trigger the FSD loop after processing.
      const pendingMessages = getUnacknowledgedMessages(blueprintId);
      if (pendingMessages.length > 0) {
        logAutopilot(blueprintId, iteration, state.summary, "yield", "Pending user messages");
        log.info(`FSD loop yielding for ${blueprintId.slice(0, 8)} at iteration ${iteration}: ${pendingMessages.length} pending message(s)`);
        break;
      }

      // Check if user switched to manual mode
      const current = getBlueprint(blueprintId);
      const isFsd = current?.executionMode === "fsd";
      if (!current || (current.executionMode !== "autopilot" && current.executionMode !== "fsd")) {
        logAutopilot(blueprintId, iteration, state.summary, "Mode switched to manual", "paused");
        log.info(`Autopilot stopped for ${blueprintId.slice(0, 8)}: mode switched to manual`);
        break;
      }

      // FSD mode: skip all safeguard checks entirely
      // Safeguard grace period: skip checks when user explicitly resumed from a safeguard pause
      const inGracePeriod = safeguardState.graceIterations > 0;
      const skipSafeguards = isFsd || inGracePeriod;
      if (inGracePeriod) {
        safeguardState.graceIterations--;
        // Still track state for when grace period ends
        checkNoProgress(safeguardState, state);
        // Reset the count so it doesn't trigger immediately after grace ends
        safeguardState.noProgressCount = 0;
      }

      if (!skipSafeguards) {
        // Check resume cap safeguard
        const resumeCapReason = checkResumeCapExceeded(blueprintId, state);
        if (resumeCapReason) {
          updateBlueprint(blueprintId, { pauseReason: resumeCapReason });
          logAutopilot(blueprintId, iteration, state.summary, "safeguard:resume_cap", resumeCapReason);
          log.warn(`Autopilot paused: ${resumeCapReason}`);
          break;
        }

        // Check no-progress safeguard
        const noProgressReason = checkNoProgress(safeguardState, state);
        if (noProgressReason) {
          updateBlueprint(blueprintId, { pauseReason: noProgressReason });
          logAutopilot(blueprintId, iteration, state.summary, "safeguard:no_progress", noProgressReason);
          log.warn(`Autopilot paused: ${noProgressReason}`);
          break;
        }
      }

      // Mark suggestions as seen so the LLM knows which are new
      const unusedSuggestionIds = current
        ? current.nodes.flatMap((n) =>
            getSuggestionsForNode(n.id).filter((s) => !s.used).map((s) => s.id),
          )
        : [];
      markSuggestionsSeen(blueprintId, unusedSuggestionIds);

      // 3. DECIDE — Ask AI what to do next
      const prompt = buildAutopilotPrompt(state, iteration, maxIterations, {
        blueprint: blueprintMemory,
        global: globalMemory,
      }, isFsd, completedThisRound);
      let decision: AutopilotDecision;
      try {
        decision = await callAgentForDecision(prompt, current.projectCwd);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error(`Autopilot decision call failed at iteration ${iteration}: ${errMsg}`);
        logAutopilot(blueprintId, iteration, state.summary, "error", errMsg);
        // Count as a wasted iteration; continue to next
        continue;
      }

      log.info(`Autopilot iteration ${iteration}: ${decision.action} — ${decision.reasoning}`);

      // Check same-action safeguard (skipped in FSD mode and during grace period)
      if (!skipSafeguards) {
        const sameActionReason = checkSameActionRepeat(safeguardState, decision);
        if (sameActionReason) {
          updateBlueprint(blueprintId, { pauseReason: sameActionReason });
          logAutopilot(blueprintId, iteration, state.summary, decision, { success: false, message: sameActionReason, error: "safeguard" });
          log.warn(`Autopilot paused: ${sameActionReason}`);
          break;
        }
      } else if (!isFsd) {
        // Still track actions during grace period for post-grace checks (not needed for FSD)
        checkSameActionRepeat(safeguardState, decision);
      }

      // 4. EXECUTE — Carry out the AI's decision
      const result = await executeDecision(blueprintId, decision);

      // Track completed nodes for retrospective
      if (decision.action === "run_node" && result.success) {
        const nodeId = decision.params.nodeId as string;
        const bp = getBlueprint(blueprintId);
        const node = bp?.nodes.find((n) => n.id === nodeId);
        if (node && node.status === "done") {
          completedThisRound.push(`#${node.seq} "${node.title}" (${nodeId})`);
        }
      }

      // 5. LOG
      logAutopilot(blueprintId, iteration, state.summary, decision, result);

      // 5b. REFLECT — Check if reflection should trigger
      const iterationsSinceReflection = iteration - lastReflectionIteration;
      const shouldReflect =
        iterationsSinceReflection >= REFLECT_EVERY_N ||
        decision.action === "pause" ||
        (!result.success && result.error);
      if (shouldReflect) {
        blueprintMemory = await reflectAndUpdateMemory(
          blueprintId,
          lastReflectionIteration,
          iteration,
          blueprintMemory,
        );
        lastReflectionIteration = iteration;
      }

      // 6. Handle pause/complete decisions — break loop
      if (decision.action === "pause") {
        log.info(`Autopilot paused at iteration ${iteration}: ${decision.params.reason}`);
        break;
      }
      if (decision.action === "complete" || decision.action === "loop_exit") {
        log.info(`Autopilot loop exit at iteration ${iteration} (LLM called ${decision.action})`);
        break;
      }

    }

    // Final reflection: always run at loop exit
    blueprintMemory = await reflectAndUpdateMemory(
      blueprintId,
      lastReflectionIteration,
      iteration,
      blueprintMemory,
    );

    // Global memory update: if all nodes done
    const finalBlueprint = getBlueprint(blueprintId);
    if (
      finalBlueprint &&
      finalBlueprint.nodes.every((n) => n.status === "done" || n.status === "skipped")
    ) {
      await updateGlobalMemory(blueprintId, blueprintMemory, readGlobalMemory());
    }

    // Safety: max iterations reached (skipped in FSD mode with unlimited iterations)
    if (maxIterations !== Infinity && iteration >= maxIterations) {
      const pauseReason = `Autopilot reached maximum iterations (${maxIterations}). Review progress and resume.`;
      updateBlueprint(blueprintId, { pauseReason });
      logAutopilot(blueprintId, iteration, "max_iterations_reached", "safeguard:max_iterations", pauseReason);
      log.warn(`Autopilot paused: max iterations (${maxIterations}) reached for ${blueprintId.slice(0, 8)}`);
    }
  } finally {
    removePendingTask(blueprintId, undefined, "autopilot");
  }

  log.info(`Autopilot loop ended for blueprint ${blueprintId.slice(0, 8)} after ${iteration} iterations`);
}

/**
 * Trigger the FSD loop if the blueprint is in autopilot/FSD mode
 * and no loop is currently running or queued.
 * Called by user-agent.ts after processing user messages.
 */
export function triggerFsdLoopIfNeeded(blueprintId: string): void {
  const bp = getBlueprint(blueprintId);
  if (!bp) return;
  const isAutopilot = bp.executionMode === "autopilot" || bp.executionMode === "fsd";
  if (!isAutopilot) return;
  const queueInfo = getQueueInfo(blueprintId);
  const hasLoopTask = queueInfo.pendingTasks.some((t) => t.type === "autopilot");
  if (!hasLoopTask) {
    enqueueBlueprintTask(blueprintId, () => runAutopilotLoop(blueprintId)).catch((err) => {
      log.error(`FSD loop failed for ${blueprintId}: ${err instanceof Error ? err.message : err}`);
    });
  }
}
