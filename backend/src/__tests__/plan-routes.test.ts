import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import express from "express";
import request from "supertest";

// Mock node:fs for projectCwd validation in blueprint creation
// Normalize paths for cross-platform: on Windows join("/test","CLAUDE.md") → "\test\CLAUDE.md"
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn((p: string) => {
      // Allow /test and /test/CLAUDE.md to pass validation
      const np = p.replace(/\\/g, "/");
      if (np === "/test" || np === "/test/CLAUDE.md") return true;
      return actual.existsSync(p);
    }),
    statSync: vi.fn((p: string) => {
      if (p.replace(/\\/g, "/") === "/test") return { isDirectory: (): boolean => true };
      return actual.statSync(p);
    }),
  };
});

// Mock plan-db
vi.mock("../plan-db.js", () => ({
  createBlueprint: vi.fn(
    (title: string, description?: string, projectCwd?: string) => ({
      id: "bp-1",
      title,
      description: description ?? "",
      status: "draft",
      ...(projectCwd ? { projectCwd } : {}),
      nodes: [],
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    })
  ),
  getBlueprint: vi.fn((id: string) => {
    if (id === "missing") return null;
    return {
      id,
      title: "Test Blueprint",
      description: "desc",
      status: "draft",
      projectCwd: "/test",
      nodes: [
        {
          id: "node-1",
          blueprintId: id,
          order: 0,
          title: "Step 1",
          description: "First step",
          status: "pending",
          dependencies: [],
          inputArtifacts: [],
          outputArtifacts: [],
          executions: [],
          createdAt: "2024-01-01",
          updatedAt: "2024-01-01",
        },
      ],
      createdAt: "2024-01-01",
      updatedAt: "2024-01-01",
    };
  }),
  listBlueprints: vi.fn(() => [
    {
      id: "bp-1",
      title: "Test",
      description: "",
      status: "draft",
      nodes: [],
      createdAt: "2024-01-01",
      updatedAt: "2024-01-01",
    },
  ]),
  updateBlueprint: vi.fn((id: string, patch: Record<string, unknown>) => {
    if (id === "missing") return null;
    return {
      id,
      title: (patch.title as string) ?? "Test Blueprint",
      description: (patch.description as string) ?? "desc",
      status: (patch.status as string) ?? "draft",
      nodes: [],
      createdAt: "2024-01-01",
      updatedAt: "2024-01-01",
    };
  }),
  deleteBlueprint: vi.fn(),
  createMacroNode: vi.fn(
    (blueprintId: string, data: Record<string, unknown>) => ({
      id: "node-new",
      blueprintId,
      order: (data.order as number) ?? 0,
      title: data.title,
      description: data.description ?? "",
      status: "pending",
      dependencies: data.dependencies ?? [],
      inputArtifacts: [],
      outputArtifacts: [],
      executions: [],
      createdAt: "2024-01-01",
      updatedAt: "2024-01-01",
    })
  ),
  updateMacroNode: vi.fn(
    (bpId: string, nodeId: string, patch: Record<string, unknown>) => {
      if (nodeId === "missing-node") return null;
      return {
        id: nodeId,
        blueprintId: bpId,
        order: 0,
        title: (patch.title as string) ?? "Step 1",
        description: (patch.description as string) ?? "",
        status: (patch.status as string) ?? "pending",
        dependencies: [],
        inputArtifacts: [],
        outputArtifacts: [],
        executions: [],
        createdAt: "2024-01-01",
        updatedAt: "2024-01-01",
      };
    }
  ),
  deleteMacroNode: vi.fn(),
  reorderMacroNodes: vi.fn(),
  createArtifact: vi.fn(
    (
      bpId: string,
      nodeId: string,
      type: string,
      content: string,
      targetNodeId?: string
    ) => ({
      id: "art-1",
      type,
      content,
      sourceNodeId: nodeId,
      ...(targetNodeId ? { targetNodeId } : {}),
      blueprintId: bpId,
      createdAt: "2024-01-01",
    })
  ),
  getArtifactsForNode: vi.fn(() => []),
  deleteArtifact: vi.fn(),
  createExecution: vi.fn(
    (nodeId: string, bpId: string) => ({
      id: "exec-1",
      nodeId,
      blueprintId: bpId,
      type: "primary",
      status: "running",
      startedAt: "2024-01-01",
    })
  ),
  updateExecution: vi.fn(),
  getExecution: vi.fn((execId: string) => {
    if (execId === "missing-exec") return null;
    return {
      id: execId,
      nodeId: "node-1",
      blueprintId: "bp-1",
      type: "primary",
      status: "running",
      startedAt: "2024-01-01",
    };
  }),
  getExecutionsForNode: vi.fn(() => []),
  getExecutionBySession: vi.fn(() => null),
  getNodeBySession: vi.fn(() => null),
  setExecutionBlocker: vi.fn(),
  setExecutionTaskSummary: vi.fn(),
  setExecutionReportedStatus: vi.fn(),
  archiveBlueprint: vi.fn((id: string) => {
    if (id === "missing") return null;
    return { id, title: "Archived BP", status: "draft", archivedAt: "2024-01-01T00:00:00Z", nodes: [], createdAt: "2024-01-01", updatedAt: "2024-01-01" };
  }),
  unarchiveBlueprint: vi.fn((id: string) => {
    if (id === "missing") return null;
    return { id, title: "Unarchived BP", status: "draft", nodes: [], createdAt: "2024-01-01", updatedAt: "2024-01-01" };
  }),
  getRelatedSessionsForNode: vi.fn(() => [
    { id: "rs-1", nodeId: "node-1", blueprintId: "bp-1", sessionId: "session-1", type: "enrich", startedAt: "2024-01-01" },
  ]),
  createRelatedSession: vi.fn(),
}));

