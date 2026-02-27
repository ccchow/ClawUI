import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getProjects,
  getSessions,
  getTimeline,
  runPrompt,
  updateSessionMeta,
  updateNodeMeta,
  getTags,
  getAppState,
  updateAppState,
  listBlueprints,
  getBlueprint,
  createBlueprint,
  updateBlueprint,
  deleteBlueprint,
  createMacroNode,
  updateMacroNode,
  deleteMacroNode,
  runNode,
  getQueueStatus,
  getSessionMeta,
  getSessionExecution,
  archiveBlueprint,
  unarchiveBlueprint,
  approveBlueprint,
  enrichNode,
  generatePlan,
  runAllNodes,
  runNextNode,
  getNodeExecutions,
  getRelatedSessions,
  resumeNodeSession,
  recoverNodeSession,
  splitNode,
  unqueueNode,
  getGlobalStatus,
  getDevStatus,
  redeployStable,
  getSessionHealth,
  uploadImage,
  smartPickDependencies,
  reevaluateNode,
  reevaluateAllNodes,
  getLastSessionMessage,
} from "./api";

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => key === "clawui_token" ? "test-token-123" : null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockJsonResponse(data: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  });
}

describe("api - session endpoints", () => {
  it("getProjects fetches projects list", async () => {
    const projects = [{ id: "p1", name: "Project 1", path: "/tmp/p1", sessionCount: 3 }];
    mockFetch.mockReturnValueOnce(mockJsonResponse(projects));
    const result = await getProjects();
    expect(result).toEqual(projects);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/projects"),
      expect.objectContaining({ headers: expect.objectContaining({ "x-clawui-token": "test-token-123" }) }),
    );
  });

  it("getSessions fetches sessions for a project", async () => {
    const sessions = [
      { sessionId: "s1", projectId: "p1", projectName: "Test", timestamp: "2025-01-01", nodeCount: 5 },
    ];
    mockFetch.mockReturnValueOnce(mockJsonResponse(sessions));
    const result = await getSessions("p1");
    expect(result).toEqual(sessions);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/projects/p1/sessions"),
      expect.objectContaining({ headers: expect.objectContaining({ "x-clawui-token": "test-token-123" }) }),
    );
  });

  it("getSessions includes filter params", async () => {
    mockFetch.mockReturnValueOnce(mockJsonResponse([]));
    await getSessions("p1", { starred: true, tag: "bug" });
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("starred=true");
    expect(url).toContain("tag=bug");
  });

  it("getTimeline fetches timeline nodes", async () => {
    const nodes = [{ id: "n1", type: "user", content: "hello" }];
    mockFetch.mockReturnValueOnce(mockJsonResponse(nodes));
    const result = await getTimeline("s1");
    expect(result).toEqual(nodes);
  });

  it("runPrompt sends POST with prompt", async () => {
    const runResult = { output: "done", suggestions: [] };
    mockFetch.mockReturnValueOnce(mockJsonResponse(runResult));
    const result = await runPrompt("s1", "fix the bug");
    expect(result).toEqual(runResult);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/sessions/s1/run"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ prompt: "fix the bug" }),
      }),
    );
  });

  it("throws on non-ok response", async () => {
    mockFetch.mockReturnValueOnce(
      Promise.resolve({
        ok: false,
        status: 404,
        text: () => Promise.resolve("Not found"),
      }),
    );
    await expect(getProjects()).rejects.toThrow("API error 404");
  });
});

describe("api - enrichment endpoints", () => {
  it("updateSessionMeta sends PATCH", async () => {
    mockFetch.mockReturnValueOnce(mockJsonResponse(undefined));
    await updateSessionMeta("s1", { starred: true });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/sessions/s1/meta"),
      expect.objectContaining({ method: "PATCH" }),
    );
  });

  it("updateNodeMeta sends PATCH", async () => {
    mockFetch.mockReturnValueOnce(mockJsonResponse(undefined));
    await updateNodeMeta("n1", { bookmarked: true });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/nodes/n1/meta"),
      expect.objectContaining({ method: "PATCH" }),
    );
  });

  it("getTags fetches tags", async () => {
    mockFetch.mockReturnValueOnce(mockJsonResponse(["bug", "feature"]));
    const result = await getTags();
    expect(result).toEqual(["bug", "feature"]);
  });
});

