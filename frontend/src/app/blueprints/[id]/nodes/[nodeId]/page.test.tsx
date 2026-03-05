import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, waitFor, act } from "@testing-library/react";
import NodeDetailPage from "./page";
import { makeMockBlueprint, makeMockNode, makeMockExecution, renderWithProviders } from "@/test-utils";
import type { Blueprint, MacroNode, NodeExecution, QueueInfo } from "@/lib/api";

// --- vi.hoisted mocks ---

const routerPush = vi.fn();

const apiMocks = vi.hoisted(() => ({
  getBlueprint: vi.fn((): Promise<Blueprint> => Promise.resolve({} as Blueprint)),
  getNodeExecutions: vi.fn((): Promise<NodeExecution[]> => Promise.resolve([])),
  getQueueStatus: vi.fn((): Promise<QueueInfo> => Promise.resolve({ running: false, queueLength: 0, pendingTasks: [] })),
  getLastSessionMessage: vi.fn(() => Promise.resolve(null)),
  getRelatedSessions: vi.fn(() => Promise.resolve([])),
  getActiveRelatedSession: vi.fn(() => Promise.resolve(null)),
  getSuggestionsForNode: vi.fn(() => Promise.resolve([])),
  runNode: vi.fn(() => Promise.resolve({ status: "queued", nodeId: "n-1" })),
  updateMacroNode: vi.fn((): Promise<MacroNode> => Promise.resolve({} as MacroNode)),
  deleteMacroNode: vi.fn(() => Promise.resolve({ ok: true })),
  enrichNode: vi.fn(() => Promise.resolve({ status: "queued", nodeId: "n-1" })),
  reevaluateNode: vi.fn(() => Promise.resolve({ status: "queued", nodeId: "n-1" })),
  recoverNodeSession: vi.fn(() => Promise.resolve({ recovered: false })),
  resumeNodeSession: vi.fn(() => Promise.resolve({ status: "queued" })),
  unqueueNode: vi.fn(() => Promise.resolve({ status: "ok" })),
  splitNode: vi.fn(() => Promise.resolve({ status: "queued", nodeId: "n-1" })),
  smartPickDependencies: vi.fn(() => Promise.resolve({ status: "queued", nodeId: "n-1" })),
  createMacroNode: vi.fn(() => Promise.resolve(makeMockNode())),
  markSuggestionUsed: vi.fn(() => Promise.resolve({ id: "s1", nodeId: "n-1", blueprintId: "bp-1", title: "", description: "", used: true, createdAt: "" })),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<object>("@/lib/api");
  return { ...actual, ...apiMocks };
});

vi.mock("next/navigation", () => ({
  useParams: vi.fn(() => ({ id: "bp-1", nodeId: "n-1" })),
  useRouter: vi.fn(() => ({ push: routerPush, back: vi.fn() })),
  usePathname: vi.fn(() => "/blueprints/bp-1/nodes/n-1"),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>{children}</a>
  ),
}));

vi.mock("@/components/StatusIndicator", () => ({
  StatusIndicator: ({ status }: { status: string }) => <span data-testid="status-indicator">{status}</span>,
}));

vi.mock("@/components/MarkdownContent", () => ({
  MarkdownContent: ({ content }: { content: string }) => <div data-testid="markdown-content">{content}</div>,
}));

vi.mock("@/components/MarkdownEditor", () => ({
  MarkdownEditor: ({ value, onChange, actions }: { value: string; onChange: (v: string) => void; actions?: React.ReactNode }) => (
    <div data-testid="markdown-editor">
      <textarea data-testid="md-textarea" value={value} onChange={(e) => onChange(e.target.value)} />
      {actions}
    </div>
  ),
}));

vi.mock("@/components/AISparkle", () => ({
  AISparkle: () => <span data-testid="ai-sparkle" />,
}));

vi.mock("@/components/SkeletonLoader", () => ({
  SkeletonLoader: () => <div data-testid="skeleton-loader" />,
}));

vi.mock("@/components/AgentSelector", () => ({
  AgentBadge: ({ agentType }: { agentType: string }) => <span data-testid="agent-badge">{agentType}</span>,
}));

vi.mock("@/components/RoleBadge", () => ({
  RoleBadge: ({ roleId }: { roleId: string }) => <span data-testid="role-badge">{roleId}</span>,
}));

