import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ───────────────────────────────────────────────────

// Mock plan-db.js
vi.mock("../plan-db.js", () => ({
  getBlueprint: vi.fn(),
  getUnacknowledgedMessages: vi.fn(() => []),
  acknowledgeMessage: vi.fn(),
  createAutopilotMessage: vi.fn(),
}));

// Mock plan-executor.js
vi.mock("../plan-executor.js", () => ({
  enqueueBlueprintTask: vi.fn((_id: string, task: () => Promise<void>) => task()),
  addPendingTask: vi.fn(),
  removePendingTask: vi.fn(),
}));

// Mock agent-runtime.js
const mockRunSession = vi.fn(async (_prompt: string, _cwd?: string) => "session output");
vi.mock("../agent-runtime.js", () => ({
  getActiveRuntime: vi.fn(() => ({
    runSession: mockRunSession,
  })),
}));

// Mock plan-generator.js
vi.mock("../plan-generator.js", () => ({
  getApiBase: vi.fn(() => "http://localhost:3001"),
  getAuthParam: vi.fn(() => "auth=test-token"),
}));

// Mock autopilot.js (dynamic import)
vi.mock("../autopilot.js", () => ({
  triggerFsdLoopIfNeeded: vi.fn(),
}));

// Mock logger.js
vi.mock("../logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Side-effect import mocks
vi.mock("../agent-claude.js", () => ({}));
vi.mock("../agent-pimono.js", () => ({}));
vi.mock("../agent-openclaw.js", () => ({}));
vi.mock("../agent-codex.js", () => ({}));

// ─── Imports ─────────────────────────────────────────────────

import { buildUserAgentPrompt, handleUserMessage, triggerUserAgent } from "../user-agent.js";
import { getBlueprint, getUnacknowledgedMessages, acknowledgeMessage, createAutopilotMessage } from "../plan-db.js";
import { enqueueBlueprintTask, addPendingTask, removePendingTask } from "../plan-executor.js";
import type { AutopilotMessage, Blueprint } from "../plan-db.js";

// ─── Helpers ─────────────────────────────────────────────────

function makeBlueprint(overrides: Partial<Blueprint> = {}): Blueprint {
  return {
    id: "bp-1",
    title: "Test Blueprint",
    description: "A test blueprint",
    projectCwd: "/test/project",
    status: "approved",
    executionMode: "autopilot",
    nodes: [
      {
        id: "node-1",
        blueprintId: "bp-1",
        order: 0,
        seq: 1,
        title: "First Node",
        description: "First task",
        status: "pending",
        dependencies: [],
        roles: [],
        inputArtifacts: [],
        outputArtifacts: [],
        executions: [],
        createdAt: "2026-03-08T00:00:00Z",
        updatedAt: "2026-03-08T00:00:00Z",
      },
      {
        id: "node-2",
        blueprintId: "bp-1",
        order: 1,
        seq: 2,
        title: "Second Node",
        description: "Second task",
        status: "done",
        dependencies: ["node-1"],
        roles: [],
        inputArtifacts: [],
        outputArtifacts: [],
        executions: [],
        createdAt: "2026-03-08T00:00:00Z",
        updatedAt: "2026-03-08T00:00:00Z",
      },
    ],
    createdAt: "2026-03-08T00:00:00Z",
    updatedAt: "2026-03-08T00:00:00Z",
    ...overrides,
  };
}

function makeMessage(overrides: Partial<AutopilotMessage> = {}): AutopilotMessage {
  return {
    id: "msg-1",
    blueprintId: "bp-1",
    role: "user",
    content: "Please add a new node for testing",
    acknowledged: false,
    createdAt: "2026-03-08T00:00:00Z",
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────

describe("buildUserAgentPrompt", () => {
  beforeEach(() => vi.clearAllMocks());

  it("includes user message content", () => {
    vi.mocked(getBlueprint).mockReturnValue(makeBlueprint());
    const messages = [
      makeMessage({ content: "Please create a login page" }),
      makeMessage({ id: "msg-2", content: "And add tests for it" }),
    ];

    const prompt = buildUserAgentPrompt("bp-1", messages);

    expect(prompt).toContain("Please create a login page");
    expect(prompt).toContain("And add tests for it");
  });

  it("includes blueprint state (title, status, nodes)", () => {
    vi.mocked(getBlueprint).mockReturnValue(makeBlueprint());
    const messages = [makeMessage()];

    const prompt = buildUserAgentPrompt("bp-1", messages);

    expect(prompt).toContain("Test Blueprint");
    expect(prompt).toContain("Status: approved");
    expect(prompt).toContain("First Node");
    expect(prompt).toContain("Second Node");
    expect(prompt).toContain("(pending)");
    expect(prompt).toContain("(done)");
  });

  it("includes node seq numbers and dependency info", () => {
    vi.mocked(getBlueprint).mockReturnValue(makeBlueprint());
    const messages = [makeMessage()];

    const prompt = buildUserAgentPrompt("bp-1", messages);

    expect(prompt).toContain("[1] First Node");
    expect(prompt).toContain("[2] Second Node");
    expect(prompt).toContain("deps: node-1");
  });

  it("includes API base URL and auth param", () => {
    vi.mocked(getBlueprint).mockReturnValue(makeBlueprint());
    const messages = [makeMessage()];

    const prompt = buildUserAgentPrompt("bp-1", messages);

    expect(prompt).toContain("http://localhost:3001");
    expect(prompt).toContain("auth=test-token");
  });

  it("includes API endpoint documentation", () => {
    vi.mocked(getBlueprint).mockReturnValue(makeBlueprint());
    const messages = [makeMessage()];

    const prompt = buildUserAgentPrompt("bp-1", messages);

    // Node operations
    expect(prompt).toContain("POST /api/blueprints/bp-1/nodes");
    expect(prompt).toContain("POST /api/blueprints/bp-1/nodes/batch-create");
    expect(prompt).toContain("PUT /api/blueprints/bp-1/nodes/{nodeId}");
    expect(prompt).toContain("DELETE /api/blueprints/bp-1/nodes/{nodeId}");

    // AI operations
    expect(prompt).toContain("POST /api/blueprints/bp-1/enrich-node");
    expect(prompt).toContain("POST /api/blueprints/bp-1/reevaluate-all");

    // Execution control
    expect(prompt).toContain("POST /api/blueprints/bp-1/run-all");

    // Communication
    expect(prompt).toContain("POST /api/blueprints/bp-1/messages");
  });

  it("does NOT include FSD-specific tools", () => {
    vi.mocked(getBlueprint).mockReturnValue(makeBlueprint());
    const messages = [makeMessage()];

    const prompt = buildUserAgentPrompt("bp-1", messages);

    expect(prompt).not.toContain("run_node");
    expect(prompt).not.toContain("evaluate_node");
    expect(prompt).not.toContain("coordinate");
    expect(prompt).not.toContain("convene");
  });

  it("throws if blueprint not found", () => {
    vi.mocked(getBlueprint).mockReturnValue(undefined as unknown as ReturnType<typeof getBlueprint>);
    const messages = [makeMessage()];

    expect(() => buildUserAgentPrompt("nonexistent", messages)).toThrow(
      "Blueprint nonexistent not found",
    );
  });

  it("handles blueprint with no nodes", () => {
    vi.mocked(getBlueprint).mockReturnValue(makeBlueprint({ nodes: [] }));
    const messages = [makeMessage()];

    const prompt = buildUserAgentPrompt("bp-1", messages);

    expect(prompt).toContain("(no nodes yet)");
  });

  it("includes blueprint description and execution mode", () => {
    vi.mocked(getBlueprint).mockReturnValue(
      makeBlueprint({ description: "Build a REST API", executionMode: "fsd" }),
    );
    const messages = [makeMessage()];

    const prompt = buildUserAgentPrompt("bp-1", messages);

    expect(prompt).toContain("Build a REST API");
    expect(prompt).toContain("Execution Mode: fsd");
  });
});

// ─── handleUserMessage ───────────────────────────────────────

describe("handleUserMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunSession.mockResolvedValue("session output");
  });

  it("returns early when no unacknowledged messages (idempotent)", async () => {
    vi.mocked(getUnacknowledgedMessages).mockReturnValue([]);

    await handleUserMessage("bp-1");

    expect(mockRunSession).not.toHaveBeenCalled();
    expect(vi.mocked(acknowledgeMessage)).not.toHaveBeenCalled();
    expect(vi.mocked(addPendingTask)).not.toHaveBeenCalled();
  });

  it("returns early when blueprint not found", async () => {
    vi.mocked(getUnacknowledgedMessages).mockReturnValue([makeMessage()]);
    vi.mocked(getBlueprint).mockReturnValue(undefined as unknown as ReturnType<typeof getBlueprint>);

    await handleUserMessage("bp-1");

    expect(mockRunSession).not.toHaveBeenCalled();
    expect(vi.mocked(addPendingTask)).not.toHaveBeenCalled();
  });

  it("runs session and acknowledges messages on success", async () => {
    const msg1 = makeMessage({ id: "msg-1", content: "Do task A" });
    const msg2 = makeMessage({ id: "msg-2", content: "Do task B" });
    vi.mocked(getUnacknowledgedMessages).mockReturnValue([msg1, msg2]);
    vi.mocked(getBlueprint).mockReturnValue(makeBlueprint());

    await handleUserMessage("bp-1");

    // runSession called with prompt and projectCwd
    expect(mockRunSession).toHaveBeenCalledTimes(1);
    const [prompt, cwd] = mockRunSession.mock.calls[0];
    expect(prompt).toContain("Do task A");
    expect(prompt).toContain("Do task B");
    expect(cwd).toBe("/test/project");

    // Both messages acknowledged
    expect(vi.mocked(acknowledgeMessage)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(acknowledgeMessage)).toHaveBeenCalledWith("msg-1");
    expect(vi.mocked(acknowledgeMessage)).toHaveBeenCalledWith("msg-2");

    // Pending task lifecycle
    expect(vi.mocked(addPendingTask)).toHaveBeenCalledWith("bp-1", expect.objectContaining({ type: "autopilot" }));
    expect(vi.mocked(removePendingTask)).toHaveBeenCalledWith("bp-1", undefined, "autopilot");
  });

  it("does not acknowledge on runSession failure, creates error message", async () => {
    vi.mocked(getUnacknowledgedMessages).mockReturnValue([makeMessage()]);
    vi.mocked(getBlueprint).mockReturnValue(makeBlueprint());
    mockRunSession.mockRejectedValue(new Error("CLI crashed"));

    await handleUserMessage("bp-1");

    // Messages NOT acknowledged
    expect(vi.mocked(acknowledgeMessage)).not.toHaveBeenCalled();

    // Error message created
    expect(vi.mocked(createAutopilotMessage)).toHaveBeenCalledWith(
      "bp-1",
      "assistant",
      "Failed to process your message. Please try again or switch to manual mode.",
    );

    // removePendingTask still called (finally block)
    expect(vi.mocked(removePendingTask)).toHaveBeenCalledWith("bp-1", undefined, "autopilot");
  });

  it("calls triggerFsdLoopIfNeeded after completion", async () => {
    vi.mocked(getUnacknowledgedMessages).mockReturnValue([makeMessage()]);
    vi.mocked(getBlueprint).mockReturnValue(makeBlueprint());

    await handleUserMessage("bp-1");

    const { triggerFsdLoopIfNeeded } = await import("../autopilot.js");
    expect(vi.mocked(triggerFsdLoopIfNeeded)).toHaveBeenCalledWith("bp-1");
  });

  it("calls triggerFsdLoopIfNeeded even after failure", async () => {
    vi.mocked(getUnacknowledgedMessages).mockReturnValue([makeMessage()]);
    vi.mocked(getBlueprint).mockReturnValue(makeBlueprint());
    mockRunSession.mockRejectedValue(new Error("Session error"));

    await handleUserMessage("bp-1");

    const { triggerFsdLoopIfNeeded } = await import("../autopilot.js");
    expect(vi.mocked(triggerFsdLoopIfNeeded)).toHaveBeenCalledWith("bp-1");
  });

  it("addPendingTask is called before runSession", async () => {
    vi.mocked(getUnacknowledgedMessages).mockReturnValue([makeMessage()]);
    vi.mocked(getBlueprint).mockReturnValue(makeBlueprint());

    const callOrder: string[] = [];
    vi.mocked(addPendingTask).mockImplementation(() => {
      callOrder.push("addPendingTask");
    });
    mockRunSession.mockImplementation(async () => {
      callOrder.push("runSession");
      return "output";
    });

    await handleUserMessage("bp-1");

    expect(callOrder.indexOf("addPendingTask")).toBeLessThan(
      callOrder.indexOf("runSession"),
    );
  });
});

