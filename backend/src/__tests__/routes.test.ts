import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import express from "express";
import request from "supertest";

// Mock all dependencies before importing routes
vi.mock("../db.js", () => ({
  getProjects: vi.fn(() => []),
  getSessions: vi.fn(() => []),
  getTimeline: vi.fn(() => []),
  getLastMessage: vi.fn(() => null),
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
}));

vi.mock("../jsonl-parser.js", () => ({
  getSessionCwd: vi.fn(() => "/test/cwd"),
  analyzeSessionHealth: vi.fn(() => null),
}));

vi.mock("../plan-db.js", () => ({
  getNodeInfoForSessions: vi.fn(() => new Map()),
}));

import router from "../routes.js";
import {
  getProjects,
  getSessions,
  getTimeline,
  getLastMessage,
  syncAll,
  syncSession,
} from "../db.js";
import {
  getEnrichments,
  updateSessionMeta,
  updateNodeMeta,
  getAllTags,
} from "../enrichment.js";
import { getAppState, updateAppState, trackSessionView } from "../app-state.js";
import { runPrompt } from "../cli-runner.js";
import { analyzeSessionHealth } from "../jsonl-parser.js";

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
      expect(res.body.error).toContain("DB error");
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

    it("returns 500 on error", async () => {
      vi.mocked(updateAppState).mockImplementation(() => {
        throw new Error("write error");
      });

      const res = await request(app).put("/api/state").send({ ui: {} });
      expect(res.status).toBe(500);
      expect(res.body.error).toContain("write error");
    });
  });

  // ─── GET /api/sessions/:id/last-message ─────────────────────

  describe("GET /api/sessions/:id/last-message", () => {
    it("returns the last message for a session", async () => {
      vi.mocked(getLastMessage).mockReturnValue({
        id: "n99",
        type: "assistant",
        timestamp: "2024-01-01T00:01:00Z",
        title: "Final response",
        content: "All done!",
      });

      const res = await request(app).get("/api/sessions/s1/last-message");
      expect(res.status).toBe(200);
      expect(res.body.id).toBe("n99");
      expect(res.body.type).toBe("assistant");
      expect(syncSession).toHaveBeenCalledWith("s1");
    });

    it("returns 404 when no messages exist", async () => {
      vi.mocked(getLastMessage).mockReturnValue(null);

      const res = await request(app).get("/api/sessions/missing/last-message");
      expect(res.status).toBe(404);
      expect(res.body.error).toContain("No messages found");
    });

    it("returns 500 on error", async () => {
      vi.mocked(getLastMessage).mockImplementation(() => {
        throw new Error("DB read error");
      });

      const res = await request(app).get("/api/sessions/s1/last-message");
      expect(res.status).toBe(500);
    });
  });

  // ─── GET /api/sessions/:id/health ──────────────────────────

  describe("GET /api/sessions/:id/health", () => {
    it("returns session health analysis", async () => {
      vi.mocked(analyzeSessionHealth).mockReturnValue({
        failureReason: "context_exhausted",
        detail: "Session compacted 3 times",
        compactCount: 3,
        peakTokens: 170000,
        lastApiError: null,
        messageCount: 50,
        contextPressure: "critical",
        endedAfterCompaction: true,
        responsesAfterLastCompact: 0,
      });

      const res = await request(app).get("/api/sessions/s1/health");
      expect(res.status).toBe(200);
      expect(res.body.failureReason).toBe("context_exhausted");
      expect(res.body.compactCount).toBe(3);
      expect(res.body.contextPressure).toBe("critical");
    });

    it("returns 404 when session file not found", async () => {
      vi.mocked(analyzeSessionHealth).mockReturnValue(null);

      const res = await request(app).get("/api/sessions/missing/health");
      expect(res.status).toBe(404);
      expect(res.body.error).toContain("Session file not found");
    });

    it("returns 500 on error", async () => {
      vi.mocked(analyzeSessionHealth).mockImplementation(() => {
        throw new Error("file read error");
      });

      const res = await request(app).get("/api/sessions/s1/health");
      expect(res.status).toBe(500);
    });
  });

  // ─── GET /api/dev/status ──────────────────────────────────

  describe("GET /api/dev/status", () => {
    it("returns dev mode status", async () => {
      const res = await request(app).get("/api/dev/status");
      expect(res.status).toBe(200);
      expect(typeof res.body.devMode).toBe("boolean");
    });
  });

  // ─── Error handling edge cases ─────────────────────────────

  describe("Error handling", () => {
    it("GET /api/projects/:id/sessions returns 500 on error", async () => {
      vi.mocked(getSessions).mockImplementation(() => {
        throw new Error("sessions error");
      });

      const res = await request(app).get("/api/projects/p1/sessions");
      expect(res.status).toBe(500);
      expect(res.body.error).toContain("sessions error");
    });

    it("GET /api/sessions/:id/timeline returns 500 on error", async () => {
      vi.mocked(syncSession).mockImplementation(() => {
        throw new Error("sync error");
      });

      const res = await request(app).get("/api/sessions/s1/timeline");
      expect(res.status).toBe(500);
      expect(res.body.error).toContain("sync error");
    });

    it("GET /api/sync returns 500 on error", async () => {
      vi.mocked(syncAll).mockImplementation(() => {
        throw new Error("sync all error");
      });

      const res = await request(app).get("/api/sync");
      expect(res.status).toBe(500);
      expect(res.body.error).toContain("sync all error");
    });

    it("PATCH /api/sessions/:id/meta returns 500 on error", async () => {
      vi.mocked(updateSessionMeta).mockImplementation(() => {
        throw new Error("enrichment write error");
      });

      const res = await request(app)
        .patch("/api/sessions/s1/meta")
        .send({ starred: true });
      expect(res.status).toBe(500);
    });

    it("PATCH /api/nodes/:id/meta returns 500 on error", async () => {
      vi.mocked(updateNodeMeta).mockImplementation(() => {
        throw new Error("node meta write error");
      });

      const res = await request(app)
        .patch("/api/nodes/n1/meta")
        .send({ bookmarked: true });
      expect(res.status).toBe(500);
    });

    it("GET /api/tags returns 500 on error", async () => {
      vi.mocked(getAllTags).mockImplementation(() => {
        throw new Error("tags error");
      });

      const res = await request(app).get("/api/tags");
      expect(res.status).toBe(500);
    });

    it("GET /api/state returns 500 on error", async () => {
      vi.mocked(getAppState).mockImplementation(() => {
        throw new Error("state read error");
      });

      const res = await request(app).get("/api/state");
      expect(res.status).toBe(500);
    });
  });

  // ─── POST /api/sessions/:id/run edge cases ─────────────────

  describe("POST /api/sessions/:id/run edge cases", () => {
    it("returns 400 for non-string prompt", async () => {
      const res = await request(app)
        .post("/api/sessions/s1/run")
        .send({ prompt: 12345 });
      expect(res.status).toBe(400);
    });

    it("trims prompt before sending to CLI", async () => {
      // Reset mocks that may have been overridden by error handling tests
      vi.mocked(syncSession).mockImplementation(() => {});
      vi.mocked(runPrompt).mockResolvedValue({
        output: "response",
        suggestions: [],
      });

      const res = await request(app)
        .post("/api/sessions/s1/run")
        .send({ prompt: "  test prompt  " });
      expect(res.status).toBe(200);
      // runPrompt should have been called with trimmed prompt
      expect(runPrompt).toHaveBeenCalledWith(
        "s1",
        "test prompt",
        expect.anything()
      );
    });

    it("syncs session after successful run", async () => {
      // Reset mocks that may have been overridden by error handling tests
      vi.mocked(syncSession).mockImplementation(() => {});
      vi.mocked(runPrompt).mockResolvedValue({
        output: "done",
        suggestions: [],
      });

      await request(app)
        .post("/api/sessions/s1/run")
        .send({ prompt: "do something" });
      expect(syncSession).toHaveBeenCalledWith("s1");
    });
  });
});
