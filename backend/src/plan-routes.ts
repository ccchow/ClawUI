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
  starBlueprint,
  unstarBlueprint,
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
  getRelatedSessionsForNode,
  getActiveRelatedSession,
  createSuggestion,
  getSuggestionsForNode,
  deleteSuggestion,
  markSuggestionUsed,
  createInsight,
  getInsightsForBlueprint,
  markInsightRead,
  markAllInsightsRead,
  dismissInsight,
  getTotalUnreadInsightCount,
  getAutopilotLog,
  createAutopilotMessage,
  getMessageHistory,
  getMessageCount,
  getBlueprintSuggestions,
  markBlueprintSuggestionUsed,
  clearBlueprintSuggestions,
} from "./plan-db.js";
import type { ArtifactType, ExecutionType, InsightSeverity, MacroNode, MacroNodeStatus, ReportedStatus } from "./plan-db.js";
import {
  createConveneSession,
  getConveneSession,
  getConveneSessions,
  getConveneMessages,
  createConveneMessage,
  updateConveneSessionStatus,
} from "./plan-db.js";
import { executeNode, executeNextNode, executeAllNodes, enqueueBlueprintTask, getQueueInfo, getGlobalQueueInfo, addPendingTask, removePendingTask, removeQueuedTask, detectNewSession, withTimeout, evaluateNodeCompletion, applyGraphMutations, resumeNodeSession, resolveNodeRoles, parseAgentParams } from "./plan-executor.js";
import type { CompletionEvaluation } from "./plan-executor.js";
import { runAgentInteractive, getApiBase, getAuthParam } from "./plan-generator.js";
import { coordinateBlueprint } from "./plan-coordinator.js";
import { executeConveneSession } from "./plan-convene.js";
import { getRole, getAllRoles } from "./roles/role-registry.js";
import type { RoleDefinition } from "./roles/role-registry.js";
import { createLogger } from "./logger.js";
import { CLAWUI_DB_DIR, AGENT_TYPE } from "./config.js";
import { runAutopilotLoop } from "./autopilot.js";
import { triggerUserAgent } from "./user-agent.js";
import {
  enrichNodeInternal,
  reevaluateNodeInternal,
  splitNodeInternal,
  smartDepsInternal,
  reevaluateAllInternal,
} from "./plan-operations.js";

// Side-effect: auto-discovers and registers all roles before getRole()
import "./roles/load-all-roles.js";


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
 * Resets stuck "running" blueprints back to "approved" when no nodes are
 * running/queued and no in-memory pending tasks remain (e.g. after a
 * process crash or queue drain without cleanup).
 *
 * Note: Does NOT auto-complete blueprints when all nodes are done.
 * Blueprint completion requires an explicit user action or autopilot
 * complete() call.
 *
 * Called after node status updates from API endpoints (batch update,
 * single-node update) so the blueprint doesn't stay stuck in "running"
 * outside the executeAllNodes loop (e.g. via reevaluate or coordinate).
 */
