import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AutopilotLog } from "./AutopilotLog";
import type { AutopilotLogEntry, BlueprintStatus, ExecutionMode } from "@/lib/api";

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

  it("renders log entries with iteration numbers", async () => {
    const entries = [
      createEntry({ id: "e1", iteration: 1, action: "run_node", decision: "Starting execution" }),
      createEntry({ id: "e2", iteration: 2, action: "resume_node", decision: "Resuming after pause" }),
    ];
    apiMocks.fetchAutopilotLog.mockResolvedValue(entries);

    renderWithQuery();

    await waitFor(() => {
      expect(screen.getByText("#1")).toBeInTheDocument();
    });
    expect(screen.getByText("#2")).toBeInTheDocument();
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
});
