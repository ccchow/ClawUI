import { Router } from "express";
import { existsSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import express from "express";
import {
  createBlueprint,
  getBlueprint,
  listBlueprints,
  updateBlueprint,
  deleteBlueprint,
  archiveBlueprint,
  unarchiveBlueprint,
  createMacroNode,
  updateMacroNode,
  deleteMacroNode,
  reorderMacroNodes,
  createArtifact,
  getArtifactsForNode,
  deleteArtifact,
  createExecution,
  updateExecution,
  getExecution,
  getExecutionsForNode,
  getExecutionBySession,
  getNodeBySession,
  setExecutionBlocker,
  setExecutionTaskSummary,
  setExecutionReportedStatus,
  createRelatedSession,
  getRelatedSessionsForNode,
} from "./plan-db.js";
import type { ArtifactType, ExecutionType, MacroNode, ReportedStatus, RelatedSessionType } from "./plan-db.js";
import { executeNode, executeNextNode, executeAllNodes, enqueueBlueprintTask, getQueueInfo, getGlobalQueueInfo, addPendingTask, removePendingTask, removeQueuedTask, detectNewSession, runClaudeInteractive, withTimeout, evaluateNodeCompletion, applyGraphMutations, resumeNodeSession } from "./plan-executor.js";
import type { CompletionEvaluation } from "./plan-executor.js";
import { runClaudeInteractiveGen, getApiBase, getAuthParam } from "./plan-generator.js";
import { createLogger } from "./logger.js";
import { CLAWUI_DB_DIR } from "./config.js";


const log = createLogger("plan-routes");

/** Return a sanitized error message for API responses (no stack traces or internal paths). */
function safeError(err: unknown): string {
  if (err instanceof Error) {
    // Allow specific user-facing error messages through
    if (err.message.includes("not found") || err.message.includes("Invalid") || err.message.includes("Missing")) {
      return err.message;
    }
  }
  return "Internal server error";
}

/**
 * Helper to detect and record a related session after an interactive CLI call.
 * Uses the same detectNewSession pattern as executeNodeInternal.
 */
function captureRelatedSession(
  projectCwd: string | undefined,
  beforeTimestamp: Date,
  nodeId: string,
  blueprintId: string,
  type: RelatedSessionType,
): void {
  if (!projectCwd) return;
  const sessionId = detectNewSession(projectCwd, beforeTimestamp);
  if (sessionId) {
    const now = new Date().toISOString();
    createRelatedSession(nodeId, blueprintId, sessionId, type, beforeTimestamp.toISOString(), now);
    log.debug(`Captured related session: type=${type}, nodeId=${nodeId.slice(0, 8)}, sessionId=${sessionId.slice(0, 8)}`);
  }
}

const planRouter = Router();

// ─── Enrichment callback store (for Smart Create) ────────────
// In-memory store: Claude posts enrichment results via curl callback instead of writing temp files.
const enrichmentCallbacks = new Map<string, {
  resolve: (result: { title: string; description: string }) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

// POST /api/enrichment-callback/:requestId — callback for Smart Create enrichment
planRouter.post("/api/enrichment-callback/:requestId", (req, res) => {
  const entry = enrichmentCallbacks.get(req.params.requestId);
  if (!entry) {
    res.status(404).json({ error: "Unknown or expired enrichment request" });
    return;
  }
  const { title, description } = req.body as { title?: string; description?: string };
  if (!title || typeof title !== "string") {
    res.status(400).json({ error: "Missing or invalid 'title'" });
    return;
  }
  clearTimeout(entry.timer);
  enrichmentCallbacks.delete(req.params.requestId);
  entry.resolve({ title, description: description || "" });
  res.json({ ok: true });
});

function waitForEnrichmentCallback(requestId: string, timeoutMs = 120_000): Promise<{ title: string; description: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      enrichmentCallbacks.delete(requestId);
      reject(new Error("Enrichment callback timed out"));
    }, timeoutMs);
    enrichmentCallbacks.set(requestId, { resolve, reject, timer });
  });
}

// ─── Blueprint CRUD ──────────────────────────────────────────

