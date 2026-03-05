import { randomUUID } from "node:crypto";
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
} from "./plan-db.js";
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
  evaluateNodeCompletion,
  addPendingTask,
  removePendingTask,
} from "./plan-executor.js";
import type { PendingTask } from "./plan-executor.js";
import { getActiveRuntime } from "./agent-runtime.js";
import { coordinateBlueprint } from "./plan-coordinator.js";
import { getDb } from "./db.js";
import { createLogger } from "./logger.js";

// Side-effect imports: ensure all runtimes are registered
import "./agent-claude.js";
import "./agent-pimono.js";
import "./agent-openclaw.js";
import "./agent-codex.js";

// Side-effect: auto-discovers and registers all roles
import "./roles/load-all-roles.js";

const log = createLogger("autopilot");

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
  description: string;
  status: MacroNodeStatus;
  dependencies: string[];
  roles?: string[];
  error?: string;
  resumeCount: number;
  suggestions: AutopilotSuggestionState[];
}

export interface AutopilotSuggestionState {
  id: string;
  title: string;
  description: string;
  roles?: string[];
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

  // Build node snapshots with suggestions
  const nodes: AutopilotNodeState[] = [];
  const allUnusedSuggestionIds: string[] = [];
  for (const node of allNodes) {
    if (!includedNodeIds.has(node.id)) continue;

    // Unused suggestions only (exclude used:true per spec)
    const allSuggestions = getSuggestionsForNode(node.id);
    const unusedSuggestions: AutopilotSuggestionState[] = allSuggestions
      .filter((s: NodeSuggestion) => !s.used)
      .map((s: NodeSuggestion) => {
        allUnusedSuggestionIds.push(s.id);
        return {
          id: s.id,
          title: s.title,
          description: truncate(s.description, 150),
          ...(s.roles && s.roles.length > 0 ? { roles: s.roles } : {}),
        };
      });

    const nodeState: AutopilotNodeState = {
      id: node.id,
      seq: node.seq,
      title: node.title,
      description: truncate(node.description, 200),
      status: node.status,
      dependencies: node.dependencies,
      resumeCount: getResumeCount(blueprintId, node.id),
      suggestions: unusedSuggestions,
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

  // Count unused suggestions across all nodes
  let totalUnusedSuggestions = 0;
  for (const node of allNodes) {
    const suggestions = getSuggestionsForNode(node.id);
    totalUnusedSuggestions += suggestions.filter((s: NodeSuggestion) => !s.used).length;
  }

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

const TOOL_DESCRIPTIONS = `### Node Execution
- **run_node(nodeId)** — Execute a single pending/queued node. Dependencies must be done first.
- **resume_node(nodeId, feedback?)** — Resume a node's session with optional guidance/feedback string.
- **evaluate_node(nodeId)** — Trigger evaluation on a completed node to check quality.
- **reevaluate_node(nodeId)** — Re-run evaluation on a previously evaluated node.

### Node Intelligence
- **enrich_node(nodeId)** — AI-enrich a node's description for better execution quality.
- **split_node(nodeId)** — Split a complex node into smaller sub-nodes.
- **smart_dependencies(nodeId)** — Auto-detect and set dependencies for a node.

### Node CRUD
- **create_node(title, description, dependsOn?, roles?)** — Create a new node. dependsOn is an array of node IDs. roles is an array of role IDs.
- **update_node(nodeId, {title?, description?, prompt?})** — Modify an existing node's title, description, or prompt.
- **skip_node(nodeId, reason)** — Skip a node that's no longer needed. Provide a reason string.
- **batch_create_nodes([{title, description, dependsOn?, roles?}])** — Create multiple nodes at once.
- **reorder_nodes([{id, order}])** — Change execution order of nodes.

### Blueprint Intelligence
- **coordinate()** — Run the coordinator to process unread insights and take corrective actions.
- **convene(topic, roleIds)** — Start a multi-role discussion on a specific topic. roleIds is an array of role ID strings.
- **reevaluate_all()** — Re-evaluate all completed nodes.

### Insight & Suggestion Management
- **mark_insight_read(insightId)** — Acknowledge an insight without taking action.
- **dismiss_insight(insightId)** — Dismiss an irrelevant insight.
- **mark_suggestion_used(nodeId, suggestionId)** — Mark a suggestion as acted upon/addressed.
- **batch_mark_suggestions_used(suggestionIds)** — Mark multiple suggestions as used at once. suggestionIds is an array of suggestion ID strings.
- **batch_dismiss_insights(insightIds)** — Dismiss multiple insights at once. insightIds is an array of insight ID strings.

### Control Flow
- **pause(reason)** — Pause autopilot and request human input. Use when you encounter ambiguous requirements, architectural decisions, or external dependencies that need human judgment.
- **complete()** — Signal that the blueprint is done. Only use when all nodes are done/skipped.`;

// ─── Autopilot Prompt Builder (spec §4.5) ────────────────────

/**
 * Build the prompt sent to the AI agent for each autopilot iteration.
 * Includes the full state snapshot, tool descriptions, and guidelines.
 */
export function buildAutopilotPrompt(
  state: AutopilotState,
  iteration: number,
  maxIterations: number,
): string {
  const remaining = maxIterations - iteration;

  return `You are the Autopilot agent for a software blueprint. Your goal is to drive this blueprint to completion by choosing the best next action at each step.

## Current Blueprint State
${JSON.stringify(state, null, 2)}

## Iteration ${iteration} of ${maxIterations}

## Available Tools
${TOOL_DESCRIPTIONS}

## Guidelines
- Execute nodes in dependency order. Don't run a node whose dependencies aren't done.
- If a node failed, analyze the error. Consider: resume with feedback, split it, modify its description/prompt, or skip it if non-critical.
- Review suggestions on completed nodes. Decide for each:
  - Create a fix/improvement node if the suggestion addresses a real issue
  - Combine multiple related suggestions into a single new node
  - Mark as used and move on if the issue is minor or already addressed
  - Skip if the suggestion is irrelevant
- If critical insights exist (severity: "critical"), address them before proceeding with normal execution.
- If warning insights exist, consider addressing them when convenient but don't block progress.
- If a node seems too complex (long description, many dependencies), consider splitting it first.
- If you're stuck or need a human decision (architectural choice, ambiguous requirement, external dependency), use pause(reason) — don't loop trying different approaches.
- Be efficient: prefer the simplest action that makes progress.
- You have ${remaining} iterations left. Prioritize high-impact actions.
- If a node has been resumed multiple times (check resumeCount), consider splitting or skipping it instead of retrying.
- When creating nodes from suggestions, set appropriate dependencies and roles.
- If the queue is busy (running: true with pending tasks), consider taking non-execution actions like triaging suggestions, managing insights, or creating/updating nodes.

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

      case "evaluate_node": {
        const nodeId = p.nodeId as string;
        addPendingTask(blueprintId, { type: "evaluate", nodeId, queuedAt: new Date().toISOString() });
        try {
          await evaluateNodeCompletion(blueprintId, nodeId);
        } catch (err) {
          log.error(`Autopilot evaluate_node ${nodeId} failed: ${err instanceof Error ? err.message : err}`);
        } finally {
          removePendingTask(blueprintId, nodeId, "evaluate");
        }
        return { success: true, message: `Evaluated node ${nodeId}` };
      }

      case "reevaluate_node": {
        const nodeId = p.nodeId as string;
        addPendingTask(blueprintId, { type: "reevaluate", nodeId, queuedAt: new Date().toISOString() });
        try {
          await evaluateNodeCompletion(blueprintId, nodeId);
        } catch (err) {
          log.error(`Autopilot reevaluate_node ${nodeId} failed: ${err instanceof Error ? err.message : err}`);
        } finally {
          removePendingTask(blueprintId, nodeId, "reevaluate");
        }
        return { success: true, message: `Reevaluated node ${nodeId}` };
      }

      case "enrich_node": {
        const nodeId = p.nodeId as string;
        addPendingTask(blueprintId, { type: "enrich", nodeId, queuedAt: new Date().toISOString() });
        try {
          await evaluateNodeCompletion(blueprintId, nodeId);
        } catch (err) {
          log.error(`Autopilot enrich_node ${nodeId} failed: ${err instanceof Error ? err.message : err}`);
        } finally {
          removePendingTask(blueprintId, nodeId, "enrich");
        }
        return { success: true, message: `Enriched node ${nodeId}` };
      }

      case "split_node": {
        const nodeId = p.nodeId as string;
        addPendingTask(blueprintId, { type: "split", nodeId, queuedAt: new Date().toISOString() });
        try {
          await evaluateNodeCompletion(blueprintId, nodeId);
        } catch (err) {
          log.error(`Autopilot split_node ${nodeId} failed: ${err instanceof Error ? err.message : err}`);
        } finally {
          removePendingTask(blueprintId, nodeId, "split");
        }
        return { success: true, message: `Split node ${nodeId}` };
      }

      case "smart_dependencies": {
        const nodeId = p.nodeId as string;
        addPendingTask(blueprintId, { type: "smart_deps", nodeId, queuedAt: new Date().toISOString() });
        try {
          await evaluateNodeCompletion(blueprintId, nodeId);
        } catch (err) {
          log.error(`Autopilot smart_dependencies ${nodeId} failed: ${err instanceof Error ? err.message : err}`);
        } finally {
          removePendingTask(blueprintId, nodeId, "smart_deps");
        }
        return { success: true, message: `Smart dependencies set for node ${nodeId}` };
      }

      case "create_node": {
        const blueprint = getBlueprint(blueprintId);
        if (!blueprint) return { success: false, message: "Blueprint not found", error: "not_found" };
        const maxOrder = Math.max(0, ...blueprint.nodes.map((n) => n.order));
        const deps = (p.dependsOn as string[] | undefined) ?? [];
        const roles = p.roles as string[] | undefined;
        const node = createMacroNode(blueprintId, {
          title: p.title as string,
          description: p.description as string | undefined,
          order: maxOrder + 1,
          dependencies: deps,
          ...(roles ? { roles } : {}),
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
          const created = createMacroNode(blueprintId, {
            title: item.title,
            description: item.description,
            order: maxOrder + i + 1,
            dependencies: depIds,
            ...(item.roles ? { roles: item.roles } : {}),
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

      case "reevaluate_all": {
        const blueprint = getBlueprint(blueprintId);
        if (!blueprint) return { success: false, message: "Blueprint not found", error: "not_found" };
        const completedNodes = blueprint.nodes.filter((n) => n.status === "done");
        if (completedNodes.length === 0) {
          return { success: false, message: "No completed nodes to reevaluate", error: "no_nodes" };
        }
        for (const n of completedNodes) {
          addPendingTask(blueprintId, { type: "reevaluate", nodeId: n.id, queuedAt: new Date().toISOString() });
        }
        try {
          for (const n of completedNodes) {
            await evaluateNodeCompletion(blueprintId, n.id);
          }
        } catch (err) {
          log.error(`Autopilot reevaluate_all failed: ${err instanceof Error ? err.message : err}`);
        } finally {
          for (const n of completedNodes) {
            removePendingTask(blueprintId, n.id, "reevaluate");
          }
        }
        return { success: true, message: `Reevaluated ${completedNodes.length} nodes` };
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
        updateBlueprint(blueprintId, {
          status: "paused" as BlueprintStatus,
          pauseReason: reason,
        });
        return { success: true, message: `Paused: ${reason}` };
      }

      case "complete": {
        updateBlueprint(blueprintId, { status: "done" as BlueprintStatus });
        return { success: true, message: "Blueprint marked as complete" };
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

export async function runAutopilotLoop(blueprintId: string): Promise<void> {
  const blueprint = getBlueprint(blueprintId);
  if (!blueprint) {
    log.error(`Autopilot: Blueprint ${blueprintId} not found`);
    return;
  }

  updateBlueprint(blueprintId, { status: "running" as BlueprintStatus });
  addPendingTask(blueprintId, { type: "autopilot" as PendingTask["type"], queuedAt: new Date().toISOString() });
  clearResumeCounts(blueprintId);
  clearSeenSuggestions(blueprintId);

  const maxIterations = blueprint.maxIterations ?? 50;
  let iteration = 0;

  const safeguardState: LoopSafeguardState = {
    recentActions: [],
    lastNodeStatuses: new Map(),
    noProgressCount: 0,
  };

  log.info(`Autopilot starting for blueprint ${blueprintId.slice(0, 8)} (max ${maxIterations} iterations)`);

  try {
    while (iteration < maxIterations) {
      iteration++;

      // 1. OBSERVE — Build current state snapshot
      const state = buildStateSnapshot(blueprintId);

      // 2. CHECK EXIT CONDITIONS
      // Only auto-exit if all nodes done AND no NEW unresolved work.
      // Unseen suggestions or unread insights → let the LLM triage first.
      // Suggestions the LLM already saw (and chose not to act on) don't block exit.
      const unusedSuggestionIds = state.nodes.flatMap((n) => n.suggestions.map((s) => s.id));
      const hasNewSuggestions = hasUnseenSuggestions(blueprintId, unusedSuggestionIds);
      const hasUnreadInsights = state.insights.length > 0; // snapshot only contains unread
      if (state.allNodesDone && !hasNewSuggestions && !hasUnreadInsights) {
        updateBlueprint(blueprintId, { status: "done" as BlueprintStatus });
        logAutopilot(blueprintId, iteration, state.summary, "All nodes complete", "complete");
        log.info(`Autopilot completed blueprint ${blueprintId.slice(0, 8)} at iteration ${iteration}`);
        break;
      }

      // Check if user switched to manual mode
      const current = getBlueprint(blueprintId);
      if (!current || current.executionMode !== "autopilot") {
        logAutopilot(blueprintId, iteration, state.summary, "Mode switched to manual", "paused");
        log.info(`Autopilot stopped for ${blueprintId.slice(0, 8)}: mode switched to manual`);
        break;
      }

      // Check resume cap safeguard
      const resumeCapReason = checkResumeCapExceeded(blueprintId, state);
      if (resumeCapReason) {
        updateBlueprint(blueprintId, {
          status: "paused" as BlueprintStatus,
          pauseReason: resumeCapReason,
        });
        logAutopilot(blueprintId, iteration, state.summary, "safeguard:resume_cap", resumeCapReason);
        log.warn(`Autopilot paused: ${resumeCapReason}`);
        break;
      }

      // Check no-progress safeguard
      const noProgressReason = checkNoProgress(safeguardState, state);
      if (noProgressReason) {
        updateBlueprint(blueprintId, {
          status: "paused" as BlueprintStatus,
          pauseReason: noProgressReason,
        });
        logAutopilot(blueprintId, iteration, state.summary, "safeguard:no_progress", noProgressReason);
        log.warn(`Autopilot paused: ${noProgressReason}`);
        break;
      }

      // Mark suggestions as seen (after exit check, so first sight blocks exit)
      markSuggestionsSeen(blueprintId, unusedSuggestionIds);

      // 3. DECIDE — Ask AI what to do next
      const prompt = buildAutopilotPrompt(state, iteration, maxIterations);
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

      // Check same-action safeguard
      const sameActionReason = checkSameActionRepeat(safeguardState, decision);
      if (sameActionReason) {
        updateBlueprint(blueprintId, {
          status: "paused" as BlueprintStatus,
          pauseReason: sameActionReason,
        });
        logAutopilot(blueprintId, iteration, state.summary, decision, { success: false, message: sameActionReason, error: "safeguard" });
        log.warn(`Autopilot paused: ${sameActionReason}`);
        break;
      }

      // 4. EXECUTE — Carry out the AI's decision
      const result = await executeDecision(blueprintId, decision);

      // 5. LOG
      logAutopilot(blueprintId, iteration, state.summary, decision, result);

      // 6. Handle pause/complete decisions
      if (decision.action === "pause") {
        // Already handled by executeDecision — just break
        log.info(`Autopilot paused at iteration ${iteration}: ${decision.params.reason}`);
        break;
      }
      if (decision.action === "complete") {
        log.info(`Autopilot complete at iteration ${iteration}`);
        break;
      }

    }

    // Safety: max iterations reached
    if (iteration >= maxIterations) {
      const pauseReason = `Autopilot reached maximum iterations (${maxIterations}). Review progress and resume.`;
      updateBlueprint(blueprintId, {
        status: "paused" as BlueprintStatus,
        pauseReason,
      });
      logAutopilot(blueprintId, iteration, "max_iterations_reached", "safeguard:max_iterations", pauseReason);
      log.warn(`Autopilot paused: max iterations (${maxIterations}) reached for ${blueprintId.slice(0, 8)}`);
    }
  } finally {
    removePendingTask(blueprintId, undefined, "autopilot");
  }

  log.info(`Autopilot loop ended for blueprint ${blueprintId.slice(0, 8)} after ${iteration} iterations`);
}
