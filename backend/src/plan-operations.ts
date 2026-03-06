/**
 * plan-operations.ts — Extracted route-level AI operations for direct invocation.
 *
 * These functions encapsulate the prompt-building and agent-call logic that was
 * previously embedded in plan-routes.ts route handlers. They can be called
 * directly from autopilot.ts or other modules without going through HTTP.
 *
 * All functions are fire-and-forget style: they enqueue work and return immediately.
 * Callers manage pendingTask tracking themselves (autopilot adds/removes its own).
 */

import {
  getBlueprint,
  createRelatedSession,
  completeRelatedSession,
} from "./plan-db.js";
import type { RelatedSessionType } from "./plan-db.js";
import {
  detectNewSession,
  runClaudeInteractive,
  withTimeout,
  resolveNodeRoles,
  parseAgentParams,
} from "./plan-executor.js";
import { runAgentInteractive, getApiBase, getAuthParam } from "./plan-generator.js";
import { syncSession } from "./db.js";
import { getRole } from "./roles/role-registry.js";
import type { RoleDefinition } from "./roles/role-registry.js";
import { createLogger } from "./logger.js";

// Side-effect: auto-discovers and registers all roles before getRole()
import "./roles/load-all-roles.js";

const log = createLogger("plan-operations");

// ─── Shared helpers ──────────────────────────────────────────

/**
 * Run an agent interactive call with background session detection polling.
 * Creates the related session record with completed_at = NULL as soon as
 * the session file appears (enabling frontend live polling), then marks it
 * complete when the CLI call finishes. Returns the CLI output.
 */
export async function runWithRelatedSessionDetection(
  prompt: string,
  projectCwd: string | undefined,
  nodeId: string,
  blueprintId: string,
  type: RelatedSessionType,
  extraArgs?: string[],
): Promise<string> {
  const beforeTimestamp = new Date();
  let relatedSessionDbId: string | null = null;
  let detectedSessionId: string | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  // Start background polling for the session file
  if (projectCwd) {
    const pollCwd = projectCwd;
    pollTimer = setInterval(() => {
      if (detectedSessionId) return; // already found
      const detected = detectNewSession(pollCwd, beforeTimestamp);
      if (detected) {
        detectedSessionId = detected;
        syncSession(detected);
        // Create in-flight related session (completed_at = NULL)
        const rs = createRelatedSession(nodeId, blueprintId, detected, type, beforeTimestamp.toISOString());
        relatedSessionDbId = rs.id;
        log.debug(`Early related session detected: type=${type}, nodeId=${nodeId.slice(0, 8)}, sessionId=${detected.slice(0, 8)}`);
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      }
    }, 3000);
  }

  try {
    const output = await runAgentInteractive(prompt, projectCwd || undefined, extraArgs);
    return output;
  } finally {
    // Stop polling
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }

    // Final detection attempt if polling missed it
    if (!detectedSessionId && projectCwd) {
      const detected = detectNewSession(projectCwd, beforeTimestamp);
      if (detected) {
        detectedSessionId = detected;
        syncSession(detected);
        const rs = createRelatedSession(nodeId, blueprintId, detected, type, beforeTimestamp.toISOString(), new Date().toISOString());
        relatedSessionDbId = rs.id;
        log.debug(`Post-run related session detected: type=${type}, nodeId=${nodeId.slice(0, 8)}, sessionId=${detected.slice(0, 8)}`);
      }
    }

    // Mark the session as complete
    if (relatedSessionDbId) {
      completeRelatedSession(relatedSessionDbId);
      log.debug(`Completed related session: type=${type}, dbId=${relatedSessionDbId.slice(0, 8)}`);
    }
  }
}

// ─── enrichNodeInternal ──────────────────────────────────────

/**
 * AI-enrich an existing node's title and description.
 * Fire-and-forget: enqueues work in the blueprint task queue.
 * The caller should manage pendingTask tracking if needed.
 *
 * @returns Promise that resolves when the enqueued task completes.
 */
