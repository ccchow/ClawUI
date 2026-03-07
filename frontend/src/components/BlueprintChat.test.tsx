import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BlueprintChat } from "./BlueprintChat";
import type { AutopilotLogEntry, AutopilotMessage, ExecutionMode, BlueprintStatus } from "@/lib/api";

// --- vi.hoisted mocks ---

const apiMocks = vi.hoisted(() => ({
  fetchAutopilotLog: vi.fn((): Promise<AutopilotLogEntry[]> => Promise.resolve([])),
  getBlueprintMessages: vi.fn(() => Promise.resolve({ messages: [] as AutopilotMessage[], total: 0 })),
  sendBlueprintMessage: vi.fn(() =>
    Promise.resolve({
      id: "msg-new",
      blueprintId: "bp-1",
      role: "user" as const,
      content: "",
      acknowledged: false,
      createdAt: new Date().toISOString(),
    }),
  ),
  updateBlueprint: vi.fn(() => Promise.resolve({})),
  runAllNodes: vi.fn(() => Promise.resolve({ message: "ok", blueprintId: "bp-1" })),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<object>("@/lib/api");
  return { ...actual, ...apiMocks };
});

// --- Helpers ---

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
    },
  });
}

interface RenderChatOptions {
  blueprintId?: string;
  executionMode?: ExecutionMode;
  blueprintStatus?: BlueprintStatus;
  pauseReason?: string;
  isReevaluating?: boolean;
  isRunning?: boolean;
  hasNodes?: boolean;
  onReevaluateAll?: () => void;
  onUpdate?: (patch: { executionMode?: ExecutionMode; status?: string }) => void;
  onInvalidate?: () => void;
  onBroadcast?: (type: string) => void;
  onScrollToNode?: (nodeId: string) => void;
}

function renderChat(opts: RenderChatOptions = {}) {
  const queryClient = createTestQueryClient();
  const props = {
    blueprintId: opts.blueprintId ?? "bp-1",
    executionMode: opts.executionMode ?? ("manual" as ExecutionMode),
    blueprintStatus: opts.blueprintStatus ?? ("approved" as BlueprintStatus),
    pauseReason: opts.pauseReason,
    isReevaluating: opts.isReevaluating ?? false,
    isRunning: opts.isRunning ?? false,
    hasNodes: opts.hasNodes ?? true,
    onReevaluateAll: opts.onReevaluateAll ?? vi.fn(),
    onUpdate: opts.onUpdate ?? vi.fn(),
    onInvalidate: opts.onInvalidate ?? vi.fn(),
    onBroadcast: opts.onBroadcast ?? vi.fn(),
    onScrollToNode: opts.onScrollToNode,
  };

  return render(
    <QueryClientProvider client={queryClient}>
      <BlueprintChat {...props} />
    </QueryClientProvider>,
  );
}

// --- Fixtures ---

function makeMessage(overrides: Partial<AutopilotMessage> = {}): AutopilotMessage {
  return {
    id: "msg-1",
    blueprintId: "bp-1",
    role: "user",
    content: "Hello autopilot",
    acknowledged: false,
    createdAt: "2025-06-01T12:00:00Z",
    ...overrides,
  };
}

function makeLogEntry(overrides: Partial<AutopilotLogEntry> = {}): AutopilotLogEntry {
  return {
    id: "log-1",
    blueprintId: "bp-1",
    iteration: 1,
    decision: "Decided to run node",
    action: "execute_node",
    result: "success",
    createdAt: "2025-06-01T12:01:00Z",
    ...overrides,
  };
}

// --- Tests ---