vi.mock("../plan-executor.js", () => ({
  executeNode: vi.fn(async () => ({
    id: "exec-1",
    nodeId: "node-1",
    status: "done",
  })),
  executeNextNode: vi.fn(async () => null),
  executeAllNodes: vi.fn(async () => {}),
  enqueueBlueprintTask: vi.fn(async (_id: string, task: () => Promise<unknown>) =>
    task()
  ),
  getQueueInfo: vi.fn(() => ({
    running: false,
    queueLength: 0,
    pendingTasks: [],
  })),
  addPendingTask: vi.fn(),
  removePendingTask: vi.fn(),
  removeQueuedTask: vi.fn(() => ({ removed: true, running: false })),
  detectNewSession: vi.fn(() => null),
  getGlobalQueueInfo: vi.fn(() => ({ active: false, totalPending: 0, tasks: [] })),
  runClaudeInteractive: vi.fn(async () => ""),
  withTimeout: vi.fn(async (promise: Promise<unknown>) => promise),
  evaluateNodeCompletion: vi.fn(async () => null),
  applyGraphMutations: vi.fn(() => ({
    createdNodes: [{ id: "new-node-1", title: "Refinement", status: "pending" }],
    rewiredDependencies: [],
  })),
  resumeNodeSession: vi.fn(async () => {}),
}));

vi.mock("../plan-generator.js", () => ({
  runClaudeInteractiveGen: vi.fn(async () => ""),
  getApiBase: vi.fn(() => "http://localhost:3001"),
  getAuthParam: vi.fn(() => "auth=test-token"),
}));

vi.mock("../db.js", () => ({
  syncSession: vi.fn(),
}));

import planRouter from "../plan-routes.js";
import {
  createBlueprint,
  listBlueprints,
  updateBlueprint,
  deleteBlueprint,
  createMacroNode,
  updateMacroNode,
  deleteMacroNode,
  reorderMacroNodes,
  getArtifactsForNode,
  // getExecution is used indirectly via mock auto-wiring in route handlers
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getExecution,
  getExecutionsForNode,
  setExecutionBlocker,
  setExecutionTaskSummary,
  setExecutionReportedStatus,
  archiveBlueprint,
  unarchiveBlueprint,
  getRelatedSessionsForNode,
} from "../plan-db.js";
import {
  applyGraphMutations,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getGlobalQueueInfo,
} from "../plan-executor.js";
// getQueueInfo is auto-mocked by vi.mock("../plan-executor.js")

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(planRouter);
  return app;
}