export async function enrichNodeInternal(blueprintId: string, nodeId: string): Promise<void> {
  const blueprint = getBlueprint(blueprintId);
  if (!blueprint) throw new Error("Blueprint not found");
  const node = blueprint.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error("Node not found");

  // Build context: dependencies (titles + handoffs) take priority.
  const depIds = node.dependencies ?? [];
  const depNodes = depIds.length > 0 ? blueprint.nodes.filter((n) => depIds.includes(n.id)) : [];

  const depContext = depNodes.length > 0
    ? depNodes
        .map((n, i) => {
          let line = `  ${i + 1}. [${n.status}] ${n.title}`;
          const handoffs = n.outputArtifacts.filter((a) => a.type === "handoff_summary");
          if (handoffs.length > 0) {
            line += `\n     Handoff: ${handoffs[handoffs.length - 1].content.slice(0, 500)}`;
          }
          return line;
        })
        .join("\n")
    : null;

  // Resolve roles for specificity guidance
  const roleIds = resolveNodeRoles(node, blueprint);
  const nodeRoles = roleIds.map((id) => getRole(id)).filter((r): r is RoleDefinition => r !== undefined);
  const specificityGuidance = nodeRoles.length > 0
    ? nodeRoles.map((r) => r.prompts.specificityGuidance).join(" ")
    : "Be specific: mention file paths, function names, API endpoints.";

  const apiBase = getApiBase();
  const authParam = getAuthParam();

  const prompt = `You are helping a developer write a clear, actionable task node for a coding blueprint.

Blueprint: "${blueprint.title}"
${blueprint.description ? `Blueprint description: ${blueprint.description}` : ""}
${blueprint.projectCwd ? `Project directory: ${blueprint.projectCwd}` : ""}
${depContext ? `\nDependency nodes (this node depends on these — consider their titles and handoff artifacts when enriching):\n${depContext}` : ""}

The user wants to enrich an existing node with:
- Title: "${node.title.trim()}"
${node.description ? `- Description: "${node.description.trim()}"` : "- Description: (none provided)"}

Your task: Enrich and improve the title and description to make them clear and actionable for an AI agent. The enriched description should:
1. Be specific about what needs to be done — ${specificityGuidance}
${depContext ? "2. Build on context from dependency nodes — reference what they produce (handoff artifacts) and how this node continues the work\n3." : "2."} Include acceptance criteria or expected behavior when helpful
${depContext ? "4." : "3."} Stay concise — no fluff

IMPORTANT: Do NOT output JSON in chat. Instead, update the node directly by calling the ClawUI API using curl:

curl -s -X PUT '${apiBase}/api/blueprints/${blueprintId}/nodes/${nodeId}?${authParam}' -H 'Content-Type: application/json' -d '{"title": "your enriched title", "description": "your enriched description"}'

Replace the placeholder values with your actual enriched title and description. Make sure the JSON is valid — escape any special characters in string values.`;

  await runWithRelatedSessionDetection(prompt, blueprint.projectCwd || undefined, nodeId, blueprintId, "enrich", parseAgentParams(blueprint.agentParams));
}

// ─── reevaluateNodeInternal ──────────────────────────────────

/**
 * AI re-evaluate a single node's title, description, and status.
 * Fire-and-forget style: runs the agent call directly.
 * The caller should manage pendingTask tracking if needed.
 *
 * @returns Promise that resolves when the agent call completes.
 */