vi.mock("@/components/RoleSelector", () => ({
  RoleSelector: ({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) => (
    <div data-testid="role-selector">
      <button onClick={() => onChange(["sde", "qa"])} data-testid="role-select-trigger">Select Roles</button>
      <span>{value.join(",")}</span>
    </div>
  ),
}));

vi.mock("@/lib/useBlueprintBroadcast", () => ({
  useBlueprintBroadcast: (_id: string, _cb: () => void) => vi.fn(),
}));

// --- Helpers ---

function renderPage() {
  return renderWithProviders(<NodeDetailPage />);
}

function setupNodeData(nodeOverrides: Partial<MacroNode> = {}, executions: NodeExecution[] = []) {
  const targetNode = makeMockNode({
    id: "n-1",
    seq: 1,
    title: "Setup database",
    description: "Create the DB schema",
    status: "pending",
    order: 0,
    ...nodeOverrides,
  });
  const otherNode = makeMockNode({
    id: "n-2",
    seq: 2,
    title: "Build API",
    status: "pending",
    order: 1,
    dependencies: ["n-1"],
  });
  const bp = makeMockBlueprint({
    id: "bp-1",
    title: "Test BP",
    status: "approved",
    nodes: [targetNode, otherNode],
  });
  apiMocks.getBlueprint.mockResolvedValue(bp);
  apiMocks.getNodeExecutions.mockResolvedValue(executions);
  return { bp, targetNode, otherNode };
}

// --- Tests ---

describe("NodeDetailPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("sessionStorage", { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() });
    apiMocks.getQueueStatus.mockResolvedValue({ running: false, queueLength: 0, pendingTasks: [] });
    apiMocks.getRelatedSessions.mockResolvedValue([]);
    apiMocks.getActiveRelatedSession.mockResolvedValue(null);
    apiMocks.getSuggestionsForNode.mockResolvedValue([]);
    apiMocks.getLastSessionMessage.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders node title", async () => {
    setupNodeData();

    renderPage();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Setup database" })).toBeInTheDocument();
    });
  });

  it("renders node description via MarkdownContent", async () => {
    setupNodeData();

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Create the DB schema")).toBeInTheDocument();
    });
  });

  it("renders node status badge", async () => {
    setupNodeData({ status: "pending" });

    renderPage();

    await waitFor(() => {
      const indicators = screen.getAllByTestId("status-indicator");
      expect(indicators.some((el) => el.textContent === "pending")).toBe(true);
    });
  });

  it("renders execution history when executions exist", async () => {
    setupNodeData(
      { status: "done" },
      [makeMockExecution({ id: "exec-1", status: "done", startedAt: "2025-01-01T00:00:00Z", completedAt: "2025-01-01T00:05:00Z" })],
    );

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Execution History")).toBeInTheDocument();
    });
  });

  it("calls runNode when Run button is clicked on pending node", async () => {
    setupNodeData({ status: "pending" });

    renderPage();

    await waitFor(() => {
      expect(screen.getAllByText("Setup database").length).toBeGreaterThan(0);
    });

    // Run button has text "► Run" (HTML entity &#9654;)
    const runBtn = screen.getByText(/Run$/);
    fireEvent.click(runBtn);

    await waitFor(() => {
      expect(apiMocks.runNode).toHaveBeenCalledWith("bp-1", "n-1");
    });
  });

  it("calls runNode (Retry) on failed node", async () => {
    setupNodeData({ status: "failed" });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Retry")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Retry"));

    await waitFor(() => {
      expect(apiMocks.runNode).toHaveBeenCalledWith("bp-1", "n-1");
    });
  });

  it("calls resumeNodeSession when resume button is clicked", async () => {
    const exec = makeMockExecution({ id: "exec-fail", status: "failed", sessionId: "sess-1" });
    setupNodeData({ status: "failed" }, [exec]);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Execution History")).toBeInTheDocument();
    });

    // The resume button is in the execution row
    const resumeBtn = screen.getByTitle(/Resume this failed session/);
    fireEvent.click(resumeBtn);

    await waitFor(() => {
      expect(apiMocks.resumeNodeSession).toHaveBeenCalledWith("bp-1", "n-1", "exec-fail");
    });
  });

  it("shows Split confirmation and calls splitNode", async () => {
    setupNodeData({ status: "pending" });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Split")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Split"));

    await waitFor(() => {
      expect(screen.getByText(/Split into sub-tasks/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Yes, Split"));

    await waitFor(() => {
      expect(apiMocks.splitNode).toHaveBeenCalledWith("bp-1", "n-1");
    });
  });

  it("calls smartPickDependencies when AI-pick button is clicked", async () => {
    setupNodeData({ status: "pending" });

    renderPage();

    await waitFor(() => {
      expect(screen.getAllByText("Setup database").length).toBeGreaterThan(0);
    });

    // Smart deps button is next to the Dependencies toggle, no need to expand
    const smartDepsBtn = screen.getByLabelText("AI-pick dependencies");
    fireEvent.click(smartDepsBtn);

    await waitFor(() => {
      expect(apiMocks.smartPickDependencies).toHaveBeenCalledWith("bp-1", "n-1");
    });
  });

  it("handles enrich in edit mode", async () => {
    setupNodeData({ status: "pending" });

    renderPage();

    await waitFor(() => {
      expect(screen.getAllByText("Setup database").length).toBeGreaterThan(0);
    });

    // Enter edit mode
    fireEvent.click(screen.getByLabelText("Edit node"));

    // Wait for edit mode to render, then click Smart Enrich button
    await waitFor(() => {
      expect(screen.getByTitle(/AI enhances the title/)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTitle(/AI enhances the title/));

    await waitFor(() => {
      expect(apiMocks.enrichNode).toHaveBeenCalledWith("bp-1", expect.objectContaining({
        title: "Setup database",
        nodeId: "n-1",
      }));
    });
  });

  it("handles reevaluate button click", async () => {
    setupNodeData({ status: "pending" });

    renderPage();

    // Re-evaluate button is in the non-editing description view
    await waitFor(() => {
      expect(screen.getByTitle(/AI reads your codebase and updates/)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTitle(/AI reads your codebase and updates/));

    await waitFor(() => {
      expect(apiMocks.reevaluateNode).toHaveBeenCalledWith("bp-1", "n-1");
    });
  });

  it("shows RoleSelector in the page", async () => {
    setupNodeData({ status: "pending" });

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId("role-selector")).toBeInTheDocument();
    });
  });

  it("shows loading skeleton initially", () => {
    apiMocks.getBlueprint.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getByTestId("skeleton-loader")).toBeInTheDocument();
  });

  it("shows error state when load fails", async () => {
    apiMocks.getBlueprint.mockRejectedValue(new Error("Not found"));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/Failed to load node/)).toBeInTheDocument();
    });
  });

  it("shows node not found when node ID doesn't exist in blueprint", async () => {
    const bp = makeMockBlueprint({
      id: "bp-1",
      nodes: [makeMockNode({ id: "n-99", seq: 99 })],
    });
    apiMocks.getBlueprint.mockResolvedValue(bp);
    apiMocks.getNodeExecutions.mockResolvedValue([]);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Node not found")).toBeInTheDocument();
    });
  });

  it("shows Delete confirmation and calls deleteMacroNode", async () => {
    setupNodeData({ status: "pending" });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Delete")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Delete"));

    await waitFor(() => {
      expect(screen.getByText("Confirm Delete")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Confirm Delete"));

    await waitFor(() => {
      expect(apiMocks.deleteMacroNode).toHaveBeenCalledWith("bp-1", "n-1");
    });
  });

  it("shows Skip button for pending nodes", async () => {
    setupNodeData({ status: "pending" });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Skip")).toBeInTheDocument();
    });
  });

  it("renders dependency count when dependencies exist", async () => {
    const dep = makeMockNode({ id: "n-dep", seq: 10, title: "Dependency Node", status: "done", order: 0 });
    const node = makeMockNode({ id: "n-1", seq: 1, title: "My Node", status: "pending", order: 1, dependencies: ["n-dep"] });
    const bp = makeMockBlueprint({ id: "bp-1", nodes: [dep, node] });
    apiMocks.getBlueprint.mockResolvedValue(bp);
    apiMocks.getNodeExecutions.mockResolvedValue([]);

    renderPage();

    await waitFor(() => {
      expect(screen.getAllByText("My Node").length).toBeGreaterThan(0);
    });

    expect(screen.getByText(/Dependencies/)).toBeInTheDocument();
    expect(screen.getByText("(1 selected)")).toBeInTheDocument();
  });

  it("polls when node is running", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    setupNodeData({ status: "running" });

    await act(async () => {
      renderPage();
    });

    // Wait for initial load
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    const initialCalls = apiMocks.getBlueprint.mock.calls.length;

    // Advance past the 5s poll interval
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5100);
    });

    expect(apiMocks.getBlueprint.mock.calls.length).toBeGreaterThan(initialCalls);

    vi.useRealTimers();
  });

  it("shows node error message", async () => {
    setupNodeData({ status: "failed", error: "Execution timed out" });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/Execution timed out/)).toBeInTheDocument();
    });
  });

  it("does not trigger runNode when Cmd+R (browser refresh) is pressed", async () => {
    setupNodeData({ status: "pending" });

    renderPage();

    await waitFor(() => {
      expect(screen.getAllByText("Setup database").length).toBeGreaterThan(0);
    });

    // Simulate Cmd+R (Mac refresh) — should NOT trigger handleRun
    fireEvent.keyDown(window, { key: "r", metaKey: true });
    // Simulate Ctrl+R (Windows/Linux refresh) — should NOT trigger handleRun
    fireEvent.keyDown(window, { key: "r", ctrlKey: true });

    // runNode should not have been called
    expect(apiMocks.runNode).not.toHaveBeenCalled();
  });

  it("triggers runNode when bare 'r' key is pressed on pending node", async () => {
    setupNodeData({ status: "pending" });

    renderPage();

    await waitFor(() => {
      expect(screen.getAllByText("Setup database").length).toBeGreaterThan(0);
    });

    // Bare 'r' should trigger handleRun
    fireEvent.keyDown(window, { key: "r" });

    await waitFor(() => {
      expect(apiMocks.runNode).toHaveBeenCalledWith("bp-1", "n-1");
    });
  });
});
