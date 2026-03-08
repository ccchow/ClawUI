import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import express from "express";
import request from "supertest";

const mockLog = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  createLogger: vi.fn(() => mockLog),
}));

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
      // /no-claude-md exists as a directory but has no CLAUDE.md
      if (np === "/no-claude-md") return true;
      return actual.existsSync(p);
    }),
    statSync: vi.fn((p: string) => {
      const np = p.replace(/\\/g, "/");
      if (np === "/test" || np === "/no-claude-md") return { isDirectory: (): boolean => true };
      return actual.statSync(p);
    }),
  };
});

// Mock plan-db
vi.mock("../plan-db.js", () => ({
  createBlueprint: vi.fn(
    (title: string, description?: string, projectCwd?: string, _agentType?: string, enabledRoles?: string[], defaultRole?: string) => ({
      id: "bp-1",
      title,
      description: description ?? "",
      status: "draft",
      ...(projectCwd ? { projectCwd } : {}),
      enabledRoles: enabledRoles ?? ["sde", "qa", "pm", "uxd"],
      defaultRole: defaultRole ?? "sde",
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
          seq: 1,
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
      seq: 1,
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
        seq: 1,
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
  completeRelatedSession: vi.fn(),
  getActiveRelatedSession: vi.fn(() => null),
  starBlueprint: vi.fn((id: string) => {
    if (id === "missing") return null;
    return { id, title: "Starred BP", status: "draft", starred: true, nodes: [], createdAt: "2024-01-01", updatedAt: "2024-01-01" };
  }),
  unstarBlueprint: vi.fn((id: string) => {
    if (id === "missing") return null;
    return { id, title: "Unstarred BP", status: "draft", starred: false, nodes: [], createdAt: "2024-01-01", updatedAt: "2024-01-01" };
  }),
  createSuggestion: vi.fn(
    (blueprintId: string, nodeId: string, title: string, description: string) => ({
      id: "sug-1",
      nodeId,
      blueprintId,
      title,
      description,
      used: false,
      createdAt: "2024-01-01T00:00:00Z",
    })
  ),
  getSuggestionsForNode: vi.fn(() => []),
  deleteSuggestionsForNode: vi.fn(),
  deleteSuggestion: vi.fn(),
  markSuggestionUsed: vi.fn((id: string) => ({
    id,
    nodeId: "node-1",
    blueprintId: "bp-1",
    title: "Marked",
    description: "",
    used: true,
    createdAt: "2024-01-01T00:00:00Z",
  })),
  createInsight: vi.fn(
    (blueprintId: string, sourceNodeId: string | null, role: string, severity: string, message: string) => ({
      id: "insight-1",
      blueprintId,
      ...(sourceNodeId ? { sourceNodeId } : {}),
      role,
      severity,
      message,
      read: false,
      dismissed: false,
      createdAt: "2024-01-01T00:00:00Z",
    })
  ),
  getInsightsForBlueprint: vi.fn(() => []),
  markInsightRead: vi.fn((id: string) => ({
    id,
    blueprintId: "bp-1",
    sourceNodeId: "node-1",
    role: "sde",
    severity: "info",
    message: "Test insight",
    read: true,
    dismissed: false,
    createdAt: "2024-01-01T00:00:00Z",
  })),
  markAllInsightsRead: vi.fn(),
  dismissInsight: vi.fn(),
  getTotalUnreadInsightCount: vi.fn(() => 0),
  createConveneSession: vi.fn(
    (blueprintId: string, topic: string, roleIds: string[], _contextNodeIds?: string[], maxRounds?: number) => ({
      id: "convene-1",
      blueprintId,
      topic,
      roleIds,
      maxRounds: maxRounds ?? 3,
      status: "active",
      synthesisResult: null,
      messageCount: 0,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    })
  ),
  getConveneSession: vi.fn(() => null),
  getConveneSessions: vi.fn(() => []),
  getConveneMessages: vi.fn(() => []),
  createConveneMessage: vi.fn((_sessionId: string, roleId: string, round: number, content: string, messageType?: string) => ({
    id: "msg-new",
    sessionId: _sessionId,
    roleId,
    round,
    content,
    messageType: messageType ?? "contribution",
    createdAt: "2024-01-01T00:00:00Z",
  })),
  updateConveneSessionStatus: vi.fn(),
  getConveneSessionCount: vi.fn(() => 0),
  createAutopilotMessage: vi.fn((blueprintId: string, role: string, content: string) => ({
    id: "msg-1",
    blueprintId,
    role,
    content,
    acknowledged: false,
    createdAt: "2024-01-01T00:00:00Z",
  })),
  getMessageHistory: vi.fn(() => []),
  getMessageCount: vi.fn(() => 0),
  getUnacknowledgedMessages: vi.fn(() => []),
  acknowledgeMessage: vi.fn(() => true),
  getAutopilotLog: vi.fn(() => []),
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
  resolveWorkspaceKey: vi.fn((blueprintId: string) => blueprintId),
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
  resolveNodeRoles: vi.fn(() => ["sde"]),
  parseAgentParams: vi.fn((params?: string) => params ? params.split(/\s+/).filter(Boolean) : []),
  buildArtifactPrompt: vi.fn(() => ""),
}));

vi.mock("../plan-generator.js", () => ({
  runAgentInteractive: vi.fn(async () => ""),
  runAgentText: vi.fn(async () => ""),
  getApiBase: vi.fn(() => "http://localhost:3001"),
  getAuthParam: vi.fn(() => "auth=test-token"),
}));

vi.mock("../plan-coordinator.js", () => ({
  coordinateBlueprint: vi.fn(async () => {}),
}));

vi.mock("../plan-convene.js", () => ({
  executeConveneSession: vi.fn(async () => {}),
}));

vi.mock("../roles/role-registry.js", () => ({
  registerRole: vi.fn(),
  getRole: vi.fn(() => undefined),
  getAllRoles: vi.fn(() => [
    { id: "sde", label: "SDE", description: "Software Development Engineer", builtin: true, artifactTypes: [], blockerTypes: [] },
    { id: "qa", label: "QA", description: "Quality Assurance", builtin: true, artifactTypes: [], blockerTypes: [] },
    { id: "pm", label: "PM", description: "Product Manager", builtin: true, artifactTypes: [], blockerTypes: [] },
    { id: "uxd", label: "UXD", description: "UX Designer", builtin: true, artifactTypes: [], blockerTypes: [] },
  ]),
  getBuiltinRoles: vi.fn(() => []),
}));

vi.mock("../roles/load-all-roles.js", () => ({}));

vi.mock("../autopilot.js", () => ({
  runAutopilotLoop: vi.fn(async () => {}),
}));

vi.mock("../user-agent.js", () => ({
  triggerUserAgent: vi.fn(),
  handleUserMessage: vi.fn(),
  buildUserAgentPrompt: vi.fn(() => "mock prompt"),
}));

vi.mock("../plan-operations.js", () => ({
  enrichNodeInternal: vi.fn(async () => {}),
  reevaluateNodeInternal: vi.fn(async () => {}),
  splitNodeInternal: vi.fn(async () => {}),
  smartDepsInternal: vi.fn(async () => {}),
  reevaluateAllInternal: vi.fn(async () => []),
}));

vi.mock("../db.js", () => ({
  syncSession: vi.fn(),
}));

import planRouter from "../plan-routes.js";
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
  starBlueprint,
  unstarBlueprint,
  getRelatedSessionsForNode,
  createSuggestion,
  getSuggestionsForNode,
  deleteSuggestion,
  markSuggestionUsed,
  createInsight,
  getInsightsForBlueprint,
  markInsightRead,
  markAllInsightsRead,
  dismissInsight,
  createConveneSession,
  getConveneSession,
  getConveneSessions,
  getConveneMessages,
  createConveneMessage,
  updateConveneSessionStatus,
  createAutopilotMessage,
  getMessageHistory,
  getMessageCount,
} from "../plan-db.js";
import {
  applyGraphMutations,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getGlobalQueueInfo,
  removeQueuedTask,
  removePendingTask,
  executeNode,
  executeAllNodes,
  enqueueBlueprintTask,
} from "../plan-executor.js";
import { runAutopilotLoop } from "../autopilot.js";
import { triggerUserAgent } from "../user-agent.js";
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

    it("passes enabledRoles and defaultRole to createBlueprint", async () => {
      const res = await request(app)
        .post("/api/blueprints")
        .send({ title: "Multi-role BP", projectCwd: "/test", enabledRoles: ["sde", "qa"], defaultRole: "qa" });
      expect(res.status).toBe(201);
      expect(createBlueprint).toHaveBeenCalledWith(
        "Multi-role BP",
        undefined,
        "/test",
        undefined,
        ["sde", "qa"],
        "qa",
        undefined,
      );
      expect(res.body.enabledRoles).toEqual(["sde", "qa"]);
      expect(res.body.defaultRole).toBe("qa");
    });

    it("returns 400 when claude agent and no CLAUDE.md", async () => {
      const res = await request(app)
        .post("/api/blueprints")
        .send({ title: "No Claude MD", projectCwd: "/no-claude-md" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("CLAUDE.md");
    });

    it("skips CLAUDE.md check for non-claude agent types", async () => {
      const res = await request(app)
        .post("/api/blueprints")
        .send({ title: "OpenClaw BP", projectCwd: "/no-claude-md", agentType: "openclaw" });
      expect(res.status).toBe(201);
      expect(res.body.title).toBe("OpenClaw BP");
    });

    it("defaults role fields when not provided", async () => {
      const res = await request(app)
        .post("/api/blueprints")
        .send({ title: "Default Roles", projectCwd: "/test" });
      expect(res.status).toBe(201);
      expect(res.body.enabledRoles).toEqual(["sde", "qa", "pm", "uxd"]);
      expect(res.body.defaultRole).toBe("sde");
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

    it("passes roles directly to createMacroNode", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/nodes")
        .send({ title: "QA Step", roles: ["qa"] });
      expect(res.status).toBe(201);
      expect(createMacroNode).toHaveBeenCalledWith("bp-1", expect.objectContaining({ roles: ["qa"] }));
    });

    it("does not pass roles to createMacroNode when no roles provided", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/nodes")
        .send({ title: "Plain Step" });
      expect(res.status).toBe(201);
      expect(createMacroNode).toHaveBeenCalledWith("bp-1", expect.not.objectContaining({ roles: expect.anything() }));
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

  // ─── Star / Unstar endpoints ──────────────────────────────

  describe("POST /api/blueprints/:id/star", () => {
    it("stars a blueprint", async () => {
      const res = await request(app).post("/api/blueprints/bp-1/star");
      expect(res.status).toBe(200);
      expect(starBlueprint).toHaveBeenCalledWith("bp-1");
      expect(res.body.starred).toBe(true);
    });

    it("returns 404 for missing blueprint", async () => {
      const res = await request(app).post("/api/blueprints/missing/star");
      expect(res.status).toBe(404);
    });

    it("does not trigger node execution", async () => {
      vi.mocked(executeNode).mockClear();
      vi.mocked(executeAllNodes).mockClear();
      vi.mocked(enqueueBlueprintTask).mockClear();
      await request(app).post("/api/blueprints/bp-1/star");
      expect(executeNode).not.toHaveBeenCalled();
      expect(executeAllNodes).not.toHaveBeenCalled();
      expect(enqueueBlueprintTask).not.toHaveBeenCalled();
    });

    it("does not change blueprint status", async () => {
      vi.mocked(updateBlueprint).mockClear();
      await request(app).post("/api/blueprints/bp-1/star");
      expect(updateBlueprint).not.toHaveBeenCalled();
    });
  });

  describe("POST /api/blueprints/:id/unstar", () => {
    it("unstars a blueprint", async () => {
      const res = await request(app).post("/api/blueprints/bp-1/unstar");
      expect(res.status).toBe(200);
      expect(unstarBlueprint).toHaveBeenCalledWith("bp-1");
      expect(res.body.starred).toBe(false);
    });

    it("returns 404 for missing blueprint", async () => {
      const res = await request(app).post("/api/blueprints/missing/unstar");
      expect(res.status).toBe(404);
    });

    it("does not trigger node execution", async () => {
      vi.mocked(executeNode).mockClear();
      vi.mocked(executeAllNodes).mockClear();
      vi.mocked(enqueueBlueprintTask).mockClear();
      await request(app).post("/api/blueprints/bp-1/unstar");
      expect(executeNode).not.toHaveBeenCalled();
      expect(executeAllNodes).not.toHaveBeenCalled();
      expect(enqueueBlueprintTask).not.toHaveBeenCalled();
    });

    it("does not change blueprint status", async () => {
      vi.mocked(updateBlueprint).mockClear();
      await request(app).post("/api/blueprints/bp-1/unstar");
      expect(updateBlueprint).not.toHaveBeenCalled();
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

  describe("GET /api/blueprints with search", () => {
    it("passes search filter to listBlueprints", async () => {
      await request(app).get("/api/blueprints?search=feature");
      expect(listBlueprints).toHaveBeenCalledWith(
        expect.objectContaining({ search: "feature" })
      );
    });

    it("combines search with other filters", async () => {
      await request(app).get("/api/blueprints?search=test&status=draft&projectCwd=/test");
      expect(listBlueprints).toHaveBeenCalledWith({
        status: "draft",
        projectCwd: "/test",
        search: "test",
        includeArchived: false,
      });
    });
  });

  describe("GET /api/blueprints/:id with search (node filtering)", () => {
    it("filters nodes by search query", async () => {
      vi.mocked(getBlueprint).mockReturnValueOnce({
        id: "bp-1",
        title: "Test Blueprint",
        description: "desc",
        status: "draft",
        projectCwd: "/test",
        nodes: [
          {
            id: "node-1", blueprintId: "bp-1", order: 0, seq: 1,
            title: "Setup database", description: "", status: "pending",
            dependencies: [], inputArtifacts: [], outputArtifacts: [], executions: [],
            createdAt: "2024-01-01", updatedAt: "2024-01-01",
          },
          {
            id: "node-2", blueprintId: "bp-1", order: 1, seq: 2,
            title: "Build API endpoints", description: "", status: "pending",
            dependencies: [], inputArtifacts: [], outputArtifacts: [], executions: [],
            createdAt: "2024-01-01", updatedAt: "2024-01-01",
          },
          {
            id: "node-3", blueprintId: "bp-1", order: 2, seq: 3,
            title: "Setup frontend", description: "", status: "pending",
            dependencies: [], inputArtifacts: [], outputArtifacts: [], executions: [],
            createdAt: "2024-01-01", updatedAt: "2024-01-01",
          },
        ],
        createdAt: "2024-01-01",
        updatedAt: "2024-01-01",
      });

      const res = await request(app).get("/api/blueprints/bp-1?search=setup");
      expect(res.status).toBe(200);
      expect(res.body.nodes.length).toBe(2);
      expect(res.body.nodes.every((n: { title: string }) => n.title.toLowerCase().includes("setup"))).toBe(true);
    });

    it("returns all nodes when no search param", async () => {
      const res = await request(app).get("/api/blueprints/bp-1");
      expect(res.status).toBe(200);
      expect(res.body.nodes.length).toBe(1); // default mock has 1 node
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

  // ─── Unqueue node endpoint ────────────────────────────────

  describe("POST /api/blueprints/:id/nodes/:nodeId/unqueue", () => {
    it("unqueues a queued node and reverts to pending", async () => {
      vi.mocked(getBlueprint).mockReturnValueOnce({
        id: "bp-1",
        title: "Test Blueprint",
        description: "desc",
        status: "running",
        projectCwd: "/test",
        nodes: [
          {
            id: "node-1",
            blueprintId: "bp-1",
            order: 0,
            seq: 1,
            title: "Step 1",
            description: "First step",
            status: "queued",
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
      });

      const res = await request(app)
        .post("/api/blueprints/bp-1/nodes/node-1/unqueue");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("pending");
      expect(removeQueuedTask).toHaveBeenCalledWith("bp-1", "node-1");
      expect(removePendingTask).toHaveBeenCalledWith("bp-1", "node-1", "run");
      expect(updateMacroNode).toHaveBeenCalledWith("bp-1", "node-1", { status: "pending" });
    });

    it("returns 404 for missing blueprint", async () => {
      const res = await request(app)
        .post("/api/blueprints/missing/nodes/node-1/unqueue");
      expect(res.status).toBe(404);
      expect(res.body.error).toContain("Blueprint not found");
    });

    it("returns 404 for missing node", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/nodes/nonexistent/unqueue");
      expect(res.status).toBe(404);
      expect(res.body.error).toContain("Node not found");
    });

    it("returns 409 when trying to unqueue a running node", async () => {
      vi.mocked(getBlueprint).mockReturnValueOnce({
        id: "bp-1",
        title: "Test Blueprint",
        description: "desc",
        status: "running",
        projectCwd: "/test",
        nodes: [
          {
            id: "node-1",
            blueprintId: "bp-1",
            order: 0,
            seq: 1,
            title: "Step 1",
            description: "First step",
            status: "running",
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
      });

      const res = await request(app)
        .post("/api/blueprints/bp-1/nodes/node-1/unqueue");
      expect(res.status).toBe(409);
      expect(res.body.error).toContain("Cannot unqueue a running node");
    });

    it("returns 400 when node is not queued", async () => {
      // Default mock returns node with status "pending"
      const res = await request(app)
        .post("/api/blueprints/bp-1/nodes/node-1/unqueue");
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("must be \"queued\" to unqueue");
    });
  });

  // ─── Suggestion CRUD lifecycle ─────────────────────────

  describe("POST /api/blueprints/:id/nodes/:nodeId/suggestions-callback", () => {
    it("creates suggestions and returns count", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/nodes/node-1/suggestions-callback")
        .send({
          suggestions: [
            { title: "Add logging", description: "Add structured logging to all endpoints" },
            { title: "Add tests", description: "Write unit tests for the new module" },
          ],
        });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.count).toBe(2);
      expect(getSuggestionsForNode).toHaveBeenCalledWith("node-1");
      expect(createSuggestion).toHaveBeenCalledTimes(2);
      expect(createSuggestion).toHaveBeenCalledWith("bp-1", "node-1", "Add logging", "Add structured logging to all endpoints", undefined);
      expect(createSuggestion).toHaveBeenCalledWith("bp-1", "node-1", "Add tests", "Write unit tests for the new module", undefined);
    });

    it("defaults description to empty string when omitted", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/nodes/node-1/suggestions-callback")
        .send({ suggestions: [{ title: "Quick fix" }] });
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(1);
      expect(createSuggestion).toHaveBeenCalledWith("bp-1", "node-1", "Quick fix", "", undefined);
    });

    it("limits to max 3 suggestions", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/nodes/node-1/suggestions-callback")
        .send({
          suggestions: [
            { title: "S1" },
            { title: "S2" },
            { title: "S3" },
            { title: "S4 should be dropped" },
          ],
        });
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(3);
      expect(createSuggestion).toHaveBeenCalledTimes(3);
      // S4 must not have been created
      expect(createSuggestion).not.toHaveBeenCalledWith(
        expect.anything(), expect.anything(), "S4 should be dropped", expect.anything(), expect.anything()
      );
    });

    it("skips already-existing suggestions by title (dedup on re-evaluation)", async () => {
      // Simulate existing suggestions from a prior callback
      (getSuggestionsForNode as ReturnType<typeof vi.fn>).mockReturnValueOnce([
        { id: "existing-1", nodeId: "node-1", blueprintId: "bp-1", title: "Add logging", description: "Old desc", createdAt: "2024-01-01" },
      ]);
      const res = await request(app)
        .post("/api/blueprints/bp-1/nodes/node-1/suggestions-callback")
        .send({
          suggestions: [
            { title: "Add logging", description: "Updated desc" },
            { title: "New suggestion", description: "Brand new" },
          ],
        });
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(2);
      // Only the new suggestion should be created; existing one is kept
      expect(createSuggestion).toHaveBeenCalledTimes(1);
      expect(createSuggestion).toHaveBeenCalledWith("bp-1", "node-1", "New suggestion", "Brand new", undefined);
      expect(deleteSuggestion).not.toHaveBeenCalled();
    });

    it("removes stale suggestions not in incoming set", async () => {
      (getSuggestionsForNode as ReturnType<typeof vi.fn>).mockReturnValueOnce([
        { id: "old-1", nodeId: "node-1", blueprintId: "bp-1", title: "Stale one", description: "", createdAt: "2024-01-01" },
        { id: "old-2", nodeId: "node-1", blueprintId: "bp-1", title: "Keep me", description: "", createdAt: "2024-01-01" },
      ]);
      const res = await request(app)
        .post("/api/blueprints/bp-1/nodes/node-1/suggestions-callback")
        .send({ suggestions: [{ title: "Keep me" }, { title: "Brand new" }] });
      expect(res.status).toBe(200);
      // "Stale one" removed, "Keep me" kept, "Brand new" created
      expect(deleteSuggestion).toHaveBeenCalledTimes(1);
      expect(deleteSuggestion).toHaveBeenCalledWith("old-1");
      expect(createSuggestion).toHaveBeenCalledTimes(1);
      expect(createSuggestion).toHaveBeenCalledWith("bp-1", "node-1", "Brand new", "", undefined);
    });

    it("returns 400 when suggestions array is missing", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/nodes/node-1/suggestions-callback")
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Missing or empty");
      expect(createSuggestion).not.toHaveBeenCalled();
    });

    it("returns 400 when suggestions array is empty", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/nodes/node-1/suggestions-callback")
        .send({ suggestions: [] });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Missing or empty");
    });

    it("returns 400 when all suggestions are malformed (validate-before-delete guard)", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/nodes/node-1/suggestions-callback")
        .send({
          suggestions: [
            { description: "no title" },
            { title: "", description: "empty title" },
            { title: 123, description: "numeric title" },
          ],
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("No valid suggestions");
      expect(getSuggestionsForNode).not.toHaveBeenCalled();
      expect(createSuggestion).not.toHaveBeenCalled();
    });

    it("filters out malformed suggestions but keeps valid ones", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/nodes/node-1/suggestions-callback")
        .send({
          suggestions: [
            { title: "", description: "empty title — invalid" },
            { title: "Valid one", description: "This is fine" },
            { description: "missing title — invalid" },
          ],
        });
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(1);
      expect(createSuggestion).toHaveBeenCalledTimes(1);
      expect(createSuggestion).toHaveBeenCalledWith("bp-1", "node-1", "Valid one", "This is fine", undefined);
    });

    it("passes roles to createSuggestion when provided", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/nodes/node-1/suggestions-callback")
        .send({
          suggestions: [
            { title: "Add tests", description: "Write tests", roles: ["qa"] },
            { title: "Refactor", description: "Clean up", roles: ["sde", "sa"] },
            { title: "No roles", description: "No role info" },
          ],
        });
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(3);
      expect(createSuggestion).toHaveBeenCalledWith("bp-1", "node-1", "Add tests", "Write tests", ["qa"]);
      expect(createSuggestion).toHaveBeenCalledWith("bp-1", "node-1", "Refactor", "Clean up", ["sde", "sa"]);
      expect(createSuggestion).toHaveBeenCalledWith("bp-1", "node-1", "No roles", "No role info", undefined);
    });

    it("filters non-string elements from roles arrays", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/nodes/node-1/suggestions-callback")
        .send({
          suggestions: [
            { title: "Mixed roles", description: "Has non-string", roles: ["sde", 42, null, "qa", true] },
          ],
        });
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(1);
      // Only string elements should survive filtering
      expect(createSuggestion).toHaveBeenCalledWith("bp-1", "node-1", "Mixed roles", "Has non-string", ["sde", "qa"]);
    });

    it("normalizes empty roles array after filtering to undefined", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/nodes/node-1/suggestions-callback")
        .send({
          suggestions: [
            { title: "All filtered", description: "desc", roles: [123, null, false] },
          ],
        });
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(1);
      // All elements filtered out → roles should be undefined
      expect(createSuggestion).toHaveBeenCalledWith("bp-1", "node-1", "All filtered", "desc", undefined);
    });

    it("treats non-array roles as undefined", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/nodes/node-1/suggestions-callback")
        .send({
          suggestions: [
            { title: "String roles", description: "desc", roles: "sde" },
          ],
        });
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(1);
      expect(createSuggestion).toHaveBeenCalledWith("bp-1", "node-1", "String roles", "desc", undefined);
    });

    it("returns 404 for missing blueprint", async () => {
      const res = await request(app)
        .post("/api/blueprints/missing/nodes/node-1/suggestions-callback")
        .send({ suggestions: [{ title: "test" }] });
      expect(res.status).toBe(404);
      expect(res.body.error).toContain("Blueprint not found");
    });

    it("returns 404 for node not in blueprint", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/nodes/nonexistent/suggestions-callback")
        .send({ suggestions: [{ title: "test" }] });
      expect(res.status).toBe(404);
      expect(res.body.error).toContain("Node not found");
    });
  });

  describe("GET /api/blueprints/:blueprintId/nodes/:nodeId/suggestions", () => {
    it("returns suggestions for a node", async () => {
      const mockSuggestions = [
        { id: "sug-1", nodeId: "node-1", blueprintId: "bp-1", title: "Add logging", description: "desc1", used: false, createdAt: "2024-01-01" },
        { id: "sug-2", nodeId: "node-1", blueprintId: "bp-1", title: "Add tests", description: "desc2", used: true, createdAt: "2024-01-01" },
      ];
      (getSuggestionsForNode as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockSuggestions);

      const res = await request(app)
        .get("/api/blueprints/bp-1/nodes/node-1/suggestions");
      expect(res.status).toBe(200);
      expect(res.body).toEqual(mockSuggestions);
      expect(getSuggestionsForNode).toHaveBeenCalledWith("node-1");
    });

    it("returns empty array when no suggestions exist", async () => {
      // Default mock already returns []
      const res = await request(app)
        .get("/api/blueprints/bp-1/nodes/node-1/suggestions");
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("returns 404 for missing blueprint", async () => {
      const res = await request(app)
        .get("/api/blueprints/missing/nodes/node-1/suggestions");
      expect(res.status).toBe(404);
      expect(res.body.error).toContain("Blueprint not found");
    });

    it("returns 404 for node not in blueprint", async () => {
      const res = await request(app)
        .get("/api/blueprints/bp-1/nodes/nonexistent/suggestions");
      expect(res.status).toBe(404);
      expect(res.body.error).toContain("Node not found");
    });
  });

  // ─── Mark suggestion as used ─────────────────────────

  describe("POST /api/blueprints/:blueprintId/nodes/:nodeId/suggestions/:suggestionId/mark-used", () => {
    it("marks a suggestion as used and returns it", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/nodes/node-1/suggestions/sug-1/mark-used");
      expect(res.status).toBe(200);
      expect(res.body.used).toBe(true);
      expect(markSuggestionUsed).toHaveBeenCalledWith("sug-1");
    });

    it("returns 404 for missing blueprint", async () => {
      const res = await request(app)
        .post("/api/blueprints/missing/nodes/node-1/suggestions/sug-1/mark-used");
      expect(res.status).toBe(404);
      expect(res.body.error).toContain("Blueprint not found");
    });

    it("returns 404 for node not in blueprint", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/nodes/nonexistent/suggestions/sug-1/mark-used");
      expect(res.status).toBe(404);
      expect(res.body.error).toContain("Node not found");
    });

    it("returns 404 for nonexistent suggestion", async () => {
      (markSuggestionUsed as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);
      const res = await request(app)
        .post("/api/blueprints/bp-1/nodes/node-1/suggestions/nonexistent/mark-used");
      expect(res.status).toBe(404);
      expect(res.body.error).toContain("Suggestion not found");
    });
  });

  // ─── Insights callback endpoint ─────────────────────────

  describe("POST /api/blueprints/:id/nodes/:nodeId/insights-callback", () => {
    it("creates insights and returns count", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/nodes/node-1/insights-callback")
        .send({
          insights: [
            { role: "sde", severity: "warning", message: "Shared utility changed" },
            { role: "qa", severity: "info", message: "Test coverage gap in auth module" },
          ],
        });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.count).toBe(2);
      expect(createInsight).toHaveBeenCalledTimes(2);
      expect(createInsight).toHaveBeenCalledWith("bp-1", "node-1", "sde", "warning", "Shared utility changed");
      expect(createInsight).toHaveBeenCalledWith("bp-1", "node-1", "qa", "info", "Test coverage gap in auth module");
    });

    it("returns 400 for empty insights array", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/nodes/node-1/insights-callback")
        .send({ insights: [] });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Missing or empty");
    });

    it("returns 400 for missing insights field", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/nodes/node-1/insights-callback")
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Missing or empty");
    });

    it("returns 400 when all insights are invalid", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/nodes/node-1/insights-callback")
        .send({
          insights: [
            { role: "sde", severity: "unknown", message: "Bad severity" },
            { severity: "info", message: "Missing role" },
            { role: "qa", severity: "warning" }, // missing message
          ],
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("No valid insights");
    });

    it("filters invalid insights and creates valid ones", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/nodes/node-1/insights-callback")
        .send({
          insights: [
            { role: "sde", severity: "critical", message: "Breaking API change" },
            { role: "qa", severity: "bad-severity", message: "Invalid" }, // bad severity
          ],
        });
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(1);
      expect(createInsight).toHaveBeenCalledTimes(1);
      expect(createInsight).toHaveBeenCalledWith("bp-1", "node-1", "sde", "critical", "Breaking API change");
    });

    it("returns 404 for missing blueprint", async () => {
      const res = await request(app)
        .post("/api/blueprints/missing/nodes/node-1/insights-callback")
        .send({ insights: [{ role: "sde", severity: "info", message: "Test" }] });
      expect(res.status).toBe(404);
    });

    it("returns 404 for missing node", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/nodes/nonexistent/insights-callback")
        .send({ insights: [{ role: "sde", severity: "info", message: "Test" }] });
      expect(res.status).toBe(404);
    });

    it("logs warning when role label does not match any known role", async () => {
      mockLog.warn.mockClear();
      const res = await request(app)
        .post("/api/blueprints/bp-1/nodes/node-1/insights-callback")
        .send({
          insights: [
            { role: "hallucinated-role", severity: "info", message: "Some insight" },
          ],
        });
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(1);
      // Unrecognized role stored as-is
      expect(createInsight).toHaveBeenCalledWith("bp-1", "node-1", "hallucinated-role", "info", "Some insight");
      // Warning emitted with the bad label and valid IDs
      expect(mockLog.warn).toHaveBeenCalledTimes(1);
      expect(mockLog.warn.mock.calls[0][0]).toContain("hallucinated-role");
      expect(mockLog.warn.mock.calls[0][0]).toContain("sde");
      expect(mockLog.warn.mock.calls[0][0]).toContain("qa");
    });
  });

  // ─── Insights read/management endpoints ─────────────────────────

  describe("GET /api/blueprints/:id/insights", () => {
    it("returns insights for blueprint", async () => {
      (getInsightsForBlueprint as ReturnType<typeof vi.fn>).mockReturnValueOnce([
        { id: "i-1", blueprintId: "bp-1", sourceNodeId: "node-1", role: "sde", severity: "warning", message: "Test", read: false, dismissed: false, createdAt: "2024-01-01" },
      ]);
      const res = await request(app).get("/api/blueprints/bp-1/insights");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].id).toBe("i-1");
      expect(getInsightsForBlueprint).toHaveBeenCalledWith("bp-1", { unreadOnly: false });
    });

    it("supports unread filter", async () => {
      (getInsightsForBlueprint as ReturnType<typeof vi.fn>).mockReturnValueOnce([]);
      const res = await request(app).get("/api/blueprints/bp-1/insights?unread=true");
      expect(res.status).toBe(200);
      expect(getInsightsForBlueprint).toHaveBeenCalledWith("bp-1", { unreadOnly: true });
    });

    it("returns 404 for missing blueprint", async () => {
      const res = await request(app).get("/api/blueprints/missing/insights");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/blueprints/:id/insights/:insightId/mark-read", () => {
    it("marks insight as read", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/insights/insight-1/mark-read");
      expect(res.status).toBe(200);
      expect(res.body.read).toBe(true);
      expect(markInsightRead).toHaveBeenCalledWith("insight-1");
    });

    it("returns 404 for missing blueprint", async () => {
      const res = await request(app)
        .post("/api/blueprints/missing/insights/insight-1/mark-read");
      expect(res.status).toBe(404);
    });

    it("returns 404 for nonexistent insight", async () => {
      (markInsightRead as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);
      const res = await request(app)
        .post("/api/blueprints/bp-1/insights/nonexistent/mark-read");
      expect(res.status).toBe(404);
      expect(res.body.error).toContain("Insight not found");
    });
  });

  describe("POST /api/blueprints/:id/insights/mark-all-read", () => {
    it("marks all insights as read", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/insights/mark-all-read");
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(markAllInsightsRead).toHaveBeenCalledWith("bp-1");
    });

    it("returns 404 for missing blueprint", async () => {
      const res = await request(app)
        .post("/api/blueprints/missing/insights/mark-all-read");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/blueprints/:id/insights/:insightId/dismiss", () => {
    it("dismisses an insight", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/insights/insight-1/dismiss");
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(dismissInsight).toHaveBeenCalledWith("insight-1");
    });

    it("returns 404 for missing blueprint", async () => {
      const res = await request(app)
        .post("/api/blueprints/missing/insights/insight-1/dismiss");
      expect(res.status).toBe(404);
    });
  });

  // ─── Convene endpoints ───────────────────────────────────

  describe("POST /api/blueprints/:id/convene", () => {
    it("starts a convene session", async () => {
      const mockGetBlueprint = getBlueprint as ReturnType<typeof vi.fn>;
      mockGetBlueprint.mockReturnValueOnce({
        id: "bp-1",
        title: "Test",
        status: "draft",
        enabledRoles: ["sde", "qa"],
        nodes: [{ id: "node-1", blueprintId: "bp-1", order: 0, seq: 1, title: "Step 1", description: "", status: "pending", dependencies: [] }],
        createdAt: "2024-01-01",
        updatedAt: "2024-01-01",
      });
      const res = await request(app)
        .post("/api/blueprints/bp-1/convene")
        .send({ topic: "Discuss architecture", roleIds: ["sde", "qa"] });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("queued");
      expect(res.body.sessionId).toBe("convene-1");
      expect(createConveneSession).toHaveBeenCalledWith("bp-1", "Discuss architecture", ["sde", "qa"], undefined, 3);
      expect(enqueueBlueprintTask).toHaveBeenCalled();
    });

    it("returns 404 for missing blueprint", async () => {
      const res = await request(app)
        .post("/api/blueprints/missing/convene")
        .send({ topic: "Test", roleIds: ["sde", "qa"] });
      expect(res.status).toBe(404);
    });

    it("returns 400 for missing topic", async () => {
      const mockGetBlueprint = getBlueprint as ReturnType<typeof vi.fn>;
      mockGetBlueprint.mockReturnValueOnce({
        id: "bp-1", title: "Test", status: "draft", enabledRoles: ["sde", "qa"], nodes: [],
        createdAt: "2024-01-01", updatedAt: "2024-01-01",
      });
      const res = await request(app)
        .post("/api/blueprints/bp-1/convene")
        .send({ roleIds: ["sde", "qa"] });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Missing or empty 'topic'");
    });

    it("returns 400 for empty topic", async () => {
      const mockGetBlueprint = getBlueprint as ReturnType<typeof vi.fn>;
      mockGetBlueprint.mockReturnValueOnce({
        id: "bp-1", title: "Test", status: "draft", enabledRoles: ["sde", "qa"], nodes: [],
        createdAt: "2024-01-01", updatedAt: "2024-01-01",
      });
      const res = await request(app)
        .post("/api/blueprints/bp-1/convene")
        .send({ topic: "   ", roleIds: ["sde", "qa"] });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Missing or empty 'topic'");
    });

    it("returns 400 for insufficient roles", async () => {
      const mockGetBlueprint = getBlueprint as ReturnType<typeof vi.fn>;
      mockGetBlueprint.mockReturnValueOnce({
        id: "bp-1", title: "Test", status: "draft", enabledRoles: ["sde", "qa"], nodes: [],
        createdAt: "2024-01-01", updatedAt: "2024-01-01",
      });
      const res = await request(app)
        .post("/api/blueprints/bp-1/convene")
        .send({ topic: "x", roleIds: ["sde"] });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("roleIds must be an array with at least 2 roles");
    });

    it("returns 400 for unknown role IDs", async () => {
      const mockGetBlueprint = getBlueprint as ReturnType<typeof vi.fn>;
      mockGetBlueprint.mockReturnValueOnce({
        id: "bp-1", title: "Test", status: "draft", enabledRoles: ["sde", "qa"], nodes: [],
        createdAt: "2024-01-01", updatedAt: "2024-01-01",
      });
      const res = await request(app)
        .post("/api/blueprints/bp-1/convene")
        .send({ topic: "Test", roleIds: ["sde", "nonexistent"] });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Unknown role IDs");
      expect(res.body.error).toContain("nonexistent");
    });

    it("allows valid registered roles even if not in enabledRoles", async () => {
      const mockGetBlueprint = getBlueprint as ReturnType<typeof vi.fn>;
      mockGetBlueprint.mockReturnValueOnce({
        id: "bp-1", title: "Test", status: "draft", enabledRoles: ["sde"], nodes: [],
        createdAt: "2024-01-01", updatedAt: "2024-01-01",
      });
      const res = await request(app)
        .post("/api/blueprints/bp-1/convene")
        .send({ topic: "Test", roleIds: ["sde", "pm"] });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("queued");
    });

    it("returns 400 for invalid context nodes", async () => {
      const mockGetBlueprint = getBlueprint as ReturnType<typeof vi.fn>;
      mockGetBlueprint.mockReturnValueOnce({
        id: "bp-1", title: "Test", status: "draft", enabledRoles: ["sde", "qa"],
        nodes: [{ id: "node-1", blueprintId: "bp-1", order: 0, seq: 1, title: "Step 1", description: "", status: "pending", dependencies: [] }],
        createdAt: "2024-01-01", updatedAt: "2024-01-01",
      });
      const res = await request(app)
        .post("/api/blueprints/bp-1/convene")
        .send({ topic: "Test", roleIds: ["sde", "qa"], contextNodeIds: ["nonexistent"] });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Context nodes not found");
    });

    it("clamps maxRounds to 5", async () => {
      const mockGetBlueprint = getBlueprint as ReturnType<typeof vi.fn>;
      mockGetBlueprint.mockReturnValueOnce({
        id: "bp-1", title: "Test", status: "draft", enabledRoles: ["sde", "qa"], nodes: [],
        createdAt: "2024-01-01", updatedAt: "2024-01-01",
      });
      await request(app)
        .post("/api/blueprints/bp-1/convene")
        .send({ topic: "Test", roleIds: ["sde", "qa"], maxRounds: 10 });
      expect(createConveneSession).toHaveBeenCalledWith("bp-1", "Test", ["sde", "qa"], undefined, 5);
    });

    it("passes contextNodeIds when valid", async () => {
      const mockGetBlueprint = getBlueprint as ReturnType<typeof vi.fn>;
      mockGetBlueprint.mockReturnValueOnce({
        id: "bp-1", title: "Test", status: "draft", enabledRoles: ["sde", "qa"],
        nodes: [{ id: "node-1", blueprintId: "bp-1", order: 0, seq: 1, title: "Step 1", description: "", status: "pending", dependencies: [] }],
        createdAt: "2024-01-01", updatedAt: "2024-01-01",
      });
      await request(app)
        .post("/api/blueprints/bp-1/convene")
        .send({ topic: "Test", roleIds: ["sde", "qa"], contextNodeIds: ["node-1"] });
      expect(createConveneSession).toHaveBeenCalledWith("bp-1", "Test", ["sde", "qa"], ["node-1"], 3);
    });
  });

  describe("GET /api/blueprints/:id/convene-sessions", () => {
    it("lists convene sessions for a blueprint", async () => {
      const mockGetConveneSessions = getConveneSessions as ReturnType<typeof vi.fn>;
      mockGetConveneSessions.mockReturnValueOnce([
        { id: "cs-1", blueprintId: "bp-1", topic: "Design", roleIds: ["sde", "qa"], status: "active", messageCount: 2, createdAt: "2024-01-01" },
      ]);
      const res = await request(app).get("/api/blueprints/bp-1/convene-sessions");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].id).toBe("cs-1");
    });

    it("returns 404 for missing blueprint", async () => {
      const res = await request(app).get("/api/blueprints/missing/convene-sessions");
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/blueprints/:id/convene-sessions/:sessionId", () => {
    it("returns session with messages", async () => {
      const mockGetConveneSession = getConveneSession as ReturnType<typeof vi.fn>;
      const mockGetConveneMessages = getConveneMessages as ReturnType<typeof vi.fn>;
      mockGetConveneSession.mockReturnValueOnce({
        id: "cs-1", blueprintId: "bp-1", topic: "Design", roleIds: ["sde", "qa"], status: "active",
        synthesisResult: null, messageCount: 1, createdAt: "2024-01-01", updatedAt: "2024-01-01",
      });
      mockGetConveneMessages.mockReturnValueOnce([
        { id: "msg-1", sessionId: "cs-1", role: "sde", round: 1, content: "Hello", createdAt: "2024-01-01" },
      ]);
      const res = await request(app).get("/api/blueprints/bp-1/convene-sessions/cs-1");
      expect(res.status).toBe(200);
      expect(res.body.id).toBe("cs-1");
      expect(res.body.messages).toHaveLength(1);
      expect(res.body.messages[0].role).toBe("sde");
    });

    it("returns 404 for missing blueprint", async () => {
      const res = await request(app).get("/api/blueprints/missing/convene-sessions/cs-1");
      expect(res.status).toBe(404);
    });

    it("returns 404 for missing session", async () => {
      const res = await request(app).get("/api/blueprints/bp-1/convene-sessions/cs-unknown");
      expect(res.status).toBe(404);
    });

    it("returns 404 when session belongs to different blueprint", async () => {
      const mockGetConveneSession = getConveneSession as ReturnType<typeof vi.fn>;
      mockGetConveneSession.mockReturnValueOnce({
        id: "cs-1", blueprintId: "bp-other", topic: "X", roleIds: ["sde", "qa"], status: "active",
        synthesisResult: null, messageCount: 0, createdAt: "2024-01-01", updatedAt: "2024-01-01",
      });
      const res = await request(app).get("/api/blueprints/bp-1/convene-sessions/cs-1");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/blueprints/:id/convene-sessions/:sessionId/approve", () => {
    it("approves synthesis and creates nodes", async () => {
      const mockGetConveneSession = getConveneSession as ReturnType<typeof vi.fn>;
      mockGetConveneSession.mockReturnValueOnce({
        id: "cs-1", blueprintId: "bp-1", topic: "Design", roleIds: ["sde", "qa"], status: "synthesizing",
        synthesisResult: [
          { title: "New Task 1", description: "Do thing 1" },
          { title: "New Task 2", description: "Do thing 2" },
        ],
        messageCount: 4, createdAt: "2024-01-01", updatedAt: "2024-01-01",
      });
      const res = await request(app).post("/api/blueprints/bp-1/convene-sessions/cs-1/approve");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("completed");
      expect(res.body.createdNodeIds).toHaveLength(2);
      expect(createMacroNode).toHaveBeenCalledTimes(2);
      expect(updateConveneSessionStatus).toHaveBeenCalledWith("cs-1", "completed");
    });

    it("returns 404 for missing blueprint", async () => {
      const res = await request(app).post("/api/blueprints/missing/convene-sessions/cs-1/approve");
      expect(res.status).toBe(404);
    });

    it("returns 404 for missing session", async () => {
      const res = await request(app).post("/api/blueprints/bp-1/convene-sessions/cs-unknown/approve");
      expect(res.status).toBe(404);
    });

    it("returns 400 when session status is not synthesizing", async () => {
      const mockGetConveneSession = getConveneSession as ReturnType<typeof vi.fn>;
      mockGetConveneSession.mockReturnValueOnce({
        id: "cs-1", blueprintId: "bp-1", topic: "Design", roleIds: ["sde", "qa"], status: "active",
        synthesisResult: null, messageCount: 2, createdAt: "2024-01-01", updatedAt: "2024-01-01",
      });
      const res = await request(app).post("/api/blueprints/bp-1/convene-sessions/cs-1/approve");
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("must be 'synthesizing' to approve");
    });

    it("returns 400 when synthesis result is empty", async () => {
      const mockGetConveneSession = getConveneSession as ReturnType<typeof vi.fn>;
      mockGetConveneSession.mockReturnValueOnce({
        id: "cs-1", blueprintId: "bp-1", topic: "Design", roleIds: ["sde", "qa"], status: "synthesizing",
        synthesisResult: [], messageCount: 4, createdAt: "2024-01-01", updatedAt: "2024-01-01",
      });
      const res = await request(app).post("/api/blueprints/bp-1/convene-sessions/cs-1/approve");
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("No synthesis result to approve");
    });
  });

  describe("POST /api/blueprints/:id/convene-sessions/:sessionId/cancel", () => {
    it("cancels an active convene session", async () => {
      const mockGetConveneSession = getConveneSession as ReturnType<typeof vi.fn>;
      mockGetConveneSession.mockReturnValueOnce({
        id: "cs-1", blueprintId: "bp-1", topic: "Design", roleIds: ["sde", "qa"], status: "active",
        synthesisResult: null, messageCount: 2, createdAt: "2024-01-01", updatedAt: "2024-01-01",
      });
      const res = await request(app).post("/api/blueprints/bp-1/convene-sessions/cs-1/cancel");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("cancelled");
      expect(updateConveneSessionStatus).toHaveBeenCalledWith("cs-1", "cancelled");
      expect(removePendingTask).toHaveBeenCalledWith("bp-1", undefined, "convene");
    });

    it("returns 404 for missing blueprint", async () => {
      const res = await request(app).post("/api/blueprints/missing/convene-sessions/cs-1/cancel");
      expect(res.status).toBe(404);
    });

    it("returns 404 for missing session", async () => {
      const res = await request(app).post("/api/blueprints/bp-1/convene-sessions/cs-unknown/cancel");
      expect(res.status).toBe(404);
    });

    it("returns 400 when session is already completed", async () => {
      const mockGetConveneSession = getConveneSession as ReturnType<typeof vi.fn>;
      mockGetConveneSession.mockReturnValueOnce({
        id: "cs-1", blueprintId: "bp-1", topic: "Design", roleIds: ["sde", "qa"], status: "completed",
        synthesisResult: null, messageCount: 4, createdAt: "2024-01-01", updatedAt: "2024-01-01",
      });
      const res = await request(app).post("/api/blueprints/bp-1/convene-sessions/cs-1/cancel");
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("already completed");
    });

    it("returns 400 when session is already cancelled", async () => {
      const mockGetConveneSession = getConveneSession as ReturnType<typeof vi.fn>;
      mockGetConveneSession.mockReturnValueOnce({
        id: "cs-1", blueprintId: "bp-1", topic: "Design", roleIds: ["sde", "qa"], status: "cancelled",
        synthesisResult: null, messageCount: 2, createdAt: "2024-01-01", updatedAt: "2024-01-01",
      });
      const res = await request(app).post("/api/blueprints/bp-1/convene-sessions/cs-1/cancel");
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("already cancelled");
    });
  });

  describe("GET /api/blueprints/:id/convene-sessions/:sessionId/panel", () => {
    it("returns empty panel text when no messages", async () => {
      const mockGetConveneSession = getConveneSession as ReturnType<typeof vi.fn>;
      const mockGetConveneMessages = getConveneMessages as ReturnType<typeof vi.fn>;
      mockGetConveneSession.mockReturnValueOnce({
        id: "cs-1", blueprintId: "bp-1", topic: "Design", status: "active",
        synthesisResult: null, messageCount: 0, createdAt: "2024-01-01",
      });
      mockGetConveneMessages.mockReturnValueOnce([]);
      const res = await request(app).get("/api/blueprints/bp-1/convene-sessions/cs-1/panel");
      expect(res.status).toBe(200);
      expect(res.type).toMatch(/text\/plain/);
      expect(res.text).toContain("No contributions yet");
    });

    it("returns formatted panel with messages grouped by round", async () => {
      const mockGetConveneSession = getConveneSession as ReturnType<typeof vi.fn>;
      const mockGetConveneMessages = getConveneMessages as ReturnType<typeof vi.fn>;
      mockGetConveneSession.mockReturnValueOnce({
        id: "cs-1", blueprintId: "bp-1", topic: "Design", status: "active",
        synthesisResult: null, messageCount: 3, createdAt: "2024-01-01",
      });
      mockGetConveneMessages.mockReturnValueOnce([
        { id: "m1", sessionId: "cs-1", roleId: "sde", round: 1, content: "SDE says hello", messageType: "contribution", createdAt: "2024-01-01T00:00:00Z" },
        { id: "m2", sessionId: "cs-1", roleId: "qa", round: 1, content: "QA agrees", messageType: "contribution", createdAt: "2024-01-01T00:01:00Z" },
        { id: "m3", sessionId: "cs-1", roleId: "sde", round: 2, content: "SDE round 2", messageType: "contribution", createdAt: "2024-01-01T00:02:00Z" },
      ]);
      const res = await request(app).get("/api/blueprints/bp-1/convene-sessions/cs-1/panel");
      expect(res.status).toBe(200);
      expect(res.type).toMatch(/text\/plain/);
      expect(res.text).toContain("## Round 1");
      expect(res.text).toContain("### SDE\nSDE says hello");
      expect(res.text).toContain("### QA\nQA agrees");
      expect(res.text).toContain("## Round 2");
      expect(res.text).toContain("### SDE\nSDE round 2");
    });

    it("returns 404 for missing blueprint", async () => {
      const res = await request(app).get("/api/blueprints/missing/convene-sessions/cs-1/panel");
      expect(res.status).toBe(404);
    });

    it("returns 404 when session belongs to different blueprint", async () => {
      const mockGetConveneSession = getConveneSession as ReturnType<typeof vi.fn>;
      mockGetConveneSession.mockReturnValueOnce({
        id: "cs-1", blueprintId: "bp-other", topic: "X", status: "active",
        synthesisResult: null, messageCount: 0, createdAt: "2024-01-01",
      });
      const res = await request(app).get("/api/blueprints/bp-1/convene-sessions/cs-1/panel");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/blueprints/:id/convene-sessions/:sessionId/contribute", () => {
    it("creates a message and returns success", async () => {
      const mockGetConveneSession = getConveneSession as ReturnType<typeof vi.fn>;
      mockGetConveneSession.mockReturnValueOnce({
        id: "cs-1", blueprintId: "bp-1", topic: "Design", status: "active",
        synthesisResult: null, messageCount: 2, createdAt: "2024-01-01",
      });
      const res = await request(app)
        .post("/api/blueprints/bp-1/convene-sessions/cs-1/contribute")
        .send({ roleId: "sde", round: 1, content: "My contribution" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
      expect(createConveneMessage).toHaveBeenCalledWith("cs-1", "sde", 1, "My contribution");
    });

    it("returns 400 for missing roleId", async () => {
      const mockGetConveneSession = getConveneSession as ReturnType<typeof vi.fn>;
      mockGetConveneSession.mockReturnValueOnce({
        id: "cs-1", blueprintId: "bp-1", topic: "Design", status: "active",
        synthesisResult: null, messageCount: 0, createdAt: "2024-01-01",
      });
      const res = await request(app)
        .post("/api/blueprints/bp-1/convene-sessions/cs-1/contribute")
        .send({ round: 1, content: "My contribution" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("roleId");
    });

    it("returns 400 for missing round", async () => {
      const mockGetConveneSession = getConveneSession as ReturnType<typeof vi.fn>;
      mockGetConveneSession.mockReturnValueOnce({
        id: "cs-1", blueprintId: "bp-1", topic: "Design", status: "active",
        synthesisResult: null, messageCount: 0, createdAt: "2024-01-01",
      });
      const res = await request(app)
        .post("/api/blueprints/bp-1/convene-sessions/cs-1/contribute")
        .send({ roleId: "sde", content: "My contribution" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("round");
    });

    it("returns 400 for missing/empty content", async () => {
      const mockGetConveneSession = getConveneSession as ReturnType<typeof vi.fn>;
      mockGetConveneSession.mockReturnValueOnce({
        id: "cs-1", blueprintId: "bp-1", topic: "Design", status: "active",
        synthesisResult: null, messageCount: 0, createdAt: "2024-01-01",
      });
      const res = await request(app)
        .post("/api/blueprints/bp-1/convene-sessions/cs-1/contribute")
        .send({ roleId: "sde", round: 1, content: "" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("content");
    });

    it("returns 400 when session is not active", async () => {
      const mockGetConveneSession = getConveneSession as ReturnType<typeof vi.fn>;
      mockGetConveneSession.mockReturnValueOnce({
        id: "cs-1", blueprintId: "bp-1", topic: "Design", status: "completed",
        synthesisResult: null, messageCount: 4, createdAt: "2024-01-01",
      });
      const res = await request(app)
        .post("/api/blueprints/bp-1/convene-sessions/cs-1/contribute")
        .send({ roleId: "sde", round: 1, content: "My contribution" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("must be 'active' to contribute");
    });

    it("returns 404 for missing blueprint", async () => {
      const res = await request(app)
        .post("/api/blueprints/missing/convene-sessions/cs-1/contribute")
        .send({ roleId: "sde", round: 1, content: "My contribution" });
      expect(res.status).toBe(404);
    });

    it("returns 404 for missing session", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/convene-sessions/cs-unknown/contribute")
        .send({ roleId: "sde", round: 1, content: "My contribution" });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/blueprints/:id/convene-sessions/:sessionId/propose-nodes", () => {
    it("stores nodes and returns success with count", async () => {
      const mockGetConveneSession = getConveneSession as ReturnType<typeof vi.fn>;
      mockGetConveneSession.mockReturnValueOnce({
        id: "cs-1", blueprintId: "bp-1", topic: "Design", status: "synthesizing",
        synthesisResult: null, messageCount: 4, createdAt: "2024-01-01",
      });
      const nodes = [
        { title: "Task A", description: "Do A", roles: ["sde"] },
        { title: "Task B", description: "Do B" },
      ];
      const res = await request(app)
        .post("/api/blueprints/bp-1/convene-sessions/cs-1/propose-nodes")
        .send({ nodes });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, count: 2 });
      expect(updateConveneSessionStatus).toHaveBeenCalledWith("cs-1", "synthesizing", nodes);
    });

    it("returns 400 for empty nodes array", async () => {
      const mockGetConveneSession = getConveneSession as ReturnType<typeof vi.fn>;
      mockGetConveneSession.mockReturnValueOnce({
        id: "cs-1", blueprintId: "bp-1", topic: "Design", status: "synthesizing",
        synthesisResult: null, messageCount: 4, createdAt: "2024-01-01",
      });
      const res = await request(app)
        .post("/api/blueprints/bp-1/convene-sessions/cs-1/propose-nodes")
        .send({ nodes: [] });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("nodes");
    });

    it("returns 400 for missing nodes field", async () => {
      const mockGetConveneSession = getConveneSession as ReturnType<typeof vi.fn>;
      mockGetConveneSession.mockReturnValueOnce({
        id: "cs-1", blueprintId: "bp-1", topic: "Design", status: "synthesizing",
        synthesisResult: null, messageCount: 4, createdAt: "2024-01-01",
      });
      const res = await request(app)
        .post("/api/blueprints/bp-1/convene-sessions/cs-1/propose-nodes")
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("nodes");
    });

    it("returns 400 for node with missing title", async () => {
      const mockGetConveneSession = getConveneSession as ReturnType<typeof vi.fn>;
      mockGetConveneSession.mockReturnValueOnce({
        id: "cs-1", blueprintId: "bp-1", topic: "Design", status: "synthesizing",
        synthesisResult: null, messageCount: 4, createdAt: "2024-01-01",
      });
      const res = await request(app)
        .post("/api/blueprints/bp-1/convene-sessions/cs-1/propose-nodes")
        .send({ nodes: [{ description: "No title here" }] });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("title");
    });

    it("returns 400 when session status is not synthesizing", async () => {
      const mockGetConveneSession = getConveneSession as ReturnType<typeof vi.fn>;
      mockGetConveneSession.mockReturnValueOnce({
        id: "cs-1", blueprintId: "bp-1", topic: "Design", status: "active",
        synthesisResult: null, messageCount: 2, createdAt: "2024-01-01",
      });
      const res = await request(app)
        .post("/api/blueprints/bp-1/convene-sessions/cs-1/propose-nodes")
        .send({ nodes: [{ title: "Task", description: "Desc" }] });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("must be 'synthesizing'");
    });

    it("returns 404 for missing blueprint", async () => {
      const res = await request(app)
        .post("/api/blueprints/missing/convene-sessions/cs-1/propose-nodes")
        .send({ nodes: [{ title: "Task", description: "Desc" }] });
      expect(res.status).toBe(404);
    });

    it("returns 404 for missing session", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/convene-sessions/cs-unknown/propose-nodes")
        .send({ nodes: [{ title: "Task", description: "Desc" }] });
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

  // ─── Autopilot mode-switching integration ──────────────────

  describe("PUT /api/blueprints/:id — autopilot mode switching", () => {
    beforeEach(() => {
      vi.mocked(updateBlueprint).mockClear();
      vi.mocked(enqueueBlueprintTask).mockClear();
      vi.mocked(runAutopilotLoop).mockClear();
    });

    it("clears pauseReason and enqueues autopilot loop when switching to autopilot on approved blueprint", async () => {
      vi.mocked(getBlueprint).mockReturnValueOnce({
        id: "bp-1",
        title: "Test",
        description: "desc",
        status: "approved",
        executionMode: undefined,
        pauseReason: "Some pause reason",
        projectCwd: "/test",
        nodes: [],
        createdAt: "2024-01-01",
        updatedAt: "2024-01-01",
      } as any);

      const res = await request(app)
        .put("/api/blueprints/bp-1")
        .send({ executionMode: "autopilot" });
      expect(res.status).toBe(200);

      // pauseReason should be cleared in the update patch
      expect(updateBlueprint).toHaveBeenCalledWith("bp-1", expect.objectContaining({
        executionMode: "autopilot",
        pauseReason: "",
      }));

      // runAutopilotLoop should be enqueued
      expect(enqueueBlueprintTask).toHaveBeenCalledWith("bp-1", expect.any(Function));

      // Execute the enqueued task to verify it calls runAutopilotLoop
      const enqueueCall = vi.mocked(enqueueBlueprintTask).mock.calls[0];
      await enqueueCall[1]();
      expect(runAutopilotLoop).toHaveBeenCalledWith("bp-1");
    });

    it("clears pauseReason and enqueues autopilot loop when switching to autopilot on paused blueprint", async () => {
      vi.mocked(getBlueprint).mockReturnValueOnce({
        id: "bp-1",
        title: "Test",
        description: "desc",
        status: "paused",
        executionMode: "manual",
        pauseReason: "Need human review",
        projectCwd: "/test",
        nodes: [],
        createdAt: "2024-01-01",
        updatedAt: "2024-01-01",
      } as any);

      const res = await request(app)
        .put("/api/blueprints/bp-1")
        .send({ executionMode: "autopilot" });
      expect(res.status).toBe(200);

      expect(updateBlueprint).toHaveBeenCalledWith("bp-1", expect.objectContaining({
        executionMode: "autopilot",
        pauseReason: "",
      }));
      expect(enqueueBlueprintTask).toHaveBeenCalledTimes(1);
    });

    it("does NOT enqueue autopilot loop when switching to autopilot on draft blueprint", async () => {
      vi.mocked(getBlueprint).mockReturnValueOnce({
        id: "bp-1",
        title: "Test",
        description: "desc",
        status: "draft",
        executionMode: undefined,
        projectCwd: "/test",
        nodes: [],
        createdAt: "2024-01-01",
        updatedAt: "2024-01-01",
      } as any);

      const res = await request(app)
        .put("/api/blueprints/bp-1")
        .send({ executionMode: "autopilot" });
      expect(res.status).toBe(200);

      // Should NOT enqueue because status is draft (not approved or paused)
      expect(enqueueBlueprintTask).not.toHaveBeenCalled();
    });

    it("does NOT enqueue autopilot loop when already in autopilot mode", async () => {
      vi.mocked(getBlueprint).mockReturnValueOnce({
        id: "bp-1",
        title: "Test",
        description: "desc",
        status: "approved",
        executionMode: "autopilot",
        projectCwd: "/test",
        nodes: [],
        createdAt: "2024-01-01",
        updatedAt: "2024-01-01",
      } as any);

      const res = await request(app)
        .put("/api/blueprints/bp-1")
        .send({ executionMode: "autopilot" });
      expect(res.status).toBe(200);

      // Already autopilot → not switching → no enqueue
      expect(enqueueBlueprintTask).not.toHaveBeenCalled();
    });

    it("does NOT enqueue autopilot loop when switching to manual", async () => {
      vi.mocked(getBlueprint).mockReturnValueOnce({
        id: "bp-1",
        title: "Test",
        description: "desc",
        status: "approved",
        executionMode: "autopilot",
        projectCwd: "/test",
        nodes: [],
        createdAt: "2024-01-01",
        updatedAt: "2024-01-01",
      } as any);

      const res = await request(app)
        .put("/api/blueprints/bp-1")
        .send({ executionMode: "manual" });
      expect(res.status).toBe(200);

      expect(enqueueBlueprintTask).not.toHaveBeenCalled();
    });

    it("clears pauseReason and enqueues autopilot loop when switching to fsd on approved blueprint", async () => {
      vi.mocked(getBlueprint).mockReturnValueOnce({
        id: "bp-1",
        title: "Test",
        description: "desc",
        status: "approved",
        executionMode: undefined,
        pauseReason: "Some pause reason",
        projectCwd: "/test",
        nodes: [],
        createdAt: "2024-01-01",
        updatedAt: "2024-01-01",
      } as any);

      const res = await request(app)
        .put("/api/blueprints/bp-1")
        .send({ executionMode: "fsd" });
      expect(res.status).toBe(200);

      expect(updateBlueprint).toHaveBeenCalledWith("bp-1", expect.objectContaining({
        executionMode: "fsd",
        pauseReason: "",
      }));
      expect(enqueueBlueprintTask).toHaveBeenCalledWith("bp-1", expect.any(Function));

      const enqueueCall = vi.mocked(enqueueBlueprintTask).mock.calls[0];
      await enqueueCall[1]();
      expect(runAutopilotLoop).toHaveBeenCalledWith("bp-1");
    });

    it("does NOT re-enqueue when already in fsd mode and setting fsd again", async () => {
      vi.mocked(getBlueprint).mockReturnValueOnce({
        id: "bp-1",
        title: "Test",
        description: "desc",
        status: "approved",
        executionMode: "fsd",
        projectCwd: "/test",
        nodes: [],
        createdAt: "2024-01-01",
        updatedAt: "2024-01-01",
      } as any);

      const res = await request(app)
        .put("/api/blueprints/bp-1")
        .send({ executionMode: "fsd" });
      expect(res.status).toBe(200);

      // Already fsd → not switching → no enqueue
      expect(enqueueBlueprintTask).not.toHaveBeenCalled();
    });

    it("enqueues autopilot loop when switching from autopilot to fsd", async () => {
      vi.mocked(getBlueprint).mockReturnValueOnce({
        id: "bp-1",
        title: "Test",
        description: "desc",
        status: "approved",
        executionMode: "autopilot",
        projectCwd: "/test",
        nodes: [],
        createdAt: "2024-01-01",
        updatedAt: "2024-01-01",
      } as any);

      const res = await request(app)
        .put("/api/blueprints/bp-1")
        .send({ executionMode: "fsd" });
      expect(res.status).toBe(200);

      // autopilot → fsd: both are autopilot-like, so NOT a switch (isAutopilotMode → isAutopilotMode)
      expect(enqueueBlueprintTask).not.toHaveBeenCalled();
    });

    it("clears pause and enqueues loop when switching autopilot→fsd while paused", async () => {
      vi.mocked(getBlueprint).mockReturnValueOnce({
        id: "bp-1",
        title: "Test",
        description: "desc",
        status: "paused",
        executionMode: "autopilot",
        pauseReason: "No progress detected after 5 consecutive iterations.",
        projectCwd: "/test",
        nodes: [],
        createdAt: "2024-01-01",
        updatedAt: "2024-01-01",
      } as any);

      const res = await request(app)
        .put("/api/blueprints/bp-1")
        .send({ executionMode: "fsd" });
      expect(res.status).toBe(200);

      // Should clear pauseReason and restart the loop in fsd mode
      expect(updateBlueprint).toHaveBeenCalledWith("bp-1", expect.objectContaining({
        executionMode: "fsd",
        pauseReason: "",
      }));
      expect(enqueueBlueprintTask).toHaveBeenCalledWith("bp-1", expect.any(Function));

      const enqueueCall = vi.mocked(enqueueBlueprintTask).mock.calls[0];
      await enqueueCall[1]();
      expect(runAutopilotLoop).toHaveBeenCalledWith("bp-1");
    });

    it("clears pause and enqueues loop when switching fsd→autopilot while paused", async () => {
      vi.mocked(getBlueprint).mockReturnValueOnce({
        id: "bp-1",
        title: "Test",
        description: "desc",
        status: "paused",
        executionMode: "fsd",
        pauseReason: "Autopilot reached maximum iterations (200).",
        projectCwd: "/test",
        nodes: [],
        createdAt: "2024-01-01",
        updatedAt: "2024-01-01",
      } as any);

      const res = await request(app)
        .put("/api/blueprints/bp-1")
        .send({ executionMode: "autopilot" });
      expect(res.status).toBe(200);

      expect(updateBlueprint).toHaveBeenCalledWith("bp-1", expect.objectContaining({
        executionMode: "autopilot",
        pauseReason: "",
      }));
      expect(enqueueBlueprintTask).toHaveBeenCalledWith("bp-1", expect.any(Function));
    });

    it("does NOT enqueue when switching autopilot→fsd while running (loop already active)", async () => {
      vi.mocked(getBlueprint).mockReturnValueOnce({
        id: "bp-1",
        title: "Test",
        description: "desc",
        status: "running",
        executionMode: "autopilot",
        projectCwd: "/test",
        nodes: [],
        createdAt: "2024-01-01",
        updatedAt: "2024-01-01",
      } as any);

      const res = await request(app)
        .put("/api/blueprints/bp-1")
        .send({ executionMode: "fsd" });
      expect(res.status).toBe(200);

      // Running loop will pick up the mode change dynamically — no restart needed
      expect(enqueueBlueprintTask).not.toHaveBeenCalled();
    });

    it("returns 400 for invalid executionMode", async () => {
      const res = await request(app)
        .put("/api/blueprints/bp-1")
        .send({ executionMode: "turbo" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("executionMode");
    });

    it("validates maxIterations range", async () => {
      const res1 = await request(app)
        .put("/api/blueprints/bp-1")
        .send({ maxIterations: 5 });
      expect(res1.status).toBe(400);
      expect(res1.body.error).toContain("maxIterations");

      const res2 = await request(app)
        .put("/api/blueprints/bp-1")
        .send({ maxIterations: 999 });
      expect(res2.status).toBe(400);
    });
  });

  // ─── run-all mode-aware routing ─────────────────────────────

  describe("POST /api/blueprints/:id/run-all — mode-aware", () => {
    beforeEach(() => {
      vi.mocked(executeAllNodes).mockClear();
      vi.mocked(enqueueBlueprintTask).mockClear();
      vi.mocked(runAutopilotLoop).mockClear();
    });

    it("routes to runAutopilotLoop when executionMode is autopilot", async () => {
      vi.mocked(getBlueprint).mockReturnValueOnce({
        id: "bp-1",
        title: "Test",
        description: "desc",
        status: "approved",
        executionMode: "autopilot",
        projectCwd: "/test",
        nodes: [],
        createdAt: "2024-01-01",
        updatedAt: "2024-01-01",
      } as any);

      const res = await request(app).post("/api/blueprints/bp-1/run-all");
      expect(res.status).toBe(200);
      expect(res.body.message).toBe("execution started");

      // Should use enqueueBlueprintTask → runAutopilotLoop, NOT executeAllNodes
      expect(enqueueBlueprintTask).toHaveBeenCalledWith("bp-1", expect.any(Function));
      expect(executeAllNodes).not.toHaveBeenCalled();

      // Verify the enqueued function calls runAutopilotLoop
      const enqueueCall = vi.mocked(enqueueBlueprintTask).mock.calls[0];
      await enqueueCall[1]();
      expect(runAutopilotLoop).toHaveBeenCalledWith("bp-1", undefined);
    });

    it("routes to runAutopilotLoop when executionMode is fsd", async () => {
      vi.mocked(getBlueprint).mockReturnValueOnce({
        id: "bp-1",
        title: "Test",
        description: "desc",
        status: "approved",
        executionMode: "fsd",
        projectCwd: "/test",
        nodes: [],
        createdAt: "2024-01-01",
        updatedAt: "2024-01-01",
      } as any);

      const res = await request(app).post("/api/blueprints/bp-1/run-all");
      expect(res.status).toBe(200);
      expect(res.body.message).toBe("execution started");

      expect(enqueueBlueprintTask).toHaveBeenCalledWith("bp-1", expect.any(Function));
      expect(executeAllNodes).not.toHaveBeenCalled();

      const enqueueCall = vi.mocked(enqueueBlueprintTask).mock.calls[0];
      await enqueueCall[1]();
      expect(runAutopilotLoop).toHaveBeenCalledWith("bp-1", undefined);
    });

    it("routes to executeAllNodes when executionMode is manual/undefined", async () => {
      vi.mocked(getBlueprint).mockReturnValueOnce({
        id: "bp-1",
        title: "Test",
        description: "desc",
        status: "approved",
        projectCwd: "/test",
        nodes: [],
        createdAt: "2024-01-01",
        updatedAt: "2024-01-01",
      } as any);

      const res = await request(app).post("/api/blueprints/bp-1/run-all");
      expect(res.status).toBe(200);

      expect(executeAllNodes).toHaveBeenCalledWith("bp-1");
      expect(enqueueBlueprintTask).not.toHaveBeenCalled();
    });

    it("returns 404 for missing blueprint", async () => {
      vi.mocked(getBlueprint).mockReturnValueOnce(null as any);

      const res = await request(app).post("/api/blueprints/missing/run-all");
      expect(res.status).toBe(404);
    });
  });

  // ─── Lightweight Node-Read Endpoints ────────────────────────

  describe("GET /api/blueprints/:id/nodes/summary", () => {
    it("returns only id/seq/title/status/roles/dependencies (no descriptions)", async () => {
      vi.mocked(getBlueprint).mockReturnValueOnce({
        id: "bp-1",
        title: "Test",
        description: "desc",
        status: "running",
        nodes: [
          {
            id: "n1", blueprintId: "bp-1", order: 0, seq: 1,
            title: "Step 1", description: "Full description here",
            status: "done", dependencies: [], roles: ["sde"],
            inputArtifacts: [], outputArtifacts: [], executions: [],
            createdAt: "2024-01-01", updatedAt: "2024-01-01",
          },
          {
            id: "n2", blueprintId: "bp-1", order: 1, seq: 2,
            title: "Step 2", description: "Another description",
            status: "pending", dependencies: ["n1"],
            inputArtifacts: [], outputArtifacts: [], executions: [],
            createdAt: "2024-01-01", updatedAt: "2024-01-01",
          },
        ],
        createdAt: "2024-01-01", updatedAt: "2024-01-01",
      } as any);

      const res = await request(app).get("/api/blueprints/bp-1/nodes/summary");
      expect(res.status).toBe(200);
      expect(res.body.nodes).toHaveLength(2);

      const node1 = res.body.nodes[0];
      expect(node1.id).toBe("n1");
      expect(node1.seq).toBe(1);
      expect(node1.title).toBe("Step 1");
      expect(node1.status).toBe("done");
      expect(node1.roles).toEqual(["sde"]);
      expect(node1.dependencies).toEqual([]);

      // Must NOT include descriptions
      expect(node1).not.toHaveProperty("description");
      expect(node1).not.toHaveProperty("prompt");
      expect(node1).not.toHaveProperty("executions");

      const node2 = res.body.nodes[1];
      expect(node2.dependencies).toEqual(["n1"]);
    });

    it("returns 404 for missing blueprint", async () => {
      vi.mocked(getBlueprint).mockReturnValueOnce(null as any);
      const res = await request(app).get("/api/blueprints/missing/nodes/summary");
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/blueprints/:id/nodes/:nodeId/context", () => {
    it("returns resolved dependencies with titles and latest handoff", async () => {
      vi.mocked(getBlueprint).mockReturnValueOnce({
        id: "bp-1",
        title: "Test",
        description: "desc",
        status: "running",
        nodes: [
          {
            id: "dep-1", blueprintId: "bp-1", order: 0, seq: 1,
            title: "Dependency Node", description: "dep desc",
            status: "done", dependencies: [],
            inputArtifacts: [], outputArtifacts: [], executions: [],
            createdAt: "2024-01-01", updatedAt: "2024-01-01",
          },
          {
            id: "n1", blueprintId: "bp-1", order: 1, seq: 2,
            title: "Main Node", description: "main desc",
            prompt: "Do something", status: "pending",
            dependencies: ["dep-1"], roles: ["sde"],
            inputArtifacts: [],
            outputArtifacts: [
              { id: "a1", type: "handoff_summary", content: "Handoff data", sourceNodeId: "n1", blueprintId: "bp-1", createdAt: "2024-01-01" },
            ],
            executions: [],
            createdAt: "2024-01-01", updatedAt: "2024-01-01",
          },
        ],
        createdAt: "2024-01-01", updatedAt: "2024-01-01",
      } as any);
      vi.mocked(getSuggestionsForNode).mockReturnValueOnce([]);

      const res = await request(app).get("/api/blueprints/bp-1/nodes/n1/context");
      expect(res.status).toBe(200);

      expect(res.body.id).toBe("n1");
      expect(res.body.title).toBe("Main Node");
      expect(res.body.description).toBe("main desc");
      expect(res.body.prompt).toBe("Do something");
      expect(res.body.status).toBe("pending");
      expect(res.body.roles).toEqual(["sde"]);

      // Dependencies resolved with titles
      expect(res.body.dependencies).toHaveLength(1);
      expect(res.body.dependencies[0].id).toBe("dep-1");
      expect(res.body.dependencies[0].title).toBe("Dependency Node");
      expect(res.body.dependencies[0].status).toBe("done");

      // Handoff present
      expect(res.body.handoff).toBe("Handoff data");
    });

    it("returns handoff: null for node without handoff artifact", async () => {
      vi.mocked(getBlueprint).mockReturnValueOnce({
        id: "bp-1",
        title: "Test",
        description: "desc",
        status: "running",
        nodes: [
          {
            id: "n1", blueprintId: "bp-1", order: 0, seq: 1,
            title: "No Handoff", description: "desc",
            status: "pending", dependencies: [],
            inputArtifacts: [], outputArtifacts: [], executions: [],
            createdAt: "2024-01-01", updatedAt: "2024-01-01",
          },
        ],
        createdAt: "2024-01-01", updatedAt: "2024-01-01",
      } as any);
      vi.mocked(getSuggestionsForNode).mockReturnValueOnce([]);

      const res = await request(app).get("/api/blueprints/bp-1/nodes/n1/context");
      expect(res.status).toBe(200);
      expect(res.body.handoff).toBeNull();
    });

    it("returns 404 for missing node", async () => {
      const res = await request(app).get("/api/blueprints/bp-1/nodes/missing-node/context");
      expect(res.status).toBe(404);
    });

    it("returns 404 for missing blueprint", async () => {
      vi.mocked(getBlueprint).mockReturnValueOnce(null as any);
      const res = await request(app).get("/api/blueprints/missing/nodes/n1/context");
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/blueprints/:id/progress", () => {
    it("returns correct counts matching node statuses", async () => {
      vi.mocked(getBlueprint).mockReturnValueOnce({
        id: "bp-1",
        title: "Test",
        description: "desc",
        status: "running",
        nodes: [
          { id: "n1", status: "done", dependencies: [], inputArtifacts: [], outputArtifacts: [], executions: [] },
          { id: "n2", status: "done", dependencies: [], inputArtifacts: [], outputArtifacts: [], executions: [] },
          { id: "n3", status: "pending", dependencies: [], inputArtifacts: [], outputArtifacts: [], executions: [] },
          { id: "n4", status: "running", dependencies: [], inputArtifacts: [], outputArtifacts: [], executions: [] },
          { id: "n5", status: "failed", dependencies: [], inputArtifacts: [], outputArtifacts: [], executions: [] },
          { id: "n6", status: "skipped", dependencies: [], inputArtifacts: [], outputArtifacts: [], executions: [] },
        ],
        createdAt: "2024-01-01", updatedAt: "2024-01-01",
      } as any);

      const res = await request(app).get("/api/blueprints/bp-1/progress");
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(6);
      expect(res.body.done).toBe(2);
      expect(res.body.pending).toBe(1);
      expect(res.body.running).toBe(1);
      expect(res.body.failed).toBe(1);
      expect(res.body.skipped).toBe(1);
      expect(res.body.queued).toBe(0);
      expect(res.body.blocked).toBe(0);
    });

    it("returns 404 for missing blueprint", async () => {
      vi.mocked(getBlueprint).mockReturnValueOnce(null as any);
      const res = await request(app).get("/api/blueprints/missing/progress");
      expect(res.status).toBe(404);
    });
  });

  // ─── Autopilot Message Endpoints ────────────────────────────

  describe("GET /api/blueprints/:id/messages", () => {
    it("returns paginated message history", async () => {
      const mockMessages = [
        { id: "m1", blueprintId: "bp-1", role: "user", content: "Hello", acknowledged: false, createdAt: "2024-01-02" },
        { id: "m2", blueprintId: "bp-1", role: "system", content: "Ack", acknowledged: true, createdAt: "2024-01-01" },
      ];
      vi.mocked(getMessageHistory).mockReturnValueOnce(mockMessages as any);
      vi.mocked(getMessageCount).mockReturnValueOnce(2);

      const res = await request(app).get("/api/blueprints/bp-1/messages");
      expect(res.status).toBe(200);
      expect(res.body.messages).toHaveLength(2);
      expect(res.body.total).toBe(2);
      expect(getMessageHistory).toHaveBeenCalledWith("bp-1", 50, 0);
    });

    it("clamps limit between 1 and 200", async () => {
      vi.mocked(getMessageHistory).mockReturnValueOnce([]);
      vi.mocked(getMessageCount).mockReturnValueOnce(0);

      await request(app).get("/api/blueprints/bp-1/messages?limit=500");
      expect(getMessageHistory).toHaveBeenCalledWith("bp-1", 200, 0);
    });

    it("returns 404 for missing blueprint", async () => {
      vi.mocked(getBlueprint).mockReturnValueOnce(null as any);
      const res = await request(app).get("/api/blueprints/missing/messages");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/blueprints/:id/messages", () => {
    it("creates message and returns it", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/messages")
        .send({ content: "Focus on tests" });
      expect(res.status).toBe(200);
      expect(res.body.content).toBe("Focus on tests");
      expect(res.body.role).toBe("user");
      expect(createAutopilotMessage).toHaveBeenCalledWith("bp-1", "user", "Focus on tests");
    });

    it("returns 400 for missing content", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/messages")
        .send({});
      expect(res.status).toBe(400);
    });

    it("returns 400 for empty content", async () => {
      const res = await request(app)
        .post("/api/blueprints/bp-1/messages")
        .send({ content: "   " });
      expect(res.status).toBe(400);
    });

    it("triggers user agent when blueprint is in FSD mode", async () => {
      const fsdBlueprint = {
        id: "bp-1",
        title: "Test",
        description: "desc",
        status: "running",
        executionMode: "fsd",
        projectCwd: "/test",
        nodes: [],
        createdAt: "2024-01-01",
        updatedAt: "2024-01-01",
      } as any;
      vi.mocked(getBlueprint).mockReturnValueOnce(fsdBlueprint);

      const res = await request(app)
        .post("/api/blueprints/bp-1/messages")
        .send({ content: "Do something" });
      expect(res.status).toBe(200);
      // triggerUserAgent is called (it internally checks mode and enqueues if needed)
      expect(triggerUserAgent).toHaveBeenCalledWith("bp-1");
    });

    it("returns 404 for missing blueprint", async () => {
      vi.mocked(getBlueprint).mockReturnValueOnce(null as any);
      const res = await request(app)
        .post("/api/blueprints/missing/messages")
        .send({ content: "Hello" });
      expect(res.status).toBe(404);
    });
  });
});