export async function reevaluateNodeInternal(blueprintId: string, nodeId: string): Promise<void> {
  const blueprint = getBlueprint(blueprintId);
  if (!blueprint) throw new Error("Blueprint not found");
  const node = blueprint.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error("Node not found");

  // Build context about all nodes
  const nodesContext = blueprint.nodes
    .map((n, i) => {
      let line = `  ${i + 1}. [${n.status}] ${n.title}`;
      if (n.error) line += ` (ERROR: ${n.error})`;
      if (n.id === node.id) line += " ← THIS NODE";
      return line;
    })
    .join("\n");

  // Collect output artifacts from completed nodes
  const completedSummaries = blueprint.nodes
    .filter((n) => n.status === "done" && n.outputArtifacts.length > 0)
    .map((n) => `Step "${n.title}": ${n.outputArtifacts[n.outputArtifacts.length - 1].content.slice(0, 300)}`)
    .join("\n");

  const apiBase = getApiBase();
  const authParam = getAuthParam();

  // Build update payload instructions — include status reset for failed/blocked nodes
  const capturedStatus = node.status;
  const statusResetNote = (capturedStatus === "failed" || capturedStatus === "blocked")
    ? `\nIMPORTANT: Because this node's current status is "${capturedStatus}", you MUST also include "status": "pending" in your curl payload to reset it so it can be re-run — UNLESS you determine the blocker/failure reason still applies.`
    : "";
  const statusField = (capturedStatus === "failed" || capturedStatus === "blocked") ? ', "status": "pending"' : "";

  // Resolve roles for role-aware reevaluation
  const reevRoleIds = resolveNodeRoles(node, blueprint);
  const reevRoles = reevRoleIds.map((id) => getRole(id)).filter((r): r is RoleDefinition => r !== undefined);
  const reevVerification = reevRoles.length > 0
    ? reevRoles.map((r) => r.prompts.reevaluationVerification).join("\n")
    : "Read the relevant source files to verify implementation status.";

  const prompt = `You are a project manager reviewing a task node in the context of its parent blueprint/plan.

Blueprint: "${blueprint.title}"
${blueprint.description ? `Blueprint description: ${blueprint.description}` : ""}
${blueprint.projectCwd ? `Project directory: ${blueprint.projectCwd}` : ""}

All nodes in the plan:
${nodesContext}

${completedSummaries ? `Progress from completed steps:\n${completedSummaries}\n` : ""}
The node to re-evaluate:
- Node ID: ${nodeId}
- Title: "${node.title}"
- Description: "${node.description || "(none)"}"
- Current status: ${node.status}
${node.error ? `- Error: ${node.error}` : ""}

Your task: Re-evaluate this node considering the current state of the project. ${reevVerification}

Based on what has already been completed, what is still pending, and whether this node's task is still relevant and accurately described:

1. Update the title to be clear and accurate given the current project state.
2. Update the description to reflect what actually needs to be done (or has been done).
3. If this node's task is ALREADY COMPLETED by another node, is REDUNDANT, OUT OF DATE, or NO LONGER NEEDED, add a warning paragraph at the end of the description starting with "⚠️ WARNING:" explaining why this node should be skipped or deleted.
4. If the node is blocked, evaluate whether the blocking condition still exists. If the blocker has been resolved or is no longer relevant, set status to "pending". If the blocker persists, keep status as "blocked" and update the description to reflect the current blocker state.

IMPORTANT: Do NOT output JSON in chat. Instead, update the node directly by calling the ClawUI API using curl:

curl -s -X PUT '${apiBase}/api/blueprints/${blueprintId}/nodes/${nodeId}?${authParam}' -H 'Content-Type: application/json' -d '{"title": "your updated title", "description": "your updated description", "error": ""${statusField}}'

Replace the placeholder values with your actual updated title and description. Make sure the JSON is valid — escape any special characters in string values.${statusResetNote}`;

  await runWithRelatedSessionDetection(prompt, blueprint.projectCwd || undefined, nodeId, blueprintId, "reevaluate", parseAgentParams(blueprint.agentParams));
}

// ─── splitNodeInternal ───────────────────────────────────────

/**
 * AI-powered node decomposition: splits a node into smaller sub-tasks.
 * The caller should manage pendingTask tracking if needed.
 *
 * @returns Promise that resolves when the agent call completes.
 */
