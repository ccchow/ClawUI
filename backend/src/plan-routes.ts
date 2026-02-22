import { Router } from "express";
import {
  createBlueprint,
  getBlueprint,
  listBlueprints,
  updateBlueprint,
  deleteBlueprint,
  createMacroNode,
  updateMacroNode,
  deleteMacroNode,
  reorderMacroNodes,
  createArtifact,
  getArtifactsForNode,
  deleteArtifact,
  createExecution,
  getExecutionsForNode,
  getExecutionBySession,
  getNodeBySession,
} from "./plan-db.js";
import type { ArtifactType, ExecutionType } from "./plan-db.js";
import { executeNode, executeNextNode, executeAllNodes } from "./plan-executor.js";

const planRouter = Router();

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
    const blueprint = createBlueprint(title.trim(), description, projectCwd);
    res.status(201).json(blueprint);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/blueprints — list blueprints
planRouter.get("/api/blueprints", (req, res) => {
  try {
    const status = req.query.status as string | undefined;
    const projectCwd = req.query.projectCwd as string | undefined;
    const blueprints = listBlueprints({ status, projectCwd });
    res.json(blueprints);
  } catch (err) {
    res.status(500).json({ error: String(err) });
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
    res.status(500).json({ error: String(err) });
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
    res.status(500).json({ error: String(err) });
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
    res.status(500).json({ error: String(err) });
  }
});

// ─── MacroNode operations ────────────────────────────────────

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
    res.status(500).json({ error: String(err) });
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
    res.status(500).json({ error: String(err) });
  }
});

// DELETE /api/blueprints/:blueprintId/nodes/:nodeId — delete node
planRouter.delete("/api/blueprints/:blueprintId/nodes/:nodeId", (req, res) => {
  try {
    deleteMacroNode(req.params.blueprintId, req.params.nodeId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
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
    res.status(500).json({ error: String(err) });
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
    res.status(500).json({ error: String(err) });
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
    res.status(500).json({ error: String(err) });
  }
});

// DELETE /api/blueprints/:blueprintId/artifacts/:artifactId
planRouter.delete("/api/blueprints/:blueprintId/artifacts/:artifactId", (req, res) => {
  try {
    deleteArtifact(req.params.artifactId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── Execution endpoints ─────────────────────────────────────

// GET /api/blueprints/:blueprintId/nodes/:nodeId/executions
planRouter.get("/api/blueprints/:blueprintId/nodes/:nodeId/executions", (req, res) => {
  try {
    const executions = getExecutionsForNode(req.params.nodeId);
    res.json(executions);
  } catch (err) {
    res.status(500).json({ error: String(err) });
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
    res.status(500).json({ error: String(err) });
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
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/blueprints/:id/nodes/:nodeId/run — run a single node
planRouter.post("/api/blueprints/:id/nodes/:nodeId/run", async (req, res) => {
  try {
    req.setTimeout(300_000); // 5 minute timeout
    const execution = await executeNode(req.params.id, req.params.nodeId);
    res.json(execution);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.includes("not found") ? 404 : msg.includes("must be") || msg.includes("not done") ? 400 : 500;
    res.status(status).json({ error: msg });
  }
});

// POST /api/blueprints/:id/run — run next pending node
planRouter.post("/api/blueprints/:id/run", async (req, res) => {
  try {
    req.setTimeout(300_000);
    const execution = await executeNextNode(req.params.id);
    if (!execution) {
      res.json({ message: "no pending nodes" });
      return;
    }
    res.json(execution);
  } catch (err) {
    res.status(500).json({ error: String(err) });
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
      console.error(`[plan-executor] run-all failed for ${req.params.id}:`, err);
    });
    res.json({ message: "execution started", blueprintId: req.params.id });
  } catch (err) {
    res.status(500).json({ error: String(err) });
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
    res.status(500).json({ error: String(err) });
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
    res.status(500).json({ error: String(err) });
  }
});

// ─── Backward-compat: /api/plans/* → same handlers ──────────

// POST /api/plans — create (accepts both cwd and projectCwd)
planRouter.post("/api/plans", (req, res) => {
  try {
    const { title, description, cwd, projectCwd, projectId } = req.body as {
      title?: string;
      description?: string;
      cwd?: string;
      projectCwd?: string;
      projectId?: string;
    };
    if (!title || typeof title !== "string" || title.trim().length === 0) {
      res.status(400).json({ error: "Missing or empty 'title'" });
      return;
    }
    const blueprint = createBlueprint(title.trim(), description, projectCwd ?? cwd);
    res.status(201).json(blueprint);
  } catch (err) {
    res.status(500).json({ error: String(err) });
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
    res.status(500).json({ error: String(err) });
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
    res.status(500).json({ error: String(err) });
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
    res.status(500).json({ error: String(err) });
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
    res.status(500).json({ error: String(err) });
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
    res.status(500).json({ error: String(err) });
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
    res.status(500).json({ error: String(err) });
  }
});

// DELETE /api/plans/:planId/nodes/:nodeId
planRouter.delete("/api/plans/:planId/nodes/:nodeId", (req, res) => {
  try {
    deleteMacroNode(req.params.planId, req.params.nodeId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
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
    res.status(500).json({ error: String(err) });
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
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/plans/:id/nodes/:nodeId/run
planRouter.post("/api/plans/:id/nodes/:nodeId/run", async (req, res) => {
  try {
    req.setTimeout(300_000);
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
    req.setTimeout(300_000);
    const execution = await executeNextNode(req.params.id);
    if (!execution) {
      res.json({ message: "no pending nodes" });
      return;
    }
    res.json(execution);
  } catch (err) {
    res.status(500).json({ error: String(err) });
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
      console.error(`[plan-executor] run-all failed for ${req.params.id}:`, err);
    });
    res.json({ message: "execution started", blueprintId: req.params.id });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default planRouter;