function maybeFinalizeBlueprint(blueprintId: string): void {
  const bp = getBlueprint(blueprintId);
  if (!bp || bp.status !== "running") return;
  // Check for stuck state: blueprint is "running" but no nodes are active
  // and no in-memory pending tasks exist (queue drained without status update)
  const anyActive = bp.nodes.some(
    (n) => n.status === "running" || n.status === "queued",
  );
  if (!anyActive) {
    const queueInfo = getQueueInfo(blueprintId);
    if (queueInfo.pendingTasks.length === 0 && !queueInfo.running) {
      updateBlueprint(blueprintId, { status: "approved" });
      log.info(`Blueprint ${blueprintId.slice(0, 8)} stuck-status reset — no active nodes or pending tasks`);
    }
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
    const { agentType, enabledRoles, defaultRole, agentParams } = req.body as { agentType?: string; enabledRoles?: string[]; defaultRole?: string; agentParams?: string };
    const effectiveAgent = agentType || AGENT_TYPE;
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
      if (effectiveAgent === "claude" && !existsSync(join(cwd, "CLAUDE.md"))) {
        res.status(400).json({ error: `No CLAUDE.md found at ${cwd}. A CLAUDE.md file is required to identify a valid Claude Code workspace.` });
        return;
      }
    }
    const blueprint = createBlueprint(title.trim(), description, projectCwd, agentType, enabledRoles, defaultRole, agentParams);
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
    const search = req.query.search as string | undefined;
    const includeArchived = req.query.includeArchived === "true";
    const blueprints = listBlueprints({ status, projectCwd, search, includeArchived });
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
    const search = req.query.search as string | undefined;
    if (search) {
      const lowerSearch = search.toLowerCase();
      blueprint.nodes = blueprint.nodes.filter(n => n.title.toLowerCase().includes(lowerSearch));
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

    // Validate executionMode if provided
    if (patch.executionMode !== undefined) {
      if (patch.executionMode !== "manual" && patch.executionMode !== "autopilot" && patch.executionMode !== "fsd") {
        res.status(400).json({ error: "executionMode must be 'manual', 'autopilot', or 'fsd'" });
        return;
      }
    }

    // Validate maxIterations if provided
    if (patch.maxIterations !== undefined) {
      const maxIter = Number(patch.maxIterations);
      if (isNaN(maxIter) || maxIter < 10 || maxIter > 200) {
        res.status(400).json({ error: "maxIterations must be between 10 and 200" });
        return;
      }
      patch.maxIterations = maxIter;
    }

    // Check if switching to autopilot — need current state before update
    const currentBp = getBlueprint(req.params.id);
    if (!currentBp) {
      res.status(404).json({ error: "Blueprint not found" });
      return;
    }
    const isAutopilotMode = (mode: string | undefined) => mode === "autopilot" || mode === "fsd";
    const switchingToAutopilot =
      isAutopilotMode(patch.executionMode as string) &&
      !isAutopilotMode(currentBp.executionMode) &&
      (currentBp.status === "approved" || currentBp.status === "paused");

    // Detect switching between autopilot-like modes (autopilot ↔ fsd) while paused.
    // The previous loop may have paused due to safeguards; switching to fsd should
    // clear the stale pause and restart the loop in the new mode.
    const switchingBetweenAutopilotModes =
      isAutopilotMode(patch.executionMode as string) &&
      isAutopilotMode(currentBp.executionMode) &&
      patch.executionMode !== currentBp.executionMode &&
      currentBp.status === "paused";

    // Clear pause_reason when switching to autopilot/fsd or between autopilot modes while paused
    if (switchingToAutopilot || switchingBetweenAutopilotModes) {
      patch.pauseReason = "";
    }

    const blueprint = updateBlueprint(req.params.id, patch);
    if (!blueprint) {
      res.status(404).json({ error: "Blueprint not found" });
      return;
    }

    // Side effect: enqueue autopilot loop when switching to autopilot on approved/paused blueprint,
    // or when switching between autopilot modes while paused (e.g. autopilot→fsd restarts loop)
    if (switchingToAutopilot || switchingBetweenAutopilotModes) {
      enqueueBlueprintTask(req.params.id, () => runAutopilotLoop(req.params.id)).catch((err) => {
        log.error(`Autopilot loop failed for ${req.params.id}: ${err instanceof Error ? err.message : err}`);
      });
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

// POST /api/blueprints/:id/star — star a blueprint
planRouter.post("/api/blueprints/:id/star", (req, res) => {
  try {
    const result = starBlueprint(req.params.id);
    if (!result) {
      res.status(404).json({ error: "Blueprint not found" });
      return;
    }
    res.json(result);
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// POST /api/blueprints/:id/unstar — unstar a blueprint
planRouter.post("/api/blueprints/:id/unstar", (req, res) => {
  try {
    const result = unstarBlueprint(req.params.id);
    if (!result) {
      res.status(404).json({ error: "Blueprint not found" });
      return;
    }
    res.json(result);
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// GET /api/blueprints/:id/autopilot-log — get autopilot decision log
planRouter.get("/api/blueprints/:id/autopilot-log", (req, res) => {
  try {
    const blueprint = getBlueprint(req.params.id);
    if (!blueprint) {
      res.status(404).json({ error: "Blueprint not found" });
      return;
    }
    const rawLimit = parseInt(req.query.limit as string, 10);
    const rawOffset = parseInt(req.query.offset as string, 10);
    const limit = Math.min(Math.max(isNaN(rawLimit) ? 20 : rawLimit, 1), 100);
    const offset = Math.max(isNaN(rawOffset) ? 0 : rawOffset, 0);
    const entries = getAutopilotLog(req.params.id, limit, offset);
    res.json(entries);
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

    // In autopilot/FSD mode, route through message queue
    if (blueprint.executionMode === "autopilot" || blueprint.executionMode === "fsd") {
      const msgContent = nodeId
        ? `Enrich node ${nodeId}: title="${title.trim()}"${description ? `, description="${description.trim()}"` : ""}`
        : `Enrich new node: title="${title.trim()}"${description ? `, description="${description.trim()}"` : ""}`;
      createAutopilotMessage(blueprintId, "user", msgContent);
      triggerUserAgent(blueprintId);
      res.json({ status: "queued", nodeId: nodeId ?? null });
      return;
    }

    // Build context: dependencies (titles + handoffs) take priority.
    // Workspace (projectCwd) provides broader context — never list all other nodes.
    const currentNode = nodeId ? blueprint.nodes.find((n) => n.id === nodeId) : null;
    const depIds = currentNode?.dependencies ?? [];
    const depNodes = depIds.length > 0 ? blueprint.nodes.filter((n) => depIds.includes(n.id)) : [];

    // Dependency nodes: titles + handoff artifacts (regardless of status)
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
    const nodeRoles: RoleDefinition[] = (() => {
      if (currentNode) {
        const roleIds = resolveNodeRoles(currentNode, blueprint);
        return roleIds.map((id) => getRole(id)).filter((r): r is RoleDefinition => r !== undefined);
      }
      // New node: use blueprint default role
      const defaultRoleId = blueprint.defaultRole ?? "sde";
      const r = getRole(defaultRoleId);
      return r ? [r] : [];
    })();
    const specificityGuidance = nodeRoles.length > 0
      ? nodeRoles.map((r) => r.prompts.specificityGuidance).join(" ")
      : "Be specific: mention file paths, function names, API endpoints.";

    const enrichPromptBase = `You are helping a developer write a clear, actionable task node for a coding blueprint.

Blueprint: "${blueprint.title}"
${blueprint.description ? `Blueprint description: ${blueprint.description}` : ""}
${blueprint.projectCwd ? `Project directory: ${blueprint.projectCwd}` : ""}
${depContext ? `\nDependency nodes (this node depends on these — consider their titles and handoff artifacts when enriching):\n${depContext}` : ""}

The user wants to ${nodeId ? "enrich an existing" : "add a new"} node with:
- Title: "${title.trim()}"
${description ? `- Description: "${description.trim()}"` : "- Description: (none provided)"}

Your task: Enrich and improve the title and description to make them clear and actionable for an AI agent. The enriched description should:
1. Be specific about what needs to be done — ${specificityGuidance}
${depContext ? "2. Build on context from dependency nodes — reference what they produce (handoff artifacts) and how this node continues the work\n3." : "2."} Include acceptance criteria or expected behavior when helpful
${depContext ? "4." : "3."} Stay concise — no fluff`;

    if (nodeId) {
      // Existing node: fire-and-forget via extracted operation
      const enrichNodeId = nodeId;
      addPendingTask(blueprintId, { type: "enrich", nodeId: enrichNodeId, queuedAt: new Date().toISOString() });
      enqueueBlueprintTask(blueprintId, async () => {
        try {
          await enrichNodeInternal(blueprintId, enrichNodeId);
        } finally {
          removePendingTask(blueprintId, enrichNodeId, "enrich");
        }
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
        await runAgentInteractive(prompt, blueprint.projectCwd || undefined, parseAgentParams(blueprint.agentParams));
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

    // In autopilot/FSD mode, route through message queue
    if (blueprint.executionMode === "autopilot" || blueprint.executionMode === "fsd") {
      createAutopilotMessage(blueprintId, "user", `Reevaluate node ${nodeId}: "${node.title}"`);
      triggerUserAgent(blueprintId);
      res.json({ status: "queued", nodeId });
      return;
    }

    // Track in pending tasks for queue status API
    addPendingTask(blueprintId, { type: "reevaluate", nodeId, queuedAt: new Date().toISOString() });

    // Fire and forget via extracted operation
    enqueueBlueprintTask(blueprintId, async () => {
      try {
        await reevaluateNodeInternal(blueprintId, nodeId);
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

    // In autopilot/FSD mode, route through message queue
    if (blueprint.executionMode === "autopilot" || blueprint.executionMode === "fsd") {
      createAutopilotMessage(blueprintId, "user", `Split node ${nodeId}: "${node.title}"`);
      triggerUserAgent(blueprintId);
      res.json({ status: "queued", nodeId });
      return;
    }

    // Track in pending tasks for queue status API
    addPendingTask(blueprintId, { type: "split", nodeId, queuedAt: new Date().toISOString() });

    // Fire and forget via extracted operation
    enqueueBlueprintTask(blueprintId, async () => {
      try {
        await splitNodeInternal(blueprintId, nodeId);
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

    // In autopilot/FSD mode, route through message queue
    if (blueprint.executionMode === "autopilot" || blueprint.executionMode === "fsd") {
      createAutopilotMessage(blueprintId, "user", `Smart dependencies for node ${nodeId}: "${node.title}"`);
      triggerUserAgent(blueprintId);
      res.json({ status: "queued", nodeId });
      return;
    }

    const siblingNodes = blueprint.nodes.filter((n) => n.id !== nodeId && n.status !== "skipped");
    if (siblingNodes.length === 0) {
      res.status(400).json({ error: "No other nodes to depend on" });
      return;
    }

    addPendingTask(blueprintId, { type: "smart_deps", nodeId, queuedAt: new Date().toISOString() });

    // Fire and forget via extracted operation
    enqueueBlueprintTask(blueprintId, async () => {
      try {
        await smartDepsInternal(blueprintId, nodeId);
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

    // If any status was updated, check if blueprint should be finalized
    if (results.some((r) => r.updated)) {
      maybeFinalizeBlueprint(req.params.blueprintId);
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
      roles?: string[];
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
        ...(step.roles && Array.isArray(step.roles) && step.roles.length > 0 ? { roles: step.roles } : {}),
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
    const { title, description, order, dependencies, parallelGroup, prompt, estimatedMinutes, roles } = req.body as {
      title?: string;
      description?: string;
      order?: number;
      dependencies?: string[];
      parallelGroup?: string;
      prompt?: string;
      estimatedMinutes?: number;
      roles?: string[];
    };
    if (!title || typeof title !== "string" || title.trim().length === 0) {
      res.status(400).json({ error: "Missing or empty 'title'" });
      return;
    }
    const maxOrder = blueprint.nodes.reduce((m, n) => Math.max(m, n.order), -1);
    const nodeOrder = order ?? maxOrder + 1;
    const node = createMacroNode(req.params.blueprintId, {
      title: title.trim(),
      description,
      order: nodeOrder,
      dependencies,
      parallelGroup,
      prompt,
      estimatedMinutes,
      ...(roles && Array.isArray(roles) && roles.length > 0 ? { roles } : {}),
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
    // Check if blueprint should be finalized after status change
    if (patch.status) {
      maybeFinalizeBlueprint(req.params.blueprintId);
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

// GET /api/blueprints/:blueprintId/nodes/:nodeId/active-related-session — get in-flight related session
planRouter.get("/api/blueprints/:blueprintId/nodes/:nodeId/active-related-session", (req, res) => {
  try {
    const session = getActiveRelatedSession(req.params.nodeId);
    res.json(session ?? null);
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
    // Opportunistically fix stuck blueprint status during polling
    maybeFinalizeBlueprint(req.params.id);
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

// POST /api/blueprints/:id/nodes/:nodeId/suggestions-callback — callback for follow-up suggestions
// Called by Claude during evaluation to persist follow-up task suggestions for completed nodes
planRouter.post("/api/blueprints/:id/nodes/:nodeId/suggestions-callback", (req, res) => {
  try {
    const blueprintId = req.params.id;
    const nodeId = req.params.nodeId;
    const blueprint = getBlueprint(blueprintId);
    if (!blueprint) { res.status(404).json({ error: "Blueprint not found" }); return; }
    const node = blueprint.nodes.find((n) => n.id === nodeId);
    if (!node) { res.status(404).json({ error: "Node not found" }); return; }

    const { suggestions } = req.body as {
      suggestions?: Array<{ title?: string; description?: string; roles?: string[] }>;
    };

    if (!Array.isArray(suggestions) || suggestions.length === 0) {
      res.status(400).json({ error: "Missing or empty 'suggestions' array" });
      return;
    }

    // Filter to valid suggestions before deleting old ones to prevent data loss
    const valid = suggestions
      .slice(0, 3)
      .filter((s) => s.title && typeof s.title === "string");

    if (valid.length === 0) {
      res.status(400).json({ error: "No valid suggestions (each must have a non-empty 'title' string)" });
      return;
    }

    // Diff-based update: keep existing suggestions that match, remove stale, add new
    const existing = getSuggestionsForNode(nodeId);
    const existingByTitle = new Map(existing.map((s) => [s.title, s]));
    const incomingTitles = new Set(valid.map((s) => s.title!));

    // Remove suggestions no longer in the incoming set
    for (const s of existing) {
      if (!incomingTitles.has(s.title)) {
        deleteSuggestion(s.id);
      }
    }

    // Create only truly new suggestions (skip duplicates by title)
    const created: ReturnType<typeof createSuggestion>[] = [];
    for (const s of valid) {
      if (!existingByTitle.has(s.title!)) {
        const roles = Array.isArray(s.roles) ? s.roles.filter((r) => typeof r === "string") : undefined;
        created.push(createSuggestion(blueprintId, nodeId, s.title!, s.description || "", roles && roles.length > 0 ? roles : undefined));
      }
    }

    const totalCount = (existing.length - existing.filter((s) => !incomingTitles.has(s.title)).length) + created.length;
    log.info(`Suggestions callback for node ${nodeId.slice(0, 8)} "${node.title}": ${totalCount} suggestions (${created.length} new, ${totalCount - created.length} kept)`);
    res.json({ success: true, count: totalCount });
  } catch (err) {
    log.error(`Suggestions callback failed: ${err instanceof Error ? err.message : err}`);
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// POST /api/blueprints/:id/nodes/:nodeId/insights-callback — callback for blueprint-level insights
// Called by the agent during evaluation to surface cross-cutting observations
planRouter.post("/api/blueprints/:id/nodes/:nodeId/insights-callback", (req, res) => {
  try {
    const blueprintId = req.params.id;
    const nodeId = req.params.nodeId;
    const blueprint = getBlueprint(blueprintId);
    if (!blueprint) { res.status(404).json({ error: "Blueprint not found" }); return; }
    const node = blueprint.nodes.find((n) => n.id === nodeId);
    if (!node) { res.status(404).json({ error: "Node not found" }); return; }

    const { insights } = req.body as {
      insights?: Array<{ role?: string; severity?: string; message?: string }>;
    };

    if (!Array.isArray(insights) || insights.length === 0) {
      res.status(400).json({ error: "Missing or empty 'insights' array" });
      return;
    }

    const validSeverities = new Set(["info", "warning", "critical"]);
    const valid = insights.filter(
      (i) => i.role && typeof i.role === "string" && i.message && typeof i.message === "string" && validSeverities.has(i.severity || ""),
    );

    if (valid.length === 0) {
      res.status(400).json({ error: "No valid insights (each must have role, severity, and message)" });
      return;
    }

    // Build a label→id lookup to normalize role labels to IDs
    const roleLabelToId = new Map<string, string>();
    for (const r of getAllRoles()) {
      roleLabelToId.set(r.label.toLowerCase(), r.id);
    }

    for (const i of valid) {
      // Normalize: if the role value isn't a known ID, try matching by label
      let roleId = i.role!;
      if (!getRole(roleId)) {
        const normalized = roleLabelToId.get(roleId.toLowerCase());
        if (normalized) {
          roleId = normalized;
        } else {
          log.warn(`Unrecognized role label "${roleId}" — valid IDs: [${getAllRoles().map(r => r.id).join(", ")}]. Storing as-is.`);
        }
      }
      createInsight(blueprintId, nodeId, roleId, i.severity! as InsightSeverity, i.message!);
    }

    log.info(`Insights callback for node ${nodeId.slice(0, 8)} "${node.title}": ${valid.length} insights created`);
    res.json({ success: true, count: valid.length });
  } catch (err) {
    log.error(`Insights callback failed: ${err instanceof Error ? err.message : err}`);
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// GET /api/blueprints/:id/insights — list insights for a blueprint
planRouter.get("/api/blueprints/:id/insights", (req, res) => {
  try {
    const blueprint = getBlueprint(req.params.id);
    if (!blueprint) { res.status(404).json({ error: "Blueprint not found" }); return; }

    const unreadOnly = req.query.unread === "true";
    const insights = getInsightsForBlueprint(req.params.id, { unreadOnly });
    res.json(insights);
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// POST /api/blueprints/:id/insights/:insightId/mark-read — mark a single insight as read
planRouter.post("/api/blueprints/:id/insights/:insightId/mark-read", (req, res) => {
  try {
    const blueprint = getBlueprint(req.params.id);
    if (!blueprint) { res.status(404).json({ error: "Blueprint not found" }); return; }

    const updated = markInsightRead(req.params.insightId);
    if (!updated) { res.status(404).json({ error: "Insight not found" }); return; }

    res.json(updated);
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// POST /api/blueprints/:id/insights/mark-all-read — mark all insights as read for a blueprint
planRouter.post("/api/blueprints/:id/insights/mark-all-read", (req, res) => {
  try {
    const blueprint = getBlueprint(req.params.id);
    if (!blueprint) { res.status(404).json({ error: "Blueprint not found" }); return; }

    markAllInsightsRead(req.params.id);
    res.json({ success: true });
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// POST /api/blueprints/:id/insights/:insightId/dismiss — dismiss a single insight
planRouter.post("/api/blueprints/:id/insights/:insightId/dismiss", (req, res) => {
  try {
    const blueprint = getBlueprint(req.params.id);
    if (!blueprint) { res.status(404).json({ error: "Blueprint not found" }); return; }

    dismissInsight(req.params.insightId);
    res.json({ success: true });
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// GET /api/insights/unread-count — aggregate unread insight count across all blueprints
planRouter.get("/api/insights/unread-count", (_req, res) => {
  try {
    const count = getTotalUnreadInsightCount();
    res.json({ count });
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// POST /api/blueprints/:id/coordinate — trigger blueprint coordinator to process unread insights
// Fire-and-forget: returns immediately with {status:"queued"}, runs async
planRouter.post("/api/blueprints/:id/coordinate", (req, res) => {
  try {
    const blueprintId = req.params.id;
    const blueprint = getBlueprint(blueprintId);
    if (!blueprint) {
      res.status(404).json({ error: "Blueprint not found" });
      return;
    }

    addPendingTask(blueprintId, { type: "coordinate", queuedAt: new Date().toISOString() });

    enqueueBlueprintTask(blueprintId, async () => {
      try {
        await coordinateBlueprint(blueprintId);
      } finally {
        removePendingTask(blueprintId, undefined, "coordinate");
      }
    }).catch((err) => {
      log.error(`Coordinate blueprint ${blueprintId.slice(0, 8)} failed: ${err instanceof Error ? err.message : err}`);
    });

    res.json({ status: "queued" });
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// GET /api/blueprints/:blueprintId/nodes/:nodeId/suggestions — get follow-up suggestions for a node
planRouter.get("/api/blueprints/:blueprintId/nodes/:nodeId/suggestions", (req, res) => {
  try {
    const blueprint = getBlueprint(req.params.blueprintId);
    if (!blueprint) { res.status(404).json({ error: "Blueprint not found" }); return; }
    const node = blueprint.nodes.find((n) => n.id === req.params.nodeId);
    if (!node) { res.status(404).json({ error: "Node not found in blueprint" }); return; }

    const suggestions = getSuggestionsForNode(req.params.nodeId);
    res.json(suggestions);
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// POST /api/blueprints/:blueprintId/nodes/:nodeId/suggestions/:suggestionId/mark-used — mark a suggestion as used
planRouter.post("/api/blueprints/:blueprintId/nodes/:nodeId/suggestions/:suggestionId/mark-used", (req, res) => {
  try {
    const blueprint = getBlueprint(req.params.blueprintId);
    if (!blueprint) { res.status(404).json({ error: "Blueprint not found" }); return; }
    const node = blueprint.nodes.find((n) => n.id === req.params.nodeId);
    if (!node) { res.status(404).json({ error: "Node not found in blueprint" }); return; }

    const updated = markSuggestionUsed(req.params.suggestionId);
    if (!updated) { res.status(404).json({ error: "Suggestion not found" }); return; }

    res.json(updated);
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// GET /api/blueprints/:blueprintId/suggestions — get unused blueprint-level suggestions
planRouter.get("/api/blueprints/:blueprintId/suggestions", (req, res) => {
  try {
    const blueprint = getBlueprint(req.params.blueprintId);
    if (!blueprint) { res.status(404).json({ error: "Blueprint not found" }); return; }

    const all = getBlueprintSuggestions(req.params.blueprintId);
    const unused = all.filter((s) => !s.used);
    res.json(unused);
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// POST /api/blueprints/:blueprintId/suggestions/:suggestionId/use — atomically mark used + send as user message + trigger autopilot
planRouter.post("/api/blueprints/:blueprintId/suggestions/:suggestionId/use", (req, res) => {
  try {
    const blueprint = getBlueprint(req.params.blueprintId);
    if (!blueprint) { res.status(404).json({ error: "Blueprint not found" }); return; }

    const suggestion = markBlueprintSuggestionUsed(req.params.suggestionId);
    if (!suggestion) { res.status(404).json({ error: "Suggestion not found" }); return; }

    // Atomically send the suggestion content as a user message
    const msgContent = suggestion.description
      ? `${suggestion.title}: ${suggestion.description}`
      : suggestion.title;
    const message = createAutopilotMessage(req.params.blueprintId, "user", msgContent);
    triggerUserAgent(req.params.blueprintId);

    res.json({ suggestion, message });
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// POST /api/blueprints/:blueprintId/suggestions/dismiss — clear all unused blueprint suggestions
planRouter.post("/api/blueprints/:blueprintId/suggestions/dismiss", (req, res) => {
  try {
    const blueprint = getBlueprint(req.params.blueprintId);
    if (!blueprint) { res.status(404).json({ error: "Blueprint not found" }); return; }

    clearBlueprintSuggestions(req.params.blueprintId);
    res.json({ ok: true });
  } catch (err) {
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

    // If the execution/node was already marked failed (e.g., by recovery logic during a server restart
    // while Claude was still thinking), the report-status callback is authoritative — fix the status.
    const node = blueprint.nodes.find((n) => n.id === execution.nodeId);
    if (node && execution.status === "failed" && status !== "failed") {
      log.info(`Late report-status override: node ${execution.nodeId.slice(0, 8)} was "failed" but Claude reported "${status}" — correcting`);

      const now = new Date().toISOString();

      if (status === "done") {
        updateExecution(execId, {
          status: "done",
          completedAt: now,
          outputSummary: execution.taskSummary || "Recovered via late report-status callback",
        });
        updateMacroNode(blueprintId, execution.nodeId, {
          status: "done",
          error: "",
        });
        // Fire-and-forget: evaluate completion in background
        enqueueBlueprintTask(blueprintId, async () => {
          await evaluateNodeCompletion(blueprintId, execution.nodeId, blueprint.projectCwd);
        }).catch(err => {
          log.error(`Post-recovery evaluation failed for node ${execution.nodeId.slice(0, 8)}: ${err instanceof Error ? err.message : err}`);
        });
      } else if (status === "blocked") {
        const blockerReason = reason || "Task reported as blocked by Claude";
        updateExecution(execId, {
          status: "done",
          completedAt: now,
          outputSummary: `BLOCKER: ${blockerReason}`,
        });
        updateMacroNode(blueprintId, execution.nodeId, {
          status: "blocked",
          error: `Blocker: ${blockerReason}`,
        });
      }
    }

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

    // In autopilot/FSD mode, route through message queue
    if (blueprint.executionMode === "autopilot" || blueprint.executionMode === "fsd") {
      createAutopilotMessage(blueprintId, "user", "Reevaluate all non-done nodes");
      triggerUserAgent(blueprintId);
      res.json({ message: "reevaluation requested via autopilot", blueprintId });
      return;
    }

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

    // Fire and forget via extracted operation
    enqueueBlueprintTask(blueprintId, async () => {
      try {
        await reevaluateAllInternal(blueprintId);
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

// POST /api/blueprints/:id/run-all — run all nodes in background (mode-aware)
planRouter.post("/api/blueprints/:id/run-all", (req, res) => {
  try {
    const blueprint = getBlueprint(req.params.id);
    if (!blueprint) {
      res.status(404).json({ error: "Blueprint not found" });
      return;
    }
    // Fire and forget — execution continues in background
    const safeguardGrace = (req.body as { safeguardGrace?: number } | undefined)?.safeguardGrace;
    if (blueprint.executionMode === "autopilot" || blueprint.executionMode === "fsd") {
      const loopOpts = safeguardGrace ? { safeguardGrace } : undefined;
      enqueueBlueprintTask(req.params.id, () => runAutopilotLoop(req.params.id, loopOpts)).catch((err) => {
        log.error(`Autopilot loop failed for ${req.params.id}: ${err instanceof Error ? err.message : err}`);
      });
    } else {
      executeAllNodes(req.params.id).catch((err) => {
        log.error(`Run-all failed for ${req.params.id}: ${err instanceof Error ? err.message : err}`);
      });
    }
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

    // In autopilot/FSD mode, route through message queue instead of running directly
    if (blueprint.executionMode === "autopilot" || blueprint.executionMode === "fsd") {
      const msgContent = description
        ? `Generate nodes: ${description}`
        : "Generate nodes for this blueprint based on its title and description";
      createAutopilotMessage(blueprintId, "user", msgContent);
      triggerUserAgent(blueprintId);
      res.json({ status: "queued", blueprintId });
      return;
    }

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
    const { title, description, cwd, projectCwd, agentType } = req.body as {
      title?: string;
      description?: string;
      cwd?: string;
      projectCwd?: string;
      agentType?: string;
    };
    if (!title || typeof title !== "string" || title.trim().length === 0) {
      res.status(400).json({ error: "Missing or empty 'title'" });
      return;
    }
    const blueprint = createBlueprint(title.trim(), description, projectCwd ?? cwd, agentType);
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
    const maxOrder = blueprint.nodes.reduce((m, n) => Math.max(m, n.order), -1);
    const nodeOrder = order ?? seq ?? maxOrder + 1;
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

// POST /api/plans/:id/run-all (legacy, mode-aware)
planRouter.post("/api/plans/:id/run-all", (req, res) => {
  try {
    const blueprint = getBlueprint(req.params.id);
    if (!blueprint) {
      res.status(404).json({ error: "Plan not found" });
      return;
    }
    if (blueprint.executionMode === "autopilot" || blueprint.executionMode === "fsd") {
      enqueueBlueprintTask(req.params.id, () => runAutopilotLoop(req.params.id)).catch((err) => {
        log.error(`Autopilot loop failed for ${req.params.id}: ${err instanceof Error ? err.message : err}`);
      });
    } else {
      executeAllNodes(req.params.id).catch((err) => {
        log.error(`Run-all failed for ${req.params.id}: ${err instanceof Error ? err.message : err}`);
      });
    }
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

// ─── Convene Endpoints ─────────────────────────────────────────

// POST /api/blueprints/:id/convene — start a convene session
// Fire-and-forget: returns immediately with {status:"queued", sessionId}, runs async
planRouter.post("/api/blueprints/:id/convene", (req, res) => {
  try {
    const blueprintId = req.params.id;
    const blueprint = getBlueprint(blueprintId);
    if (!blueprint) {
      res.status(404).json({ error: "Blueprint not found" });
      return;
    }

    const { topic, roleIds, contextNodeIds, maxRounds } = req.body as {
      topic?: string;
      roleIds?: string[];
      contextNodeIds?: string[];
      maxRounds?: number;
    };

    if (!topic || typeof topic !== "string" || topic.trim().length === 0) {
      res.status(400).json({ error: "Missing or empty 'topic'" });
      return;
    }
    if (!roleIds || !Array.isArray(roleIds) || roleIds.length < 2) {
      res.status(400).json({ error: "roleIds must be an array with at least 2 roles" });
      return;
    }

    // Validate roleIds against registered roles (not enabledRoles — enabledRoles is a preference, not a gate)
    const registeredRoles = new Set(getAllRoles().map((r) => r.id));
    const invalidRoles = roleIds.filter((r) => !registeredRoles.has(r));
    if (invalidRoles.length > 0) {
      res.status(400).json({ error: `Unknown role IDs: ${invalidRoles.join(", ")}` });
      return;
    }

    // Validate contextNodeIds if provided
    if (contextNodeIds && Array.isArray(contextNodeIds)) {
      const nodeIds = new Set(blueprint.nodes.map((n) => n.id));
      const invalidNodes = contextNodeIds.filter((id) => !nodeIds.has(id));
      if (invalidNodes.length > 0) {
        res.status(400).json({ error: `Context nodes not found in blueprint: ${invalidNodes.join(", ")}` });
        return;
      }
    }

    // Clamp maxRounds to 1-5
    const rounds = Math.max(1, Math.min(5, maxRounds ?? 3));

    const session = createConveneSession(blueprintId, topic.trim(), roleIds, contextNodeIds, rounds);

    addPendingTask(blueprintId, { type: "convene", queuedAt: new Date().toISOString() });

    enqueueBlueprintTask(blueprintId, async () => {
      try {
        await executeConveneSession(session.id);
      } finally {
        removePendingTask(blueprintId, undefined, "convene");
      }
    }).catch((err) => {
      log.error(`Convene session ${session.id.slice(0, 8)} failed: ${err instanceof Error ? err.message : err}`);
    });

    res.json({ status: "queued", sessionId: session.id });
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// GET /api/blueprints/:id/convene-sessions — list convene sessions for a blueprint
planRouter.get("/api/blueprints/:id/convene-sessions", (req, res) => {
  try {
    const blueprint = getBlueprint(req.params.id);
    if (!blueprint) {
      res.status(404).json({ error: "Blueprint not found" });
      return;
    }
    const sessions = getConveneSessions(req.params.id);
    res.json(sessions);
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// GET /api/blueprints/:id/convene-sessions/:sessionId — get full convene session with messages
planRouter.get("/api/blueprints/:id/convene-sessions/:sessionId", (req, res) => {
  try {
    const blueprint = getBlueprint(req.params.id);
    if (!blueprint) {
      res.status(404).json({ error: "Blueprint not found" });
      return;
    }
    const session = getConveneSession(req.params.sessionId);
    if (!session || session.blueprintId !== req.params.id) {
      res.status(404).json({ error: "Convene session not found" });
      return;
    }
    const messages = getConveneMessages(req.params.sessionId);
    res.json({ ...session, messages });
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// POST /api/blueprints/:id/convene-sessions/:sessionId/approve — approve synthesis and create nodes
planRouter.post("/api/blueprints/:id/convene-sessions/:sessionId/approve", (req, res) => {
  try {
    const blueprintId = req.params.id;
    const blueprint = getBlueprint(blueprintId);
    if (!blueprint) {
      res.status(404).json({ error: "Blueprint not found" });
      return;
    }
    const session = getConveneSession(req.params.sessionId);
    if (!session || session.blueprintId !== blueprintId) {
      res.status(404).json({ error: "Convene session not found" });
      return;
    }
    if (session.status !== "synthesizing") {
      res.status(400).json({ error: `Session status is '${session.status}', must be 'synthesizing' to approve` });
      return;
    }
    if (!session.synthesisResult || session.synthesisResult.length === 0) {
      res.status(400).json({ error: "No synthesis result to approve" });
      return;
    }

    // Reuse batch-create logic: resolve dependencies by index within the array
    const existingNodeIds = new Set(blueprint.nodes.map((n) => n.id));
    const maxOrder = Math.max(0, ...blueprint.nodes.map((n) => n.order));
    const createdNodes: MacroNode[] = [];

    for (let i = 0; i < session.synthesisResult.length; i++) {
      const step = session.synthesisResult[i];
      if (!step.title || typeof step.title !== "string") continue;

      const depIds = (step.dependencies || [])
        .map((dep) => {
          if (typeof dep === "number") {
            return dep >= 0 && dep < createdNodes.length ? createdNodes[dep].id : null;
          }
          if (typeof dep === "string") {
            return existingNodeIds.has(dep) || createdNodes.some((n) => n.id === dep) ? dep : null;
          }
          return null;
        })
        .filter((id): id is string => id !== null);

      const node = createMacroNode(blueprintId, {
        title: step.title,
        description: step.description,
        order: maxOrder + i + 1,
        dependencies: depIds.length > 0 ? depIds : undefined,
        ...(step.roles && Array.isArray(step.roles) && step.roles.length > 0 ? { roles: step.roles } : {}),
      });
      createdNodes.push(node);
    }

    updateConveneSessionStatus(req.params.sessionId, "completed");

    res.json({ status: "completed", createdNodeIds: createdNodes.map((n) => n.id) });
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// POST /api/blueprints/:id/convene-sessions/:sessionId/cancel — cancel a convene session
planRouter.post("/api/blueprints/:id/convene-sessions/:sessionId/cancel", (req, res) => {
  try {
    const blueprint = getBlueprint(req.params.id);
    if (!blueprint) {
      res.status(404).json({ error: "Blueprint not found" });
      return;
    }
    const session = getConveneSession(req.params.sessionId);
    if (!session || session.blueprintId !== req.params.id) {
      res.status(404).json({ error: "Convene session not found" });
      return;
    }
    if (session.status === "completed" || session.status === "cancelled") {
      res.status(400).json({ error: `Session already ${session.status}` });
      return;
    }

    updateConveneSessionStatus(req.params.sessionId, "cancelled");
    removePendingTask(req.params.id, undefined, "convene");

    res.json({ status: "cancelled" });
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// GET /api/blueprints/:id/convene-sessions/:sessionId/panel — read discussion panel (agent-facing)
planRouter.get("/api/blueprints/:id/convene-sessions/:sessionId/panel", (req, res) => {
  try {
    const blueprint = getBlueprint(req.params.id);
    if (!blueprint) {
      res.status(404).json({ error: "Blueprint not found" });
      return;
    }
    const session = getConveneSession(req.params.sessionId);
    if (!session || session.blueprintId !== req.params.id) {
      res.status(404).json({ error: "Convene session not found" });
      return;
    }

    const messages = getConveneMessages(req.params.sessionId);
    if (messages.length === 0) {
      res.type("text/plain").send("(No contributions yet — you are the first to speak.)");
      return;
    }

    // Group messages by round
    const byRound = new Map<number, typeof messages>();
    for (const msg of messages) {
      const arr = byRound.get(msg.round) ?? [];
      arr.push(msg);
      byRound.set(msg.round, arr);
    }

    const parts: string[] = [];
    for (const [round, msgs] of [...byRound.entries()].sort((a, b) => a[0] - b[0])) {
      parts.push(`## Round ${round}`);
      for (const msg of msgs) {
        parts.push(`### ${msg.roleId.toUpperCase()}\n${msg.content}`);
      }
    }

    res.type("text/plain").send(parts.join("\n\n"));
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// POST /api/blueprints/:id/convene-sessions/:sessionId/contribute — post a role contribution (agent-facing)
planRouter.post("/api/blueprints/:id/convene-sessions/:sessionId/contribute", (req, res) => {
  try {
    const blueprint = getBlueprint(req.params.id);
    if (!blueprint) {
      res.status(404).json({ error: "Blueprint not found" });
      return;
    }
    const session = getConveneSession(req.params.sessionId);
    if (!session || session.blueprintId !== req.params.id) {
      res.status(404).json({ error: "Convene session not found" });
      return;
    }
    if (session.status !== "active") {
      res.status(400).json({ error: `Session status is '${session.status}', must be 'active' to contribute` });
      return;
    }

    const { roleId, round, content } = req.body as {
      roleId?: string;
      round?: number;
      content?: string;
    };

    if (!roleId || typeof roleId !== "string") {
      res.status(400).json({ error: "Missing or invalid 'roleId'" });
      return;
    }
    if (!round || typeof round !== "number" || round < 1 || !Number.isInteger(round)) {
      res.status(400).json({ error: "Missing or invalid 'round' (must be a positive integer)" });
      return;
    }
    if (!content || typeof content !== "string" || content.trim().length === 0) {
      res.status(400).json({ error: "Missing or empty 'content'" });
      return;
    }

    createConveneMessage(req.params.sessionId, roleId, round, content.trim());
    res.json({ success: true });
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// POST /api/blueprints/:id/convene-sessions/:sessionId/propose-nodes — synthesis posts proposed nodes (agent-facing)
planRouter.post("/api/blueprints/:id/convene-sessions/:sessionId/propose-nodes", (req, res) => {
  try {
    const blueprint = getBlueprint(req.params.id);
    if (!blueprint) {
      res.status(404).json({ error: "Blueprint not found" });
      return;
    }
    const session = getConveneSession(req.params.sessionId);
    if (!session || session.blueprintId !== req.params.id) {
      res.status(404).json({ error: "Convene session not found" });
      return;
    }
    if (session.status !== "synthesizing") {
      res.status(400).json({ error: `Session status is '${session.status}', must be 'synthesizing' to propose nodes` });
      return;
    }

    const { nodes } = req.body as { nodes?: unknown };
    if (!Array.isArray(nodes) || nodes.length === 0) {
      res.status(400).json({ error: "Missing or empty 'nodes' array" });
      return;
    }
    for (const node of nodes) {
      if (!node || typeof node !== "object" || !("title" in node) || typeof node.title !== "string" || !node.title.trim()) {
        res.status(400).json({ error: "Each node must have a non-empty 'title' string" });
        return;
      }
      if (!("description" in node) || typeof node.description !== "string") {
        res.status(400).json({ error: "Each node must have a 'description' string" });
        return;
      }
    }

    updateConveneSessionStatus(req.params.sessionId, "synthesizing", nodes);
    res.json({ success: true, count: nodes.length });
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// ─── Autopilot Message Queue ─────────────────────────────────

// POST /api/blueprints/:id/messages — send a user message to the autopilot
planRouter.post("/api/blueprints/:id/messages", (req, res) => {
  try {
    const blueprint = getBlueprint(req.params.id);
    if (!blueprint) {
      res.status(404).json({ error: "Blueprint not found" });
      return;
    }
    const { content } = req.body as { content?: string };
    if (!content || typeof content !== "string" || !content.trim()) {
      res.status(400).json({ error: "Missing or empty 'content'" });
      return;
    }
    const message = createAutopilotMessage(req.params.id, "user", content.trim());
    triggerUserAgent(req.params.id);
    res.json(message);
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// GET /api/blueprints/:id/messages — get message history for chat display
planRouter.get("/api/blueprints/:id/messages", (req, res) => {
  try {
    const blueprint = getBlueprint(req.params.id);
    if (!blueprint) {
      res.status(404).json({ error: "Blueprint not found" });
      return;
    }
    const rawLimit = parseInt(req.query.limit as string, 10);
    const rawOffset = parseInt(req.query.offset as string, 10);
    const limit = Math.min(Math.max(isNaN(rawLimit) ? 50 : rawLimit, 1), 200);
    const offset = Math.max(isNaN(rawOffset) ? 0 : rawOffset, 0);
    const messages = getMessageHistory(req.params.id, limit, offset);
    const total = getMessageCount(req.params.id);
    res.json({ messages, total });
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// ─── Lightweight Node-Read Endpoints ─────────────────────────

// GET /api/blueprints/:id/nodes/summary — lightweight node overview for autopilot
planRouter.get("/api/blueprints/:id/nodes/summary", (req, res) => {
  try {
    const blueprint = getBlueprint(req.params.id);
    if (!blueprint) {
      res.status(404).json({ error: "Blueprint not found" });
      return;
    }
    const nodes = blueprint.nodes.map((n) => ({
      id: n.id,
      seq: n.seq,
      title: n.title,
      status: n.status,
      roles: n.roles ?? [],
      dependencies: n.dependencies,
    }));
    res.json({ nodes });
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// GET /api/blueprints/:id/nodes/:nodeId/context — full node context for autopilot
planRouter.get("/api/blueprints/:id/nodes/:nodeId/context", (req, res) => {
  try {
    const blueprint = getBlueprint(req.params.id);
    if (!blueprint) {
      res.status(404).json({ error: "Blueprint not found" });
      return;
    }
    const node = blueprint.nodes.find((n) => n.id === req.params.nodeId);
    if (!node) {
      res.status(404).json({ error: "Node not found" });
      return;
    }

    // Resolve dependencies to objects with title + status
    const dependencies = node.dependencies
      .map((depId) => {
        const dep = blueprint.nodes.find((n) => n.id === depId);
        return dep ? { id: dep.id, title: dep.title, status: dep.status } : null;
      })
      .filter(Boolean) as Array<{ id: string; title: string; status: MacroNodeStatus }>;

    // Latest handoff_summary artifact
    const handoffArtifact = [...node.outputArtifacts]
      .filter((a) => a.type === "handoff_summary")
      .pop();
    const handoff = handoffArtifact ? handoffArtifact.content : null;

    // Suggestions
    const suggestions = getSuggestionsForNode(node.id).map((s) => ({
      id: s.id,
      title: s.title,
      description: s.description,
    }));

    res.json({
      id: node.id,
      seq: node.seq,
      title: node.title,
      description: node.description,
      prompt: node.prompt ?? null,
      status: node.status,
      error: node.error ?? null,
      roles: node.roles ?? [],
      dependencies,
      handoff,
      suggestions,
    });
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

// GET /api/blueprints/:id/progress — node status counts
planRouter.get("/api/blueprints/:id/progress", (req, res) => {
  try {
    const blueprint = getBlueprint(req.params.id);
    if (!blueprint) {
      res.status(404).json({ error: "Blueprint not found" });
      return;
    }
    const counts: Record<string, number> = { total: 0, done: 0, failed: 0, pending: 0, running: 0, skipped: 0, queued: 0, blocked: 0 };
    for (const node of blueprint.nodes) {
      counts.total++;
      if (node.status in counts) {
        counts[node.status]++;
      }
    }
    res.json(counts);
  } catch (err) {
    log.error(String(err)); res.status(500).json({ error: safeError(err) });
  }
});

export default planRouter;