describe("api - app state endpoints", () => {
  it("getAppState fetches state", async () => {
    mockFetch.mockReturnValueOnce(mockJsonResponse({ theme: "dark" }));
    const result = await getAppState();
    expect(result).toEqual({ theme: "dark" });
  });

  it("updateAppState sends PUT", async () => {
    mockFetch.mockReturnValueOnce(mockJsonResponse(undefined));
    await updateAppState({ theme: "light" });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/state"),
      expect.objectContaining({ method: "PUT" }),
    );
  });
});

describe("api - blueprint endpoints", () => {
  it("listBlueprints fetches with optional filters", async () => {
    mockFetch.mockReturnValueOnce(mockJsonResponse([]));
    await listBlueprints({ status: "draft" });
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("status=draft");
  });

  it("getBlueprint fetches single blueprint", async () => {
    const bp = { id: "bp1", title: "Plan", nodes: [] };
    mockFetch.mockReturnValueOnce(mockJsonResponse(bp));
    const result = await getBlueprint("bp1");
    expect(result).toEqual(bp);
  });

  it("createBlueprint sends POST", async () => {
    const bp = { id: "bp1", title: "New Plan", nodes: [] };
    mockFetch.mockReturnValueOnce(mockJsonResponse(bp));
    const result = await createBlueprint({ title: "New Plan" });
    expect(result).toEqual(bp);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/blueprints"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("updateBlueprint sends PUT", async () => {
    mockFetch.mockReturnValueOnce(mockJsonResponse({ id: "bp1", title: "Updated" }));
    await updateBlueprint("bp1", { title: "Updated" });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/blueprints/bp1"),
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("deleteBlueprint sends DELETE", async () => {
    mockFetch.mockReturnValueOnce(mockJsonResponse({ ok: true }));
    await deleteBlueprint("bp1");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/blueprints/bp1"),
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("createMacroNode sends POST to nodes endpoint", async () => {
    const node = { id: "n1", title: "Step 1" };
    mockFetch.mockReturnValueOnce(mockJsonResponse(node));
    await createMacroNode("bp1", { title: "Step 1" });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/blueprints/bp1/nodes"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("updateMacroNode sends PUT", async () => {
    mockFetch.mockReturnValueOnce(mockJsonResponse({ id: "n1" }));
    await updateMacroNode("bp1", "n1", { title: "Updated" });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/blueprints/bp1/nodes/n1"),
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("deleteMacroNode sends DELETE", async () => {
    mockFetch.mockReturnValueOnce(mockJsonResponse({ ok: true }));
    await deleteMacroNode("bp1", "n1");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/blueprints/bp1/nodes/n1"),
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("runNode sends POST to run endpoint", async () => {
    mockFetch.mockReturnValueOnce(mockJsonResponse({ id: "e1", status: "running" }));
    await runNode("bp1", "n1");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/blueprints/bp1/nodes/n1/run"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("getQueueStatus fetches queue info", async () => {
    const queue = { running: false, queueLength: 0, pendingTasks: [] };
    mockFetch.mockReturnValueOnce(mockJsonResponse(queue));
    const result = await getQueueStatus("bp1");
    expect(result).toEqual(queue);
  });
});

describe("api - session meta and health endpoints", () => {
  it("getSessionMeta returns session metadata on success", async () => {
    const meta = { starred: true, tags: ["bug"] };
    mockFetch.mockReturnValueOnce(
      Promise.resolve({ ok: true, json: () => Promise.resolve(meta) }),
    );
    const result = await getSessionMeta("s1");
    expect(result).toEqual(meta);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/sessions/s1/meta"),
      expect.objectContaining({ headers: expect.objectContaining({ "x-clawui-token": "test-token-123" }) }),
    );
  });

  it("getSessionMeta returns null on non-ok response", async () => {
    mockFetch.mockReturnValueOnce(
      Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve(null) }),
    );
    const result = await getSessionMeta("s1");
    expect(result).toBeNull();
  });

  it("getSessionMeta returns null on fetch error", async () => {
    mockFetch.mockReturnValueOnce(Promise.reject(new Error("Network error")));
    const result = await getSessionMeta("s1");
    expect(result).toBeNull();
  });

  it("getLastSessionMessage fetches last message for a session", async () => {
    const lastMsg = { id: "n1", type: "assistant", content: "Done" };
    mockFetch.mockReturnValueOnce(mockJsonResponse(lastMsg));
    const result = await getLastSessionMessage("s1");
    expect(result).toEqual(lastMsg);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/sessions/s1/last-message"),
      expect.any(Object),
    );
  });

  it("getSessionHealth fetches session health info", async () => {
    const health = { failureReason: null, detail: "", compactCount: 0, peakTokens: 50000, lastApiError: null, messageCount: 10 };
    mockFetch.mockReturnValueOnce(mockJsonResponse(health));
    const result = await getSessionHealth("s1");
    expect(result).toEqual(health);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/sessions/s1/health"),
      expect.any(Object),
    );
  });
});

describe("api - execution endpoints", () => {
  it("getSessionExecution returns execution on success", async () => {
    const exec = { id: "e1", nodeId: "n1", status: "running" };
    mockFetch.mockReturnValueOnce(
      Promise.resolve({ ok: true, json: () => Promise.resolve(exec) }),
    );
    const result = await getSessionExecution("s1");
    expect(result).toEqual(exec);
  });

  it("getSessionExecution returns null on non-ok response", async () => {
    mockFetch.mockReturnValueOnce(
      Promise.resolve({ ok: false, status: 404 }),
    );
    const result = await getSessionExecution("s1");
    expect(result).toBeNull();
  });

  it("getSessionExecution returns null on fetch error", async () => {
    mockFetch.mockReturnValueOnce(Promise.reject(new Error("Network error")));
    const result = await getSessionExecution("s1");
    expect(result).toBeNull();
  });

  it("getNodeExecutions fetches executions for a node", async () => {
    const executions = [
      { id: "e1", nodeId: "n1", status: "done" },
      { id: "e2", nodeId: "n1", status: "failed" },
    ];
    mockFetch.mockReturnValueOnce(mockJsonResponse(executions));
    const result = await getNodeExecutions("bp1", "n1");
    expect(result).toEqual(executions);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/blueprints/bp1/nodes/n1/executions"),
      expect.any(Object),
    );
  });

  it("runNextNode sends POST to run endpoint", async () => {
    const exec = { id: "e1", status: "running" };
    mockFetch.mockReturnValueOnce(mockJsonResponse(exec));
    const result = await runNextNode("bp1");
    expect(result).toEqual(exec);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/blueprints/bp1/run"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("runAllNodes sends POST to run-all endpoint", async () => {
    const response = { message: "Started", blueprintId: "bp1" };
    mockFetch.mockReturnValueOnce(mockJsonResponse(response));
    const result = await runAllNodes("bp1");
    expect(result).toEqual(response);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/blueprints/bp1/run-all"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("resumeNodeSession sends POST with executionId", async () => {
    mockFetch.mockReturnValueOnce(mockJsonResponse({ status: "queued" }));
    await resumeNodeSession("bp1", "n1", "e1");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/blueprints/bp1/nodes/n1/resume-session"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ executionId: "e1" }),
      }),
    );
  });

  it("recoverNodeSession sends POST to recover-session endpoint", async () => {
    mockFetch.mockReturnValueOnce(mockJsonResponse({ recovered: true, recoveredCount: 1 }));
    const result = await recoverNodeSession("bp1", "n1");
    expect(result).toEqual({ recovered: true, recoveredCount: 1 });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/blueprints/bp1/nodes/n1/recover-session"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("unqueueNode sends POST to unqueue endpoint", async () => {
    mockFetch.mockReturnValueOnce(mockJsonResponse({ status: "pending" }));
    const result = await unqueueNode("bp1", "n1");
    expect(result).toEqual({ status: "pending" });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/blueprints/bp1/nodes/n1/unqueue"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("splitNode sends POST to split endpoint", async () => {
    mockFetch.mockReturnValueOnce(mockJsonResponse({ status: "queued", nodeId: "n1" }));
    const result = await splitNode("bp1", "n1");
    expect(result).toEqual({ status: "queued", nodeId: "n1" });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/blueprints/bp1/nodes/n1/split"),
      expect.objectContaining({ method: "POST" }),
    );
  });
});

