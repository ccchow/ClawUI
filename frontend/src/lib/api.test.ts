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
