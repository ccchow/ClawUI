import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import express from "express";
import request from "supertest";

// Mock all dependencies before importing routes
vi.mock("../db.js", () => ({
  getProjects: vi.fn(() => []),
  getSessions: vi.fn(() => []),
  getTimeline: vi.fn(() => []),
  syncAll: vi.fn(),
  syncSession: vi.fn(),
}));

vi.mock("../enrichment.js", () => ({
  getEnrichments: vi.fn(() => ({
    version: 1,
    sessions: {},
    nodes: {},
    tags: [],
  })),
  updateSessionMeta: vi.fn((id: string, patch: Record<string, unknown>) => ({
    ...patch,
  })),
  updateNodeMeta: vi.fn((id: string, patch: Record<string, unknown>) => ({
    ...patch,
  })),
  getAllTags: vi.fn(() => ["tag1", "tag2"]),
}));

vi.mock("../app-state.js", () => ({
  getAppState: vi.fn(() => ({
    version: 1,
    ui: { theme: "dark" },
    recentSessions: [],
    filters: { hideArchivedSessions: true, defaultSort: "updated_at" },
  })),
  updateAppState: vi.fn((patch: Record<string, unknown>) => ({
    version: 1,
    ui: { theme: "dark", ...((patch.ui as Record<string, unknown>) ?? {}) },
    recentSessions: [],
    filters: { hideArchivedSessions: true, defaultSort: "updated_at" },
  })),
  trackSessionView: vi.fn(),
}));

vi.mock("../cli-runner.js", () => ({
  runPrompt: vi.fn(async () => ({
    output: "AI response",
    suggestions: [{ title: "Next", description: "desc", prompt: "do it" }],
  })),
  validateSessionId: vi.fn(),
}));

vi.mock("../jsonl-parser.js", () => ({
  getSessionCwd: vi.fn(() => "/test/cwd"),
}));

vi.mock("../plan-db.js", () => ({
  getNodeInfoForSessions: vi.fn(() => new Map()),
}));

import router from "../routes.js";
import {
  getProjects,
  getSessions,
  getTimeline,
  syncAll,
  syncSession,
} from "../db.js";
import {
  getEnrichments,
  updateSessionMeta,
  updateNodeMeta,
} from "../enrichment.js";
import { updateAppState, trackSessionView } from "../app-state.js";
import { runPrompt } from "../cli-runner.js";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