export async function splitNodeInternal(blueprintId: string, nodeId: string): Promise<void> {
  const blueprint = getBlueprint(blueprintId);
  if (!blueprint) throw new Error("Blueprint not found");
  const node = blueprint.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error("Node not found");

  // Find downstream dependents (nodes that depend on this node)
  const downstreamDeps = blueprint.nodes
    .filter((n) => n.dependencies.includes(nodeId))
    .map((n) => ({ id: n.id, title: n.title }));

  // Build context about all nodes (titles + statuses only)
  const nodesContext = blueprint.nodes
    .map((n, i) => {
      let line = `  ${i + 1}. [${n.status}] ${n.title}`;
      if (n.id === nodeId) line += " ← THIS NODE (to be split)";
      return line;
    })
    .join("\n");

  const apiBase = getApiBase();
  const authParam = getAuthParam();

  const downstreamInfo = downstreamDeps.length > 0
    ? `\nDownstream nodes that currently depend on this node (their dependencies must be rewired to point to the LAST sub-node):\n${downstreamDeps.map((d) => `  - ${d.id} ("${d.title}")`).join("\n")}`
    : "\nNo downstream nodes depend on this node.";

  const depsJson = JSON.stringify(node.dependencies);

  // Resolve roles for role-aware split decomposition
  const splitRoleIds = resolveNodeRoles(node, blueprint);
  const splitRoles = splitRoleIds.map((id) => getRole(id)).filter((r): r is RoleDefinition => r !== undefined);
  const splitHeuristic = splitRoles.length > 0
    ? splitRoles.map((r) => r.prompts.decompositionHeuristic).join("\n")
    : "Each sub-node should be completable in one agent session (5-15 min).";
  const splitSpecificity = splitRoles.length > 0
    ? splitRoles.map((r) => r.prompts.specificityGuidance).join(" ")
    : "Be specific: mention file paths, function names, API endpoints.";

  const prompt = `You are a project manager splitting a large task into smaller, more actionable sub-tasks.

Blueprint: "${blueprint.title}"
${blueprint.description ? `Blueprint description: ${blueprint.description}` : ""}
${blueprint.projectCwd ? `Project directory: ${blueprint.projectCwd}` : ""}

All nodes in the plan:
${nodesContext}

The node to split:
- Node ID: ${nodeId}
- Title: "${node.title}"
- Description: "${node.description || "(none)"}"
- Dependencies: ${depsJson}
${downstreamInfo}

Your task: Decompose this node into 2-3 smaller, self-contained sub-nodes. Each sub-node should be completable in a single agent session. Think carefully about logical boundaries.

Execute these steps IN ORDER using curl:

**Step 1 — Create sub-nodes via batch-create:**
The first sub-node must inherit the original node's dependencies: ${depsJson}
Subsequent sub-nodes should depend on the previous one (use integer index: 0 for first created, 1 for second, etc.).

curl -s -X POST '${apiBase}/api/blueprints/${blueprintId}/nodes/batch-create?${authParam}' -H 'Content-Type: application/json' -d '[
  {"title": "Sub-task 1 title", "description": "Sub-task 1 description", "dependencies": ${depsJson}},
  {"title": "Sub-task 2 title", "description": "Sub-task 2 description", "dependencies": [0]},
  {"title": "Sub-task 3 title (if needed)", "description": "Sub-task 3 description", "dependencies": [1]}
]'

IMPORTANT: The response will contain a "nodes" array with the created nodes and their IDs. You MUST read the response to get the ID of the LAST created sub-node for step 2.

${downstreamDeps.length > 0 ? `**Step 2 — Rewire downstream dependents:**
For each downstream node, replace "${nodeId}" in their dependencies with the ID of the LAST sub-node you created.

${downstreamDeps.map((d) => `curl -s -X PUT '${apiBase}/api/blueprints/${blueprintId}/nodes/${d.id}?${authParam}' -H 'Content-Type: application/json' -d '{"dependencies": [REPLACE_WITH_CORRECT_DEPS]}'
# Original deps for "${d.title}": replace "${nodeId}" with the last sub-node's ID`).join("\n\n")}

IMPORTANT: When updating dependencies, keep ALL existing dependencies — only replace "${nodeId}" with the last sub-node ID. Fetch the node first if you need to see its current deps.` : "**Step 2 — No downstream rewiring needed** (no nodes depend on this one)."}

**Step ${downstreamDeps.length > 0 ? "3" : "2"} — Mark original node as skipped:**
curl -s -X PUT '${apiBase}/api/blueprints/${blueprintId}/nodes/${nodeId}?${authParam}' -H 'Content-Type: application/json' -d '{"status": "skipped"}'

Guidelines for decomposition:
${splitHeuristic}
- Descriptions should be specific and actionable for an AI agent — ${splitSpecificity}
- Preserve the intent and scope of the original node — don't add or remove work
- If the task naturally has only 2 parts, use 2 sub-nodes (don't force 3)`;

  await runWithRelatedSessionDetection(prompt, blueprint.projectCwd || undefined, nodeId, blueprintId, "split", parseAgentParams(blueprint.agentParams));
}

// ─── smartDepsInternal ───────────────────────────────────────

/**
 * AI-powered dependency selection for a node.
 * The caller should manage pendingTask tracking if needed.
 *
 * @returns Promise that resolves when the agent call completes.
 */