describe("plan-routes", () => {
  let app: express.Express;

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Blueprint CRUD ────────────────────────────────────────

  describe("POST /api/blueprints", () => {
    it("creates a blueprint", async () => {
      const res = await request(app)
        .post("/api/blueprints")
        .send({ title: "New Plan", description: "desc", projectCwd: "/test" });
      expect(res.status).toBe(201);
      expect(res.body.title).toBe("New Plan");
    });

    it("returns 400 for missing title", async () => {
      const res = await request(app).post("/api/blueprints").send({});
      expect(res.status).toBe(400);
    });

    it("returns 400 for empty title", async () => {
      const res = await request(app)
        .post("/api/blueprints")
        .send({ title: "   " });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/blueprints", () => {
    it("lists blueprints", async () => {
      const res = await request(app).get("/api/blueprints");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it("passes status and projectCwd filters", async () => {
      await request(app).get(
        "/api/blueprints?status=draft&projectCwd=/test"
      );
      expect(listBlueprints).toHaveBeenCalledWith({
        status: "draft",
        projectCwd: "/test",
        includeArchived: false,
      });
    });
  });

  describe("GET /api/blueprints/:id", () => {
    it("returns a blueprint", async () => {
      const res = await request(app).get("/api/blueprints/bp-1");
      expect(res.status).toBe(200);
      expect(res.body.title).toBe("Test Blueprint");
    });

    it("returns 404 for missing blueprint", async () => {
      const res = await request(app).get("/api/blueprints/missing");
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /api/blueprints/:id", () => {
    it("updates a blueprint", async () => {
      const res = await request(app)
        .put("/api/blueprints/bp-1")
        .send({ title: "Updated" });
      expect(res.status).toBe(200);
      expect(updateBlueprint).toHaveBeenCalledWith("bp-1", {
        title: "Updated",
      });
    });

    it("returns 404 for missing blueprint", async () => {
      const res = await request(app)
        .put("/api/blueprints/missing")
        .send({ title: "x" });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/blueprints/:id", () => {
    it("deletes a blueprint", async () => {
      const res = await request(app).delete("/api/blueprints/bp-1");
      expect(res.status).toBe(200);
      expect(deleteBlueprint).toHaveBeenCalledWith("bp-1");
    });

    it("returns 404 for missing blueprint", async () => {
      const res = await request(app).delete("/api/blueprints/missing");
      expect(res.status).toBe(404);
    });
  });

  // ─── MacroNode operations ──────────────────────────────────

  describe("POST /api/blueprints/:id/nodes", () => {
    it("creates a node", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/nodes")
        .send({ title: "New Step", description: "do stuff" });
      expect(res.status).toBe(201);
      expect(createMacroNode).toHaveBeenCalled();
    });

    it("returns 400 for missing title", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/nodes")
        .send({});
      expect(res.status).toBe(400);
    });

    it("returns 404 for missing blueprint", async () => {
      const res = await request(app)
        .post("/api/blueprints/missing/nodes")
        .send({ title: "Step" });
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /api/blueprints/:id/nodes/:nodeId", () => {
    it("updates a node", async () => {
      const res = await request(app)
        .put("/api/blueprints/bp-1/nodes/node-1")
        .send({ title: "Updated Step" });
      expect(res.status).toBe(200);
      expect(updateMacroNode).toHaveBeenCalledWith("bp-1", "node-1", {
        title: "Updated Step",
      });
    });

    it("returns 404 for missing node", async () => {
      const res = await request(app)
        .put("/api/blueprints/bp-1/nodes/missing-node")
        .send({ title: "x" });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/blueprints/:id/nodes/:nodeId", () => {
    it("deletes a node", async () => {
      const res = await request(app).delete(
        "/api/blueprints/bp-1/nodes/node-1"
      );
      expect(res.status).toBe(200);
      expect(deleteMacroNode).toHaveBeenCalledWith("bp-1", "node-1");
    });
  });

  describe("POST /api/blueprints/:id/nodes/reorder", () => {
    it("reorders nodes", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/nodes/reorder")
        .send([
          { id: "node-1", order: 1 },
          { id: "node-2", order: 0 },
        ]);
      expect(res.status).toBe(200);
      expect(reorderMacroNodes).toHaveBeenCalled();
    });

    it("returns 400 for non-array body", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/nodes/reorder")
        .send({ not: "array" });
      expect(res.status).toBe(400);
    });
  });

  // ─── Artifact endpoints ────────────────────────────────────

  describe("GET /api/blueprints/:id/nodes/:nodeId/artifacts", () => {
    it("returns artifacts with default direction=output", async () => {
      const res = await request(app).get(
        "/api/blueprints/bp-1/nodes/node-1/artifacts"
      );
      expect(res.status).toBe(200);
      expect(getArtifactsForNode).toHaveBeenCalledWith("node-1", "output");
    });

    it("accepts direction=input", async () => {
      const res = await request(app).get(
        "/api/blueprints/bp-1/nodes/node-1/artifacts?direction=input"
      );
      expect(res.status).toBe(200);
      expect(getArtifactsForNode).toHaveBeenCalledWith("node-1", "input");
    });

    it("returns 400 for invalid direction", async () => {
      const res = await request(app).get(
        "/api/blueprints/bp-1/nodes/node-1/artifacts?direction=sideways"
      );
      expect(res.status).toBe(400);
    });
  });

  // ─── Execution endpoints ───────────────────────────────────

  describe("GET /api/blueprints/:id/nodes/:nodeId/executions", () => {
    it("returns executions", async () => {
      const res = await request(app).get(
        "/api/blueprints/bp-1/nodes/node-1/executions"
      );
      expect(res.status).toBe(200);
      expect(getExecutionsForNode).toHaveBeenCalledWith("node-1");
    });
  });

  // ─── Queue status ──────────────────────────────────────────

  describe("GET /api/blueprints/:id/queue", () => {
    it("returns queue info", async () => {
      const res = await request(app).get("/api/blueprints/bp-1/queue");
      expect(res.status).toBe(200);
      expect(res.body.running).toBe(false);
      expect(res.body.queueLength).toBe(0);
    });
  });

  // ─── Blueprint lifecycle ───────────────────────────────────

  describe("POST /api/blueprints/:id/approve", () => {
    it("approves a blueprint", async () => {
      const res = await request(app).post("/api/blueprints/bp-1/approve");
      expect(res.status).toBe(200);
      expect(updateBlueprint).toHaveBeenCalledWith("bp-1", {
        status: "approved",
      });
    });

    it("returns 404 for missing blueprint", async () => {
      const res = await request(app).post("/api/blueprints/missing/approve");
      expect(res.status).toBe(404);
    });
  });

  // ─── Reverse lookups ──────────────────────────────────────

  describe("GET /api/sessions/:sessionId/plan-node", () => {
    it("returns 404 when no node linked", async () => {
      const res = await request(app).get("/api/sessions/s1/plan-node");
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/sessions/:sessionId/execution", () => {
    it("returns 404 when no execution linked", async () => {
      const res = await request(app).get("/api/sessions/s1/execution");
      expect(res.status).toBe(404);
    });
  });

  // ─── Execution callback endpoints ──────────────────────────

  describe("POST /api/blueprints/:id/executions/:execId/report-blocker", () => {
    it("stores blocker info", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/executions/exec-1/report-blocker")
        .send({ type: "missing_dependency", description: "Redis not installed", suggestion: "npm install redis" });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(setExecutionBlocker).toHaveBeenCalledWith(
        "exec-1",
        JSON.stringify({ type: "missing_dependency", description: "Redis not installed", suggestion: "npm install redis" })
      );
    });

    it("returns 400 for missing type", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/executions/exec-1/report-blocker")
        .send({ description: "Something" });
      expect(res.status).toBe(400);
    });

    it("returns 400 for missing description", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/executions/exec-1/report-blocker")
        .send({ type: "access_issue" });
      expect(res.status).toBe(400);
    });

    it("returns 404 for missing blueprint", async () => {
      const res = await request(app)
        .post("/api/blueprints/missing/executions/exec-1/report-blocker")
        .send({ type: "access_issue", description: "No API key" });
      expect(res.status).toBe(404);
    });

    it("returns 404 for missing execution", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/executions/missing-exec/report-blocker")
        .send({ type: "access_issue", description: "No API key" });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/blueprints/:id/executions/:execId/task-summary", () => {
    it("stores task summary", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/executions/exec-1/task-summary")
        .send({ summary: "Implemented JWT auth with token refresh." });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(setExecutionTaskSummary).toHaveBeenCalledWith(
        "exec-1",
        "Implemented JWT auth with token refresh."
      );
    });

    it("returns 400 for missing summary", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/executions/exec-1/task-summary")
        .send({});
      expect(res.status).toBe(400);
    });

    it("returns 404 for missing blueprint", async () => {
      const res = await request(app)
        .post("/api/blueprints/missing/executions/exec-1/task-summary")
        .send({ summary: "Something" });
      expect(res.status).toBe(404);
    });

    it("returns 404 for missing execution", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/executions/missing-exec/task-summary")
        .send({ summary: "Something" });
      expect(res.status).toBe(404);
    });
  });

  // ─── Backward-compat /api/plans/* ──────────────────────────

  describe("POST /api/plans", () => {
    it("creates a plan via legacy endpoint", async () => {
      const res = await request(app)
        .post("/api/plans")
        .send({ title: "Legacy Plan", cwd: "/test" });
      expect(res.status).toBe(201);
      expect(createBlueprint).toHaveBeenCalledWith("Legacy Plan", undefined, "/test", undefined);
    });

    it("returns 400 for missing title", async () => {
      const res = await request(app).post("/api/plans").send({});
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/plans", () => {
    it("lists plans", async () => {
      const res = await request(app).get("/api/plans");
      expect(res.status).toBe(200);
    });
  });

  describe("GET /api/plans/:id", () => {
    it("returns a plan", async () => {
      const res = await request(app).get("/api/plans/bp-1");
      expect(res.status).toBe(200);
    });

    it("returns 404 for missing plan", async () => {
      const res = await request(app).get("/api/plans/missing");
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /api/plans/:id", () => {
    it("updates a plan with field mapping", async () => {
      const res = await request(app)
        .put("/api/plans/bp-1")
        .send({ cwd: "/new/path" });
      expect(res.status).toBe(200);
      // cwd should be mapped to projectCwd
      expect(updateBlueprint).toHaveBeenCalledWith(
        "bp-1",
        expect.objectContaining({ projectCwd: "/new/path" })
      );
    });
  });

  describe("DELETE /api/plans/:id", () => {
    it("deletes a plan", async () => {
      const res = await request(app).delete("/api/plans/bp-1");
      expect(res.status).toBe(200);
    });
  });

  describe("POST /api/plans/:planId/nodes", () => {
    it("creates a node via legacy endpoint with field mapping", async () => {
      const res = await request(app)
        .post("/api/plans/bp-1/nodes")
        .send({ title: "Step", seq: 0, dependsOn: ["dep-id"] });
      expect(res.status).toBe(201);
      expect(createMacroNode).toHaveBeenCalledWith(
        "bp-1",
        expect.objectContaining({
          title: "Step",
          order: 0,
          dependencies: ["dep-id"],
        })
      );
    });
  });

  describe("PUT /api/plans/:planId/nodes/:nodeId", () => {
    it("updates node with field mapping", async () => {
      const res = await request(app)
        .put("/api/plans/bp-1/nodes/node-1")
        .send({ dependsOn: ["d1"], seq: 5 });
      expect(res.status).toBe(200);
      expect(updateMacroNode).toHaveBeenCalledWith(
        "bp-1",
        "node-1",
        expect.objectContaining({
          dependencies: ["d1"],
          order: 5,
        })
      );
    });
  });

  // ─── Archive / Unarchive endpoints ────────────────────────

  describe("POST /api/blueprints/:id/archive", () => {
    it("archives a blueprint", async () => {
      const res = await request(app).post("/api/blueprints/bp-1/archive");
      expect(res.status).toBe(200);
      expect(archiveBlueprint).toHaveBeenCalledWith("bp-1");
      expect(res.body.archivedAt).toBeDefined();
    });

    it("returns 404 for missing blueprint", async () => {
      const res = await request(app).post("/api/blueprints/missing/archive");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/blueprints/:id/unarchive", () => {
    it("unarchives a blueprint", async () => {
      const res = await request(app).post("/api/blueprints/bp-1/unarchive");
      expect(res.status).toBe(200);
      expect(unarchiveBlueprint).toHaveBeenCalledWith("bp-1");
    });

    it("returns 404 for missing blueprint", async () => {
      const res = await request(app).post("/api/blueprints/missing/unarchive");
      expect(res.status).toBe(404);
    });
  });

  // ─── report-status callback endpoint ──────────────────────

  describe("POST /api/blueprints/:id/executions/:execId/report-status", () => {
    it("stores reported status 'done'", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/executions/exec-1/report-status")
        .send({ status: "done" });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(setExecutionReportedStatus).toHaveBeenCalledWith("exec-1", "done", undefined);
    });

    it("stores reported status 'failed' with reason", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/executions/exec-1/report-status")
        .send({ status: "failed", reason: "Tests didn't pass" });
      expect(res.status).toBe(200);
      expect(setExecutionReportedStatus).toHaveBeenCalledWith("exec-1", "failed", "Tests didn't pass");
    });

    it("stores reported status 'blocked'", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/executions/exec-1/report-status")
        .send({ status: "blocked", reason: "Need AWS credentials" });
      expect(res.status).toBe(200);
      expect(setExecutionReportedStatus).toHaveBeenCalledWith("exec-1", "blocked", "Need AWS credentials");
    });

    it("returns 400 for invalid status", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/executions/exec-1/report-status")
        .send({ status: "invalid" });
      expect(res.status).toBe(400);
    });

    it("returns 400 for missing status", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/executions/exec-1/report-status")
        .send({});
      expect(res.status).toBe(400);
    });

    it("returns 404 for missing blueprint", async () => {
      const res = await request(app)
        .post("/api/blueprints/missing/executions/exec-1/report-status")
        .send({ status: "done" });
      expect(res.status).toBe(404);
    });

    it("returns 404 for missing execution", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/executions/missing-exec/report-status")
        .send({ status: "done" });
      expect(res.status).toBe(404);
    });
  });

  // ─── evaluation-callback endpoint ─────────────────────────

  describe("POST /api/blueprints/:id/nodes/:nodeId/evaluation-callback", () => {
    it("accepts COMPLETE evaluation with no mutations", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/nodes/node-1/evaluation-callback")
        .send({ status: "COMPLETE", evaluation: "Task fully done", mutations: [] });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.status).toBe("COMPLETE");
      // COMPLETE should not call applyGraphMutations
      expect(applyGraphMutations).not.toHaveBeenCalled();
    });

    it("accepts NEEDS_REFINEMENT with INSERT_BETWEEN mutation", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/nodes/node-1/evaluation-callback")
        .send({
          status: "NEEDS_REFINEMENT",
          evaluation: "Missing validation",
          mutations: [{ action: "INSERT_BETWEEN", new_node: { title: "Add validation", description: "Add input validation" } }],
        });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("NEEDS_REFINEMENT");
      expect(applyGraphMutations).toHaveBeenCalled();
    });

    it("accepts HAS_BLOCKER with ADD_SIBLING mutation", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/nodes/node-1/evaluation-callback")
        .send({
          status: "HAS_BLOCKER",
          evaluation: "Needs AWS creds",
          mutations: [{ action: "ADD_SIBLING", new_node: { title: "Wait for creds", description: "Contact ops" } }],
        });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("HAS_BLOCKER");
      expect(applyGraphMutations).toHaveBeenCalled();
    });

    it("returns 400 for invalid status", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/nodes/node-1/evaluation-callback")
        .send({ status: "INVALID", evaluation: "test", mutations: [] });
      expect(res.status).toBe(400);
    });

    it("returns 404 for missing blueprint", async () => {
      const res = await request(app)
        .post("/api/blueprints/missing/nodes/node-1/evaluation-callback")
        .send({ status: "COMPLETE", evaluation: "test", mutations: [] });
      expect(res.status).toBe(404);
    });

    it("filters mutations without required fields", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/nodes/node-1/evaluation-callback")
        .send({
          status: "NEEDS_REFINEMENT",
          evaluation: "test",
          mutations: [
            { action: "INSERT_BETWEEN", new_node: { title: "Valid", description: "desc" } },
            { action: null, new_node: { title: "Invalid" } },
            { action: "ADD_SIBLING" },
          ],
        });
      expect(res.status).toBe(200);
      // applyGraphMutations should be called with only the valid mutation
      expect(applyGraphMutations).toHaveBeenCalled();
    });
  });

  // ─── batch-create endpoint ────────────────────────────────

  describe("POST /api/blueprints/:blueprintId/nodes/batch-create", () => {
    it("creates multiple nodes at once", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/nodes/batch-create")
        .send([
          { title: "Step A", description: "Do A" },
          { title: "Step B", description: "Do B", dependencies: [0] },
        ]);
      expect(res.status).toBe(201);
      expect(res.body.created).toBe(2);
      expect(res.body.nodes).toHaveLength(2);
    });

    it("skips entries with missing title", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/nodes/batch-create")
        .send([
          { title: "Valid", description: "ok" },
          { description: "no title" },
        ]);
      expect(res.status).toBe(201);
      expect(res.body.created).toBe(1);
    });

    it("returns 400 for non-array body", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/nodes/batch-create")
        .send({ title: "Not an array" });
      expect(res.status).toBe(400);
    });

    it("returns 404 for missing blueprint", async () => {
      const res = await request(app)
        .post("/api/blueprints/missing/nodes/batch-create")
        .send([{ title: "Step" }]);
      expect(res.status).toBe(404);
    });
  });

  // ─── global-status endpoint ───────────────────────────────

  describe("GET /api/global-status", () => {
    it("returns global queue info", async () => {
      const res = await request(app).get("/api/global-status");
      expect(res.status).toBe(200);
      expect(res.body.active).toBe(false);
      expect(res.body.totalPending).toBe(0);
      expect(res.body.tasks).toEqual([]);
    });
  });

  // ─── related-sessions endpoint ────────────────────────────

  describe("GET /api/blueprints/:id/nodes/:nodeId/related-sessions", () => {
    it("returns related sessions for a node", async () => {
      const res = await request(app).get("/api/blueprints/bp-1/nodes/node-1/related-sessions");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(getRelatedSessionsForNode).toHaveBeenCalledWith("node-1");
    });
  });

  // ─── includeArchived query param ──────────────────────────

  describe("GET /api/blueprints with includeArchived", () => {
    it("passes includeArchived=true filter", async () => {
      await request(app).get("/api/blueprints?includeArchived=true");
      expect(listBlueprints).toHaveBeenCalledWith(
        expect.objectContaining({ includeArchived: true })
      );
    });

    it("defaults includeArchived to false", async () => {
      await request(app).get("/api/blueprints");
      expect(listBlueprints).toHaveBeenCalledWith(
        expect.objectContaining({ includeArchived: false })
      );
    });
  });

  // ─── Run node with dependency validation ──────────────────

  describe("POST /api/blueprints/:id/nodes/:nodeId/run", () => {
    it("queues a pending node for execution", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/nodes/node-1/run");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("queued");
    });

    it("returns 404 for missing blueprint", async () => {
      const res = await request(app)
        .post("/api/blueprints/missing/nodes/node-1/run");
      expect(res.status).toBe(404);
    });
  });

  // ─── Enrichment callback endpoint ─────────────────────────

  describe("POST /api/enrichment-callback/:requestId", () => {
    it("returns 404 for unknown request ID", async () => {
      const res = await request(app)
        .post("/api/enrichment-callback/unknown-id")
        .send({ title: "Test", description: "Desc" });
      expect(res.status).toBe(404);
    });

    it("returns 404 for unregistered requestId even with missing title", async () => {
      // "some-id" was never registered in enrichmentCallbacks map,
      // so the endpoint returns 404 before reaching body validation
      const res = await request(app)
        .post("/api/enrichment-callback/some-id")
        .send({ description: "No title" });
      expect(res.status).toBe(404);
    });
  });
});
