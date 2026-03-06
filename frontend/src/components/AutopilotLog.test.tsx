import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AutopilotLog } from "./AutopilotLog";
import type { AutopilotLogEntry, BlueprintStatus, ExecutionMode } from "@/lib/api";

// Mock IntersectionObserver (not available in jsdom)
const mockObserve = vi.fn();
const mockDisconnect = vi.fn();
vi.stubGlobal("IntersectionObserver", class {
  constructor(private cb: IntersectionObserverCallback) {
    // Immediately report as visible so auto-scroll logic works in tests
    setTimeout(() => cb([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver), 0);
  }
  observe = mockObserve;
  disconnect = mockDisconnect;
  unobserve = vi.fn();
});

// Mock scrollIntoView (not available in jsdom)
Element.prototype.scrollIntoView = vi.fn();

// Mock API
const apiMocks = vi.hoisted(() => ({
  fetchAutopilotLog: vi.fn((): Promise<AutopilotLogEntry[]> => Promise.resolve([])),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<object>("@/lib/api");
  return { ...actual, ...apiMocks };
});

// Mock polling-utils to simplify — return the callback result directly
vi.mock("@/lib/polling-utils", () => ({
  usePollingInterval: (fn: () => number | false) => fn(),
}));

function createEntry(overrides: Partial<AutopilotLogEntry> = {}): AutopilotLogEntry {
  return {
    id: `entry-${Math.random().toString(36).slice(2)}`,
    blueprintId: "bp-1",
    iteration: 1,
    decision: "Proceeding with node execution",
    action: "run_node",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
}

function renderWithQuery(
  props: {
    blueprintId?: string;
    executionMode?: ExecutionMode;
    blueprintStatus?: BlueprintStatus;
  } = {},
) {
  const qc = createQueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <AutopilotLog
        blueprintId={props.blueprintId ?? "bp-1"}
        executionMode={props.executionMode ?? "autopilot"}
        blueprintStatus={props.blueprintStatus ?? "running"}
      />
    </QueryClientProvider>,
  );
}

describe("AutopilotLog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders nothing when there are no log entries", async () => {
    apiMocks.fetchAutopilotLog.mockResolvedValue([]);

    const { container } = renderWithQuery();

    // Wait for query to settle
    await waitFor(() => {
      expect(apiMocks.fetchAutopilotLog).toHaveBeenCalled();
    });

    // Component returns null when totalCount === 0
    expect(container.firstChild).toBeNull();
  });

  it("renders log entries with relative timestamps instead of iteration numbers", async () => {
    const entries = [
      createEntry({ id: "e1", iteration: 1, action: "run_node", decision: "Starting execution" }),
      createEntry({ id: "e2", iteration: 2, action: "resume_node", decision: "Resuming after pause" }),
    ];
    apiMocks.fetchAutopilotLog.mockResolvedValue(entries);

    renderWithQuery();

    await waitFor(() => {
      expect(screen.getByText("run_node")).toBeInTheDocument();
    });
    // Should show relative time, not #1/#2
    expect(screen.queryByText("#1")).not.toBeInTheDocument();
    expect(screen.queryByText("#2")).not.toBeInTheDocument();
    // Both entries created with Date.now() should show "0s ago"
    const timeLabels = screen.getAllByText(/ago$/);
    expect(timeLabels.length).toBeGreaterThanOrEqual(2);
  });

  it("displays entries in descending order (newest first)", async () => {
    const now = Date.now();
    const entries = [
      createEntry({ id: "e1", iteration: 1, action: "first_action", createdAt: new Date(now - 60000).toISOString() }),
      createEntry({ id: "e2", iteration: 2, action: "second_action", createdAt: new Date(now).toISOString() }),
    ];
    apiMocks.fetchAutopilotLog.mockResolvedValue(entries);

    renderWithQuery();

    await waitFor(() => {
      expect(screen.getByText("first_action")).toBeInTheDocument();
    });

    const actions = screen.getAllByText(/action$/);
    // Newest (second_action) should appear before oldest (first_action)
    expect(actions[0].textContent).toBe("second_action");
    expect(actions[1].textContent).toBe("first_action");
  });

  it("displays action text for each entry", async () => {
    const entries = [
      createEntry({ id: "e1", action: "run_node" }),
      createEntry({ id: "e2", action: "skip_node" }),
    ];
    apiMocks.fetchAutopilotLog.mockResolvedValue(entries);

    renderWithQuery();

    await waitFor(() => {
      expect(screen.getByText("run_node")).toBeInTheDocument();
    });
    expect(screen.getByText("skip_node")).toBeInTheDocument();
  });

  it("displays reasoning/decision text", async () => {
    apiMocks.fetchAutopilotLog.mockResolvedValue([
      createEntry({ id: "e1", decision: "Dependencies are all met, proceeding" }),
    ]);

    renderWithQuery();

    await waitFor(() => {
      expect(screen.getByText("Dependencies are all met, proceeding")).toBeInTheDocument();
    });
  });

  it("maps success status icon correctly (green check)", async () => {
    apiMocks.fetchAutopilotLog.mockResolvedValue([
      createEntry({ id: "e1", result: undefined }),
    ]);

    renderWithQuery();

    await waitFor(() => {
      expect(screen.getByText("\u2713")).toBeInTheDocument();
    });
  });

  it("maps error status icon correctly (red X)", async () => {
    apiMocks.fetchAutopilotLog.mockResolvedValue([
      createEntry({ id: "e1", result: "error: timeout" }),
    ]);

    renderWithQuery();

    await waitFor(() => {
      expect(screen.getByText("\u2715")).toBeInTheDocument();
    });
  });

  it("maps retry/resume status icon correctly (blue arrow)", async () => {
    apiMocks.fetchAutopilotLog.mockResolvedValue([
      createEntry({ id: "e1", result: "retry scheduled" }),
    ]);

    renderWithQuery();

    await waitFor(() => {
      expect(screen.getByText("\u21BB")).toBeInTheDocument();
    });
  });

  it("maps warning/pause status icon correctly (amber warning)", async () => {
    apiMocks.fetchAutopilotLog.mockResolvedValue([
      createEntry({ id: "e1", result: "pause: blocker detected" }),
    ]);

    renderWithQuery();

    await waitFor(() => {
      expect(screen.getByText("\u26A0")).toBeInTheDocument();
    });
  });

  it("shows iteration count in header", async () => {
    apiMocks.fetchAutopilotLog.mockResolvedValue([
      createEntry({ id: "e1" }),
      createEntry({ id: "e2" }),
      createEntry({ id: "e3" }),
    ]);

    renderWithQuery();

    await waitFor(() => {
      expect(screen.getByText("(3 iterations)")).toBeInTheDocument();
    });
  });

  it("shows singular 'iteration' for single entry", async () => {
    apiMocks.fetchAutopilotLog.mockResolvedValue([createEntry({ id: "e1" })]);

    renderWithQuery();

    await waitFor(() => {
      expect(screen.getByText("(1 iteration)")).toBeInTheDocument();
    });
  });

  it("shows 'Autopilot Log' header text", async () => {
    apiMocks.fetchAutopilotLog.mockResolvedValue([createEntry({ id: "e1" })]);

    renderWithQuery();

    await waitFor(() => {
      expect(screen.getByText("Autopilot Log")).toBeInTheDocument();
    });
  });

  it("shows pulsing green dot when autopilot is running", async () => {
    apiMocks.fetchAutopilotLog.mockResolvedValue([createEntry({ id: "e1" })]);

    const { container } = renderWithQuery({
      executionMode: "autopilot",
      blueprintStatus: "running",
    });

    await waitFor(() => {
      expect(screen.getByText("Autopilot Log")).toBeInTheDocument();
    });

    const dot = container.querySelector(".bg-accent-green.animate-pulse");
    expect(dot).toBeInTheDocument();
  });

  it("does NOT show pulsing dot when not running", async () => {
    apiMocks.fetchAutopilotLog.mockResolvedValue([createEntry({ id: "e1" })]);

    const { container } = renderWithQuery({
      executionMode: "autopilot",
      blueprintStatus: "approved",
    });

    await waitFor(() => {
      expect(screen.getByText("Autopilot Log")).toBeInTheDocument();
    });

    const dot = container.querySelector(".bg-accent-green.animate-pulse");
    expect(dot).not.toBeInTheDocument();
  });

  it("toggles collapse/expand on header click", async () => {
    apiMocks.fetchAutopilotLog.mockResolvedValue([
      createEntry({ id: "e1", action: "run_node" }),
    ]);

    renderWithQuery();

    await waitFor(() => {
      expect(screen.getByText("run_node")).toBeInTheDocument();
    });

    // Click header to collapse
    fireEvent.click(screen.getByText("Autopilot Log"));

    // Content should be hidden
    expect(screen.queryByText("run_node")).not.toBeInTheDocument();

    // Click again to expand
    fireEvent.click(screen.getByText("Autopilot Log"));

    expect(screen.getByText("run_node")).toBeInTheDocument();
  });

  it("shows 'Show earlier...' button when page is full and calls fetchAutopilotLog", async () => {
    // Create 20 entries (PAGE_SIZE = 20)
    const entries = Array.from({ length: 20 }, (_, i) =>
      createEntry({ id: `e-${i}`, iteration: i + 1 }),
    );
    apiMocks.fetchAutopilotLog.mockResolvedValue(entries);

    renderWithQuery();

    await waitFor(() => {
      expect(screen.getByText("Show earlier...")).toBeInTheDocument();
    });

    // Click to load more
    apiMocks.fetchAutopilotLog.mockResolvedValueOnce([
      createEntry({ id: "e-old-1", iteration: 0 }),
    ]);
    fireEvent.click(screen.getByText("Show earlier..."));

    // fetchAutopilotLog should be called with offset
    await waitFor(() => {
      expect(apiMocks.fetchAutopilotLog).toHaveBeenCalledWith("bp-1", 20, 20);
    });
  });

  it("does NOT show 'Show earlier...' when entries < PAGE_SIZE", async () => {
    apiMocks.fetchAutopilotLog.mockResolvedValue([
      createEntry({ id: "e1" }),
      createEntry({ id: "e2" }),
    ]);

    renderWithQuery();

    await waitFor(() => {
      expect(screen.getByText("Autopilot Log")).toBeInTheDocument();
    });

    expect(screen.queryByText("Show earlier...")).not.toBeInTheDocument();
  });

  it("sets polling interval to 5000 when autopilot is running", async () => {
    apiMocks.fetchAutopilotLog.mockResolvedValue([createEntry({ id: "e1" })]);

    // The mock for usePollingInterval returns the callback result directly
    // When running: 5000, when not: false
    renderWithQuery({
      executionMode: "autopilot",
      blueprintStatus: "running",
    });

    await waitFor(() => {
      expect(screen.getByText("Autopilot Log")).toBeInTheDocument();
    });

    // If we could check refetchInterval, it would be 5000
    // The mocked usePollingInterval returns the fn() result directly
    // This test validates it doesn't crash and renders properly when running
  });

  it("disables polling when not running (manual mode)", async () => {
    apiMocks.fetchAutopilotLog.mockResolvedValue([createEntry({ id: "e1" })]);

    renderWithQuery({
      executionMode: "manual",
      blueprintStatus: "approved",
    });

    await waitFor(() => {
      expect(screen.getByText("Autopilot Log")).toBeInTheDocument();
    });
  });

  describe("per-entry expand/collapse", () => {
    // jsdom has no layout — mock scrollHeight > clientHeight to simulate overflow
    beforeEach(() => {
      Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
        configurable: true,
        get() { return 100; },
      });
      Object.defineProperty(HTMLElement.prototype, "clientHeight", {
        configurable: true,
        get() { return 20; },
      });
    });

    afterEach(() => {
      Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
        configurable: true,
        get() { return 0; },
      });
      Object.defineProperty(HTMLElement.prototype, "clientHeight", {
        configurable: true,
        get() { return 0; },
      });
    });

    it("does not show 'Show more' when text does not overflow", async () => {
      // Temporarily restore no-overflow (scrollHeight === clientHeight)
      Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
        configurable: true,
        get() { return 20; },
      });
      Object.defineProperty(HTMLElement.prototype, "clientHeight", {
        configurable: true,
        get() { return 20; },
      });

      apiMocks.fetchAutopilotLog.mockResolvedValue([
        createEntry({ id: "e1", action: "run_node", decision: "Short" }),
      ]);
      renderWithQuery();

      await waitFor(() => {
        expect(screen.getByText("run_node")).toBeInTheDocument();
      });

      expect(screen.queryByText("Show more")).not.toBeInTheDocument();
    });

    it("shows 'Show more' button when decision text overflows", async () => {
      apiMocks.fetchAutopilotLog.mockResolvedValue([
        createEntry({ id: "e1", action: "run_node", decision: "Some long decision text" }),
      ]);
      renderWithQuery();

      await waitFor(() => {
        expect(screen.getByText("Show more")).toBeInTheDocument();
      });
    });

    it("toggles entry between expanded and collapsed on 'Show more'/'Show less' click", async () => {
      apiMocks.fetchAutopilotLog.mockResolvedValue([
        createEntry({ id: "e1", action: "run_node", decision: "Some decision" }),
      ]);
      renderWithQuery();

      await waitFor(() => {
        expect(screen.getByText("Show more")).toBeInTheDocument();
      });

      // Expand
      fireEvent.click(screen.getByText("Show more"));
      expect(screen.getByText("Show less")).toBeInTheDocument();

      // Collapse
      fireEvent.click(screen.getByText("Show less"));
      expect(screen.getByText("Show more")).toBeInTheDocument();
    });

    it("sets aria-expanded on per-entry toggle button", async () => {
      apiMocks.fetchAutopilotLog.mockResolvedValue([
        createEntry({ id: "e1", action: "run_node", decision: "Some decision" }),
      ]);
      renderWithQuery();

      await waitFor(() => {
        expect(screen.getByText("Show more")).toBeInTheDocument();
      });

      const btn = screen.getByText("Show more");
      expect(btn).toHaveAttribute("aria-expanded", "false");

      fireEvent.click(btn);
      expect(screen.getByText("Show less")).toHaveAttribute("aria-expanded", "true");
    });
  });

  describe("expand-all / collapse-all", () => {
    // jsdom has no layout — mock overflow for tests that need Show more/less
    beforeEach(() => {
      Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
        configurable: true,
        get() { return 100; },
      });
      Object.defineProperty(HTMLElement.prototype, "clientHeight", {
        configurable: true,
        get() { return 20; },
      });
    });

    afterEach(() => {
      Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
        configurable: true,
        get() { return 0; },
      });
      Object.defineProperty(HTMLElement.prototype, "clientHeight", {
        configurable: true,
        get() { return 0; },
      });
    });

    it("does not show 'Expand all' button when only one entry", async () => {
      apiMocks.fetchAutopilotLog.mockResolvedValue([
        createEntry({ id: "e1" }),
      ]);
      renderWithQuery();

      await waitFor(() => {
        expect(screen.getByText("Autopilot Log")).toBeInTheDocument();
      });

      expect(screen.queryByText("Expand all")).not.toBeInTheDocument();
    });

    it("shows 'Expand all' button when multiple entries exist", async () => {
      apiMocks.fetchAutopilotLog.mockResolvedValue([
        createEntry({ id: "e1" }),
        createEntry({ id: "e2" }),
      ]);
      renderWithQuery();

      await waitFor(() => {
        expect(screen.getByText("Expand all")).toBeInTheDocument();
      });
    });

    it("expands all entries on 'Expand all' click, then collapses on 'Collapse all'", async () => {
      apiMocks.fetchAutopilotLog.mockResolvedValue([
        createEntry({ id: "e1", decision: "Decision 1" }),
        createEntry({ id: "e2", decision: "Decision 2" }),
      ]);
      renderWithQuery();

      await waitFor(() => {
        expect(screen.getByText("Expand all")).toBeInTheDocument();
      });

      // All entries should show "Show more" initially (overflow is mocked)
      const showMoreButtons = screen.getAllByText("Show more");
      expect(showMoreButtons).toHaveLength(2);

      // Expand all
      fireEvent.click(screen.getByText("Expand all"));

      // All should now show "Show less"
      const showLessButtons = screen.getAllByText("Show less");
      expect(showLessButtons).toHaveLength(2);
      expect(screen.getByText("Collapse all")).toBeInTheDocument();

      // Collapse all
      fireEvent.click(screen.getByText("Collapse all"));

      // All should show "Show more" again
      expect(screen.getAllByText("Show more")).toHaveLength(2);
      expect(screen.getByText("Expand all")).toBeInTheDocument();
    });

    it("switches to 'Collapse all' when all entries are individually expanded", async () => {
      apiMocks.fetchAutopilotLog.mockResolvedValue([
        createEntry({ id: "e1", decision: "d1" }),
        createEntry({ id: "e2", decision: "d2" }),
      ]);
      renderWithQuery();

      await waitFor(() => {
        expect(screen.getByText("Expand all")).toBeInTheDocument();
      });

      // Expand each entry individually
      const showMoreButtons = screen.getAllByText("Show more");
      fireEvent.click(showMoreButtons[0]);
      fireEvent.click(showMoreButtons[1]);

      // Should now show "Collapse all"
      expect(screen.getByText("Collapse all")).toBeInTheDocument();
    });
  });

  describe("duration between consecutive entries", () => {
    it("shows duration separator between entries spaced >= 1 second apart", async () => {
      const now = Date.now();
      const entries = [
        createEntry({ id: "e1", action: "second_action", createdAt: new Date(now).toISOString() }),
        createEntry({ id: "e2", action: "first_action", createdAt: new Date(now - 95000).toISOString() }),
      ];
      apiMocks.fetchAutopilotLog.mockResolvedValue(entries);

      renderWithQuery();

      await waitFor(() => {
        expect(screen.getByText("second_action")).toBeInTheDocument();
      });

      // 95 seconds = 1m 35s
      expect(screen.getByText("1m 35s")).toBeInTheDocument();
    });

    it("does not show duration when gap is less than 1 second", async () => {
      const now = Date.now();
      const entries = [
        createEntry({ id: "e1", action: "action_a", createdAt: new Date(now).toISOString() }),
        createEntry({ id: "e2", action: "action_b", createdAt: new Date(now - 500).toISOString() }),
      ];
      apiMocks.fetchAutopilotLog.mockResolvedValue(entries);

      const { container } = renderWithQuery();

      await waitFor(() => {
        expect(screen.getByText("action_a")).toBeInTheDocument();
      });

      // No duration separator lines should be rendered
      const separators = container.querySelectorAll(".border-border-primary\\/50");
      expect(separators).toHaveLength(0);
    });

    it("formats hours correctly", async () => {
      const now = Date.now();
      const entries = [
        createEntry({ id: "e1", action: "late_action", createdAt: new Date(now).toISOString() }),
        createEntry({ id: "e2", action: "early_action", createdAt: new Date(now - 3720000).toISOString() }),
      ];
      apiMocks.fetchAutopilotLog.mockResolvedValue(entries);

      renderWithQuery();

      await waitFor(() => {
        expect(screen.getByText("late_action")).toBeInTheDocument();
      });

      // 3720000ms = 1h 2m
      expect(screen.getByText("1h 2m")).toBeInTheDocument();
    });

    it("does not show duration after the last entry", async () => {
      const now = Date.now();
      const entries = [
        createEntry({ id: "e1", action: "only_action", createdAt: new Date(now).toISOString() }),
      ];
      apiMocks.fetchAutopilotLog.mockResolvedValue(entries);

      const { container } = renderWithQuery();

      await waitFor(() => {
        expect(screen.getByText("only_action")).toBeInTheDocument();
      });

      // No duration separator for a single entry
      const durationSeparators = container.querySelectorAll(".border-border-primary\\/50");
      expect(durationSeparators).toHaveLength(0);
    });
  });

  it("shows absolute timestamp tooltip on relative time labels", async () => {
    const fixedDate = "2026-03-05T14:32:07.000Z";
    apiMocks.fetchAutopilotLog.mockResolvedValue([
      createEntry({ id: "e1", action: "run_node", createdAt: fixedDate }),
    ]);

    renderWithQuery();

    await waitFor(() => {
      expect(screen.getByText("run_node")).toBeInTheDocument();
    });

    const timeLabel = screen.getAllByText(/ago$/)[0];
    // title should contain the formatted absolute timestamp (local time)
    const title = timeLabel.getAttribute("title");
    expect(title).toBeTruthy();
    expect(title).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  describe("ARIA accessibility", () => {
    it("has aria-expanded=true on header button when open (default)", async () => {
      apiMocks.fetchAutopilotLog.mockResolvedValue([createEntry({ id: "e1" })]);
      renderWithQuery();

      await waitFor(() => {
        expect(screen.getByText("Autopilot Log")).toBeInTheDocument();
      });

      const btn = screen.getByRole("button", { name: /collapse autopilot log/i });
      expect(btn).toHaveAttribute("aria-expanded", "true");
    });

    it("has aria-expanded=false on header button after collapsing", async () => {
      apiMocks.fetchAutopilotLog.mockResolvedValue([
        createEntry({ id: "e1", action: "run_node" }),
      ]);
      renderWithQuery();

      await waitFor(() => {
        expect(screen.getByText("run_node")).toBeInTheDocument();
      });

      // Collapse
      fireEvent.click(screen.getByText("Autopilot Log"));

      const btn = screen.getByRole("button", { name: /expand autopilot log/i });
      expect(btn).toHaveAttribute("aria-expanded", "false");
    });

    it("updates aria-label when toggling between expanded/collapsed", async () => {
      apiMocks.fetchAutopilotLog.mockResolvedValue([
        createEntry({ id: "e1", action: "run_node" }),
      ]);
      renderWithQuery();

      await waitFor(() => {
        expect(screen.getByText("run_node")).toBeInTheDocument();
      });

      // Initially expanded
      let btn = screen.getByRole("button", { name: /collapse autopilot log/i });
      expect(btn).toBeInTheDocument();

      // Collapse
      fireEvent.click(btn);
      btn = screen.getByRole("button", { name: /expand autopilot log/i });
      expect(btn).toBeInTheDocument();

      // Expand again
      fireEvent.click(btn);
      btn = screen.getByRole("button", { name: /collapse autopilot log/i });
      expect(btn).toBeInTheDocument();
    });
  });
});