export async function smartDepsInternal(blueprintId: string, nodeId: string): Promise<void> {
  const blueprint = getBlueprint(blueprintId);
  if (!blueprint) throw new Error("Blueprint not found");
  const node = blueprint.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error("Node not found");

  const siblingNodes = blueprint.nodes.filter((n) => n.id !== nodeId && n.status !== "skipped");
  if (siblingNodes.length === 0) throw new Error("No other nodes to depend on");

  // Build node list for context (titles + statuses + IDs, no descriptions)
  const nodesContext = siblingNodes
    .map((n) => {
      let line = `  - ID: ${n.id} | #${n.seq} [${n.status}] "${n.title}"`;
      if (n.status === "done" && n.outputArtifacts.length > 0) {
        line += ` — Handoff: ${n.outputArtifacts[n.outputArtifacts.length - 1].content.slice(0, 200)}`;
      }
      return line;
    })
    .join("\n");

  const apiBase = getApiBase();
  const authParam = getAuthParam();

  // Resolve roles for role-aware dependency considerations
  const sdRoleIds = resolveNodeRoles(node, blueprint);
  const sdRoles = sdRoleIds.map((id) => getRole(id)).filter((r): r is RoleDefinition => r !== undefined);
  const depConsiderations = sdRoles.length > 0
    ? sdRoles.map((r) => r.prompts.dependencyConsiderations).join("\n")
    : "1. Data flow: Does this node need output/artifacts from another node?\n2. Code dependencies: Does this node modify code that another node creates?\n3. Logical ordering: Must another task complete first for this one to make sense?";

  const prompt = `You are analyzing a blueprint to determine the correct dependencies for a specific task node.

Blueprint: "${blueprint.title}"
${blueprint.description ? `Blueprint description: ${blueprint.description}` : ""}
${blueprint.projectCwd ? `Project directory: ${blueprint.projectCwd}` : ""}

Target node (the node that needs dependencies):
- Title: "${node.title}"
- Description: "${node.description || "(none)"}"
- Current dependencies: ${node.dependencies.length > 0 ? node.dependencies.map((d) => {
      const dn = blueprint.nodes.find((n) => n.id === d);
      return dn ? `"${dn.title}"` : d;
    }).join(", ") : "(none)"}

Available nodes that could be dependencies:
${nodesContext}

Your task: Pick the most relevant dependencies for the target node — nodes whose output or completion is logically required before this node can start. Consider:
${depConsiderations}

Rules:
- Pick 0-3 dependencies (only pick ones that are truly needed)
- Prefer "done" nodes as dependencies when they provide relevant context
- Do NOT pick nodes that are independent/parallel work
- If no dependencies are needed, use an empty array

IMPORTANT: Do NOT output JSON in chat. Instead, update the node directly by calling the ClawUI API using curl:

curl -s -X PUT '${apiBase}/api/blueprints/${blueprintId}/nodes/${nodeId}?${authParam}' -H 'Content-Type: application/json' -d '{"dependencies": ["nodeId1", "nodeId2"]}'

Replace the nodeId values with actual IDs from the available nodes list above. Use an empty array if no dependencies are needed.`;

  await runWithRelatedSessionDetection(prompt, blueprint.projectCwd || undefined, nodeId, blueprintId, "smart_deps", parseAgentParams(blueprint.agentParams));
}

// ─── reevaluateAllInternal ───────────────────────────────────

/**
 * AI re-evaluate all non-done nodes in a blueprint.
 * Runs a single agent call that uses the batch update API.
 * The caller should manage pendingTask tracking if needed.
 *
 * @returns The list of node IDs that were included in the reevaluation.
 */
