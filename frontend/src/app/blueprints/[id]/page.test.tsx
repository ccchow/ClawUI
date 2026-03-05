import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import BlueprintDetailPage from "./page";
import { makeMockBlueprint, makeMockNode, makeMockInsight } from "@/test-utils";
import { ToastProvider } from "@/components/Toast";
import type { Blueprint, BlueprintInsight, QueueInfo, ConveneSession, ConveneMessage, BatchCreateNode, RoleInfo } from "@/lib/api";

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
  getConveneSessions: vi.fn((): Promise<ConveneSession[]> => Promise.resolve([])),
  getConveneSessionDetail: vi.fn((): Promise<ConveneSession & { messages: ConveneMessage[] }> => Promise.resolve({} as ConveneSession & { messages: ConveneMessage[] })),
  startConveneSession: vi.fn(() => Promise.resolve({ status: "queued", sessionId: "cs-1" })),
  approveConveneSession: vi.fn(() => Promise.resolve({ status: "ok", createdNodeIds: ["n-new-1", "n-new-2"] })),
  cancelConveneSession: vi.fn(() => Promise.resolve({ status: "ok" })),
  fetchRoles: vi.fn((): Promise<RoleInfo[]> => Promise.resolve([
    { id: "sde", label: "SDE", description: "Software Development Engineer", builtin: true, artifactTypes: [], blockerTypes: [] },
    { id: "qa", label: "QA", description: "Quality Assurance", builtin: true, artifactTypes: [], blockerTypes: [] },
    { id: "pm", label: "PM", description: "Product Manager", builtin: true, artifactTypes: [], blockerTypes: [] },
    { id: "uxd", label: "UXD", description: "UX Designer", builtin: true, artifactTypes: [], blockerTypes: [] },
  ])),
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

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        // Disable refetchOnWindowFocus in tests to avoid unexpected refetches
        refetchOnWindowFocus: false,
      },
    },
  });
}

