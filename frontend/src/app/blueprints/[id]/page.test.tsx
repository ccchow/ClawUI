import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import BlueprintDetailPage from "./page";
import { makeMockBlueprint, makeMockNode, makeMockInsight } from "@/test-utils";
import { ToastProvider } from "@/components/Toast";
import type { Blueprint, BlueprintInsight, QueueInfo } from "@/lib/api";

// --- vi.hoisted mocks ---

const apiMocks = vi.hoisted(() => ({
  getBlueprint: vi.fn((): Promise<Blueprint> => Promise.resolve({} as Blueprint)),
  getQueueStatus: vi.fn((): Promise<QueueInfo> => Promise.resolve({ running: false, queueLength: 0, pendingTasks: [] })),
  approveBlueprint: vi.fn((): Promise<Blueprint> => Promise.resolve({} as Blueprint)),
  updateBlueprint: vi.fn((): Promise<Blueprint> => Promise.resolve({} as Blueprint)),
  createMacroNode: vi.fn(() => Promise.resolve(makeMockNode())),
  enrichNode: vi.fn(() => Promise.resolve({ title: "Enriched", description: "desc" })),
  generatePlan: vi.fn(() => Promise.resolve({ status: "queued", blueprintId: "bp-1" })),
  runAllNodes: vi.fn(() => Promise.resolve({ message: "ok", blueprintId: "bp-1" })),
  reevaluateAllNodes: vi.fn(() => Promise.resolve({ message: "ok", blueprintId: "bp-1", nodeCount: 0 })),
  recoverNodeSession: vi.fn(() => Promise.resolve({ recovered: false })),
  archiveBlueprint: vi.fn((): Promise<Blueprint> => Promise.resolve({} as Blueprint)),
  unarchiveBlueprint: vi.fn((): Promise<Blueprint> => Promise.resolve({} as Blueprint)),
  starBlueprint: vi.fn((): Promise<Blueprint> => Promise.resolve({} as Blueprint)),
  unstarBlueprint: vi.fn((): Promise<Blueprint> => Promise.resolve({} as Blueprint)),
  fetchBlueprintInsights: vi.fn((): Promise<BlueprintInsight[]> => Promise.resolve([])),
  markInsightRead: vi.fn(() => Promise.resolve(makeMockInsight({ read: true }))),
  markAllInsightsRead: vi.fn(() => Promise.resolve({ success: true })),
  dismissInsight: vi.fn(() => Promise.resolve({ success: true })),
  coordinateBlueprint: vi.fn(() => Promise.resolve({ status: "queued", blueprintId: "bp-1" })),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<object>("@/lib/api");
  return { ...actual, ...apiMocks };
});

vi.mock("next/navigation", () => ({
  useParams: vi.fn(() => ({ id: "bp-1" })),
  useSearchParams: vi.fn(() => new URLSearchParams()),
  useRouter: vi.fn(() => ({ push: vi.fn(), back: vi.fn() })),
  usePathname: vi.fn(() => "/blueprints/bp-1"),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>{children}</a>
  ),
}));

vi.mock("@/components/AgentSelector", () => ({
  AgentBadge: ({ agentType }: { agentType: string }) => <span data-testid="agent-badge">{agentType}</span>,
}));

vi.mock("@/components/RoleBadge", () => ({
  RoleBadge: ({ roleId }: { roleId: string }) => <span data-testid="role-badge">{roleId}</span>,
}));

vi.mock("@/components/RoleSelector", () => ({
  RoleSelector: () => <div data-testid="role-selector" />,
}));

vi.mock("@/components/StatusIndicator", () => ({
  StatusIndicator: ({ status }: { status: string }) => <span data-testid="status-indicator">{status}</span>,
}));

vi.mock("@/components/MacroNodeCard", () => ({
  MacroNodeCard: ({ node }: { node: { title: string; seq: number; status: string } }) => (
    <div data-testid={`node-card-${node.seq}`}>
      <span>{node.title}</span>
      <span>{node.status}</span>
    </div>
  ),
}));

vi.mock("@/components/MarkdownContent", () => ({
  MarkdownContent: ({ content }: { content: string }) => <div data-testid="markdown-content">{content}</div>,
}));

vi.mock("@/components/MarkdownEditor", () => ({
  MarkdownEditor: () => <div data-testid="markdown-editor" />,
}));

vi.mock("@/components/AISparkle", () => ({
  AISparkle: () => <span data-testid="ai-sparkle" />,
}));

vi.mock("@/components/DependencyGraph", () => ({
  computeDepLayout: () => new Map(),
}));

vi.mock("@/components/SkeletonLoader", () => ({
  SkeletonLoader: () => <div data-testid="skeleton-loader" />,
}));

vi.mock("@/lib/useBlueprintBroadcast", () => ({
  useBlueprintBroadcast: (_id: string, _cb: () => void) => vi.fn(),
}));

// --- Helpers ---

function renderPage() {
  return render(
    <ToastProvider>
      <BlueprintDetailPage />
    </ToastProvider>,
  );
}