describe("api - blueprint lifecycle endpoints", () => {
  it("archiveBlueprint sends POST to archive endpoint", async () => {
    const bp = { id: "bp1", status: "done", archivedAt: "2025-01-01" };
    mockFetch.mockReturnValueOnce(mockJsonResponse(bp));
    const result = await archiveBlueprint("bp1");
    expect(result).toEqual(bp);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/blueprints/bp1/archive"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("unarchiveBlueprint sends POST to unarchive endpoint", async () => {
    const bp = { id: "bp1", status: "done", archivedAt: undefined };
    mockFetch.mockReturnValueOnce(mockJsonResponse(bp));
    const result = await unarchiveBlueprint("bp1");
    expect(result).toEqual(bp);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/blueprints/bp1/unarchive"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("approveBlueprint sends POST to approve endpoint", async () => {
    const bp = { id: "bp1", status: "approved" };
    mockFetch.mockReturnValueOnce(mockJsonResponse(bp));
    const result = await approveBlueprint("bp1");
    expect(result).toEqual(bp);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/blueprints/bp1/approve"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("listBlueprints includes includeArchived filter", async () => {
    mockFetch.mockReturnValueOnce(mockJsonResponse([]));
    await listBlueprints({ includeArchived: true });
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("includeArchived=true");
  });

  it("listBlueprints includes projectCwd filter", async () => {
    mockFetch.mockReturnValueOnce(mockJsonResponse([]));
    await listBlueprints({ projectCwd: "/home/user/project" });
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("projectCwd=%2Fhome%2Fuser%2Fproject");
  });

  it("listBlueprints with no filters omits query string", async () => {
    mockFetch.mockReturnValueOnce(mockJsonResponse([]));
    await listBlueprints();
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toBe("/api/blueprints");
  });
});