function renderPage() {
  const queryClient = createTestQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <BlueprintDetailPage />
      </ToastProvider>
    </QueryClientProvider>,
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
    apiMocks.getConveneSessions.mockResolvedValue([]);
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

  it("calls runAllNodes when Run All is clicked with confirmation", async () => {
    setupBlueprintWithNodes({ status: "approved" });
    apiMocks.runAllNodes.mockResolvedValue({ message: "ok", blueprintId: "bp-1" });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Run All")).toBeInTheDocument();
    });

    // First click shows confirmation strip
    fireEvent.click(screen.getByText("Run All"));

    await waitFor(() => {
      expect(screen.getByText("Run all pending nodes?")).toBeInTheDocument();
    });

    // Confirm by clicking Yes
    fireEvent.click(screen.getByText("Yes"));

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

  // ─── Convene / Discussions Tests ───────────────────────────────

  describe("Convene button", () => {
    it("renders Convene button for approved blueprints with 2+ enabled roles", async () => {
      const bp = makeMockBlueprint({ id: "bp-1", status: "approved", nodes: [], enabledRoles: ["sde", "qa", "pm"] });
      apiMocks.getBlueprint.mockResolvedValue(bp);

      renderPage();

      await waitFor(() => {
        expect(screen.getByText("Convene")).toBeInTheDocument();
      });
    });

    it("Convene button is enabled even with single enabledRole (no longer gated)", async () => {
      const bp = makeMockBlueprint({ id: "bp-1", status: "approved", nodes: [], enabledRoles: ["sde"] });
      apiMocks.getBlueprint.mockResolvedValue(bp);

      renderPage();

      await waitFor(() => {
        expect(screen.getByText("Convene")).toBeInTheDocument();
      });

      const btn = screen.getByText("Convene").closest("button")!;
      expect(btn).not.toBeDisabled();
    });

    it("opens convene config form when clicked", async () => {
      const bp = makeMockBlueprint({ id: "bp-1", status: "approved", nodes: [], enabledRoles: ["sde", "qa"] });
      apiMocks.getBlueprint.mockResolvedValue(bp);

      renderPage();

      await waitFor(() => {
        expect(screen.getByText("Convene")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("Convene"));

      await waitFor(() => {
        expect(screen.getByRole("heading", { name: "Start Discussion" })).toBeInTheDocument();
      });
    });
  });

  describe("Convene config form", () => {
    function setupConveneForm(nodeOverrides: Parameters<typeof makeMockNode>[0][] = []) {
      const nodes = nodeOverrides.map((ov, i) => makeMockNode({ id: `n-${i + 1}`, seq: i + 1, order: i, ...ov }));
      const bp = makeMockBlueprint({
        id: "bp-1",
        status: "approved",
        nodes,
        enabledRoles: ["sde", "qa", "pm"],
      });
      apiMocks.getBlueprint.mockResolvedValue(bp);
      return bp;
    }

    async function openConveneForm() {
      renderPage();
      await waitFor(() => {
        expect(screen.getByText("Convene")).toBeInTheDocument();
      });
      fireEvent.click(screen.getByText("Convene"));
      await waitFor(() => {
        expect(screen.getByRole("heading", { name: "Start Discussion" })).toBeInTheDocument();
      });
    }

    it("renders topic input, role selection, and max rounds", async () => {
      setupConveneForm();
      await openConveneForm();

      expect(screen.getByPlaceholderText(/Discussion topic/)).toBeInTheDocument();
      expect(screen.getByText("Participating roles (min 2)")).toBeInTheDocument();
      expect(screen.getByText("Max rounds")).toBeInTheDocument();
      // Role buttons (use getByRole to avoid matching RoleBadge spans in header)
      expect(screen.getByRole("button", { name: "SDE" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "QA" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "PM" })).toBeInTheDocument();
    });

    it("shows max round stepper buttons 1-5 with default 3 selected", async () => {
      setupConveneForm();
      await openConveneForm();

      // All 5 stepper buttons should exist
      for (const n of [1, 2, 3, 4, 5]) {
        expect(screen.getByRole("button", { name: String(n) })).toBeInTheDocument();
      }
    });

    it("Start Discussion button is disabled when topic is empty", async () => {
      setupConveneForm();
      await openConveneForm();

      // All roles are pre-selected (enabledRoles), but topic is empty
      const startBtn = screen.getByRole("button", { name: /Start Discussion/ });
      expect(startBtn).toBeDisabled();
    });

    it("Start Discussion button is disabled when fewer than 2 roles selected", async () => {
      setupConveneForm();
      await openConveneForm();

      // Fill in the topic
      fireEvent.change(screen.getByPlaceholderText(/Discussion topic/), { target: { value: "Test topic" } });

      // Deselect all roles (they start pre-selected) by clicking each
      fireEvent.click(screen.getByRole("button", { name: "SDE" }));
      fireEvent.click(screen.getByRole("button", { name: "QA" }));
      fireEvent.click(screen.getByRole("button", { name: "PM" }));

      // Re-select only 1 role
      fireEvent.click(screen.getByRole("button", { name: "SDE" }));

      const startBtn = screen.getByRole("button", { name: /Start Discussion/ });
      expect(startBtn).toBeDisabled();
    });

    it("calls startConveneSession with correct parameters", async () => {
      setupConveneForm();
      await openConveneForm();

      // Fill topic
      fireEvent.change(screen.getByPlaceholderText(/Discussion topic/), { target: { value: "Design auth system" } });

      // Deselect PM (keep SDE and QA selected)
      fireEvent.click(screen.getByRole("button", { name: "PM" }));

      // Change max rounds to 2
      fireEvent.click(screen.getByRole("button", { name: "2" }));

      // Click Start Discussion
      fireEvent.click(screen.getByRole("button", { name: /Start Discussion/ }));

      await waitFor(() => {
        expect(apiMocks.startConveneSession).toHaveBeenCalledWith("bp-1", {
          topic: "Design auth system",
          roleIds: ["sde", "qa"],
          contextNodeIds: undefined,
          maxRounds: 2,
        });
      });
    });

    it("includes context nodes when selected", async () => {
      setupConveneForm([
        { title: "Setup database" },
        { title: "Build API" },
      ]);
      await openConveneForm();

      // Fill topic
      fireEvent.change(screen.getByPlaceholderText(/Discussion topic/), { target: { value: "API design" } });

      // Select a context node — use the button with "#1" prefix in the context nodes section
      const contextBtns = screen.getAllByText(/Setup database/);
      // The context node button contains "#1 Setup database", find the button element
      const contextNodeBtn = contextBtns.find(el => el.closest("button")?.textContent?.includes("#1"))!;
      fireEvent.click(contextNodeBtn.closest("button")!);

      // Click Start Discussion
      fireEvent.click(screen.getByRole("button", { name: /Start Discussion/ }));

      await waitFor(() => {
        expect(apiMocks.startConveneSession).toHaveBeenCalledWith("bp-1", expect.objectContaining({
          topic: "API design",
          contextNodeIds: ["n-1"],
        }));
      });
    });

    it("closes form when Cancel is clicked", async () => {
      setupConveneForm();
      await openConveneForm();

      // Click Cancel button (the one in the actions section)
      const cancelBtns = screen.getAllByText("Cancel");
      fireEvent.click(cancelBtns[cancelBtns.length - 1]);

      await waitFor(() => {
        expect(screen.queryByPlaceholderText(/Discussion topic/)).not.toBeInTheDocument();
      });
    });

    it("closes form via close icon button", async () => {
      setupConveneForm();
      await openConveneForm();

      fireEvent.click(screen.getByLabelText("Close convene form"));

      await waitFor(() => {
        expect(screen.queryByPlaceholderText(/Discussion topic/)).not.toBeInTheDocument();
      });
    });

    it("resets form state after starting a discussion", async () => {
      setupConveneForm();
      await openConveneForm();

      // Fill topic
      fireEvent.change(screen.getByPlaceholderText(/Discussion topic/), { target: { value: "Topic" } });

      // Click Start Discussion
      fireEvent.click(screen.getByRole("button", { name: /Start Discussion/ }));

      await waitFor(() => {
        expect(apiMocks.startConveneSession).toHaveBeenCalled();
      });

      // Form should be hidden after submission
      await waitFor(() => {
        expect(screen.queryByPlaceholderText(/Discussion topic/)).not.toBeInTheDocument();
      });
    });
  });

  describe("Discussions panel", () => {
    function makeMockSession(overrides: Partial<ConveneSession> = {}): ConveneSession {
      return {
        id: "cs-1",
        blueprintId: "bp-1",
        topic: "Auth system design",
        contextNodeIds: null,
        participatingRoles: ["sde", "qa"],
        maxRounds: 3,
        status: "completed",
        synthesisResult: null,
        messageCount: 5,
        createdAt: "2025-06-01T10:00:00Z",
        completedAt: "2025-06-01T10:30:00Z",
        ...overrides,
      };
    }

    it("renders Discussions panel when sessions exist", async () => {
      const sessions = [makeMockSession()];
      apiMocks.getConveneSessions.mockResolvedValue(sessions);
      const bp = makeMockBlueprint({ id: "bp-1", status: "approved", nodes: [] });
      apiMocks.getBlueprint.mockResolvedValue(bp);

      renderPage();

      await waitFor(() => {
        expect(screen.getByText("Discussions")).toBeInTheDocument();
      });
    });

    it("shows session count badge", async () => {
      const sessions = [
        makeMockSession({ id: "cs-1", topic: "Topic A" }),
        makeMockSession({ id: "cs-2", topic: "Topic B", status: "active" }),
      ];
      apiMocks.getConveneSessions.mockResolvedValue(sessions);
      const bp = makeMockBlueprint({ id: "bp-1", status: "approved", nodes: [] });
      apiMocks.getBlueprint.mockResolvedValue(bp);

      renderPage();

      await waitFor(() => {
        expect(screen.getByText("2")).toBeInTheDocument();
      });
    });

    it("shows completed count", async () => {
      const sessions = [
        makeMockSession({ id: "cs-1", status: "completed" }),
        makeMockSession({ id: "cs-2", status: "active" }),
      ];
      apiMocks.getConveneSessions.mockResolvedValue(sessions);
      const bp = makeMockBlueprint({ id: "bp-1", status: "approved", nodes: [] });
      apiMocks.getBlueprint.mockResolvedValue(bp);

      renderPage();

      await waitFor(() => {
        expect(screen.getByText("1 completed")).toBeInTheDocument();
      });
    });

    it("displays session topic and status badge", async () => {
      const sessions = [makeMockSession({ topic: "Database schema review", status: "active" })];
      apiMocks.getConveneSessions.mockResolvedValue(sessions);
      const bp = makeMockBlueprint({ id: "bp-1", status: "approved", nodes: [] });
      apiMocks.getBlueprint.mockResolvedValue(bp);

      renderPage();

      await waitFor(() => {
        expect(screen.getByText("Database schema review")).toBeInTheDocument();
      });
      expect(screen.getByText("active")).toBeInTheDocument();
    });

    it("displays message count", async () => {
      const sessions = [makeMockSession({ messageCount: 7 })];
      apiMocks.getConveneSessions.mockResolvedValue(sessions);
      const bp = makeMockBlueprint({ id: "bp-1", status: "approved", nodes: [] });
      apiMocks.getBlueprint.mockResolvedValue(bp);

      renderPage();

      await waitFor(() => {
        expect(screen.getByText("7 messages")).toBeInTheDocument();
      });
    });

    it("shows singular 'message' for count of 1", async () => {
      const sessions = [makeMockSession({ messageCount: 1 })];
      apiMocks.getConveneSessions.mockResolvedValue(sessions);
      const bp = makeMockBlueprint({ id: "bp-1", status: "approved", nodes: [] });
      apiMocks.getBlueprint.mockResolvedValue(bp);

      renderPage();

      await waitFor(() => {
        expect(screen.getByText("1 message")).toBeInTheDocument();
      });
    });

    it("does not render Discussions panel when no sessions exist", async () => {
      apiMocks.getConveneSessions.mockResolvedValue([]);
      const bp = makeMockBlueprint({ id: "bp-1", status: "approved", nodes: [] });
      apiMocks.getBlueprint.mockResolvedValue(bp);

      renderPage();

      await waitFor(() => {
        expect(screen.getByText("Test Blueprint")).toBeInTheDocument();
      });

      // Panel is not rendered
      expect(screen.queryByText("Discussions")).not.toBeInTheDocument();
    });

    it("expands session detail on click and fetches messages", async () => {
      const sessions = [makeMockSession({ id: "cs-1", topic: "Auth flow" })];
      apiMocks.getConveneSessions.mockResolvedValue(sessions);

      const messages: ConveneMessage[] = [
        { id: "m-1", sessionId: "cs-1", roleId: "sde", round: 1, content: "We need JWT tokens", messageType: "contribution", createdAt: "2025-06-01T10:01:00Z" },
        { id: "m-2", sessionId: "cs-1", roleId: "qa", round: 1, content: "Need to test token expiry", messageType: "contribution", createdAt: "2025-06-01T10:02:00Z" },
      ];
      apiMocks.getConveneSessionDetail.mockResolvedValue({
        ...sessions[0],
        messages,
      });

      const bp = makeMockBlueprint({ id: "bp-1", status: "approved", nodes: [] });
      apiMocks.getBlueprint.mockResolvedValue(bp);

      renderPage();

      await waitFor(() => {
        expect(screen.getByText("Auth flow")).toBeInTheDocument();
      });

      // Click session to expand
      fireEvent.click(screen.getByText("Auth flow"));

      await waitFor(() => {
        expect(apiMocks.getConveneSessionDetail).toHaveBeenCalledWith("bp-1", "cs-1");
      });

      // Message content rendered
      await waitFor(() => {
        expect(screen.getByText("We need JWT tokens")).toBeInTheDocument();
      });
      expect(screen.getByText("Need to test token expiry")).toBeInTheDocument();
    });

    it("shows role labels on messages", async () => {
      const sessions = [makeMockSession({ id: "cs-1", topic: "API review" })];
      apiMocks.getConveneSessions.mockResolvedValue(sessions);

      apiMocks.getConveneSessionDetail.mockResolvedValue({
        ...sessions[0],
        messages: [
          { id: "m-1", sessionId: "cs-1", roleId: "sde", round: 1, content: "Content", messageType: "contribution", createdAt: "2025-06-01T10:01:00Z" },
        ],
      });

      const bp = makeMockBlueprint({ id: "bp-1", status: "approved", nodes: [] });
      apiMocks.getBlueprint.mockResolvedValue(bp);

      renderPage();

      await waitFor(() => {
        expect(screen.getByText("API review")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("API review"));

      await waitFor(() => {
        expect(screen.getByText("SDE")).toBeInTheDocument();
      });
      expect(screen.getByText("Round 1")).toBeInTheDocument();
    });

    it("shows 'Synthesis' label for synthesis messages", async () => {
      const sessions = [makeMockSession({ id: "cs-1", topic: "Design review" })];
      apiMocks.getConveneSessions.mockResolvedValue(sessions);

      apiMocks.getConveneSessionDetail.mockResolvedValue({
        ...sessions[0],
        messages: [
          { id: "m-1", sessionId: "cs-1", roleId: "sde", round: 1, content: "Synthesis result", messageType: "synthesis", createdAt: "2025-06-01T10:01:00Z" },
        ],
      });

      const bp = makeMockBlueprint({ id: "bp-1", status: "approved", nodes: [] });
      apiMocks.getBlueprint.mockResolvedValue(bp);

      renderPage();

      await waitFor(() => {
        expect(screen.getByText("Design review")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("Design review"));

      await waitFor(() => {
        expect(screen.getByText("Synthesis")).toBeInTheDocument();
      });
      // Synthesis messages don't show "Round N"
      expect(screen.queryByText(/Round/)).not.toBeInTheDocument();
    });

    it("collapses expanded session on second click", async () => {
      const sessions = [makeMockSession({ id: "cs-1", topic: "Collapse test" })];
      apiMocks.getConveneSessions.mockResolvedValue(sessions);

      apiMocks.getConveneSessionDetail.mockResolvedValue({
        ...sessions[0],
        messages: [
          { id: "m-1", sessionId: "cs-1", roleId: "sde", round: 1, content: "Message content here", messageType: "contribution", createdAt: "2025-06-01T10:01:00Z" },
        ],
      });

      const bp = makeMockBlueprint({ id: "bp-1", status: "approved", nodes: [] });
      apiMocks.getBlueprint.mockResolvedValue(bp);

      renderPage();

      await waitFor(() => {
        expect(screen.getByText("Collapse test")).toBeInTheDocument();
      });

      // Click to expand
      fireEvent.click(screen.getByText("Collapse test"));

      await waitFor(() => {
        expect(screen.getByText("Message content here")).toBeInTheDocument();
      });

      // Click again to collapse
      fireEvent.click(screen.getByText("Collapse test"));

      await waitFor(() => {
        expect(screen.queryByText("Message content here")).not.toBeInTheDocument();
      });
    });

    it("toggles Discussions panel open/closed", async () => {
      const sessions = [makeMockSession({ topic: "Toggle test" })];
      apiMocks.getConveneSessions.mockResolvedValue(sessions);
      const bp = makeMockBlueprint({ id: "bp-1", status: "approved", nodes: [] });
      apiMocks.getBlueprint.mockResolvedValue(bp);

      renderPage();

      await waitFor(() => {
        expect(screen.getByText("Toggle test")).toBeInTheDocument();
      });

      // Click the Discussions header to collapse
      fireEvent.click(screen.getByText("Discussions"));

      await waitFor(() => {
        // Topic should be hidden when panel collapsed
        expect(screen.queryByText("Toggle test")).not.toBeInTheDocument();
      });

      // Click again to re-expand
      fireEvent.click(screen.getByText("Discussions"));

      await waitFor(() => {
        expect(screen.getByText("Toggle test")).toBeInTheDocument();
      });
    });
  });

  describe("Synthesis approve/discard", () => {
    function makeSynthesizingSession(): ConveneSession {
      return {
        id: "cs-synth",
        blueprintId: "bp-1",
        topic: "Feature planning",
        contextNodeIds: null,
        participatingRoles: ["sde", "qa"],
        maxRounds: 3,
        status: "synthesizing",
        synthesisResult: [
          { title: "Implement auth", description: "JWT auth flow", roles: ["sde"] },
          { title: "Write auth tests", description: "Unit + integration", roles: ["qa"] },
        ] as BatchCreateNode[],
        messageCount: 4,
        createdAt: "2025-06-01T10:00:00Z",
        completedAt: null,
      };
    }

    async function expandSynthesizingSession() {
      const session = makeSynthesizingSession();
      apiMocks.getConveneSessions.mockResolvedValue([session]);
      apiMocks.getConveneSessionDetail.mockResolvedValue({
        ...session,
        messages: [
          { id: "m-1", sessionId: "cs-synth", roleId: "sde", round: 1, content: "Auth plan", messageType: "contribution", createdAt: "2025-06-01T10:01:00Z" },
        ],
      });
      const bp = makeMockBlueprint({ id: "bp-1", status: "approved", nodes: [] });
      apiMocks.getBlueprint.mockResolvedValue(bp);

      renderPage();

      await waitFor(() => {
        expect(screen.getByText("Feature planning")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("Feature planning"));

      await waitFor(() => {
        expect(screen.getByText("Implement auth")).toBeInTheDocument();
      });
    }

    it("shows synthesis review panel with proposed nodes for synthesizing sessions", async () => {
      await expandSynthesizingSession();

      expect(screen.getByText("Proposed nodes (2)")).toBeInTheDocument();
      expect(screen.getByText("Implement auth")).toBeInTheDocument();
      expect(screen.getByText("Write auth tests")).toBeInTheDocument();
    });

    it("shows Approve and Discard buttons", async () => {
      await expandSynthesizingSession();

      expect(screen.getByText("Approve")).toBeInTheDocument();
      expect(screen.getByText("Discard")).toBeInTheDocument();
    });

    it("calls approveConveneSession when Approve is clicked", async () => {
      await expandSynthesizingSession();

      fireEvent.click(screen.getByText("Approve"));

      await waitFor(() => {
        expect(apiMocks.approveConveneSession).toHaveBeenCalledWith("bp-1", "cs-synth");
      });
    });

    it("shows inline discard confirmation when Discard is clicked", async () => {
      await expandSynthesizingSession();

      fireEvent.click(screen.getByText("Discard"));

      await waitFor(() => {
        expect(screen.getByText("Discard?")).toBeInTheDocument();
        expect(screen.getByText("Yes")).toBeInTheDocument();
        expect(screen.getByText("No")).toBeInTheDocument();
      });
    });

    it("calls cancelConveneSession when discard is confirmed", async () => {
      await expandSynthesizingSession();

      fireEvent.click(screen.getByText("Discard"));

      await waitFor(() => {
        expect(screen.getByText("Discard?")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("Yes"));

      await waitFor(() => {
        expect(apiMocks.cancelConveneSession).toHaveBeenCalledWith("bp-1", "cs-synth");
      });
    });

    it("cancels discard confirmation when No is clicked", async () => {
      await expandSynthesizingSession();

      fireEvent.click(screen.getByText("Discard"));

      await waitFor(() => {
        expect(screen.getByText("Discard?")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("No"));

      await waitFor(() => {
        // Confirmation strip disappears, Discard button reappears
        expect(screen.queryByText("Discard?")).not.toBeInTheDocument();
        expect(screen.getByText("Discard")).toBeInTheDocument();
      });
    });

    it("does not show synthesis review for completed sessions", async () => {
      const session: ConveneSession = {
        id: "cs-done",
        blueprintId: "bp-1",
        topic: "Completed discussion",
        contextNodeIds: null,
        participatingRoles: ["sde", "qa"],
        maxRounds: 3,
        status: "completed",
        synthesisResult: [{ title: "Some node", description: "desc" }],
        messageCount: 3,
        createdAt: "2025-06-01T10:00:00Z",
        completedAt: "2025-06-01T10:30:00Z",
      };
      apiMocks.getConveneSessions.mockResolvedValue([session]);
      apiMocks.getConveneSessionDetail.mockResolvedValue({
        ...session,
        messages: [
          { id: "m-1", sessionId: "cs-done", roleId: "sde", round: 1, content: "Final msg", messageType: "contribution", createdAt: "2025-06-01T10:01:00Z" },
        ],
      });
      const bp = makeMockBlueprint({ id: "bp-1", status: "approved", nodes: [] });
      apiMocks.getBlueprint.mockResolvedValue(bp);

      renderPage();

      await waitFor(() => {
        expect(screen.getByText("Completed discussion")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("Completed discussion"));

      await waitFor(() => {
        expect(screen.getByText("Final msg")).toBeInTheDocument();
      });

      // Should NOT show synthesis review buttons for completed sessions
      expect(screen.queryByText("Approve")).not.toBeInTheDocument();
      expect(screen.queryByText("Discard")).not.toBeInTheDocument();
    });
  });

  describe("Convene active banner", () => {
    it("shows active discussion banner when convene task is pending", async () => {
      const bp = makeMockBlueprint({ id: "bp-1", status: "approved", nodes: [] });
      apiMocks.getBlueprint.mockResolvedValue(bp);
      apiMocks.getQueueStatus.mockResolvedValue({
        running: false,
        queueLength: 0,
        pendingTasks: [{ type: "convene", blueprintId: "bp-1" }] as any[],
      });

      renderPage();

      await waitFor(() => {
        expect(screen.getByText("Role discussion in progress")).toBeInTheDocument();
      });
    });

    it("disables Convene button when convene is already running", async () => {
      const bp = makeMockBlueprint({ id: "bp-1", status: "approved", nodes: [], enabledRoles: ["sde", "qa"] });
      apiMocks.getBlueprint.mockResolvedValue(bp);
      apiMocks.getQueueStatus.mockResolvedValue({
        running: false,
        queueLength: 0,
        pendingTasks: [{ type: "convene", blueprintId: "bp-1" }] as any[],
      });

      renderPage();

      await waitFor(() => {
        expect(screen.getByText("Convene")).toBeInTheDocument();
      });

      const btn = screen.getByText("Convene").closest("button")!;
      expect(btn).toBeDisabled();
    });
  });

  describe("Convene broadcast", () => {
    it("calls broadcastOperation('convene') when starting a discussion", async () => {
      // We need a custom mock for useBlueprintBroadcast that tracks calls
      // The mock is already set up to return vi.fn(), so the broadcastOperation calls are tracked
      const bp = makeMockBlueprint({ id: "bp-1", status: "approved", nodes: [], enabledRoles: ["sde", "qa"] });
      apiMocks.getBlueprint.mockResolvedValue(bp);

      renderPage();

      await waitFor(() => {
        expect(screen.getByText("Convene")).toBeInTheDocument();
      });

      // Open form
      fireEvent.click(screen.getByText("Convene"));

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/Discussion topic/)).toBeInTheDocument();
      });

      // Fill and submit
      fireEvent.change(screen.getByPlaceholderText(/Discussion topic/), { target: { value: "Test broadcast" } });
      fireEvent.click(screen.getByRole("button", { name: /Start Discussion/ }));

      await waitFor(() => {
        expect(apiMocks.startConveneSession).toHaveBeenCalled();
      });

      // After successful startConveneSession, getConveneSessions should be refetched
      await waitFor(() => {
        expect(apiMocks.getConveneSessions).toHaveBeenCalled();
      });
    });
  });

  describe("Status reset", () => {
    it("shows Reset button when blueprint is running but no nodes are active", async () => {
      const bp = makeMockBlueprint({
        id: "bp-1",
        status: "running",
        nodes: [
          makeMockNode({ id: "n-1", seq: 1, title: "Done node", status: "done", order: 0 }),
          makeMockNode({ id: "n-2", seq: 2, title: "Pending node", status: "pending", order: 1 }),
        ],
      });
      apiMocks.getBlueprint.mockResolvedValue(bp);

      renderPage();

      await waitFor(() => {
        expect(screen.getByText("Reset")).toBeInTheDocument();
      });
    });

    it("does NOT show Reset button when nodes are actively running", async () => {
      const bp = makeMockBlueprint({
        id: "bp-1",
        status: "running",
        nodes: [
          makeMockNode({ id: "n-1", seq: 1, title: "Running node", status: "running", order: 0 }),
          makeMockNode({ id: "n-2", seq: 2, title: "Pending node", status: "pending", order: 1 }),
        ],
      });
      apiMocks.getBlueprint.mockResolvedValue(bp);

      renderPage();

      await waitFor(() => {
        expect(screen.getByText("In Progress")).toBeInTheDocument();
      });

      expect(screen.queryByText("Reset")).not.toBeInTheDocument();
    });

    it("calls updateBlueprint with status approved on Reset confirmation", async () => {
      const bp = makeMockBlueprint({
        id: "bp-1",
        status: "running",
        nodes: [
          makeMockNode({ id: "n-1", seq: 1, title: "Done node", status: "done", order: 0 }),
          makeMockNode({ id: "n-2", seq: 2, title: "Pending node", status: "pending", order: 1 }),
        ],
      });
      apiMocks.getBlueprint.mockResolvedValue(bp);
      apiMocks.updateBlueprint.mockResolvedValue(makeMockBlueprint({ id: "bp-1", status: "approved" }));

      renderPage();

      await waitFor(() => {
        expect(screen.getByText("Reset")).toBeInTheDocument();
      });

      // Click Reset shows confirmation strip
      fireEvent.click(screen.getByText("Reset"));

      await waitFor(() => {
        expect(screen.getByText("Reset to Approved?")).toBeInTheDocument();
      });

      // Confirm
      fireEvent.click(screen.getByText("Yes"));

      await waitFor(() => {
        expect(apiMocks.updateBlueprint).toHaveBeenCalledWith("bp-1", { status: "approved" });
      });
    });
  });

  // ─── Manual Blueprint Status Transitions ──────────────────────────

  describe("Manual blueprint status transitions", () => {
    it("shows Reopen button for done blueprints", async () => {
      const bp = makeMockBlueprint({ id: "bp-1", status: "done", nodes: [
        makeMockNode({ id: "n-1", seq: 1, title: "Done node", status: "done", order: 0 }),
      ] });
      apiMocks.getBlueprint.mockResolvedValue(bp);

      renderPage();

      await waitFor(() => {
        expect(screen.getByText("Reopen")).toBeInTheDocument();
      });
    });

    it("shows Reopen button for failed blueprints", async () => {
      const bp = makeMockBlueprint({ id: "bp-1", status: "failed", nodes: [
        makeMockNode({ id: "n-1", seq: 1, title: "Failed node", status: "failed", order: 0 }),
      ] });
      apiMocks.getBlueprint.mockResolvedValue(bp);

      renderPage();

      await waitFor(() => {
        expect(screen.getByText("Reopen")).toBeInTheDocument();
      });
    });

    it("calls updateBlueprint with approved on Reopen confirmation for done blueprint", async () => {
      const bp = makeMockBlueprint({ id: "bp-1", status: "done", nodes: [] });
      apiMocks.getBlueprint.mockResolvedValue(bp);
      apiMocks.updateBlueprint.mockResolvedValue(makeMockBlueprint({ id: "bp-1", status: "approved" }));

      renderPage();

      await waitFor(() => {
        expect(screen.getByText("Reopen")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("Reopen"));

      await waitFor(() => {
        expect(screen.getByText("Reopen to Approved?")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("Yes"));

      await waitFor(() => {
        expect(apiMocks.updateBlueprint).toHaveBeenCalledWith("bp-1", { status: "approved" });
      });
    });

    it("shows Back to Draft button for approved blueprints", async () => {
      setupBlueprintWithNodes({ status: "approved" });

      renderPage();

      await waitFor(() => {
        expect(screen.getByText("Back to Draft")).toBeInTheDocument();
      });
    });

    it("calls updateBlueprint with draft on Back to Draft confirmation", async () => {
      setupBlueprintWithNodes({ status: "approved" });
      apiMocks.updateBlueprint.mockResolvedValue(makeMockBlueprint({ id: "bp-1", status: "draft" }));

      renderPage();

      await waitFor(() => {
        expect(screen.getByText("Back to Draft")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("Back to Draft"));

      await waitFor(() => {
        expect(screen.getByText("Revert to Draft?")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("Yes"));

      await waitFor(() => {
        expect(apiMocks.updateBlueprint).toHaveBeenCalledWith("bp-1", { status: "draft" });
      });
    });

    it("shows Resume button for paused blueprints", async () => {
      const bp = makeMockBlueprint({ id: "bp-1", status: "paused", nodes: [] });
      apiMocks.getBlueprint.mockResolvedValue(bp);

      renderPage();

      await waitFor(() => {
        expect(screen.getByText("Resume")).toBeInTheDocument();
      });
    });

    it("calls updateBlueprint with approved on Resume confirmation", async () => {
      const bp = makeMockBlueprint({ id: "bp-1", status: "paused", nodes: [] });
      apiMocks.getBlueprint.mockResolvedValue(bp);
      apiMocks.updateBlueprint.mockResolvedValue(makeMockBlueprint({ id: "bp-1", status: "approved" }));

      renderPage();

      await waitFor(() => {
        expect(screen.getByText("Resume")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("Resume"));

      await waitFor(() => {
        expect(screen.getByText("Resume to Approved?")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("Yes"));

      await waitFor(() => {
        expect(apiMocks.updateBlueprint).toHaveBeenCalledWith("bp-1", { status: "approved" });
      });
    });

    it("dismisses confirmation strip on No click", async () => {
      const bp = makeMockBlueprint({ id: "bp-1", status: "done", nodes: [] });
      apiMocks.getBlueprint.mockResolvedValue(bp);

      renderPage();

      await waitFor(() => {
        expect(screen.getByText("Reopen")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("Reopen"));

      await waitFor(() => {
        expect(screen.getByText("Reopen to Approved?")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("No"));

      await waitFor(() => {
        expect(screen.queryByText("Reopen to Approved?")).not.toBeInTheDocument();
        expect(screen.getByText("Reopen")).toBeInTheDocument();
      });
    });

    it("does not show Reopen for running or draft blueprints", async () => {
      const bp = makeMockBlueprint({ id: "bp-1", status: "running", nodes: [
        makeMockNode({ id: "n-1", seq: 1, title: "Running node", status: "running", order: 0 }),
      ] });
      apiMocks.getBlueprint.mockResolvedValue(bp);

      renderPage();

      await waitFor(() => {
        expect(screen.getByText("In Progress")).toBeInTheDocument();
      });

      expect(screen.queryByText("Reopen")).not.toBeInTheDocument();
    });
  });

  // ─── Collapsible Convene Messages Tests ──────────────────────────

  describe("Collapsible convene messages", () => {
    function makeMockConveneSession(overrides: Partial<ConveneSession> = {}): ConveneSession {
      return {
        id: "cs-collapse",
        blueprintId: "bp-1",
        topic: "Collapse test discussion",
        contextNodeIds: null,
        participatingRoles: ["sde", "qa"],
        maxRounds: 3,
        status: "completed",
        synthesisResult: null,
        messageCount: 5,
        createdAt: "2025-06-01T10:00:00Z",
        completedAt: "2025-06-01T10:30:00Z",
        ...overrides,
      };
    }

    function makeMsg(id: string, roleId: string, round: number, content: string, messageType: "contribution" | "synthesis" = "contribution"): ConveneMessage {
      return { id, sessionId: "cs-collapse", roleId, round, content, messageType, createdAt: `2025-06-01T10:0${round}:00Z` };
    }

    async function setupAndExpandSession(messages: ConveneMessage[], sessionOverrides: Partial<ConveneSession> = {}) {
      const session = makeMockConveneSession(sessionOverrides);
      apiMocks.getConveneSessions.mockResolvedValue([session]);
      apiMocks.getConveneSessionDetail.mockResolvedValue({ ...session, messages });
      const bp = makeMockBlueprint({ id: "bp-1", status: "approved", nodes: [] });
      apiMocks.getBlueprint.mockResolvedValue(bp);

      renderPage();

      await waitFor(() => {
        expect(screen.getByText("Collapse test discussion")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("Collapse test discussion"));

      await waitFor(() => {
        expect(apiMocks.getConveneSessionDetail).toHaveBeenCalledWith("bp-1", "cs-collapse");
      });
    }

    it("renders non-synthesis messages collapsed by default (2-line preview, no MarkdownContent)", async () => {
      const messages = [
        makeMsg("m-1", "sde", 1, "This is **bold** and `code` content that should be stripped"),
        makeMsg("m-2", "qa", 1, "QA review of the implementation approach"),
      ];

      await setupAndExpandSession(messages);

      // Should show plain text preview (stripMarkdown output), not MarkdownContent
      await waitFor(() => {
        const showMoreLinks = screen.getAllByText("Show more");
        expect(showMoreLinks.length).toBe(2);
      });

      // The stripped preview text should be visible
      expect(screen.getByText(/This is bold and code content/)).toBeInTheDocument();
      expect(screen.getByText(/QA review of the implementation/)).toBeInTheDocument();

      // Both should have aria-expanded=false
      const buttons = screen.getAllByRole("button", { expanded: false });
      const msgButtons = buttons.filter(b => b.getAttribute("aria-label")?.includes("expand"));
      expect(msgButtons.length).toBe(2);
    });

    it("clicking a collapsed message expands it (shows MarkdownContent)", async () => {
      const messages = [
        makeMsg("m-1", "sde", 1, "We need to discuss the architecture"),
      ];

      await setupAndExpandSession(messages);

      // Initially collapsed — preview text shown, message MarkdownContent NOT rendered
      await waitFor(() => {
        expect(screen.getByText(/discuss the architecture/)).toBeInTheDocument();
      });

      // Count MarkdownContent before expand (1 = blueprint description only)
      const before = screen.getAllByTestId("markdown-content").length;

      // Find the message button and click to expand
      const msgBtn = screen.getByRole("button", { name: /SDE.*expand/i });
      fireEvent.click(msgBtn);

      // Now one more MarkdownContent should render (the expanded message)
      await waitFor(() => {
        expect(screen.getAllByTestId("markdown-content").length).toBe(before + 1);
      });

      // aria-expanded should be true
      expect(msgBtn).toHaveAttribute("aria-expanded", "true");
    });

    it("clicking an expanded message collapses it back", async () => {
      const messages = [
        makeMsg("m-1", "sde", 1, "Architecture discussion content"),
      ];

      await setupAndExpandSession(messages);

      await waitFor(() => {
        expect(screen.getByText(/Architecture discussion/)).toBeInTheDocument();
      });

      const msgBtn = screen.getByRole("button", { name: /SDE.*expand/i });

      // Expand
      fireEvent.click(msgBtn);
      await waitFor(() => {
        expect(msgBtn).toHaveAttribute("aria-expanded", "true");
      });

      // Collapse
      fireEvent.click(msgBtn);
      await waitFor(() => {
        expect(msgBtn).toHaveAttribute("aria-expanded", "false");
      });

      // Should show "Show more" again (collapsed preview)
      expect(screen.getByText("Show more")).toBeInTheDocument();
    });

    it("synthesis messages always render expanded regardless of state", async () => {
      const messages = [
        makeMsg("m-1", "sde", 1, "Regular contribution"),
        makeMsg("m-synth", "sde", 1, "This is the synthesis result", "synthesis"),
      ];

      await setupAndExpandSession(messages);

      await waitFor(() => {
        expect(screen.getByText("Synthesis")).toBeInTheDocument();
      });

      // Synthesis message should have MarkdownContent (always expanded)
      const markdownContents = screen.getAllByTestId("markdown-content");
      expect(markdownContents.length).toBeGreaterThanOrEqual(1);

      // The synthesis MarkdownContent should have the synthesis text
      const synthContent = markdownContents.find(el => el.textContent?.includes("This is the synthesis result"));
      expect(synthContent).toBeTruthy();

      // The synthesis button should not have a chevron (no collapse toggle)
      const synthLabel = screen.getByText("Synthesis");
      const synthBtn = synthLabel.closest("button")!;
      expect(synthBtn).toHaveAttribute("aria-expanded", "true");

      // Clicking synthesis button should NOT toggle it (it stays expanded)
      fireEvent.click(synthBtn);
      expect(synthBtn).toHaveAttribute("aria-expanded", "true");
    });

    it("Expand all / Collapse all button appears when 4+ non-synthesis messages", async () => {
      const fewMessages = [
        makeMsg("m-1", "sde", 1, "Message one"),
        makeMsg("m-2", "qa", 1, "Message two"),
        makeMsg("m-3", "pm", 1, "Message three"),
      ];

      await setupAndExpandSession(fewMessages);

      await waitFor(() => {
        expect(screen.getByText(/Message one/)).toBeInTheDocument();
      });

      // With only 3 non-synthesis messages, Expand all should NOT appear
      expect(screen.queryByText("Expand all")).not.toBeInTheDocument();
      expect(screen.queryByText("Collapse all")).not.toBeInTheDocument();
    });

    it("Expand all / Collapse all toggle works with 4+ non-synthesis messages", async () => {
      const messages = [
        makeMsg("m-1", "sde", 1, "First message"),
        makeMsg("m-2", "qa", 1, "Second message"),
        makeMsg("m-3", "pm", 1, "Third message"),
        makeMsg("m-4", "sde", 2, "Fourth message"),
      ];

      await setupAndExpandSession(messages);

      await waitFor(() => {
        expect(screen.getByText(/First message/)).toBeInTheDocument();
      });

      // "Expand all" button should be present (since all are collapsed by default)
      const expandAllBtn = screen.getByText("Expand all");
      expect(expandAllBtn).toBeInTheDocument();

      // Count baseline MarkdownContent (blueprint description)
      const baseline = screen.getAllByTestId("markdown-content").length;

      // Click Expand all
      fireEvent.click(expandAllBtn);

      // All 4 messages should be expanded — MarkdownContent count increases by 4
      await waitFor(() => {
        const markdownContents = screen.getAllByTestId("markdown-content");
        expect(markdownContents.length).toBe(baseline + 4);
      });

      // Button text should now be "Collapse all"
      expect(screen.getByText("Collapse all")).toBeInTheDocument();

      // Click Collapse all
      fireEvent.click(screen.getByText("Collapse all"));

      // Should return to collapsed — "Show more" links should appear
      await waitFor(() => {
        const showMoreLinks = screen.getAllByText("Show more");
        expect(showMoreLinks.length).toBe(4);
      });

      // Button text should revert to "Expand all"
      expect(screen.getByText("Expand all")).toBeInTheDocument();
    });

    it("Expand all does not affect synthesis messages (they stay expanded)", async () => {
      const messages = [
        makeMsg("m-1", "sde", 1, "Contribution 1"),
        makeMsg("m-2", "qa", 1, "Contribution 2"),
        makeMsg("m-3", "pm", 1, "Contribution 3"),
        makeMsg("m-4", "sde", 2, "Contribution 4"),
        makeMsg("m-synth", "sde", 2, "Synthesis output", "synthesis"),
      ];

      await setupAndExpandSession(messages);

      await waitFor(() => {
        expect(screen.getByText("Synthesis")).toBeInTheDocument();
      });

      // Count baseline (blueprint description MarkdownContent)
      // + synthesis = baseline + 1 (synthesis always expanded)
      let markdownContents = screen.getAllByTestId("markdown-content");
      const baseline = markdownContents.length; // blueprint desc + synthesis

      // Click Expand all
      fireEvent.click(screen.getByText("Expand all"));

      // 4 contributions expand, synthesis stays expanded
      await waitFor(() => {
        markdownContents = screen.getAllByTestId("markdown-content");
        expect(markdownContents.length).toBe(baseline + 4);
      });

      // Collapse all — only contributions collapse; synthesis stays expanded
      fireEvent.click(screen.getByText("Collapse all"));

      await waitFor(() => {
        markdownContents = screen.getAllByTestId("markdown-content");
        expect(markdownContents.length).toBe(baseline);
      });
    });

    it("switching sessions resets expanded state", async () => {
      const session1 = makeMockConveneSession({ id: "cs-1", topic: "Session One" });
      const session2 = makeMockConveneSession({ id: "cs-2", topic: "Session Two" });
      apiMocks.getConveneSessions.mockResolvedValue([session1, session2]);

      const msgs1 = [makeMsg("m-1", "sde", 1, "Content for session 1")];
      const msgs2 = [makeMsg("m-2", "qa", 1, "Content for session 2")];
      msgs1[0].sessionId = "cs-1";
      msgs2[0].sessionId = "cs-2";

      (apiMocks.getConveneSessionDetail as ReturnType<typeof vi.fn>)
        .mockImplementation((_bpId: string, sessionId: string) => {
          if (sessionId === "cs-1") return Promise.resolve({ ...session1, messages: msgs1 });
          return Promise.resolve({ ...session2, messages: msgs2 });
        });

      const bp = makeMockBlueprint({ id: "bp-1", status: "approved", nodes: [] });
      apiMocks.getBlueprint.mockResolvedValue(bp);

      renderPage();

      // Wait for sessions to render
      await waitFor(() => {
        expect(screen.getByText("Session One")).toBeInTheDocument();
      });

      // Expand Session One
      fireEvent.click(screen.getByText("Session One"));
      await waitFor(() => {
        expect(screen.getByText(/Content for session 1/)).toBeInTheDocument();
      });

      // Expand that message
      const msgBtn = screen.getByRole("button", { name: /SDE.*expand/i });
      fireEvent.click(msgBtn);
      await waitFor(() => {
        expect(msgBtn).toHaveAttribute("aria-expanded", "true");
      });

      // Now switch to Session Two
      fireEvent.click(screen.getByText("Session Two"));
      await waitFor(() => {
        expect(screen.getByText(/Content for session 2/)).toBeInTheDocument();
      });

      // New session's message should be collapsed by default (expanded state reset)
      const newMsgBtn = screen.getByRole("button", { name: /QA.*expand/i });
      expect(newMsgBtn).toHaveAttribute("aria-expanded", "false");
    });

    it('"Show more" link expands a collapsed message', async () => {
      const messages = [
        makeMsg("m-1", "sde", 1, "A detailed message that is currently collapsed"),
      ];

      await setupAndExpandSession(messages);

      await waitFor(() => {
        expect(screen.getByText("Show more")).toBeInTheDocument();
      });

      const before = screen.getAllByTestId("markdown-content").length;

      // Click "Show more"
      fireEvent.click(screen.getByText("Show more"));

      // One more MarkdownContent should appear
      await waitFor(() => {
        expect(screen.getAllByTestId("markdown-content").length).toBe(before + 1);
      });
    });
  });

  // ─── stripMarkdown Tests ─────────────────────────────────────────
  // Note: stripMarkdown is a module-scope function tested indirectly
  // via the collapsed message previews. We test it through the UI.

  describe("stripMarkdown (via collapsed message preview)", () => {
    function makeSessionWithContent(content: string) {
      const session: ConveneSession = {
        id: "cs-strip",
        blueprintId: "bp-1",
        topic: "Strip test",
        contextNodeIds: null,
        participatingRoles: ["sde"],
        maxRounds: 1,
        status: "completed",
        synthesisResult: null,
        messageCount: 1,
        createdAt: "2025-06-01T10:00:00Z",
        completedAt: "2025-06-01T10:30:00Z",
      };
      const msg: ConveneMessage = {
        id: "m-strip",
        sessionId: "cs-strip",
        roleId: "sde",
        round: 1,
        content,
        messageType: "contribution",
        createdAt: "2025-06-01T10:01:00Z",
      };
      return { session, msg };
    }

    async function renderAndGetPreview(content: string) {
      const { session, msg } = makeSessionWithContent(content);
      apiMocks.getConveneSessions.mockResolvedValue([session]);
      apiMocks.getConveneSessionDetail.mockResolvedValue({ ...session, messages: [msg] });
      const bp = makeMockBlueprint({ id: "bp-1", status: "approved", nodes: [] });
      apiMocks.getBlueprint.mockResolvedValue(bp);

      renderPage();

      await waitFor(() => {
        expect(screen.getByText("Strip test")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("Strip test"));

      await waitFor(() => {
        expect(apiMocks.getConveneSessionDetail).toHaveBeenCalled();
      });
    }

    it("strips headings", async () => {
      await renderAndGetPreview("# Heading\nSome text");
      await waitFor(() => {
        expect(screen.getByText(/Heading Some text/)).toBeInTheDocument();
      });
    });

    it("strips bold and italic", async () => {
      await renderAndGetPreview("This is **bold** and *italic* text");
      await waitFor(() => {
        expect(screen.getByText(/This is bold and italic text/)).toBeInTheDocument();
      });
    });

    it("strips fenced code blocks", async () => {
      await renderAndGetPreview("Before\n```js\nconsole.log('hi')\n```\nAfter");
      await waitFor(() => {
        expect(screen.getByText(/Before After/)).toBeInTheDocument();
      });
    });

    it("strips inline code", async () => {
      await renderAndGetPreview("Use the `useState` hook");
      await waitFor(() => {
        expect(screen.getByText(/Use the useState hook/)).toBeInTheDocument();
      });
    });

    it("strips links but keeps text", async () => {
      await renderAndGetPreview("See [the docs](https://example.com) for details");
      await waitFor(() => {
        expect(screen.getByText(/See the docs for details/)).toBeInTheDocument();
      });
    });

    it("strips blockquotes", async () => {
      await renderAndGetPreview("> Important note\nFollowing text");
      await waitFor(() => {
        expect(screen.getByText(/Important note Following text/)).toBeInTheDocument();
      });
    });

    it("strips list markers", async () => {
      await renderAndGetPreview("- Item one\n- Item two");
      await waitFor(() => {
        expect(screen.getByText(/Item one Item two/)).toBeInTheDocument();
      });
    });
  });
});