// ─── triggerUserAgent ────────────────────────────────────────

describe("triggerUserAgent", () => {
  beforeEach(() => vi.clearAllMocks());

  it("enqueues task in autopilot mode", () => {
    vi.mocked(getBlueprint).mockReturnValue(makeBlueprint({ executionMode: "autopilot" }));

    triggerUserAgent("bp-1");

    expect(vi.mocked(enqueueBlueprintTask)).toHaveBeenCalledWith(
      "bp-1",
      expect.any(Function),
    );
  });

  it("enqueues task in FSD mode", () => {
    vi.mocked(getBlueprint).mockReturnValue(makeBlueprint({ executionMode: "fsd" }));

    triggerUserAgent("bp-1");

    expect(vi.mocked(enqueueBlueprintTask)).toHaveBeenCalledWith(
      "bp-1",
      expect.any(Function),
    );
  });

  it("returns early in manual mode", () => {
    vi.mocked(getBlueprint).mockReturnValue(makeBlueprint({ executionMode: "manual" }));

    triggerUserAgent("bp-1");

    expect(vi.mocked(enqueueBlueprintTask)).not.toHaveBeenCalled();
  });

  it("returns early if blueprint not found", () => {
    vi.mocked(getBlueprint).mockReturnValue(undefined as unknown as ReturnType<typeof getBlueprint>);

    triggerUserAgent("nonexistent");

    expect(vi.mocked(enqueueBlueprintTask)).not.toHaveBeenCalled();
  });

  it("returns early if executionMode is undefined (defaults to non-autopilot)", () => {
    vi.mocked(getBlueprint).mockReturnValue(makeBlueprint({ executionMode: undefined }));

    triggerUserAgent("bp-1");

    expect(vi.mocked(enqueueBlueprintTask)).not.toHaveBeenCalled();
  });
});