describe("api - AI generation endpoints", () => {
  it("enrichNode sends POST with title and description", async () => {
    const enriched = { title: "Better Title", description: "Better desc" };
    mockFetch.mockReturnValueOnce(mockJsonResponse(enriched));
    const result = await enrichNode("bp1", { title: "Test", nodeId: "n1" });
    expect(result).toEqual(enriched);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/blueprints/bp1/enrich-node"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ title: "Test", nodeId: "n1" }),
      }),
    );
  });

  it("generatePlan sends POST with optional description", async () => {
    mockFetch.mockReturnValueOnce(mockJsonResponse({ status: "queued", blueprintId: "bp1" }));
    const result = await generatePlan("bp1", "Build a web app");
    expect(result).toEqual({ status: "queued", blueprintId: "bp1" });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/blueprints/bp1/generate"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ description: "Build a web app" }),
      }),
    );
  });

  it("reevaluateNode sends POST to reevaluate endpoint", async () => {
    mockFetch.mockReturnValueOnce(mockJsonResponse({ status: "queued", nodeId: "n1" }));
    const result = await reevaluateNode("bp1", "n1");
    expect(result).toEqual({ status: "queued", nodeId: "n1" });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/blueprints/bp1/nodes/n1/reevaluate"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("reevaluateAllNodes sends POST to reevaluate-all endpoint", async () => {
    mockFetch.mockReturnValueOnce(mockJsonResponse({ message: "Started", blueprintId: "bp1", nodeCount: 5 }));
    const result = await reevaluateAllNodes("bp1");
    expect(result).toEqual({ message: "Started", blueprintId: "bp1", nodeCount: 5 });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/blueprints/bp1/reevaluate-all"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("smartPickDependencies sends POST to smart-dependencies endpoint", async () => {
    mockFetch.mockReturnValueOnce(mockJsonResponse({ status: "queued", nodeId: "n1" }));
    const result = await smartPickDependencies("bp1", "n1");
    expect(result).toEqual({ status: "queued", nodeId: "n1" });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/blueprints/bp1/nodes/n1/smart-dependencies"),
      expect.objectContaining({ method: "POST" }),
    );
  });
});