function setupBlueprintWithNodes(overrides: Partial<Blueprint> = {}) {
  const nodes = [
    makeMockNode({ id: "n-1", seq: 1, title: "Setup database", status: "pending", order: 0 }),
    makeMockNode({ id: "n-2", seq: 2, title: "Build API", status: "pending", order: 1, dependencies: ["n-1"] }),
    makeMockNode({ id: "n-3", seq: 3, title: "Write tests", status: "done", order: 2 }),
  ];
  const bp = makeMockBlueprint({ id: "bp-1", title: "My Blueprint", status: "approved", nodes, ...overrides });
  apiMocks.getBlueprint.mockResolvedValue(bp);
  return bp;
}

// --- Tests ---

describe("BlueprintDetailPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("sessionStorage", { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() });
    // Default mocks
    apiMocks.getBlueprint.mockResolvedValue(makeMockBlueprint());
    apiMocks.getQueueStatus.mockResolvedValue({ running: false, queueLength: 0, pendingTasks: [] });
    apiMocks.fetchBlueprintInsights.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders node list from blueprint data", async () => {
    setupBlueprintWithNodes();

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Setup database")).toBeInTheDocument();
    });
    expect(screen.getByText("Build API")).toBeInTheDocument();
    expect(screen.getByText("Write tests")).toBeInTheDocument();
  });

  it("renders blueprint title", async () => {
    setupBlueprintWithNodes();

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("My Blueprint")).toBeInTheDocument();
    });
  });

  it("shows Approve button for draft blueprints", async () => {
    const bp = makeMockBlueprint({ id: "bp-1", status: "draft", nodes: [] });
    apiMocks.getBlueprint.mockResolvedValue(bp);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Approve")).toBeInTheDocument();
    });
  });

  it("calls approveBlueprint when Approve is clicked", async () => {
    const bp = makeMockBlueprint({ id: "bp-1", status: "draft", nodes: [] });
    apiMocks.getBlueprint.mockResolvedValue(bp);
    apiMocks.approveBlueprint.mockResolvedValue(makeMockBlueprint({ id: "bp-1", status: "approved" }));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Approve")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Approve"));

    await waitFor(() => {
      expect(apiMocks.approveBlueprint).toHaveBeenCalledWith("bp-1");
    });
  });

  it("calls generatePlan when Generate button is clicked", async () => {
    const bp = makeMockBlueprint({ id: "bp-1", status: "approved", nodes: [] });
    apiMocks.getBlueprint.mockResolvedValue(bp);

    renderPage();

    await waitFor(() => {
      expect(screen.getByLabelText("Generate nodes")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("Generate nodes"));

    await waitFor(() => {
      expect(apiMocks.generatePlan).toHaveBeenCalledWith("bp-1", undefined);
    });
  });

  it("shows Run All button for approved blueprints with pending nodes", async () => {
    setupBlueprintWithNodes({ status: "approved" });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Run All")).toBeInTheDocument();
    });
  });

  it("calls runAllNodes when Run All is clicked", async () => {
    setupBlueprintWithNodes({ status: "approved" });
    apiMocks.runAllNodes.mockResolvedValue({ message: "ok", blueprintId: "bp-1" });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Run All")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Run All"));

    await waitFor(() => {
      expect(apiMocks.runAllNodes).toHaveBeenCalledWith("bp-1");
    });
  });

  it("calls reevaluateAllNodes with confirmation flow", async () => {
    setupBlueprintWithNodes({ status: "approved" });

    renderPage();

    // Wait for page to load
    await waitFor(() => {
      expect(screen.getByText("My Blueprint")).toBeInTheDocument();
    });

    // Find the Reevaluate button — first click shows confirmation
    const reevalBtn = screen.getByText("Reevaluate");
    fireEvent.click(reevalBtn);

    // Confirmation: "Reevaluate?" with Yes/No
    await waitFor(() => {
      expect(screen.getByText("Reevaluate?")).toBeInTheDocument();
    });

    // Click Yes to confirm
    fireEvent.click(screen.getByText("Yes"));

    await waitFor(() => {
      expect(apiMocks.reevaluateAllNodes).toHaveBeenCalledWith("bp-1");
    });
  });

  it("renders insights panel when insights exist", async () => {
    const bp = makeMockBlueprint({ id: "bp-1", status: "approved", nodes: [] });
    apiMocks.getBlueprint.mockResolvedValue(bp);
    apiMocks.fetchBlueprintInsights.mockResolvedValue([
      makeMockInsight({ id: "ins-1", message: "Consider adding more tests", severity: "info" }),
    ]);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Consider adding more tests")).toBeInTheDocument();
    });
  });

  it("handles mark-read on insights with optimistic update", async () => {
    const bp = makeMockBlueprint({ id: "bp-1", status: "approved", nodes: [] });
    apiMocks.getBlueprint.mockResolvedValue(bp);
    apiMocks.fetchBlueprintInsights.mockResolvedValue([
      makeMockInsight({ id: "ins-1", message: "Insight text", read: false }),
    ]);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Insight text")).toBeInTheDocument();
    });

    // Find and click mark-read button
    const markReadBtn = screen.getByTitle("Mark as read");
    fireEvent.click(markReadBtn);

    await waitFor(() => {
      expect(apiMocks.markInsightRead).toHaveBeenCalledWith("bp-1", "ins-1");
    });
  });

  it("handles dismiss on insights with optimistic update", async () => {
    const bp = makeMockBlueprint({ id: "bp-1", status: "approved", nodes: [] });
    apiMocks.getBlueprint.mockResolvedValue(bp);
    apiMocks.fetchBlueprintInsights.mockResolvedValue([
      makeMockInsight({ id: "ins-1", message: "Dismiss me", read: false }),
    ]);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Dismiss me")).toBeInTheDocument();
    });

    const dismissBtn = screen.getByTitle("Dismiss");
    fireEvent.click(dismissBtn);

    await waitFor(() => {
      expect(apiMocks.dismissInsight).toHaveBeenCalledWith("bp-1", "ins-1");
    });
  });

  it("calls coordinateBlueprint when Analyze button is clicked", async () => {
    const bp = makeMockBlueprint({ id: "bp-1", status: "approved", nodes: [] });
    apiMocks.getBlueprint.mockResolvedValue(bp);
    apiMocks.fetchBlueprintInsights.mockResolvedValue([
      makeMockInsight({ id: "ins-1", message: "Some insight", read: false }),
    ]);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Some insight")).toBeInTheDocument();
    });

    // The coordinate button shows as "Analyze" in the insights header
    const coordBtn = screen.getByText("Analyze");
    fireEvent.click(coordBtn);

    await waitFor(() => {
      expect(apiMocks.coordinateBlueprint).toHaveBeenCalledWith("bp-1");
    });
  });

  it("shows Add Node form and calls createMacroNode", async () => {
    setupBlueprintWithNodes();
    const newNode = makeMockNode({ id: "n-4", seq: 4, title: "Deploy", status: "pending", order: 3 });
    apiMocks.createMacroNode.mockResolvedValue(newNode);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("My Blueprint")).toBeInTheDocument();
    });

    // Click "Add Node" button (dashed border button)
    const addBtn = screen.getByText("Add Node");
    fireEvent.click(addBtn);

    // Fill in the form
    const titleInput = screen.getByPlaceholderText("Node title");
    fireEvent.change(titleInput, { target: { value: "Deploy" } });

    // Submit via the "Add" button (aria-label="Add node")
    const submitBtn = screen.getByLabelText("Add node");
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(apiMocks.createMacroNode).toHaveBeenCalledWith("bp-1", expect.objectContaining({
        title: "Deploy",
        order: 3,
      }));
    });
  });

  it("shows loading skeleton initially", () => {
    // Never resolve the promise to keep loading state
    apiMocks.getBlueprint.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getByTestId("skeleton-loader")).toBeInTheDocument();
  });

  it("shows error state when blueprint fails to load", async () => {
    apiMocks.getBlueprint.mockRejectedValue(new Error("Not found"));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/Failed to load blueprint/)).toBeInTheDocument();
    });
  });

  it("shows star toggle and calls star/unstar API", async () => {
    const bp = makeMockBlueprint({ id: "bp-1", starred: false, status: "approved", nodes: [] });
    apiMocks.getBlueprint.mockResolvedValue(bp);
    apiMocks.starBlueprint.mockResolvedValue(makeMockBlueprint({ starred: true }));

    renderPage();

    await waitFor(() => {
      expect(screen.getByLabelText("Star blueprint")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("Star blueprint"));

    await waitFor(() => {
      expect(apiMocks.starBlueprint).toHaveBeenCalledWith("bp-1");
    });
  });

  it("polls for updates when blueprint has running nodes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const bp = makeMockBlueprint({
      id: "bp-1",
      status: "approved",
      nodes: [makeMockNode({ id: "n-1", status: "running" })],
    });
    apiMocks.getBlueprint.mockResolvedValue(bp);

    await act(async () => {
      renderPage();
    });

    // Wait for initial data to load
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    const initialCalls = apiMocks.getBlueprint.mock.calls.length;

    // Advance past the 5s poll interval
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5100);
    });

    // Should have polled at least once more
    expect(apiMocks.getBlueprint.mock.calls.length).toBeGreaterThan(initialCalls);

    vi.useRealTimers();
  });

  it("shows status filter chips and filters nodes by status", async () => {
    setupBlueprintWithNodes();

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Setup database")).toBeInTheDocument();
    });

    // Click "done 1" status filter (CSS capitalize makes it display as "Done 1")
    const doneFilter = screen.getByRole("button", { name: /done 1/ });
    fireEvent.click(doneFilter);

    // Only "Write tests" (done) should be visible
    await waitFor(() => {
      expect(screen.getByText("Write tests")).toBeInTheDocument();
    });
    expect(screen.queryByText("Setup database")).not.toBeInTheDocument();
  });

  it("shows archive/unarchive button", async () => {
    const bp = makeMockBlueprint({ id: "bp-1", status: "approved", nodes: [] });
    apiMocks.getBlueprint.mockResolvedValue(bp);

    renderPage();

    await waitFor(() => {
      expect(screen.getByLabelText("Archive blueprint")).toBeInTheDocument();
    });
  });
});