// POST /api/blueprints — create blueprint
planRouter.post("/api/blueprints", (req, res) => {
  try {
    const { title, description, projectCwd } = req.body as {
      title?: string;
      description?: string;
      projectCwd?: string;
    };
    if (!title || typeof title !== "string" || title.trim().length === 0) {
      res.status(400).json({ error: "Missing or empty 'title'" });
      return;
    }
    if (projectCwd && typeof projectCwd === "string" && projectCwd.trim().length > 0) {
      const cwd = projectCwd.trim();
      if (!existsSync(cwd)) {
        res.status(400).json({ error: `Project directory does not exist: ${cwd}` });
        return;
      }
      if (!statSync(cwd).isDirectory()) {
        res.status(400).json({ error: `Path is not a directory: ${cwd}` });
        return;
      }
      if (!existsSync(join(cwd, "CLAUDE.md"))) {
        res.status(400).json({ error: `No CLAUDE.md found at ${cwd}. A CLAUDE.md file is required to identify a valid Claude Code workspace.` });
        return;
      }
    }
    const blueprint = createBlueprint(title.trim(), description, projectCwd);
    res.status(201).json(blueprint);
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// GET /api/blueprints — list blueprints
planRouter.get("/api/blueprints", (req, res) => {
  try {
    const status = req.query.status as string | undefined;
    const projectCwd = req.query.projectCwd as string | undefined;
    const includeArchived = req.query.includeArchived === "true";
    const blueprints = listBlueprints({ status, projectCwd, includeArchived });
    res.json(blueprints);
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// GET /api/blueprints/:id — get blueprint with nodes
planRouter.get("/api/blueprints/:id", (req, res) => {
  try {
    const blueprint = getBlueprint(req.params.id);
    if (!blueprint) {
      res.status(404).json({ error: "Blueprint not found" });
      return;
    }
    res.json(blueprint);
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// PUT /api/blueprints/:id — update blueprint metadata
planRouter.put("/api/blueprints/:id", (req, res) => {
  try {
    const patch = req.body as Record<string, unknown>;
    const blueprint = updateBlueprint(req.params.id, patch);
    if (!blueprint) {
      res.status(404).json({ error: "Blueprint not found" });
      return;
    }
    res.json(blueprint);
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// DELETE /api/blueprints/:id — delete blueprint and all nodes
planRouter.delete("/api/blueprints/:id", (req, res) => {
  try {
    const blueprint = getBlueprint(req.params.id);
    if (!blueprint) {
      res.status(404).json({ error: "Blueprint not found" });
      return;
    }
    deleteBlueprint(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// POST /api/blueprints/:id/archive — archive a blueprint
planRouter.post("/api/blueprints/:id/archive", (req, res) => {
  try {
    const result = archiveBlueprint(req.params.id);
    if (!result) {
      res.status(404).json({ error: "Blueprint not found" });
      return;
    }
    res.json(result);
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// POST /api/blueprints/:id/unarchive — unarchive a blueprint
planRouter.post("/api/blueprints/:id/unarchive", (req, res) => {
  try {
    const result = unarchiveBlueprint(req.params.id);
    if (!result) {
      res.status(404).json({ error: "Blueprint not found" });
      return;
    }
    res.json(result);
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// ─── MacroNode operations ────────────────────────────────────

// POST /api/blueprints/:blueprintId/enrich-node — AI-enrich title & description
planRouter.post("/api/blueprints/:blueprintId/enrich-node", async (req, res) => {
  try {
    const blueprintId = req.params.blueprintId;
    const blueprint = getBlueprint(blueprintId);
    if (!blueprint) {
      res.status(404).json({ error: "Blueprint not found" });
      return;
    }
    const { title, description, nodeId } = req.body as { title?: string; description?: string; nodeId?: string };
    if (!title || typeof title !== "string" || title.trim().length === 0) {
      res.status(400).json({ error: "Missing or empty 'title'" });
      return;
    }

    // Validate nodeId if provided
    if (nodeId) {
      const node = blueprint.nodes.find((n) => n.id === nodeId);
      if (!node) {
        res.status(404).json({ error: "Node not found" });
        return;
      }
    }

    // Build context: if the node has dependencies, only show those deps (saves tokens).
    // Otherwise fall back to showing all nodes for broader context.
    const currentNode = nodeId ? blueprint.nodes.find((n) => n.id === nodeId) : null;
    const depIds = currentNode?.dependencies ?? [];
    const contextNodes = depIds.length > 0
      ? blueprint.nodes.filter((n) => depIds.includes(n.id))
      : blueprint.nodes;
    const contextLabel = depIds.length > 0 ? "Dependency nodes" : "Existing nodes";

    // Titles + handoff summaries only, no descriptions
    const existingNodes = contextNodes
      .map((n, i) => {
        let line = `  ${i + 1}. [${n.status}] ${n.title}`;
        if (n.status === "done" && n.outputArtifacts.length > 0) {
          line += ` — Handoff: ${n.outputArtifacts[n.outputArtifacts.length - 1].content.slice(0, 300)}`;
        }
        return line;
      })
      .join("\n");

    const enrichPromptBase = `You are helping a developer write a clear, actionable task node for a coding blueprint.

Blueprint: "${blueprint.title}"
${blueprint.description ? `Blueprint description: ${blueprint.description}` : ""}
${blueprint.projectCwd ? `Project directory: ${blueprint.projectCwd}` : ""}
${existingNodes ? `\n${contextLabel}:\n${existingNodes}` : "\nNo existing nodes yet."}

The user wants to add a new node with:
- Title: "${title.trim()}"
${description ? `- Description: "${description.trim()}"` : "- Description: (none provided)"}

Your task: Enrich and improve the title and description to make them clear and actionable for an AI coding agent. The enriched description should:
1. Be specific about what needs to be done
2. Reference relevant files/components if the project context suggests them
3. Include acceptance criteria or expected behavior when helpful
4. Stay concise — no fluff`;

    if (nodeId) {
      // Existing node: fire-and-forget — Claude writes directly to DB via curl.
      // Return immediately so the HTTP response doesn't block for minutes.
      const apiBase = getApiBase();
      const authParam = getAuthParam();

      const prompt = `${enrichPromptBase}

IMPORTANT: Do NOT output JSON in chat. Instead, update the node directly by calling the ClawUI API using curl:

curl -s -X PUT '${apiBase}/api/blueprints/${blueprintId}/nodes/${nodeId}?${authParam}' -H 'Content-Type: application/json' -d '{"title": "your enriched title", "description": "your enriched description"}'

Replace the placeholder values with your actual enriched title and description. Make sure the JSON is valid — escape any special characters in string values.`;

      const enrichBefore = new Date();
      const enrichNodeId = nodeId;
      addPendingTask(blueprintId, { type: "enrich", nodeId: enrichNodeId, queuedAt: new Date().toISOString() });
      enqueueBlueprintTask(blueprintId, async () => {
        try {
          await runClaudeInteractiveGen(prompt, blueprint.projectCwd || undefined);
        } finally {
          removePendingTask(blueprintId, enrichNodeId, "enrich");
        }
      }).then(() => {
        captureRelatedSession(blueprint.projectCwd, enrichBefore, enrichNodeId, blueprintId, "enrich");
      }).catch((err) => {
        log.error(`Enrich node ${enrichNodeId} failed: ${err instanceof Error ? err.message : err}`);
      });

      res.json({ status: "queued", nodeId });
    } else {
      // New node (Smart Create): use API callback (same pattern as evaluation/generate)
      // Register callback INSIDE the enqueued task so the 120s timeout doesn't start
      // until the task actually begins executing (not while waiting in queue).
      const requestId = randomUUID();
      const apiBase = getApiBase();
      const authParam = getAuthParam();

      const prompt = `${enrichPromptBase}

IMPORTANT: Do NOT output JSON in chat. Instead, post your enriched result by calling the ClawUI API using curl:

curl -s -X POST '${apiBase}/api/enrichment-callback/${requestId}?${authParam}' -H 'Content-Type: application/json' -d '{"title": "your enriched title", "description": "your enriched description"}'

Replace the placeholder values with your actual enriched title and description. Make sure the JSON is valid — escape any special characters in string values.`;

      let resultPromise: ReturnType<typeof waitForEnrichmentCallback>;
      await enqueueBlueprintTask(blueprintId, async () => {
        resultPromise = waitForEnrichmentCallback(requestId);
        await runClaudeInteractiveGen(prompt, blueprint.projectCwd || undefined);
      });

      const result = await resultPromise!;
      res.json({ title: result.title, description: result.description });
    }
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// POST /api/blueprints/:blueprintId/nodes/:nodeId/reevaluate — AI re-evaluate node title & description
// Fire-and-forget: returns immediately with {status:"queued"}, applies results in background
planRouter.post("/api/blueprints/:blueprintId/nodes/:nodeId/reevaluate", (req, res) => {
  try {
    const blueprint = getBlueprint(req.params.blueprintId);
    if (!blueprint) {
      res.status(404).json({ error: "Blueprint not found" });
      return;
    }
    const node = blueprint.nodes.find((n) => n.id === req.params.nodeId);
    if (!node) {
      res.status(404).json({ error: "Node not found" });
      return;
    }

    const blueprintId = req.params.blueprintId;
    const nodeId = req.params.nodeId;

    // Track in pending tasks for queue status API
    addPendingTask(blueprintId, { type: "reevaluate", nodeId, queuedAt: new Date().toISOString() });

    // Build context about all nodes (titles + handoff summaries only, no descriptions)
    const nodesContext = blueprint.nodes
      .map((n, i) => {
        let line = `  ${i + 1}. [${n.status}] ${n.title}`;
        if (n.error) line += ` (ERROR: ${n.error})`;
        if (n.id === node.id) line += " ← THIS NODE";
        return line;
      })
      .join("\n");

    // Collect output artifacts from completed nodes as project progress context
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

    const prompt = `You are a project manager reviewing a development task node in the context of its parent blueprint/plan.

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

Your task: Re-evaluate this node considering the current state of the project. Based on what has already been completed, what is still pending, and whether this node's task is still relevant and accurately described:

1. Update the title to be clear and accurate given the current project state.
2. Update the description to reflect what actually needs to be done (or has been done).
3. If this node's task is ALREADY COMPLETED by another node, is REDUNDANT, OUT OF DATE, or NO LONGER NEEDED, add a warning paragraph at the end of the description starting with "⚠️ WARNING:" explaining why this node should be skipped or deleted.
4. If the node is blocked, evaluate whether the blocking condition still exists. If the blocker has been resolved or is no longer relevant, set status to "pending". If the blocker persists, keep status as "blocked" and update the description to reflect the current blocker state.

IMPORTANT: Do NOT output JSON in chat. Instead, update the node directly by calling the ClawUI API using curl:

curl -s -X PUT '${apiBase}/api/blueprints/${blueprintId}/nodes/${nodeId}?${authParam}' -H 'Content-Type: application/json' -d '{"title": "your updated title", "description": "your updated description", "error": ""${statusField}}'

Replace the placeholder values with your actual updated title and description. Make sure the JSON is valid — escape any special characters in string values.${statusResetNote}`;

    // Fire and forget — enqueue and apply results when done
    const reevBefore = new Date();
    const reevCwd = blueprint.projectCwd;
    enqueueBlueprintTask(blueprintId, async () => {
      try {
        await runClaudeInteractiveGen(prompt, reevCwd || undefined);
        captureRelatedSession(reevCwd, reevBefore, nodeId, blueprintId, "reevaluate");
      } finally {
        removePendingTask(blueprintId, nodeId, "reevaluate");
      }
    }).catch(err => {
      const errMsg = err instanceof Error ? err.message : String(err);
      updateMacroNode(blueprintId, nodeId, {
        error: `Re-evaluate failed: ${errMsg.slice(0, 200)}`,
      });
      log.error(`Reevaluate node ${nodeId} failed: ${errMsg}`);
    });

    res.json({ status: "queued", nodeId });
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// POST /api/blueprints/:blueprintId/nodes/:nodeId/split — AI-powered node decomposition
// Fire-and-forget: returns immediately with {status:"queued"}, creates sub-nodes in background
planRouter.post("/api/blueprints/:blueprintId/nodes/:nodeId/split", (req, res) => {
  try {
    const blueprint = getBlueprint(req.params.blueprintId);
    if (!blueprint) {
      res.status(404).json({ error: "Blueprint not found" });
      return;
    }
    const node = blueprint.nodes.find((n) => n.id === req.params.nodeId);
    if (!node) {
      res.status(404).json({ error: "Node not found" });
      return;
    }
    if (node.status !== "pending") {
      res.status(400).json({ error: "Only pending nodes can be split" });
      return;
    }

    const blueprintId = req.params.blueprintId;
    const nodeId = req.params.nodeId;

    // Find downstream dependents (nodes that depend on this node)
    const downstreamDeps = blueprint.nodes
      .filter((n) => n.dependencies.includes(nodeId))
      .map((n) => ({ id: n.id, title: n.title }));

    // Track in pending tasks for queue status API
    addPendingTask(blueprintId, { type: "split", nodeId, queuedAt: new Date().toISOString() });

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

    const prompt = `You are a project manager splitting a large development task into smaller, more actionable sub-tasks.

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

Your task: Decompose this node into 2-3 smaller, self-contained sub-nodes. Each sub-node should be completable in a single Claude Code session. Think carefully about logical boundaries.

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
- Each sub-node should be independently testable and completable
- Descriptions should be specific and actionable for an AI coding agent
- Preserve the intent and scope of the original node — don't add or remove work
- If the task naturally has only 2 parts, use 2 sub-nodes (don't force 3)`;

    // Fire and forget — enqueue and apply results when done
    const splitBefore = new Date();
    const splitCwd = blueprint.projectCwd;
    enqueueBlueprintTask(blueprintId, async () => {
      try {
        await runClaudeInteractiveGen(prompt, splitCwd || undefined);
        captureRelatedSession(splitCwd, splitBefore, nodeId, blueprintId, "split");
      } finally {
        removePendingTask(blueprintId, nodeId, "split");
      }
    }).catch(err => {
      const errMsg = err instanceof Error ? err.message : String(err);
      updateMacroNode(blueprintId, nodeId, {
        error: `Split failed: ${errMsg.slice(0, 200)}`,
      });
      log.error(`Split node ${nodeId} failed: ${errMsg}`);
    });

    res.json({ status: "queued", nodeId });
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// POST /api/blueprints/:blueprintId/nodes/:nodeId/smart-dependencies — AI-powered dependency selection
planRouter.post("/api/blueprints/:blueprintId/nodes/:nodeId/smart-dependencies", (req, res) => {
  try {
    const blueprintId = req.params.blueprintId;
    const blueprint = getBlueprint(blueprintId);
    if (!blueprint) {
      res.status(404).json({ error: "Blueprint not found" });
      return;
    }
    const nodeId = req.params.nodeId;
    const node = blueprint.nodes.find((n) => n.id === nodeId);
    if (!node) {
      res.status(404).json({ error: "Node not found" });
      return;
    }
    if (!["pending", "failed", "blocked"].includes(node.status)) {
      res.status(400).json({ error: "Smart dependencies only available for pending/failed/blocked nodes" });
      return;
    }

    const siblingNodes = blueprint.nodes.filter((n) => n.id !== nodeId && n.status !== "skipped");
    if (siblingNodes.length === 0) {
      res.status(400).json({ error: "No other nodes to depend on" });
      return;
    }

    addPendingTask(blueprintId, { type: "smart_deps", nodeId, queuedAt: new Date().toISOString() });

    // Build node list for context (titles + statuses + IDs, no descriptions)
    const nodesContext = siblingNodes
      .map((n) => {
        let line = `  - ID: ${n.id} | #${n.order + 1} [${n.status}] "${n.title}"`;
        if (n.status === "done" && n.outputArtifacts.length > 0) {
          line += ` — Handoff: ${n.outputArtifacts[n.outputArtifacts.length - 1].content.slice(0, 200)}`;
        }
        return line;
      })
      .join("\n");

    const apiBase = getApiBase();
    const authParam = getAuthParam();

    const prompt = `You are analyzing a development blueprint to determine the correct dependencies for a specific task node.

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
1. Data flow: Does this node need output/artifacts from another node?
2. Code dependencies: Does this node modify code that another node creates?
3. Logical ordering: Must another task complete first for this one to make sense?

Rules:
- Pick 0-3 dependencies (only pick ones that are truly needed)
- Prefer "done" nodes as dependencies when they provide relevant context
- Do NOT pick nodes that are independent/parallel work
- If no dependencies are needed, use an empty array

IMPORTANT: Do NOT output JSON in chat. Instead, update the node directly by calling the ClawUI API using curl:

curl -s -X PUT '${apiBase}/api/blueprints/${blueprintId}/nodes/${nodeId}?${authParam}' -H 'Content-Type: application/json' -d '{"dependencies": ["nodeId1", "nodeId2"]}'

Replace the nodeId values with actual IDs from the available nodes list above. Use an empty array if no dependencies are needed.`;

    const smartDepsBefore = new Date();
    const smartDepsCwd = blueprint.projectCwd;
    enqueueBlueprintTask(blueprintId, async () => {
      try {
        await runClaudeInteractiveGen(prompt, smartDepsCwd || undefined);
        captureRelatedSession(smartDepsCwd, smartDepsBefore, nodeId, blueprintId, "smart_deps");
      } finally {
        removePendingTask(blueprintId, nodeId, "smart_deps");
      }
    }).catch(err => {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error(`Smart dependencies for node ${nodeId} failed: ${errMsg}`);
    });

    res.json({ status: "queued", nodeId });
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// PUT /api/blueprints/:blueprintId/nodes/batch — batch update multiple nodes
planRouter.put("/api/blueprints/:blueprintId/nodes/batch", (req, res) => {
  try {
    const blueprint = getBlueprint(req.params.blueprintId);
    if (!blueprint) {
      res.status(404).json({ error: "Blueprint not found" });
      return;
    }
    const updates = req.body as Array<{
      id: string;
      title?: string;
      description?: string;
      status?: string;
      dependencies?: string[];
      error?: string;
    }>;
    if (!Array.isArray(updates)) {
      res.status(400).json({ error: "Body must be a JSON array" });
      return;
    }

    const validIds = new Set(blueprint.nodes.map((n) => n.id));
    const results: { id: string; updated: boolean; error?: string }[] = [];

    for (const update of updates) {
      if (!update.id || !validIds.has(update.id)) {
        results.push({ id: update.id, updated: false, error: "Node not found" });
        continue;
      }
      const { id, ...patch } = update;
      // Filter dependencies to valid IDs only
      if (Array.isArray(patch.dependencies)) {
        patch.dependencies = patch.dependencies.filter((d) => validIds.has(d));
      }
      try {
        updateMacroNode(req.params.blueprintId, id, patch as Record<string, unknown>);
        results.push({ id, updated: true });
      } catch (err) {
        results.push({ id, updated: false, error: String(err) });
      }
    }

    res.json({ updated: results.filter((r) => r.updated).length, total: updates.length, results });
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// POST /api/blueprints/:blueprintId/nodes/batch-create — create multiple nodes at once
// Returns created node IDs so callers can reference them for inter-batch dependencies.
planRouter.post("/api/blueprints/:blueprintId/nodes/batch-create", (req, res) => {
  try {
    const blueprint = getBlueprint(req.params.blueprintId);
    if (!blueprint) {
      res.status(404).json({ error: "Blueprint not found" });
      return;
    }
    const nodes = req.body as Array<{
      title: string;
      description?: string;
      order?: number;
      dependencies?: (string | number)[];
    }>;
    if (!Array.isArray(nodes)) {
      res.status(400).json({ error: "Body must be a JSON array of nodes" });
      return;
    }

    const existingNodeIds = new Set(blueprint.nodes.map((n) => n.id));
    const maxOrder = Math.max(0, ...blueprint.nodes.map((n) => n.order));
    const createdNodes: MacroNode[] = [];

    for (let i = 0; i < nodes.length; i++) {
      const step = nodes[i];
      if (!step.title || typeof step.title !== "string") {
        continue; // skip invalid entries
      }
      // Resolve dependencies: string = existing node ID, number = index into this batch
      const depIds = (step.dependencies || [])
        .map((dep) => {
          if (typeof dep === "number") {
            return dep >= 0 && dep < createdNodes.length ? createdNodes[dep].id : null;
          }
          if (typeof dep === "string") {
            // Accept both existing node IDs and already-created batch IDs
            return existingNodeIds.has(dep) || createdNodes.some((n) => n.id === dep) ? dep : null;
          }
          return null;
        })
        .filter((id): id is string => id !== null);

      const node = createMacroNode(req.params.blueprintId, {
        title: step.title,
        description: step.description,
        order: step.order ?? maxOrder + i + 1,
        dependencies: depIds.length > 0 ? depIds : undefined,
      });
      createdNodes.push(node);
    }

    res.status(201).json({ created: createdNodes.length, nodes: createdNodes });
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// POST /api/blueprints/:blueprintId/nodes/:nodeId/insert-between — INSERT_BETWEEN graph mutation
// Creates a refinement node between a completed node and its downstream dependents.
// Rewires all dependents of :nodeId to depend on the new node instead.
planRouter.post("/api/blueprints/:blueprintId/nodes/:nodeId/insert-between", (req, res) => {
  try {
    const blueprint = getBlueprint(req.params.blueprintId);
    if (!blueprint) {
      res.status(404).json({ error: "Blueprint not found" });
      return;
    }
    const completedNode = blueprint.nodes.find((n) => n.id === req.params.nodeId);
    if (!completedNode) {
      res.status(404).json({ error: "Node not found" });
      return;
    }

    const { title, description } = req.body as { title?: string; description?: string };
    if (!title || typeof title !== "string") {
      res.status(400).json({ error: "Missing or empty 'title'" });
      return;
    }

    // Create new node depending on completedNode
    const newNode = createMacroNode(req.params.blueprintId, {
      title,
      description,
      order: completedNode.order + 1,
      dependencies: [req.params.nodeId],
    });

    // Rewire: each dependent that depended on completedNode now depends on newNode instead
    const dependents = blueprint.nodes.filter((n) => n.dependencies.includes(req.params.nodeId));
    const rewired: { nodeId: string; oldDeps: string[]; newDeps: string[] }[] = [];
    for (const dep of dependents) {
      const oldDeps = [...dep.dependencies];
      const newDeps = dep.dependencies.map((d) => (d === req.params.nodeId ? newNode.id : d));
      updateMacroNode(req.params.blueprintId, dep.id, { dependencies: newDeps });
      rewired.push({ nodeId: dep.id, oldDeps, newDeps });
    }

    log.info(`INSERT_BETWEEN: Created node "${newNode.title}" (${newNode.id.slice(0, 8)}) between ${req.params.nodeId.slice(0, 8)} and ${dependents.length} dependent(s)`);
    res.status(201).json({ node: newNode, rewired });
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// POST /api/blueprints/:blueprintId/nodes/:nodeId/add-sibling — ADD_SIBLING graph mutation
// Creates a blocked sibling node inheriting the target node's dependencies,
// and adds it as a dependency for all downstream nodes.
planRouter.post("/api/blueprints/:blueprintId/nodes/:nodeId/add-sibling", (req, res) => {
  try {
    const blueprint = getBlueprint(req.params.blueprintId);
    if (!blueprint) {
      res.status(404).json({ error: "Blueprint not found" });
      return;
    }
    const targetNode = blueprint.nodes.find((n) => n.id === req.params.nodeId);
    if (!targetNode) {
      res.status(404).json({ error: "Node not found" });
      return;
    }

    const { title, description } = req.body as { title?: string; description?: string };
    if (!title || typeof title !== "string") {
      res.status(400).json({ error: "Missing or empty 'title'" });
      return;
    }

    // Create sibling node inheriting target's dependencies
    const newNode = createMacroNode(req.params.blueprintId, {
      title,
      description,
      order: targetNode.order + 1,
      dependencies: [...targetNode.dependencies],
    });
    // Mark as blocked (needs human intervention)
    updateMacroNode(req.params.blueprintId, newNode.id, { status: "blocked" });

    // Add newNode as a dependency for all downstream dependents
    const dependents = blueprint.nodes.filter((n) => n.dependencies.includes(req.params.nodeId));
    const rewired: { nodeId: string; oldDeps: string[]; newDeps: string[] }[] = [];
    for (const dep of dependents) {
      if (!dep.dependencies.includes(newNode.id)) {
        const oldDeps = [...dep.dependencies];
        const newDeps = [...dep.dependencies, newNode.id];
        updateMacroNode(req.params.blueprintId, dep.id, { dependencies: newDeps });
        rewired.push({ nodeId: dep.id, oldDeps, newDeps });
      }
    }

    log.info(`ADD_SIBLING: Created blocker node "${newNode.title}" (${newNode.id.slice(0, 8)}) as sibling of ${req.params.nodeId.slice(0, 8)}`);
    res.status(201).json({ node: newNode, rewired });
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// POST /api/blueprints/:blueprintId/nodes — add node
planRouter.post("/api/blueprints/:blueprintId/nodes", (req, res) => {
  try {
    const blueprint = getBlueprint(req.params.blueprintId);
    if (!blueprint) {
      res.status(404).json({ error: "Blueprint not found" });
      return;
    }
    const { title, description, order, dependencies, parallelGroup, prompt, estimatedMinutes } = req.body as {
      title?: string;
      description?: string;
      order?: number;
      dependencies?: string[];
      parallelGroup?: string;
      prompt?: string;
      estimatedMinutes?: number;
    };
    if (!title || typeof title !== "string" || title.trim().length === 0) {
      res.status(400).json({ error: "Missing or empty 'title'" });
      return;
    }
    const nodeOrder = order ?? blueprint.nodes.length;
    const node = createMacroNode(req.params.blueprintId, {
      title: title.trim(),
      description,
      order: nodeOrder,
      dependencies,
      parallelGroup,
      prompt,
      estimatedMinutes,
    });
    res.status(201).json(node);
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// PUT /api/blueprints/:blueprintId/nodes/:nodeId — edit node
planRouter.put("/api/blueprints/:blueprintId/nodes/:nodeId", (req, res) => {
  try {
    const patch = req.body as Record<string, unknown>;
    const node = updateMacroNode(req.params.blueprintId, req.params.nodeId, patch);
    if (!node) {
      res.status(404).json({ error: "Node not found" });
      return;
    }
    res.json(node);
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// DELETE /api/blueprints/:blueprintId/nodes/:nodeId — delete node
planRouter.delete("/api/blueprints/:blueprintId/nodes/:nodeId", (req, res) => {
  try {
    deleteMacroNode(req.params.blueprintId, req.params.nodeId);
    res.json({ ok: true });
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// POST /api/blueprints/:blueprintId/nodes/reorder — reorder nodes
planRouter.post("/api/blueprints/:blueprintId/nodes/reorder", (req, res) => {
  try {
    const ordering = req.body as { id: string; order: number }[];
    if (!Array.isArray(ordering)) {
      res.status(400).json({ error: "Body must be an array of {id, order}" });
      return;
    }
    reorderMacroNodes(req.params.blueprintId, ordering);
    const blueprint = getBlueprint(req.params.blueprintId);
    res.json(blueprint);
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// ─── Artifact endpoints ──────────────────────────────────────

// GET /api/blueprints/:blueprintId/nodes/:nodeId/artifacts
planRouter.get("/api/blueprints/:blueprintId/nodes/:nodeId/artifacts", (req, res) => {
  try {
    const direction = (req.query.direction as string) || "output";
    if (direction !== "input" && direction !== "output") {
      res.status(400).json({ error: "direction must be 'input' or 'output'" });
      return;
    }
    const artifacts = getArtifactsForNode(req.params.nodeId, direction);
    res.json(artifacts);
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// POST /api/blueprints/:blueprintId/nodes/:nodeId/artifacts
planRouter.post("/api/blueprints/:blueprintId/nodes/:nodeId/artifacts", (req, res) => {
  try {
    const { type, content, targetNodeId } = req.body as {
      type?: ArtifactType;
      content?: string;
      targetNodeId?: string;
    };
    if (!content || typeof content !== "string") {
      res.status(400).json({ error: "Missing or empty 'content'" });
      return;
    }
    const artifact = createArtifact(
      req.params.blueprintId,
      req.params.nodeId,
      type ?? "handoff_summary",
      content,
      targetNodeId,
    );
    res.status(201).json(artifact);
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// DELETE /api/blueprints/:blueprintId/artifacts/:artifactId
planRouter.delete("/api/blueprints/:blueprintId/artifacts/:artifactId", (req, res) => {
  try {
    deleteArtifact(req.params.artifactId);
    res.json({ ok: true });
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// ─── Execution endpoints ─────────────────────────────────────

// GET /api/blueprints/:blueprintId/nodes/:nodeId/executions
planRouter.get("/api/blueprints/:blueprintId/nodes/:nodeId/executions", (req, res) => {
  try {
    const executions = getExecutionsForNode(req.params.nodeId);
    res.json(executions);
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// GET /api/blueprints/:blueprintId/nodes/:nodeId/related-sessions
planRouter.get("/api/blueprints/:blueprintId/nodes/:nodeId/related-sessions", (req, res) => {
  try {
    const sessions = getRelatedSessionsForNode(req.params.nodeId);
    res.json(sessions);
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// POST /api/blueprints/:blueprintId/nodes/:nodeId/executions
planRouter.post("/api/blueprints/:blueprintId/nodes/:nodeId/executions", (req, res) => {
  try {
    const { sessionId, type, inputContext, parentExecutionId, status, outputSummary, completedAt } = req.body as {
      sessionId?: string;
      type?: ExecutionType;
      inputContext?: string;
      parentExecutionId?: string;
      status?: "running" | "done" | "failed" | "cancelled";
      outputSummary?: string;
      completedAt?: string;
    };
    const execution = createExecution(
      req.params.nodeId,
      req.params.blueprintId,
      sessionId,
      type ?? "primary",
      inputContext,
      parentExecutionId,
      status,
      outputSummary,
      completedAt,
    );
    res.status(201).json(execution);
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// ─── Queue status ─────────────────────────────────────────────

// GET /api/blueprints/:id/queue — get queue info for a blueprint
planRouter.get("/api/blueprints/:id/queue", (req, res) => {
  try {
    const info = getQueueInfo(req.params.id);
    res.json(info);
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// ─── Global queue status ──────────────────────────────────────

// GET /api/global-status — aggregate queue info across all blueprints
planRouter.get("/api/global-status", (_req, res) => {
  try {
    res.json(getGlobalQueueInfo());
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// ─── Blueprint lifecycle ─────────────────────────────────────

// POST /api/blueprints/:id/approve — set status to approved
planRouter.post("/api/blueprints/:id/approve", (req, res) => {
  try {
    const blueprint = updateBlueprint(req.params.id, { status: "approved" });
    if (!blueprint) {
      res.status(404).json({ error: "Blueprint not found" });
      return;
    }
    res.json(blueprint);
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// POST /api/blueprints/:id/nodes/:nodeId/run — run a single node (async: returns immediately)
planRouter.post("/api/blueprints/:id/nodes/:nodeId/run", (req, res) => {
  try {
    // Validate preconditions synchronously before fire-and-forget
    const bp = getBlueprint(req.params.id);
    if (!bp) { res.status(404).json({ error: "Blueprint not found" }); return; }
    const nd = bp.nodes.find((n) => n.id === req.params.nodeId);
    if (!nd) { res.status(404).json({ error: "Node not found" }); return; }
    if (nd.status !== "pending" && nd.status !== "failed") {
      res.status(400).json({ error: `Node status is "${nd.status}", must be "pending" or "failed" to run` }); return;
    }
    // Only block queueing when dependencies are in terminal-failure states.
    // Running/queued/pending deps are fine — the actual execution will re-check
    // and fail if deps aren't done/skipped by the time this node runs.
    const blockedStatuses = new Set(["failed", "blocked"]);
    for (const depId of nd.dependencies) {
      const dep = bp.nodes.find((n) => n.id === depId);
      if (!dep || blockedStatuses.has(dep.status)) {
        res.status(400).json({ error: `Dependency "${dep?.title ?? depId}" is ${dep?.status ?? "missing"} — cannot queue` }); return;
      }
    }

    // Fire and forget — executeNode sets "queued" immediately, frontend polls
    executeNode(req.params.id, req.params.nodeId)
      .catch(err => log.error(`Node ${req.params.nodeId} execution failed: ${err.message}`));
    res.json({ status: "queued", nodeId: req.params.nodeId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// POST /api/blueprints/:id/nodes/:nodeId/unqueue — cancel a queued node, reverting it to pending
planRouter.post("/api/blueprints/:id/nodes/:nodeId/unqueue", (req, res) => {
  try {
    const bp = getBlueprint(req.params.id);
    if (!bp) { res.status(404).json({ error: "Blueprint not found" }); return; }
    const nd = bp.nodes.find((n) => n.id === req.params.nodeId);
    if (!nd) { res.status(404).json({ error: "Node not found" }); return; }
    if (nd.status === "running") {
      res.status(409).json({ error: "Cannot unqueue a running node" }); return;
    }
    if (nd.status !== "queued") {
      res.status(400).json({ error: `Node status is "${nd.status}", must be "queued" to unqueue` }); return;
    }

    // Remove from in-memory queue and pending tasks
    removeQueuedTask(req.params.id, req.params.nodeId);
    removePendingTask(req.params.id, req.params.nodeId, "run");
    // Revert SQLite status to pending
    updateMacroNode(req.params.id, req.params.nodeId, { status: "pending" });

    log.info(`Unqueued node ${req.params.nodeId.slice(0, 8)} in blueprint ${req.params.id.slice(0, 8)}`);
    res.json({ status: "pending" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// POST /api/blueprints/:id/nodes/:nodeId/resume-session — resume a failed session
planRouter.post("/api/blueprints/:id/nodes/:nodeId/resume-session", (req, res) => {
  try {
    const { executionId } = req.body as { executionId?: string };
    if (!executionId) { res.status(400).json({ error: "executionId is required" }); return; }

    const bp = getBlueprint(req.params.id);
    if (!bp) { res.status(404).json({ error: "Blueprint not found" }); return; }
    const nd = bp.nodes.find((n) => n.id === req.params.nodeId);
    if (!nd) { res.status(404).json({ error: "Node not found" }); return; }
    if (nd.status !== "failed") {
      res.status(400).json({ error: `Node status is "${nd.status}", must be "failed" to resume` }); return;
    }

    const exec = getExecution(executionId);
    if (!exec) { res.status(404).json({ error: "Execution not found" }); return; }
    if (!exec.sessionId) { res.status(400).json({ error: "Execution has no session to resume" }); return; }

    const blueprintId = req.params.id;
    const nodeId = req.params.nodeId;

    addPendingTask(blueprintId, { type: "run", nodeId, queuedAt: new Date().toISOString() });
    updateMacroNode(blueprintId, nodeId, { status: "queued" });

    enqueueBlueprintTask(blueprintId, async () => {
      try {
        return await resumeNodeSession(blueprintId, nodeId, executionId);
      } finally {
        removePendingTask(blueprintId, nodeId, "run");
      }
    }).catch(err => {
      log.error(`Resume session for node ${nodeId} failed: ${err instanceof Error ? err.message : err}`);
    });

    res.json({ status: "queued" });
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// POST /api/blueprints/:id/nodes/:nodeId/recover-session — try to find a lost session for a failed node
planRouter.post("/api/blueprints/:id/nodes/:nodeId/recover-session", (req, res) => {
  try {
    const bp = getBlueprint(req.params.id);
    if (!bp) { res.status(404).json({ error: "Blueprint not found" }); return; }
    const nd = bp.nodes.find((n) => n.id === req.params.nodeId);
    if (!nd) { res.status(404).json({ error: "Node not found" }); return; }

    // Find failed executions without a sessionId that have the server restart error
    const executions = getExecutionsForNode(req.params.nodeId);
    const recoverable = executions.filter(
      (e) => e.status === "failed" && !e.sessionId &&
        e.outputSummary?.includes("Server restarted"),
    );
    if (recoverable.length === 0) {
      res.json({ recovered: false, reason: "No recoverable executions found" });
      return;
    }

    if (!bp.projectCwd) {
      res.json({ recovered: false, reason: "Blueprint has no projectCwd" });
      return;
    }

    let recoveredCount = 0;
    for (const exec of recoverable) {
      // Look for sessions created after this execution started
      const beforeTimestamp = new Date(exec.startedAt);
      const sessionId = detectNewSession(bp.projectCwd, beforeTimestamp);
      if (sessionId) {
        // Check this session isn't already claimed by another execution
        const existing = getExecutionBySession(sessionId);
        if (!existing) {
          // Link session and mark execution as done (it completed before the restart)
          updateExecution(exec.id, {
            sessionId,
            status: "done",
            completedAt: new Date().toISOString(),
            outputSummary: "Recovered after server restart",
          });
          recoveredCount++;
        }
      }
    }

    // If any executions were recovered, mark the node as done too
    if (recoveredCount > 0) {
      updateMacroNode(req.params.id, req.params.nodeId, {
        status: "done",
        error: "",
      });
    }

    res.json({ recovered: recoveredCount > 0, recoveredCount });
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// POST /api/blueprints/:id/nodes/:nodeId/evaluation-callback — callback endpoint for interactive evaluation
// Called by Claude during evaluateNodeCompletion() to apply graph mutations directly
planRouter.post("/api/blueprints/:id/nodes/:nodeId/evaluation-callback", (req, res) => {
  try {
    const blueprintId = req.params.id;
    const nodeId = req.params.nodeId;
    const blueprint = getBlueprint(blueprintId);
    if (!blueprint) { res.status(404).json({ error: "Blueprint not found" }); return; }
    const node = blueprint.nodes.find((n) => n.id === nodeId);
    if (!node) { res.status(404).json({ error: "Node not found" }); return; }

    const { status, evaluation: evalText, mutations } = req.body as {
      status?: string;
      evaluation?: string;
      mutations?: Array<{ action: string; new_node: { title: string; description: string } }>;
    };

    if (!status || !["COMPLETE", "NEEDS_REFINEMENT", "HAS_BLOCKER"].includes(status)) {
      res.status(400).json({ error: `Invalid status: "${status}". Must be COMPLETE, NEEDS_REFINEMENT, or HAS_BLOCKER` });
      return;
    }

    const completionEval: CompletionEvaluation = {
      evaluation: evalText || "",
      status: status as CompletionEvaluation["status"],
      mutations: Array.isArray(mutations)
        ? mutations.filter(m => m.action && m.new_node?.title).map(m => ({
            action: m.action as "INSERT_BETWEEN" | "ADD_SIBLING",
            new_node: { title: m.new_node.title, description: m.new_node.description || "" },
          }))
        : [],
    };

    log.info(`Evaluation callback for node ${nodeId.slice(0, 8)} "${node.title}": ${completionEval.status} — ${completionEval.evaluation}`);

    let createdNodes: MacroNode[] = [];
    if (completionEval.status !== "COMPLETE" && completionEval.mutations.length > 0) {
      const result = applyGraphMutations(blueprintId, nodeId, completionEval, blueprint);
      createdNodes = result.createdNodes;
    }

    res.json({ success: true, status: completionEval.status, createdNodes });
  } catch (err) {
    log.error(`Evaluation callback failed: ${err instanceof Error ? err.message : err}`);
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// POST /api/blueprints/:id/executions/:execId/report-blocker — callback for execution blocker reporting
// Called by Claude during node execution to report blockers via API instead of output markers
planRouter.post("/api/blueprints/:id/executions/:execId/report-blocker", (req, res) => {
  try {
    const blueprintId = req.params.id;
    const execId = req.params.execId;

    const blueprint = getBlueprint(blueprintId);
    if (!blueprint) { res.status(404).json({ error: "Blueprint not found" }); return; }

    const execution = getExecution(execId);
    if (!execution || execution.blueprintId !== blueprintId) {
      res.status(404).json({ error: "Execution not found" }); return;
    }

    const { type, description, suggestion } = req.body as {
      type?: string;
      description?: string;
      suggestion?: string;
    };

    if (!type || !description) {
      res.status(400).json({ error: "Missing required fields: type, description" }); return;
    }

    const blockerJson = JSON.stringify({ type, description, suggestion: suggestion || "" });
    setExecutionBlocker(execId, blockerJson);

    log.info(`Blocker reported for execution ${execId.slice(0, 8)}: [${type}] ${description}`);
    res.json({ success: true });
  } catch (err) {
    log.error(`Report blocker failed: ${err instanceof Error ? err.message : err}`);
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// POST /api/blueprints/:id/executions/:execId/task-summary — callback for task completion summary
// Called by Claude during node execution to report task summary via API instead of output markers
planRouter.post("/api/blueprints/:id/executions/:execId/task-summary", (req, res) => {
  try {
    const blueprintId = req.params.id;
    const execId = req.params.execId;

    const blueprint = getBlueprint(blueprintId);
    if (!blueprint) { res.status(404).json({ error: "Blueprint not found" }); return; }

    const execution = getExecution(execId);
    if (!execution || execution.blueprintId !== blueprintId) {
      res.status(404).json({ error: "Execution not found" }); return;
    }

    const { summary } = req.body as { summary?: string };

    if (!summary) {
      res.status(400).json({ error: "Missing required field: summary" }); return;
    }

    setExecutionTaskSummary(execId, summary);

    log.info(`Task summary reported for execution ${execId.slice(0, 8)}: ${summary.slice(0, 100)}...`);
    res.json({ success: true });
  } catch (err) {
    log.error(`Task summary callback failed: ${err instanceof Error ? err.message : err}`);
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// POST /api/blueprints/:id/executions/:execId/report-status — callback for explicit execution status reporting
// Called by Claude at the end of node execution to authoritatively report done/failed/blocked status
planRouter.post("/api/blueprints/:id/executions/:execId/report-status", (req, res) => {
  try {
    const blueprintId = req.params.id;
    const execId = req.params.execId;

    const blueprint = getBlueprint(blueprintId);
    if (!blueprint) { res.status(404).json({ error: "Blueprint not found" }); return; }

    const execution = getExecution(execId);
    if (!execution || execution.blueprintId !== blueprintId) {
      res.status(404).json({ error: "Execution not found" }); return;
    }

    const { status, reason } = req.body as {
      status?: string;
      reason?: string;
    };

    const validStatuses: ReportedStatus[] = ["done", "failed", "blocked"];
    if (!status || !validStatuses.includes(status as ReportedStatus)) {
      res.status(400).json({ error: "Missing or invalid status field. Must be one of: done, failed, blocked" }); return;
    }

    setExecutionReportedStatus(execId, status as ReportedStatus, reason);

    log.info(`Status reported for execution ${execId.slice(0, 8)}: ${status}${reason ? ` (reason: ${reason.slice(0, 100)})` : ""}`);
    res.json({ success: true });
  } catch (err) {
    log.error(`Report status failed: ${err instanceof Error ? err.message : err}`);
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// POST /api/blueprints/:id/nodes/:nodeId/evaluate — evaluate completed node and apply graph mutations
// Fire-and-forget: returns immediately with {status:"queued"}, applies mutations in background
planRouter.post("/api/blueprints/:id/nodes/:nodeId/evaluate", (req, res) => {
  try {
    const bp = getBlueprint(req.params.id);
    if (!bp) { res.status(404).json({ error: "Blueprint not found" }); return; }
    const nd = bp.nodes.find((n) => n.id === req.params.nodeId);
    if (!nd) { res.status(404).json({ error: "Node not found" }); return; }
    if (nd.status !== "done") {
      res.status(400).json({ error: `Node status is "${nd.status}", must be "done" to evaluate` }); return;
    }

    const blueprintId = req.params.id;
    const nodeId = req.params.nodeId;

    addPendingTask(blueprintId, { type: "reevaluate", nodeId, queuedAt: new Date().toISOString() });

    enqueueBlueprintTask(blueprintId, async () => {
      try {
        const result = await evaluateNodeCompletion(blueprintId, nodeId, bp.projectCwd);
        return result;
      } finally {
        removePendingTask(blueprintId, nodeId, "reevaluate");
      }
    }).catch(err => {
      log.error(`Evaluate node ${nodeId} failed: ${err instanceof Error ? err.message : err}`);
    });

    res.json({ status: "queued", nodeId });
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// POST /api/blueprints/:id/run — run next pending node (async)
planRouter.post("/api/blueprints/:id/run", (req, res) => {
  try {
    executeNextNode(req.params.id)
      .then(exec => { if (!exec) log.info("No pending nodes for run-next"); })
      .catch(err => log.error(`Run-next failed: ${err.message}`));
    res.json({ status: "started" });
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// POST /api/blueprints/:id/reevaluate-all — AI re-evaluate all non-done nodes (status, deps, description)
// Fire-and-forget: returns immediately, applies results in background
planRouter.post("/api/blueprints/:id/reevaluate-all", (req, res) => {
  try {
    const blueprint = getBlueprint(req.params.id);
    if (!blueprint) {
      res.status(404).json({ error: "Blueprint not found" });
      return;
    }

    const blueprintId = req.params.id;
    const nonDoneNodes = blueprint.nodes.filter(
      (n) => n.status !== "done" && n.status !== "running" && n.status !== "queued",
    );
    if (nonDoneNodes.length === 0) {
      res.json({ message: "No nodes to reevaluate", blueprintId });
      return;
    }

    // Track all nodes as pending reevaluate tasks
    for (const n of nonDoneNodes) {
      addPendingTask(blueprintId, { type: "reevaluate", nodeId: n.id, queuedAt: new Date().toISOString() });
    }

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

    const prompt = `You are a project manager reviewing a development blueprint/plan and reevaluating all incomplete nodes.

Blueprint: "${blueprint.title}"
${blueprint.description ? `Blueprint description: ${blueprint.description}` : ""}
${blueprint.projectCwd ? `Project directory: ${blueprint.projectCwd}` : ""}

All nodes in the plan:
${nodesContext}

${completedSummaries ? `Progress from completed steps:\n${completedSummaries}\n` : ""}
Nodes to reevaluate:
${targetNodesList}

Valid node IDs for dependencies: ${validNodeIds}

For EACH node listed above, reevaluate it by examining the actual codebase:

1. Read the relevant source files to verify implementation status.
2. Then DIRECTLY update ALL nodes in a SINGLE batch API call.

Batch API endpoint: PUT ${getApiBase()}/api/blueprints/${blueprintId}/nodes/batch?${getAuthParam()}
Content-Type: application/json

The body is a JSON ARRAY of node updates. Each element has:
- "id": (REQUIRED) the node ID
- "title": updated title string
- "description": updated description string
- "status": one of "pending", "done", "skipped", "blocked" (set "done" if fully implemented, "skipped" if redundant, "pending" if a previously blocked node's blocker is resolved, "blocked" if a blocker still persists)
- "dependencies": array of node ID strings (only use valid IDs from the list above)
- "error": error message string (set to "" to clear)

Guidelines:
1. Read actual source code — do NOT guess implementation status.
2. If fully implemented → set status to "done".
3. If partially implemented → keep "pending", describe what remains.
4. If redundant/obsolete → set to "skipped", explain why in description.
5. If blocked and blocker is resolved → set to "pending". If blocker persists → keep "blocked" and update description.
6. Update dependencies if needed (remove invalid, add missing).
7. You MUST make ONE batch API call with ALL node updates — do NOT call individual endpoints.

Example (updates all nodes in one call):
curl -X PUT '${getApiBase()}/api/blueprints/${blueprintId}/nodes/batch?${getAuthParam()}' -H "Content-Type: application/json" -d '[{"id":"node-id-1", "title":"...", "description":"...", "status":"done"}, {"id":"node-id-2", "title":"...", "status":"skipped"}]'`;

    // Fire and forget via blueprint queue — Claude Code will directly update DB via API
    // withTimeout prevents indefinite hangs if the CLI process never exits
    const REEVALUATE_TIMEOUT = 32 * 60 * 1000; // 32 min (30 min exec + 2 min grace)
    const reevAllBefore = new Date();
    const reevAllCwd = blueprint.projectCwd;
    const reevAllNodeIds = nonDoneNodes.map(n => n.id);
    enqueueBlueprintTask(blueprintId, async () => {
      try {
        await withTimeout(
          runClaudeInteractive(prompt, reevAllCwd || undefined),
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
      } finally {
        // Always clean up pending tasks, whether success, error, or timeout
        for (const n of nonDoneNodes) {
          removePendingTask(blueprintId, n.id, "reevaluate");
        }
      }
    }).catch((err) => {
      log.error(`Reevaluate-all blueprint ${blueprintId} failed: ${err instanceof Error ? err.message : err}`);
    });

    res.json({ message: "reevaluation started", blueprintId, nodeCount: nonDoneNodes.length });
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// POST /api/blueprints/:id/run-all — run all nodes in background
planRouter.post("/api/blueprints/:id/run-all", (req, res) => {
  try {
    const blueprint = getBlueprint(req.params.id);
    if (!blueprint) {
      res.status(404).json({ error: "Blueprint not found" });
      return;
    }
    // Fire and forget — execution continues in background
    executeAllNodes(req.params.id).catch((err) => {
      log.error(`Run-all failed for ${req.params.id}: ${err instanceof Error ? err.message : err}`);
    });
    res.json({ message: "execution started", blueprintId: req.params.id });
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// ─── Reverse lookup ──────────────────────────────────────────

// GET /api/sessions/:sessionId/plan-node — find node linked to a session
planRouter.get("/api/sessions/:sessionId/plan-node", (req, res) => {
  try {
    const node = getNodeBySession(req.params.sessionId);
    if (!node) {
      res.status(404).json({ error: "No plan node linked to this session" });
      return;
    }
    res.json(node);
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// GET /api/sessions/:sessionId/execution — find execution linked to a session
planRouter.get("/api/sessions/:sessionId/execution", (req, res) => {
  try {
    const execution = getExecutionBySession(req.params.sessionId);
    if (!execution) {
      res.status(404).json({ error: "No execution linked to this session" });
      return;
    }
    res.json(execution);
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// ─── AI Plan Generation ──────────────────────────────────────

// POST /api/blueprints/:id/generate — generate nodes via Claude (fire-and-forget)
// Claude Code calls the batch-create endpoint directly in interactive mode.
planRouter.post("/api/blueprints/:id/generate", (req, res) => {
  try {
    const blueprint = getBlueprint(req.params.id);
    if (!blueprint) {
      res.status(404).json({ error: "Blueprint not found" });
      return;
    }

    const blueprintId = req.params.id;
    const { description } = req.body as { description?: string };

    // Track as a pending generate task for queue status API
    addPendingTask(blueprintId, { type: "generate", queuedAt: new Date().toISOString() });

    const GENERATE_TIMEOUT = 10 * 60 * 1000; // 10 min
    enqueueBlueprintTask(blueprintId, async () => {
      try {
        const { generatePlan } = await import("./plan-generator.js");
        await withTimeout(
          generatePlan(blueprintId, description),
          GENERATE_TIMEOUT,
          "Generate nodes timed out after 10 minutes",
        );
      } finally {
        removePendingTask(blueprintId, undefined, "generate");
      }
    }).catch((err) => {
      log.error(`Generate nodes for blueprint ${blueprintId} failed: ${err instanceof Error ? err.message : err}`);
    });

    res.json({ status: "queued", blueprintId });
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// ─── Image upload for node descriptions ──────────────────────

const UPLOADS_DIR = join(CLAWUI_DB_DIR, "uploads");

// Serve uploaded images statically
planRouter.use("/api/uploads", express.static(UPLOADS_DIR));

// POST /api/uploads — accepts base64-encoded image, stores to disk
planRouter.post("/api/uploads", (req, res) => {
  try {
    const { data, filename } = req.body as { data?: string; filename?: string };
    if (!data || typeof data !== "string") {
      res.status(400).json({ error: "Missing 'data' (base64-encoded image)" });
      return;
    }

    // Extract mime type and raw base64 from data URL
    const match = data.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!match) {
      res.status(400).json({ error: "Invalid data URL format. Expected data:image/*;base64,..." });
      return;
    }

    const mimeType = match[1];
    const base64Data = match[2];
    const ext = mimeType.split("/")[1] || "png";
    const safeName = filename
      ? filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 50)
      : `image-${Date.now()}`;
    const finalName = `${randomUUID().slice(0, 8)}-${safeName}.${ext}`;

    if (!existsSync(UPLOADS_DIR)) {
      mkdirSync(UPLOADS_DIR, { recursive: true });
    }

    writeFileSync(join(UPLOADS_DIR, finalName), Buffer.from(base64Data, "base64"));

    res.json({ url: `/api/uploads/${finalName}` });
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// ─── Backward-compat: /api/plans/* → same handlers ──────────

// POST /api/plans — create (accepts both cwd and projectCwd)
planRouter.post("/api/plans", (req, res) => {
  try {
    const { title, description, cwd, projectCwd } = req.body as {
      title?: string;
      description?: string;
      cwd?: string;
      projectCwd?: string;
    };
    if (!title || typeof title !== "string" || title.trim().length === 0) {
      res.status(400).json({ error: "Missing or empty 'title'" });
      return;
    }
    const blueprint = createBlueprint(title.trim(), description, projectCwd ?? cwd);
    res.status(201).json(blueprint);
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// GET /api/plans
planRouter.get("/api/plans", (req, res) => {
  try {
    const status = req.query.status as string | undefined;
    const projectCwd = (req.query.projectCwd ?? req.query.projectId) as string | undefined;
    const blueprints = listBlueprints({ status, projectCwd });
    res.json(blueprints);
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// GET /api/plans/:id
planRouter.get("/api/plans/:id", (req, res) => {
  try {
    const blueprint = getBlueprint(req.params.id);
    if (!blueprint) {
      res.status(404).json({ error: "Plan not found" });
      return;
    }
    res.json(blueprint);
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// PUT /api/plans/:id
planRouter.put("/api/plans/:id", (req, res) => {
  try {
    const patch = req.body as Record<string, unknown>;
    // Map old field names
    if (patch.cwd !== undefined && patch.projectCwd === undefined) {
      patch.projectCwd = patch.cwd;
    }
    const blueprint = updateBlueprint(req.params.id, patch);
    if (!blueprint) {
      res.status(404).json({ error: "Plan not found" });
      return;
    }
    res.json(blueprint);
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// DELETE /api/plans/:id
planRouter.delete("/api/plans/:id", (req, res) => {
  try {
    const blueprint = getBlueprint(req.params.id);
    if (!blueprint) {
      res.status(404).json({ error: "Plan not found" });
      return;
    }
    deleteBlueprint(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// POST /api/plans/:planId/nodes (accepts seq/dependsOn or order/dependencies)
planRouter.post("/api/plans/:planId/nodes", (req, res) => {
  try {
    const blueprint = getBlueprint(req.params.planId);
    if (!blueprint) {
      res.status(404).json({ error: "Plan not found" });
      return;
    }
    const { title, description, seq, order, dependsOn, dependencies, prompt } = req.body as {
      title?: string;
      description?: string;
      seq?: number;
      order?: number;
      dependsOn?: string[];
      dependencies?: string[];
      prompt?: string;
    };
    if (!title || typeof title !== "string" || title.trim().length === 0) {
      res.status(400).json({ error: "Missing or empty 'title'" });
      return;
    }
    const nodeOrder = order ?? seq ?? blueprint.nodes.length;
    const node = createMacroNode(req.params.planId, {
      title: title.trim(),
      description,
      order: nodeOrder,
      dependencies: dependencies ?? dependsOn,
      prompt,
    });
    res.status(201).json(node);
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// PUT /api/plans/:planId/nodes/:nodeId
planRouter.put("/api/plans/:planId/nodes/:nodeId", (req, res) => {
  try {
    const patch = req.body as Record<string, unknown>;
    // Map old field names
    if (patch.dependsOn !== undefined && patch.dependencies === undefined) {
      patch.dependencies = patch.dependsOn;
    }
    if (patch.seq !== undefined && patch.order === undefined) {
      patch.order = patch.seq;
    }
    const node = updateMacroNode(req.params.planId, req.params.nodeId, patch);
    if (!node) {
      res.status(404).json({ error: "Node not found" });
      return;
    }
    res.json(node);
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// DELETE /api/plans/:planId/nodes/:nodeId
planRouter.delete("/api/plans/:planId/nodes/:nodeId", (req, res) => {
  try {
    deleteMacroNode(req.params.planId, req.params.nodeId);
    res.json({ ok: true });
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// POST /api/plans/:planId/nodes/reorder (accepts seq or order)
planRouter.post("/api/plans/:planId/nodes/reorder", (req, res) => {
  try {
    const ordering = req.body as { id: string; seq?: number; order?: number }[];
    if (!Array.isArray(ordering)) {
      res.status(400).json({ error: "Body must be an array of {id, order}" });
      return;
    }
    reorderMacroNodes(
      req.params.planId,
      ordering.map((o) => ({ id: o.id, order: o.order ?? o.seq ?? 0 })),
    );
    const blueprint = getBlueprint(req.params.planId);
    res.json(blueprint);
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// POST /api/plans/:id/approve
planRouter.post("/api/plans/:id/approve", (req, res) => {
  try {
    const blueprint = updateBlueprint(req.params.id, { status: "approved" });
    if (!blueprint) {
      res.status(404).json({ error: "Plan not found" });
      return;
    }
    res.json(blueprint);
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// POST /api/plans/:id/nodes/:nodeId/evaluate
planRouter.post("/api/plans/:id/nodes/:nodeId/evaluate", (req, res) => {
  try {
    const bp = getBlueprint(req.params.id);
    if (!bp) { res.status(404).json({ error: "Plan not found" }); return; }
    const nd = bp.nodes.find((n) => n.id === req.params.nodeId);
    if (!nd) { res.status(404).json({ error: "Node not found" }); return; }
    if (nd.status !== "done") {
      res.status(400).json({ error: `Node status is "${nd.status}", must be "done" to evaluate` }); return;
    }

    const blueprintId = req.params.id;
    const nodeId = req.params.nodeId;

    addPendingTask(blueprintId, { type: "reevaluate", nodeId, queuedAt: new Date().toISOString() });

    enqueueBlueprintTask(blueprintId, async () => {
      try {
        return await evaluateNodeCompletion(blueprintId, nodeId, bp.projectCwd);
      } finally {
        removePendingTask(blueprintId, nodeId, "reevaluate");
      }
    }).catch(err => {
      log.error(`Evaluate node ${nodeId} failed: ${err instanceof Error ? err.message : err}`);
    });

    res.json({ status: "queued", nodeId });
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// POST /api/plans/:id/nodes/:nodeId/run
planRouter.post("/api/plans/:id/nodes/:nodeId/run", async (req, res) => {
  try {
    req.setTimeout(30 * 60 * 1000);
    const execution = await executeNode(req.params.id, req.params.nodeId);
    res.json(execution);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.includes("not found") ? 404 : msg.includes("must be") || msg.includes("not done") ? 400 : 500;
    res.status(status).json({ error: msg });
  }
});

// POST /api/plans/:id/run
planRouter.post("/api/plans/:id/run", async (req, res) => {
  try {
    req.setTimeout(30 * 60 * 1000);
    const execution = await executeNextNode(req.params.id);
    if (!execution) {
      res.json({ message: "no pending nodes" });
      return;
    }
    res.json(execution);
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// POST /api/plans/:id/run-all
planRouter.post("/api/plans/:id/run-all", (req, res) => {
  try {
    const blueprint = getBlueprint(req.params.id);
    if (!blueprint) {
      res.status(404).json({ error: "Plan not found" });
      return;
    }
    executeAllNodes(req.params.id).catch((err) => {
      log.error(`Run-all failed for ${req.params.id}: ${err instanceof Error ? err.message : err}`);
    });
    res.json({ message: "execution started", blueprintId: req.params.id });
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// POST /api/plans/:id/generate
planRouter.post("/api/plans/:id/generate", async (req, res) => {
  res.setTimeout(180_000);
  try {
    const { description } = req.body as { description?: string };
    const nodes = await enqueueBlueprintTask(req.params.id, async () => {
      const { generatePlan } = await import("./plan-generator.js");
      return generatePlan(req.params.id, description);
    });
    res.json(nodes);
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

export default planRouter;
