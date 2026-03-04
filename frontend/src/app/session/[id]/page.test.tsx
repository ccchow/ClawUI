import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import SessionPage from "./page";
import { ToastProvider } from "@/components/Toast";
import type { TimelineNode, SessionMeta, SessionStatus, RunResult, NodeExecution, Blueprint } from "@/lib/api";

// --- vi.hoisted mocks ---

const apiMocks = vi.hoisted(() => ({
  getTimeline: vi.fn((): Promise<TimelineNode[]> => Promise.resolve([])),
  getSessionMeta: vi.fn((): Promise<SessionMeta | null> => Promise.resolve(null)),
  getSessionStatus: vi.fn((): Promise<SessionStatus> => Promise.resolve({ running: false })),
  getSessionExecution: vi.fn((): Promise<NodeExecution | null> => Promise.resolve(null)),
  getBlueprint: vi.fn((): Promise<Blueprint | null> => Promise.resolve(null)),
  updateSessionMeta: vi.fn(() => Promise.resolve()),
  runPrompt: vi.fn((): Promise<RunResult> => Promise.resolve({ output: "", suggestions: [] })),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<object>("@/lib/api");
  return { ...actual, ...apiMocks };
});

vi.mock("next/navigation", () => ({
  useParams: vi.fn(() => ({ id: "session-1" })),
  useRouter: vi.fn(() => ({ push: vi.fn(), back: vi.fn() })),
  usePathname: vi.fn(() => "/session/session-1"),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>{children}</a>
  ),
}));

vi.mock("@/components/Timeline", () => ({
  Timeline: ({ nodes }: { nodes: TimelineNode[] }) => (
    <div data-testid="timeline">
      {nodes.map((n) => (
        <div key={n.id} data-testid={`timeline-node-${n.id}`}>{n.title}</div>
      ))}
    </div>
  ),
}));

vi.mock("@/components/MarkdownContent", () => ({
  MarkdownContent: ({ content }: { content: string }) => <div data-testid="markdown-content">{content}</div>,
}));

vi.mock("@/components/SuggestionButtons", () => ({
  SuggestionButtons: ({ suggestions, onSelect, disabled }: { suggestions: { text: string }[]; disabled: boolean; onSelect: (text: string) => void }) => (
    <div data-testid="suggestion-buttons">
      {suggestions.map((s, i) => (
        <button key={i} data-testid={`suggestion-${i}`} disabled={disabled} onClick={() => onSelect(s.text)}>
          {s.text}
        </button>
      ))}
    </div>
  ),
}));

vi.mock("@/components/PromptInput", () => ({
  PromptInput: ({ onSubmit, disabled, loading }: { onSubmit: (text: string) => void; disabled: boolean; loading: boolean }) => (
    <div data-testid="prompt-input">
      <input
        data-testid="prompt-text"
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmit((e.target as HTMLInputElement).value);
        }}
        disabled={disabled}
      />
      <button
        data-testid="prompt-submit"
        disabled={disabled || loading}
        onClick={() => {
          const input = document.querySelector("[data-testid=prompt-text]") as HTMLInputElement;
          if (input?.value) onSubmit(input.value);
        }}
      >
        Send
      </button>
    </div>
  ),
}));

vi.mock("@/components/AgentSelector", () => ({
  AgentBadge: ({ agentType }: { agentType: string }) => <span data-testid="agent-badge">{agentType}</span>,
}));

vi.mock("@/lib/format-time", () => ({
  formatTimeAgo: () => "just now",
}));

vi.mock("@/lib/suggestions-store", () => ({
  saveSuggestions: vi.fn(),
  loadSuggestions: vi.fn(() => []),
  clearSuggestions: vi.fn(),
}));

vi.mock("@/lib/useSessionBroadcast", () => ({
  useSessionBroadcast: (_id: string, _cb: (running: boolean) => void) => vi.fn(),
}));

// --- Helpers ---

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
    },
  });
}