describe("BlueprintChat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // jsdom doesn't provide scrollIntoView
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── Rendering tests ──────────────────────────────────────

  describe("rendering", () => {
    it("renders chat input textarea with correct placeholder", async () => {
      renderChat();

      await waitFor(() => {
        expect(
          screen.getByPlaceholderText(/Ask autopilot to generate nodes/),
        ).toBeInTheDocument();
      });
    });

    it("renders user messages as right-aligned bubbles with bg-accent-blue/10", async () => {
      apiMocks.getBlueprintMessages.mockResolvedValue({
        messages: [makeMessage({ content: "Please enrich all nodes" })],
        total: 1,
      });

      renderChat();

      await waitFor(() => {
        expect(screen.getByText("Please enrich all nodes")).toBeInTheDocument();
      });

      // User message bubble has the blue accent styling
      const bubble = screen.getByText("Please enrich all nodes").closest(".rounded-xl");
      expect(bubble).toHaveClass("bg-accent-blue/10");
    });

    it("renders autopilot log entries as left-aligned with status icons", async () => {
      apiMocks.fetchAutopilotLog.mockResolvedValue([
        makeLogEntry({ action: "execute_node", decision: "Running first node", result: "success" }),
      ]);

      renderChat();

      await waitFor(() => {
        expect(screen.getByText("execute_node")).toBeInTheDocument();
      });

      expect(screen.getByText("Running first node")).toBeInTheDocument();
      // Log entry is left-aligned (justify-start parent)
      const wrapper = screen.getByText("execute_node").closest(".flex.justify-start");
      expect(wrapper).toBeInTheDocument();
    });

    it("shows 'Autopilot active' indicator when status is running + executionMode is autopilot", async () => {
      renderChat({ executionMode: "autopilot", blueprintStatus: "running" });

      await waitFor(() => {
        expect(screen.getByText("Autopilot active")).toBeInTheDocument();
      });
    });

    it("shows 'Autopilot active' indicator for FSD mode when running", async () => {
      renderChat({ executionMode: "fsd", blueprintStatus: "running" });

      await waitFor(() => {
        expect(screen.getByText("Autopilot active")).toBeInTheDocument();
      });
    });

    it("shows 'Manual mode' indicator when executionMode is manual", async () => {
      renderChat({ executionMode: "manual", blueprintStatus: "approved" });

      await waitFor(() => {
        expect(screen.getByText("Manual mode")).toBeInTheDocument();
      });
    });

    it("disables input when blueprint is in draft status", async () => {
      renderChat({ blueprintStatus: "draft" });

      await waitFor(() => {
        const textarea = screen.getByPlaceholderText(/Approve the blueprint first/);
        expect(textarea).toBeDisabled();
      });

      // Send button should also be disabled
      expect(screen.getByLabelText("Send message")).toBeDisabled();
    });

    it("shows pause message inline when autopilot is paused with pauseReason", async () => {
      renderChat({
        executionMode: "autopilot",
        blueprintStatus: "paused",
        pauseReason: "Safeguard: node n-1 needs review",
      });

      await waitFor(() => {
        expect(screen.getByText("Autopilot Paused")).toBeInTheDocument();
      });

      expect(screen.getByText("Safeguard: node n-1 needs review")).toBeInTheDocument();
      expect(screen.getByText(/Resume Autopilot/)).toBeInTheDocument();
    });

    it("shows 'Autopilot paused' status indicator when paused", async () => {
      renderChat({
        executionMode: "autopilot",
        blueprintStatus: "paused",
        pauseReason: "Some reason",
      });

      await waitFor(() => {
        expect(screen.getByText("Autopilot paused")).toBeInTheDocument();
      });
    });
  });

  // ─── Interaction tests ──────────────────────────────────────

  describe("interactions", () => {
    it("sends message via sendBlueprintMessage when pressing Enter", async () => {
      apiMocks.sendBlueprintMessage.mockResolvedValue(
        makeMessage({ id: "msg-new", content: "Do something" }),
      );

      renderChat();

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/Ask autopilot/)).toBeInTheDocument();
      });

      const textarea = screen.getByPlaceholderText(/Ask autopilot/);
      fireEvent.change(textarea, { target: { value: "Do something" } });
      fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

      await waitFor(() => {
        expect(apiMocks.sendBlueprintMessage).toHaveBeenCalledWith("bp-1", "Do something");
      });
    });

    it("inserts newline on Shift+Enter (does not send)", async () => {
      renderChat();

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/Ask autopilot/)).toBeInTheDocument();
      });

      const textarea = screen.getByPlaceholderText(/Ask autopilot/) as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "line1" } });
      fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });

      // Should NOT have sent (Shift+Enter should not trigger send)
      expect(apiMocks.sendBlueprintMessage).not.toHaveBeenCalled();
    });

    it("sends message on Send button click", async () => {
      apiMocks.sendBlueprintMessage.mockResolvedValue(
        makeMessage({ id: "msg-new", content: "Run all" }),
      );

      renderChat();

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/Ask autopilot/)).toBeInTheDocument();
      });

      const textarea = screen.getByPlaceholderText(/Ask autopilot/);
      fireEvent.change(textarea, { target: { value: "Run all" } });

      fireEvent.click(screen.getByLabelText("Send message"));

      await waitFor(() => {
        expect(apiMocks.sendBlueprintMessage).toHaveBeenCalledWith("bp-1", "Run all");
      });
    });

    it("disables send button for empty message", async () => {
      renderChat();

      await waitFor(() => {
        expect(screen.getByLabelText("Send message")).toBeDisabled();
      });
    });

    it("clears textarea after sending message", async () => {
      apiMocks.sendBlueprintMessage.mockResolvedValue(
        makeMessage({ id: "msg-new", content: "Test message" }),
      );

      renderChat();

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/Ask autopilot/)).toBeInTheDocument();
      });

      const textarea = screen.getByPlaceholderText(/Ask autopilot/) as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "Test message" } });
      expect(textarea.value).toBe("Test message");

      fireEvent.click(screen.getByLabelText("Send message"));

      await waitFor(() => {
        expect(textarea.value).toBe("");
      });
    });
  });

  // ─── Data fetching / merge tests ────────────────────────────

  describe("data fetching", () => {
    it("merges messages and log entries by timestamp", async () => {
      apiMocks.getBlueprintMessages.mockResolvedValue({
        messages: [
          makeMessage({ id: "msg-1", content: "First message", createdAt: "2025-06-01T12:00:00Z" }),
          makeMessage({ id: "msg-2", content: "Third message", createdAt: "2025-06-01T12:05:00Z" }),
        ],
        total: 2,
      });
      apiMocks.fetchAutopilotLog.mockResolvedValue([
        makeLogEntry({ id: "log-1", action: "Second action", createdAt: "2025-06-01T12:02:00Z" }),
      ]);

      renderChat();

      // Wait for both data sources to load
      await waitFor(() => {
        expect(screen.getByText("First message")).toBeInTheDocument();
      });
      expect(screen.getByText("Second action")).toBeInTheDocument();
      expect(screen.getByText("Third message")).toBeInTheDocument();

      // Verify chronological order in the DOM
      const items = screen.getByText("First message")
        .closest(".space-y-3")!;
      const texts = Array.from(items.querySelectorAll(".text-sm"))
        .map((el) => el.textContent)
        .filter(Boolean);

      expect(texts.indexOf("First message")).toBeLessThan(texts.indexOf("Second action"));
      expect(texts.indexOf("Second action")).toBeLessThan(texts.indexOf("Third message"));
    });

    it("shows empty state message for manual mode", async () => {
      apiMocks.getBlueprintMessages.mockResolvedValue({ messages: [], total: 0 });
      apiMocks.fetchAutopilotLog.mockResolvedValue([]);

      renderChat({ executionMode: "manual" });

      await waitFor(() => {
        expect(
          screen.getByText(/Send messages to queue instructions/),
        ).toBeInTheDocument();
      });
    });

    it("shows empty state message for autopilot mode", async () => {
      apiMocks.getBlueprintMessages.mockResolvedValue({ messages: [], total: 0 });
      apiMocks.fetchAutopilotLog.mockResolvedValue([]);

      renderChat({ executionMode: "autopilot", blueprintStatus: "approved" });

      await waitFor(() => {
        expect(
          screen.getByText(/Send a message to interact with autopilot/),
        ).toBeInTheDocument();
      });
    });

    it("renders system messages as centered bubbles", async () => {
      apiMocks.getBlueprintMessages.mockResolvedValue({
        messages: [
          makeMessage({ id: "msg-sys", role: "system", content: "Autopilot started" }),
        ],
        total: 1,
      });

      renderChat();

      await waitFor(() => {
        expect(screen.getByText("Autopilot started")).toBeInTheDocument();
      });

      const centered = screen.getByText("Autopilot started").closest(".flex.justify-center");
      expect(centered).toBeInTheDocument();
    });
  });

  // ─── Header actions ────────────────────────────────────────

  describe("header actions", () => {
    it("calls onReevaluateAll when Reevaluate button is clicked", async () => {
      const onReevaluateAll = vi.fn();
      renderChat({ hasNodes: true, onReevaluateAll });

      await waitFor(() => {
        expect(screen.getByText("Reevaluate")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("Reevaluate"));
      expect(onReevaluateAll).toHaveBeenCalled();
    });

    it("hides Reevaluate button when hasNodes is false", async () => {
      renderChat({ hasNodes: false });

      await waitFor(() => {
        expect(screen.getByText("Blueprint Chat")).toBeInTheDocument();
      });

      expect(screen.queryByText("Reevaluate")).not.toBeInTheDocument();
    });

    it("disables Reevaluate when isRunning is true", async () => {
      renderChat({ hasNodes: true, isRunning: true });

      await waitFor(() => {
        expect(screen.getByText("Reevaluate")).toBeDisabled();
      });
    });
  });

  // ─── Pause / Resume ────────────────────────────────────────

  describe("pause / resume", () => {
    it("calls updateBlueprint and runAllNodes when Resume is clicked", async () => {
      const onUpdate = vi.fn();
      const onInvalidate = vi.fn();
      const onBroadcast = vi.fn();

      renderChat({
        executionMode: "autopilot",
        blueprintStatus: "paused",
        pauseReason: "Safeguard triggered",
        onUpdate,
        onInvalidate,
        onBroadcast,
      });

      await waitFor(() => {
        expect(screen.getByText(/Resume Autopilot/)).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByText(/Resume Autopilot/));
      });

      await waitFor(() => {
        expect(apiMocks.updateBlueprint).toHaveBeenCalledWith("bp-1", {
          status: "running",
          pauseReason: "",
        });
      });

      expect(apiMocks.runAllNodes).toHaveBeenCalledWith("bp-1", { safeguardGrace: 5 });
      expect(onUpdate).toHaveBeenCalledWith({ status: "running" });
      expect(onBroadcast).toHaveBeenCalledWith("autopilot_resume");
    });

    it("shows 'Resume FSD' for FSD mode", async () => {
      renderChat({
        executionMode: "fsd",
        blueprintStatus: "paused",
        pauseReason: "Node failed",
      });

      await waitFor(() => {
        expect(screen.getByText(/Resume FSD/)).toBeInTheDocument();
      });

      expect(screen.getByText("FSD Paused")).toBeInTheDocument();
    });
  });
});