describe("routes", () => {
  let app: express.Express;

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── GET /api/projects ──────────────────────────────────────

  describe("GET /api/projects", () => {
    it("returns projects list", async () => {
      vi.mocked(getProjects).mockReturnValue([
        { id: "p1", name: "Project1", path: "/test", sessionCount: 5 },
      ]);

      const res = await request(app).get("/api/projects");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].name).toBe("Project1");
    });

    it("returns 500 on error", async () => {
      vi.mocked(getProjects).mockImplementation(() => {
        throw new Error("DB error");
      });

      const res = await request(app).get("/api/projects");
      expect(res.status).toBe(500);
      expect(res.body.error).toContain("Internal server error");
    });
  });

  // ─── GET /api/projects/:id/sessions ─────────────────────────

  describe("GET /api/projects/:id/sessions", () => {
    it("returns sessions with enrichment merged", async () => {
      vi.mocked(getSessions).mockReturnValue([
        {
          sessionId: "s1",
          projectId: "p1",
          projectName: "Test",
          timestamp: "2024-01-01T00:00:00Z",
          nodeCount: 10,
        },
      ]);
      vi.mocked(getEnrichments).mockReturnValue({
        version: 1,
        sessions: { s1: { starred: true, tags: ["important"] } },
        nodes: {},
        tags: ["important"],
      });

      const res = await request(app).get("/api/projects/p1/sessions");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].starred).toBe(true);
      expect(res.body[0].tags).toEqual(["important"]);
    });

    it("filters by starred=true", async () => {
      vi.mocked(getSessions).mockReturnValue([
        {
          sessionId: "s1",
          projectId: "p1",
          projectName: "T",
          timestamp: "2024-01-01",
          nodeCount: 1,
        },
        {
          sessionId: "s2",
          projectId: "p1",
          projectName: "T",
          timestamp: "2024-01-01",
          nodeCount: 1,
        },
      ]);
      vi.mocked(getEnrichments).mockReturnValue({
        version: 1,
        sessions: { s1: { starred: true } },
        nodes: {},
        tags: [],
      });

      const res = await request(app).get(
        "/api/projects/p1/sessions?starred=true"
      );
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].sessionId).toBe("s1");
    });

    it("filters by tag", async () => {
      vi.mocked(getSessions).mockReturnValue([
        {
          sessionId: "s1",
          projectId: "p1",
          projectName: "T",
          timestamp: "2024-01-01",
          nodeCount: 1,
        },
      ]);
      vi.mocked(getEnrichments).mockReturnValue({
        version: 1,
        sessions: { s1: { tags: ["bug"] } },
        nodes: {},
        tags: ["bug"],
      });

      const res = await request(app).get(
        "/api/projects/p1/sessions?tag=feature"
      );
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(0);
    });

    it("hides archived by default", async () => {
      vi.mocked(getSessions).mockReturnValue([
        {
          sessionId: "s1",
          projectId: "p1",
          projectName: "T",
          timestamp: "2024-01-01",
          nodeCount: 1,
        },
      ]);
      vi.mocked(getEnrichments).mockReturnValue({
        version: 1,
        sessions: { s1: { archived: true } },
        nodes: {},
        tags: [],
      });

      const res = await request(app).get("/api/projects/p1/sessions");
      expect(res.body).toHaveLength(0);

      // But shows when requested
      const res2 = await request(app).get(
        "/api/projects/p1/sessions?archived=true"
      );
      expect(res2.body).toHaveLength(1);
    });
  });

  // ─── GET /api/sessions/:id/timeline ─────────────────────────

  describe("GET /api/sessions/:id/timeline", () => {
    it("returns timeline nodes", async () => {
      vi.mocked(getTimeline).mockReturnValue([
        {
          id: "n1",
          type: "user",
          timestamp: "2024-01-01",
          title: "Test",
          content: "Hello",
        },
      ]);

      const res = await request(app).get("/api/sessions/s1/timeline");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(syncSession).toHaveBeenCalledWith("s1");
      expect(trackSessionView).toHaveBeenCalledWith("s1");
    });

    it("returns 404 for empty session", async () => {
      vi.mocked(getTimeline).mockReturnValue([]);

      const res = await request(app).get("/api/sessions/missing/timeline");
      expect(res.status).toBe(404);
    });
  });

  // ─── GET /api/sync ──────────────────────────────────────────

  describe("GET /api/sync", () => {
    it("triggers sync and returns timing", async () => {
      const res = await request(app).get("/api/sync");
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(typeof res.body.elapsed_ms).toBe("number");
      expect(syncAll).toHaveBeenCalled();
    });
  });

  // ─── POST /api/sessions/:id/run ─────────────────────────────

  describe("POST /api/sessions/:id/run", () => {
    it("runs prompt and returns output with suggestions", async () => {
      const res = await request(app)
        .post("/api/sessions/s1/run")
        .send({ prompt: "test prompt" });

      expect(res.status).toBe(200);
      expect(res.body.output).toBe("AI response");
      expect(res.body.suggestions).toHaveLength(1);
    });

    it("returns 400 for missing prompt", async () => {
      const res = await request(app)
        .post("/api/sessions/s1/run")
        .send({});
      expect(res.status).toBe(400);
    });

    it("returns 400 for empty prompt", async () => {
      const res = await request(app)
        .post("/api/sessions/s1/run")
        .send({ prompt: "  " });
      expect(res.status).toBe(400);
    });

    it("returns 400 for prompt too long", async () => {
      const res = await request(app)
        .post("/api/sessions/s1/run")
        .send({ prompt: "x".repeat(10001) });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("too long");
    });

    it("returns 500 on CLI error", async () => {
      vi.mocked(runPrompt).mockRejectedValue(new Error("CLI died"));

      const res = await request(app)
        .post("/api/sessions/s1/run")
        .send({ prompt: "test" });
      expect(res.status).toBe(500);
    });
  });

  // ─── PATCH /api/sessions/:id/meta ───────────────────────────

  describe("PATCH /api/sessions/:id/meta", () => {
    it("updates session enrichment", async () => {
      const res = await request(app)
        .patch("/api/sessions/s1/meta")
        .send({ starred: true });

      expect(res.status).toBe(200);
      expect(updateSessionMeta).toHaveBeenCalledWith("s1", { starred: true });
    });
  });

  // ─── PATCH /api/nodes/:id/meta ──────────────────────────────

  describe("PATCH /api/nodes/:id/meta", () => {
    it("updates node enrichment", async () => {
      const res = await request(app)
        .patch("/api/nodes/n1/meta")
        .send({ bookmarked: true });

      expect(res.status).toBe(200);
      expect(updateNodeMeta).toHaveBeenCalledWith("n1", { bookmarked: true });
    });
  });

  // ─── GET /api/tags ──────────────────────────────────────────

  describe("GET /api/tags", () => {
    it("returns all tags", async () => {
      const res = await request(app).get("/api/tags");
      expect(res.status).toBe(200);
      expect(res.body).toEqual(["tag1", "tag2"]);
    });
  });

  // ─── GET /api/state ─────────────────────────────────────────

  describe("GET /api/state", () => {
    it("returns app state", async () => {
      const res = await request(app).get("/api/state");
      expect(res.status).toBe(200);
      expect(res.body.version).toBe(1);
      expect(res.body.ui.theme).toBe("dark");
    });
  });

  // ─── PUT /api/state ─────────────────────────────────────────

  describe("PUT /api/state", () => {
    it("updates app state", async () => {
      const res = await request(app)
        .put("/api/state")
        .send({ ui: { lastViewedProject: "p2" } });

      expect(res.status).toBe(200);
      expect(updateAppState).toHaveBeenCalled();
    });
  });
});