export async function reevaluateAllInternal(blueprintId: string): Promise<string[]> {
  const blueprint = getBlueprint(blueprintId);
  if (!blueprint) throw new Error("Blueprint not found");

  const nonDoneNodes = blueprint.nodes.filter(
    (n) => n.status !== "done" && n.status !== "running" && n.status !== "queued",
  );
  if (nonDoneNodes.length === 0) return [];

  // Build full context about all nodes and their statuses
  const nodeIdMap = Object.fromEntries(blueprint.nodes.map((n) => [n.id, n]));
  const nodesContext = blueprint.nodes
    .map((n, i) => {
      const depsStr = n.dependencies.length > 0
        ? ` [depends on: ${n.dependencies.map((d) => nodeIdMap[d]?.title ?? d).join(", ")}]`
        : "";
      let line = `  ${i + 1}. (id: ${n.id}) [${n.status}] ${n.title}${depsStr}`;
      if (n.error) line += ` (ERROR: ${n.error})`;
      return line;
    })
    .join("\n");

  // Collect output artifacts from completed nodes
  const completedSummaries = blueprint.nodes
    .filter((n) => n.status === "done" && n.outputArtifacts.length > 0)
    .map((n) => `Step "${n.title}": ${n.outputArtifacts[n.outputArtifacts.length - 1].content.slice(0, 300)}`)
    .join("\n");

  // Build list of nodes to reevaluate with IDs
  const targetNodesList = nonDoneNodes
    .map((n) => `  - id: "${n.id}", title: "${n.title}", status: "${n.status}", dependencies: [${n.dependencies.map((d) => `"${d}"`).join(", ")}]`)
    .join("\n");

  // Valid node IDs for dependency reference
  const validNodeIds = blueprint.nodes.map((n) => `"${n.id}" (${n.title})`).join(", ");

  // Resolve blueprint-level enabled roles for reevaluate-all verification
  const reevAllRoleIds = blueprint.enabledRoles ?? ["sde"];
  const reevAllRoles = reevAllRoleIds.map((id) => getRole(id)).filter((r): r is RoleDefinition => r !== undefined);
  const reevAllVerification = reevAllRoles.length > 0
    ? reevAllRoles.map((r) => r.prompts.reevaluationVerification).join("\n\n")
    : "For EACH node listed above, reevaluate it by examining the actual codebase:\n\n1. Read the relevant source files to verify implementation status.\n2. Then DIRECTLY update ALL nodes in a SINGLE batch API call.";

  const apiBase = getApiBase();
  const authParam = getAuthParam();

  const prompt = `You are a project manager reviewing a blueprint/plan and reevaluating all incomplete nodes.

Blueprint: "${blueprint.title}"
${blueprint.description ? `Blueprint description: ${blueprint.description}` : ""}
${blueprint.projectCwd ? `Project directory: ${blueprint.projectCwd}` : ""}

All nodes in the plan:
${nodesContext}

${completedSummaries ? `Progress from completed steps:\n${completedSummaries}\n` : ""}
Nodes to reevaluate:
${targetNodesList}

Valid node IDs for dependencies: ${validNodeIds}

${reevAllVerification}

Batch API endpoint: PUT ${apiBase}/api/blueprints/${blueprintId}/nodes/batch?${authParam}
Content-Type: application/json

The body is a JSON ARRAY of node updates. Each element has:
- "id": (REQUIRED) the node ID
- "title": updated title string
- "description": updated description string
- "status": one of "pending", "done", "skipped", "blocked" (set "done" if fully implemented, "skipped" if redundant, "pending" if a previously blocked node's blocker is resolved, "blocked" if a blocker still persists)
- "dependencies": array of node ID strings (only use valid IDs from the list above)
- "error": error message string (set to "" to clear)

Guidelines:
1. Verify actual project state — do NOT guess implementation status.
2. If fully implemented → set status to "done".
3. If partially implemented → keep "pending", describe what remains.
4. If redundant/obsolete → set to "skipped", explain why in description.
5. If blocked and blocker is resolved → set to "pending". If blocker persists → keep "blocked" and update description.
6. Update dependencies if needed (remove invalid, add missing).
7. You MUST make ONE batch API call with ALL node updates — do NOT call individual endpoints.

Example (updates all nodes in one call):
curl -X PUT '${apiBase}/api/blueprints/${blueprintId}/nodes/batch?${authParam}' -H "Content-Type: application/json" -d '[{"id":"node-id-1", "title":"...", "description":"...", "status":"done"}, {"id":"node-id-2", "title":"...", "status":"skipped"}]'`;

  const REEVALUATE_TIMEOUT = 32 * 60 * 1000; // 32 min (30 min exec + 2 min grace)
  const reevAllBefore = new Date();
  const reevAllCwd = blueprint.projectCwd;
  const reevAllNodeIds = nonDoneNodes.map((n) => n.id);

  await withTimeout(
    runClaudeInteractive(prompt, reevAllCwd || undefined, parseAgentParams(blueprint.agentParams)),
    REEVALUATE_TIMEOUT,
    "Reevaluate-all timed out after 32 minutes",
  );

  // Capture session for all reevaluated nodes (single session covers all)
  if (reevAllCwd) {
    const sessionId = detectNewSession(reevAllCwd, reevAllBefore);
    if (sessionId) {
      const now = new Date().toISOString();
      for (const nid of reevAllNodeIds) {
        createRelatedSession(nid, blueprintId, sessionId, "reevaluate_all", reevAllBefore.toISOString(), now);
      }
      log.debug(`Captured reevaluate-all session ${sessionId.slice(0, 8)} for ${reevAllNodeIds.length} nodes`);
    }
  }

  return reevAllNodeIds;
}
