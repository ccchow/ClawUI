import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PauseBanner } from "./PauseBanner";

// Mock API
const apiMocks = vi.hoisted(() => ({
  updateBlueprint: vi.fn(() => Promise.resolve({})),
  runAllNodes: vi.fn(() => Promise.resolve({ message: "ok" })),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<object>("@/lib/api");
  return { ...actual, ...apiMocks };
});

describe("PauseBanner", () => {
  const defaultProps = {
    blueprintId: "bp-1",
    pauseReason: "Node abc12345 encountered a blocker",
    onUpdate: vi.fn(),
    onInvalidate: vi.fn(),
    onBroadcast: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders pause reason text", () => {
    render(<PauseBanner {...defaultProps} />);

    expect(screen.getByText("Autopilot Paused")).toBeInTheDocument();
    expect(screen.getByText("Node abc12345 encountered a blocker")).toBeInTheDocument();
  });

  it("renders Resume Autopilot and Switch to Manual buttons", () => {
    render(<PauseBanner {...defaultProps} />);

    expect(screen.getByText("Resume Autopilot")).toBeInTheDocument();
    expect(screen.getByText("Switch to Manual")).toBeInTheDocument();
  });

  it("calls updateBlueprint, onUpdate, runAllNodes, onBroadcast, and onInvalidate on Resume click", async () => {
    render(<PauseBanner {...defaultProps} />);

    fireEvent.click(screen.getByText("Resume Autopilot"));

    await waitFor(() => {
      expect(apiMocks.updateBlueprint).toHaveBeenCalledWith("bp-1", { executionMode: "autopilot" });
    });
    expect(defaultProps.onUpdate).toHaveBeenCalledWith({ executionMode: "autopilot" });

    await waitFor(() => {
      expect(apiMocks.runAllNodes).toHaveBeenCalledWith("bp-1");
    });
    expect(defaultProps.onBroadcast).toHaveBeenCalledWith("autopilot_resume");
    expect(defaultProps.onInvalidate).toHaveBeenCalled();
  });

  it("shows 'Resuming...' text while resume is in progress", async () => {
    // Make updateBlueprint hang so we can check loading state
    let resolveUpdate!: () => void;
    apiMocks.updateBlueprint.mockImplementationOnce(
      () => new Promise<object>((res) => { resolveUpdate = () => res({}); }),
    );

    render(<PauseBanner {...defaultProps} />);

    fireEvent.click(screen.getByText("Resume Autopilot"));

    expect(screen.getByText("Resuming...")).toBeInTheDocument();

    // Resolve to clean up
    resolveUpdate();
    await waitFor(() => {
      expect(screen.getByText("Resume Autopilot")).toBeInTheDocument();
    });
  });

  it("disables Resume button while resuming", async () => {
    let resolveUpdate!: () => void;
    apiMocks.updateBlueprint.mockImplementationOnce(
      () => new Promise<object>((res) => { resolveUpdate = () => res({}); }),
    );

    render(<PauseBanner {...defaultProps} />);

    const resumeBtn = screen.getByText("Resume Autopilot");
    fireEvent.click(resumeBtn);

    const btn = screen.getByText("Resuming...").closest("button");
    expect(btn).toBeDisabled();

    resolveUpdate();
    await waitFor(() => {
      expect(screen.getByText("Resume Autopilot")).toBeInTheDocument();
    });
  });

  it("calls updateBlueprint with manual and onUpdate on Switch to Manual click", async () => {
    const onUpdate = vi.fn();
    const onInvalidate = vi.fn();
    render(
      <PauseBanner
        {...defaultProps}
        onUpdate={onUpdate}
        onInvalidate={onInvalidate}
      />,
    );

    fireEvent.click(screen.getByText("Switch to Manual"));

    await waitFor(() => {
      expect(apiMocks.updateBlueprint).toHaveBeenCalledWith("bp-1", { executionMode: "manual" });
      expect(onUpdate).toHaveBeenCalledWith({ executionMode: "manual" });
      expect(onInvalidate).toHaveBeenCalled();
    });
  });

  it("shows Review Issue button when pause reason contains a node ID", () => {
    const onScrollToNode = vi.fn();
    render(
      <PauseBanner {...defaultProps} onScrollToNode={onScrollToNode} />,
    );

    const reviewBtn = screen.getByText("Review Issue");
    expect(reviewBtn).toBeInTheDocument();

    fireEvent.click(reviewBtn);
    expect(onScrollToNode).toHaveBeenCalledWith("abc12345");
  });

  it("does NOT show Review Issue button when no node ID in reason", () => {
    render(
      <PauseBanner
        {...defaultProps}
        pauseReason="General error occurred"
        onScrollToNode={vi.fn()}
      />,
    );

    expect(screen.queryByText("Review Issue")).not.toBeInTheDocument();
  });

  it("does NOT show Review Issue button when onScrollToNode is not provided", () => {
    render(
      <PauseBanner {...defaultProps} />,
    );

    // Even though reason has a node ID, no onScrollToNode -> no button
    expect(screen.queryByText("Review Issue")).not.toBeInTheDocument();
  });

  it("has amber-themed styling", () => {
    const { container } = render(<PauseBanner {...defaultProps} />);

    const banner = container.firstChild as HTMLElement;
    expect(banner.className).toContain("bg-accent-amber");
    expect(banner.className).toContain("border-accent-amber");
  });

  describe("ARIA accessibility", () => {
    it("has role=alert on the banner container", () => {
      render(<PauseBanner {...defaultProps} />);
      const alert = screen.getByRole("alert");
      expect(alert).toBeInTheDocument();
    });

    it("has aria-live=assertive on the banner container", () => {
      render(<PauseBanner {...defaultProps} />);
      const alert = screen.getByRole("alert");
      expect(alert).toHaveAttribute("aria-live", "assertive");
    });

    it("alert region contains the pause reason text", () => {
      render(<PauseBanner {...defaultProps} />);
      const alert = screen.getByRole("alert");
      expect(alert).toHaveTextContent("Node abc12345 encountered a blocker");
    });
  });
});
