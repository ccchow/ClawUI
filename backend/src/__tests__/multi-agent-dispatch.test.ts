/**
 * Integration test: POST /api/sessions/:id/run — multi-agent dispatch
 *
 * Verifies the full routes.ts → cli-runner.ts → AgentRuntime path:
 * 1. Agent type is resolved from the DB per session
 * 2. The correct runtime factory is selected from the registry
 * 3. The runtime's resumeSession() is called with the correct args
 * 4. Fallback to claude when agent type is null or unregistered
 *
 * cli-runner.ts is NOT mocked — the real runPrompt runs end-to-end.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import express from "express";
import request from "supertest";
import type { AgentRuntime, AgentCapabilities, AgentType } from "../agent-runtime.js";

// ─── Helpers ────────────────────────────────────────────────────────

function createMockRuntime(agentType: string, output: string): AgentRuntime {
  return {
    type: agentType as AgentRuntime["type"],
    capabilities: {
      supportsResume: true,
      supportsInteractive: true,
      supportsTextOutput: true,
      supportsDangerousMode: true,
    } as AgentCapabilities,
    getSessionsDir: () => `/mock/${agentType}/sessions`,
    runSession: vi.fn(async () => ""),
    runSessionInteractive: vi.fn(async () => ""),
    resumeSession: vi.fn(async () => output),
    encodeProjectCwd: (cwd: string) => cwd,
    detectNewSession: () => null,
    cleanEnv: () => ({ ...process.env }),
    analyzeSessionHealth: vi.fn(() => null),
  };
}

// ─── Per-type mock runtimes ────────────────────────────────────────

const claudeRuntime = createMockRuntime("claude", "Claude response");
const openclawRuntime = createMockRuntime("openclaw", "OpenClaw response");
const piRuntime = createMockRuntime("pi", "Pi response");
const codexRuntime = createMockRuntime("codex", "Codex response");

const runtimeFactories = new Map<AgentType, () => AgentRuntime>([
  ["claude", vi.fn(() => claudeRuntime)],
  ["openclaw", vi.fn(() => openclawRuntime)],
  ["pi", vi.fn(() => piRuntime)],
  ["codex", vi.fn(() => codexRuntime)],
]);

// ─── Session DB stubs ──────────────────────────────────────────────

const sessionAgentTypes: Record<string, string | null> = {
  "session-claude": "claude",
  "session-openclaw": "openclaw",
  "session-pi": "pi",
  "session-codex": "codex",
  "session-unknown": "unknown_type",
  "session-null": null,
};

const sessionCwds: Record<string, string> = {
  "session-claude": "/projects/claude-app",
  "session-openclaw": "/projects/openclaw-app",
  "session-pi": "/projects/pi-app",
  "session-codex": "/projects/codex-app",
  "session-unknown": "/projects/unknown-app",
  "session-null": "/projects/null-app",
};

// ─── Mocks ─────────────────────────────────────────────────────────

vi.mock("../db.js", () => ({
  getProjects: vi.fn(() => []),
  getSessions: vi.fn(() => []),
  getTimeline: vi.fn(() => []),
  getLastMessage: vi.fn(() => null),
  syncAll: vi.fn(),
  syncSession: vi.fn(),
  getSessionAgentType: vi.fn((id: string) => sessionAgentTypes[id] ?? null),
  getSessionCwdFromDb: vi.fn((id: string) => sessionCwds[id] ?? undefined),
  getAvailableAgents: vi.fn(() => []),
}));

vi.mock("../enrichment.js", () => ({
  getEnrichments: vi.fn(() => ({ version: 1, sessions: {}, nodes: {}, tags: [] })),
  updateSessionMeta: vi.fn(),
  updateNodeMeta: vi.fn(),
  getAllTags: vi.fn(() => []),
}));

vi.mock("../app-state.js", () => ({
  getAppState: vi.fn(() => ({ version: 1, ui: {}, recentSessions: [], filters: {} })),
  updateAppState: vi.fn(),
  trackSessionView: vi.fn(),
}));

// NOT mocking cli-runner.js — the real runPrompt() is used end-to-end

vi.mock("../jsonl-parser.js", () => ({
  getSessionCwd: vi.fn(() => "/fallback/cwd"),
}));

vi.mock("../plan-db.js", () => ({
  getNodeInfoForSessions: vi.fn(() => new Map()),
}));

// Mock session-lock to avoid in-memory state leaking between tests
vi.mock("../session-lock.js", () => ({
  acquireSessionLock: vi.fn(() => true),
  releaseSessionLock: vi.fn(),
  isSessionRunning: vi.fn(() => false),
}));

vi.mock("../agent-runtime.js", () => ({
  getRegisteredRuntimes: vi.fn(() => runtimeFactories),
  getActiveRuntime: vi.fn(() => claudeRuntime),
  getRuntimeByType: vi.fn((type: string) => {
    const factory = runtimeFactories.get(type as AgentType);
    return factory ? factory() : null;
  }),
  registerRuntime: vi.fn(),
  resetActiveRuntime: vi.fn(),
}));

vi.mock("../agent-claude.js", () => ({}));
vi.mock("../agent-pimono.js", () => ({}));
vi.mock("../agent-openclaw.js", () => ({}));
vi.mock("../agent-codex.js", () => ({}));

import router from "../routes.js";
import { getSessionAgentType, getSessionCwdFromDb, syncSession } from "../db.js";
import { getRegisteredRuntimes } from "../agent-runtime.js";
import { acquireSessionLock, releaseSessionLock } from "../session-lock.js";

// ─── Test Suite ────────────────────────────────────────────────────

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

describe("Multi-agent session run dispatch (integration)", () => {
  let app: express.Express;

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Re-wire mocks after clearAllMocks
    vi.mocked(getSessionAgentType).mockImplementation(
      (id: string) => (sessionAgentTypes[id] as ReturnType<typeof getSessionAgentType>) ?? null
    );
    vi.mocked(getSessionCwdFromDb).mockImplementation(
      (id: string) => sessionCwds[id] ?? undefined
    );
    vi.mocked(getRegisteredRuntimes).mockReturnValue(runtimeFactories);
    vi.mocked(acquireSessionLock).mockReturnValue(true);

    // Reset per-runtime resumeSession mocks
    vi.mocked(claudeRuntime.resumeSession).mockResolvedValue("Claude response");
    vi.mocked(openclawRuntime.resumeSession).mockResolvedValue("OpenClaw response");
    vi.mocked(piRuntime.resumeSession).mockResolvedValue("Pi response");
    vi.mocked(codexRuntime.resumeSession).mockResolvedValue("Codex response");
  });

  // ─── Per-agent dispatch ──────────────────────────────────────

  const agentCases = [
    { session: "session-claude", type: "claude", runtime: claudeRuntime, expected: "Claude response" },
    { session: "session-openclaw", type: "openclaw", runtime: openclawRuntime, expected: "OpenClaw response" },
    { session: "session-pi", type: "pi", runtime: piRuntime, expected: "Pi response" },
    { session: "session-codex", type: "codex", runtime: codexRuntime, expected: "Codex response" },
  ] as const;

  for (const { session, type, runtime, expected } of agentCases) {
    it(`dispatches ${type} session to ${type} runtime`, async () => {
      const res = await request(app)
        .post(`/api/sessions/${session}/run`)
        .send({ prompt: "test prompt" });

      expect(res.status).toBe(200);
      expect(res.body.output).toBe(expected);

      // Verify the correct factory was selected from the registry
      const factory = runtimeFactories.get(type)!;
      expect(factory).toHaveBeenCalled();

      // Verify the runtime's resumeSession was called (real runPrompt path)
      expect(runtime.resumeSession).toHaveBeenCalledWith(
        session,
        expect.stringContaining("test prompt"),
        expect.any(String),
        expect.any(Function),  // onPid callback from real runPrompt
      );
    });
  }

  // ─── Agent type resolution from DB ───────────────────────────

  it("resolves agent type from DB for each session", async () => {
    await request(app)
      .post("/api/sessions/session-openclaw/run")
      .send({ prompt: "hello" });

    expect(getSessionAgentType).toHaveBeenCalledWith("session-openclaw");
  });

  it("passes DB-sourced CWD to the runtime", async () => {
    await request(app)
      .post("/api/sessions/session-pi/run")
      .send({ prompt: "hello" });

    expect(getSessionCwdFromDb).toHaveBeenCalledWith("session-pi");
    expect(piRuntime.resumeSession).toHaveBeenCalledWith(
      "session-pi",
      expect.stringContaining("hello"),
      "/projects/pi-app",
      expect.any(Function),
    );
  });

  // ─── Fallback behavior ───────────────────────────────────────

  it("falls back to claude runtime when agent type is null", async () => {
    const res = await request(app)
      .post("/api/sessions/session-null/run")
      .send({ prompt: "test" });

    expect(res.status).toBe(200);
    expect(res.body.output).toBe("Claude response");

    const claudeFactory = runtimeFactories.get("claude")!;
    expect(claudeFactory).toHaveBeenCalled();
  });

  it("falls back to claude runtime when agent type is unregistered", async () => {
    const res = await request(app)
      .post("/api/sessions/session-unknown/run")
      .send({ prompt: "test" });

    expect(res.status).toBe(200);
    expect(res.body.output).toBe("Claude response");

    // unknown_type has no factory in the registry, so claude factory is used
    const claudeFactory = runtimeFactories.get("claude")!;
    expect(claudeFactory).toHaveBeenCalled();
  });

  // ─── Session lock integration ────────────────────────────────

  it("returns 409 when session lock cannot be acquired", async () => {
    vi.mocked(acquireSessionLock).mockReturnValue(false);

    const res = await request(app)
      .post("/api/sessions/session-claude/run")
      .send({ prompt: "test" });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("already running");
  });

  it("releases session lock after successful run", async () => {
    await request(app)
      .post("/api/sessions/session-claude/run")
      .send({ prompt: "test" });

    expect(acquireSessionLock).toHaveBeenCalledWith("session-claude");
    expect(releaseSessionLock).toHaveBeenCalledWith("session-claude");
  });

  it("releases session lock after failed run", async () => {
    vi.mocked(claudeRuntime.resumeSession).mockRejectedValueOnce(new Error("CLI crashed"));

    const res = await request(app)
      .post("/api/sessions/session-claude/run")
      .send({ prompt: "fail" });

    expect(res.status).toBe(500);
    expect(releaseSessionLock).toHaveBeenCalledWith("session-claude");
  });

  // ─── Post-run sync ──────────────────────────────────────────

  it("syncs session after successful run for each agent type", async () => {
    for (const { session } of agentCases) {
      vi.mocked(syncSession).mockClear();

      await request(app)
        .post(`/api/sessions/${session}/run`)
        .send({ prompt: "sync test" });

      expect(syncSession).toHaveBeenCalledWith(session);
    }
  });

  // ─── Registry edge cases ─────────────────────────────────────

  it("returns 500 when no runtimes are registered", async () => {
    vi.mocked(getRegisteredRuntimes).mockReturnValueOnce(new Map());

    const res = await request(app)
      .post("/api/sessions/session-claude/run")
      .send({ prompt: "test" });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("No agent runtime available");
  });

  // ─── End-to-end suggestion parsing through real runPrompt ────

  it("parses suggestions from runtime output through real runPrompt", async () => {
    vi.mocked(claudeRuntime.resumeSession).mockResolvedValueOnce(
      `Here is the answer.\n---SUGGESTIONS---\n[{"title":"Next","description":"Do next","prompt":"next step"}]`
    );

    const res = await request(app)
      .post("/api/sessions/session-claude/run")
      .send({ prompt: "analyze code" });

    expect(res.status).toBe(200);
    expect(res.body.output).toBe("Here is the answer.");
    expect(res.body.suggestions).toHaveLength(1);
    expect(res.body.suggestions[0].title).toBe("Next");
  });

  // ─── Multi-agent sequential flow ────────────────────────────

  it("dispatches correctly across sequential requests for different agents", async () => {
    const r1 = await request(app)
      .post("/api/sessions/session-claude/run")
      .send({ prompt: "from claude" });
    expect(r1.body.output).toBe("Claude response");

    const r2 = await request(app)
      .post("/api/sessions/session-openclaw/run")
      .send({ prompt: "from openclaw" });
    expect(r2.body.output).toBe("OpenClaw response");

    const r3 = await request(app)
      .post("/api/sessions/session-codex/run")
      .send({ prompt: "from codex" });
    expect(r3.body.output).toBe("Codex response");

    // Each runtime's resumeSession was called exactly once
    expect(claudeRuntime.resumeSession).toHaveBeenCalledTimes(1);
    expect(openclawRuntime.resumeSession).toHaveBeenCalledTimes(1);
    expect(codexRuntime.resumeSession).toHaveBeenCalledTimes(1);
    expect(piRuntime.resumeSession).not.toHaveBeenCalled();
  });
});