describe("api - related sessions", () => {
  it("getRelatedSessions fetches related sessions for a node", async () => {
    const sessions = [
      { id: "rs1", nodeId: "n1", blueprintId: "bp1", sessionId: "s1", type: "enrich", startedAt: "2025-01-01" },
    ];
    mockFetch.mockReturnValueOnce(mockJsonResponse(sessions));
    const result = await getRelatedSessions("bp1", "n1");
    expect(result).toEqual(sessions);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/blueprints/bp1/nodes/n1/related-sessions"),
      expect.any(Object),
    );
  });
});

describe("api - global status and dev endpoints", () => {
  it("getGlobalStatus fetches global queue info", async () => {
    const status = { active: true, totalPending: 3, tasks: [] };
    mockFetch.mockReturnValueOnce(mockJsonResponse(status));
    const result = await getGlobalStatus();
    expect(result).toEqual(status);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/global-status"),
      expect.any(Object),
    );
  });

  it("getDevStatus fetches dev mode status", async () => {
    mockFetch.mockReturnValueOnce(mockJsonResponse({ devMode: true }));
    const result = await getDevStatus();
    expect(result).toEqual({ devMode: true });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/dev/status"),
      expect.any(Object),
    );
  });

  it("redeployStable sends POST to redeploy endpoint", async () => {
    mockFetch.mockReturnValueOnce(mockJsonResponse({ ok: true, message: "Deployed" }));
    const result = await redeployStable();
    expect(result).toEqual({ ok: true, message: "Deployed" });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/dev/redeploy"),
      expect.objectContaining({ method: "POST" }),
    );
  });
});

describe("api - upload endpoint", () => {
  it("uploadImage sends POST with data URL and filename", async () => {
    mockFetch.mockReturnValueOnce(mockJsonResponse({ url: "/uploads/img.png" }));
    const result = await uploadImage("data:image/png;base64,abc123", "screenshot.png");
    expect(result).toEqual({ url: "/uploads/img.png" });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/uploads"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ data: "data:image/png;base64,abc123", filename: "screenshot.png" }),
      }),
    );
  });
});

describe("api - error handling edge cases", () => {
  it("includes error body text in thrown error", async () => {
    mockFetch.mockReturnValueOnce(
      Promise.resolve({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal Server Error: DB locked"),
      }),
    );
    await expect(getProjects()).rejects.toThrow("API error 500: Internal Server Error: DB locked");
  });

  it("sends auth token in header for all fetchJSON calls", async () => {
    mockFetch.mockReturnValueOnce(mockJsonResponse([]));
    await getProjects();
    const headers = mockFetch.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers["x-clawui-token"]).toBe("test-token-123");
  });

  it("sends empty headers when no token in localStorage", async () => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    mockFetch.mockReturnValueOnce(mockJsonResponse([]));
    await getProjects();
    const headers = mockFetch.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers["x-clawui-token"]).toBeUndefined();
  });

  it("encodes special characters in blueprint IDs", async () => {
    mockFetch.mockReturnValueOnce(mockJsonResponse({ id: "bp with spaces" }));
    await getBlueprint("bp with spaces");
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("bp%20with%20spaces");
  });

  it("getSessions includes archived filter param", async () => {
    mockFetch.mockReturnValueOnce(mockJsonResponse([]));
    await getSessions("p1", { archived: true });
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("archived=true");
  });

  it("getSessions omits empty filter params", async () => {
    mockFetch.mockReturnValueOnce(mockJsonResponse([]));
    await getSessions("p1", {});
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).not.toContain("?");
  });
});