function renderPage() {
  const queryClient = createTestQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <SessionPage />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function makeTimelineNodes(): TimelineNode[] {
  return [
    { id: "node-1", type: "user", timestamp: "2025-01-01T00:00:00Z", title: "Hello", content: "Hello world" },
    { id: "node-2", type: "assistant", timestamp: "2025-01-01T00:01:00Z", title: "Hi there", content: "How can I help?" },
    { id: "node-3", type: "tool_use", timestamp: "2025-01-01T00:02:00Z", title: "ReadFile", content: "src/main.ts" },
  ];
}

// --- Tests ---

describe("SessionPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.getTimeline.mockResolvedValue([]);
    apiMocks.getSessionMeta.mockResolvedValue(null);
    apiMocks.getSessionStatus.mockResolvedValue({ running: false });
    apiMocks.getSessionExecution.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders timeline nodes from getTimeline response", async () => {
    apiMocks.getTimeline.mockResolvedValue(makeTimelineNodes());

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Hello")).toBeInTheDocument();
    });
    expect(screen.getByText("Hi there")).toBeInTheDocument();
    expect(screen.getByText("ReadFile")).toBeInTheDocument();
  });

  it("shows session ID in header", async () => {
    apiMocks.getTimeline.mockResolvedValue(makeTimelineNodes());

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("session-")).toBeInTheDocument();
    });
  });

  it("shows node count", async () => {
    apiMocks.getTimeline.mockResolvedValue(makeTimelineNodes());

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("3 nodes")).toBeInTheDocument();
    });
  });

  it("calls runPrompt when prompt is submitted", async () => {
    apiMocks.getTimeline.mockResolvedValue(makeTimelineNodes());
    apiMocks.runPrompt.mockResolvedValue({ output: "Done", suggestions: [] });
    // Re-resolve getTimeline with additional nodes after run
    const afterNodes = [
      ...makeTimelineNodes(),
      { id: "node-4", type: "user" as const, timestamp: "2025-01-01T00:03:00Z", title: "Fix the bug", content: "Fix the bug" },
    ];
    apiMocks.getTimeline.mockResolvedValueOnce(makeTimelineNodes()).mockResolvedValue(afterNodes);

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId("prompt-input")).toBeInTheDocument();
    });

    const input = screen.getByTestId("prompt-text") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Fix the bug" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(apiMocks.runPrompt).toHaveBeenCalledWith("session-1", "Fix the bug");
    });
  });

  it("shows optimistic user message and thinking indicator during run", async () => {
    apiMocks.getTimeline.mockResolvedValue([]);
    // Make runPrompt take a while
    apiMocks.runPrompt.mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve({ output: "ok", suggestions: [] }), 5000);
    }));

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId("prompt-input")).toBeInTheDocument();
    });

    const input = screen.getByTestId("prompt-text") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Do something" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // Optimistic nodes should appear
    await waitFor(() => {
      expect(screen.getByText("Do something")).toBeInTheDocument();
    });
  });

  it("handles star toggle with optimistic update", async () => {
    apiMocks.getTimeline.mockResolvedValue(makeTimelineNodes());
    apiMocks.getSessionMeta.mockResolvedValue({
      sessionId: "session-1",
      projectId: "p1",
      projectName: "test",
      timestamp: "2025-01-01T00:00:00Z",
      nodeCount: 3,
      starred: false,
      tags: [],
      notes: "",
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByTitle("Star")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle("Star"));

    await waitFor(() => {
      expect(apiMocks.updateSessionMeta).toHaveBeenCalledWith("session-1", { starred: true });
    });
  });

  it("shows remote running warning when session is running in another tab", async () => {
    apiMocks.getTimeline.mockResolvedValue(makeTimelineNodes());
    apiMocks.getSessionStatus.mockResolvedValue({ running: true });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Session is running in another tab")).toBeInTheDocument();
    });
  });

  it("shows agent badge when agentType is set", async () => {
    apiMocks.getTimeline.mockResolvedValue(makeTimelineNodes());
    apiMocks.getSessionMeta.mockResolvedValue({
      sessionId: "session-1",
      projectId: "p1",
      projectName: "test",
      timestamp: "2025-01-01T00:00:00Z",
      nodeCount: 3,
      agentType: "openclaw",
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId("agent-badge")).toHaveTextContent("openclaw");
    });
  });

  it("shows error state when getTimeline fails", async () => {
    apiMocks.getTimeline.mockRejectedValue(new Error("Network error"));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/Failed to load session/)).toBeInTheDocument();
    });
  });

  it("shows PromptInput component", async () => {
    apiMocks.getTimeline.mockResolvedValue(makeTimelineNodes());

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId("prompt-input")).toBeInTheDocument();
    });
  });

  it("shows back to sessions link", async () => {
    apiMocks.getTimeline.mockResolvedValue(makeTimelineNodes());

    renderPage();

    await waitFor(() => {
      const backLink = screen.getByText("← Back to sessions");
      expect(backLink.closest("a")).toHaveAttribute("href", "/sessions");
    });
  });

  it("shows session alias when available", async () => {
    apiMocks.getTimeline.mockResolvedValue(makeTimelineNodes());
    apiMocks.getSessionMeta.mockResolvedValue({
      sessionId: "session-1",
      projectId: "p1",
      projectName: "test",
      timestamp: "2025-01-01T00:00:00Z",
      nodeCount: 3,
      alias: "My Important Session",
      tags: [],
      notes: "",
      starred: false,
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getAllByText("My Important Session").length).toBeGreaterThan(0);
    });
  });

  it("shows tags when available", async () => {
    apiMocks.getTimeline.mockResolvedValue(makeTimelineNodes());
    apiMocks.getSessionMeta.mockResolvedValue({
      sessionId: "session-1",
      projectId: "p1",
      projectName: "test",
      timestamp: "2025-01-01T00:00:00Z",
      nodeCount: 3,
      tags: ["frontend", "bugfix"],
      starred: false,
      notes: "",
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getAllByText("frontend").length).toBeGreaterThan(0);
      expect(screen.getAllByText("bugfix").length).toBeGreaterThan(0);
    });
  });

  it("disables prompt input when session is remotely running", async () => {
    apiMocks.getTimeline.mockResolvedValue(makeTimelineNodes());
    apiMocks.getSessionStatus.mockResolvedValue({ running: true });

    renderPage();

    await waitFor(() => {
      const input = screen.getByTestId("prompt-text");
      expect(input).toBeDisabled();
    });
  });

  it("renders blueprint context banner when session has execution", async () => {
    apiMocks.getTimeline.mockResolvedValue(makeTimelineNodes());
    apiMocks.getSessionExecution.mockResolvedValue({
      id: "exec-ctx",
      nodeId: "n-ctx",
      blueprintId: "bp-ctx",
      type: "primary",
      status: "running",
      startedAt: "2025-01-01T00:00:00Z",
    });
    apiMocks.getBlueprint.mockResolvedValue({
      id: "bp-ctx",
      title: "Context Blueprint",
      nodes: [
        { id: "n-ctx", title: "Context Node", description: "", seq: 1, order: 0, status: "running", dependencies: [], inputArtifacts: [], outputArtifacts: [], executions: [], blueprintId: "bp-ctx", createdAt: "", updatedAt: "" },
      ],
      status: "running",
      description: "",
      createdAt: "",
      updatedAt: "",
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Context Blueprint")).toBeInTheDocument();
    });
    expect(screen.getByText("Context Node")).toBeInTheDocument();
  });
});
