import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AutopilotToggle } from "./AutopilotToggle";
import type { ExecutionMode } from "@/lib/api";

// Mock API
const apiMocks = vi.hoisted(() => ({
  updateBlueprint: vi.fn(() => Promise.resolve({})),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<object>("@/lib/api");
  return { ...actual, ...apiMocks };
});

describe("AutopilotToggle", () => {
  const defaultProps = {
    blueprintId: "bp-1",
    executionMode: "manual" as ExecutionMode,
    blueprintStatus: "approved",
    onUpdate: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders in manual/inactive state with correct classes", () => {
    render(<AutopilotToggle {...defaultProps} />);

    const btn = screen.getByRole("button");
    expect(btn).toHaveTextContent("Manual");
    expect(btn.className).toContain("bg-bg-tertiary");
    expect(btn.className).toContain("text-text-secondary");
  });

  it("renders in autopilot/active state with accent-green classes", () => {
    render(<AutopilotToggle {...defaultProps} executionMode="autopilot" />);

    const btn = screen.getByRole("button");
    expect(btn).toHaveTextContent("Autopilot");
    expect(btn.className).toContain("accent-green");
  });

  it("shows green pulsing dot when active", () => {
    const { container } = render(
      <AutopilotToggle {...defaultProps} executionMode="autopilot" />,
    );

    const dot = container.querySelector(".bg-accent-green.animate-pulse");
    expect(dot).toBeInTheDocument();
  });

  it("shows muted dot when inactive", () => {
    const { container } = render(<AutopilotToggle {...defaultProps} />);

    const dot = container.querySelector(".bg-text-muted");
    expect(dot).toBeInTheDocument();
  });

  it("is disabled (opacity-disabled) when blueprint status is draft", () => {
    render(
      <AutopilotToggle {...defaultProps} blueprintStatus="draft" />,
    );

    const btn = screen.getByRole("button");
    expect(btn).toBeDisabled();
    expect(btn.className).toContain("opacity-disabled");
    expect(btn.className).toContain("cursor-not-allowed");
  });

  it("shows correct tooltip when disabled (draft)", () => {
    render(
      <AutopilotToggle {...defaultProps} blueprintStatus="draft" />,
    );

    const btn = screen.getByRole("button");
    expect(btn).toHaveAttribute("title", "Approve blueprint to enable autopilot");
  });

  it("shows correct tooltip when active", () => {
    render(
      <AutopilotToggle {...defaultProps} executionMode="autopilot" />,
    );

    const btn = screen.getByRole("button");
    expect(btn).toHaveAttribute(
      "title",
      "Autopilot: AI agent drives execution using all available operations",
    );
  });

  it("shows correct tooltip when inactive (manual)", () => {
    render(<AutopilotToggle {...defaultProps} />);

    const btn = screen.getByRole("button");
    expect(btn).toHaveAttribute("title", "Manual: you control execution");
  });

  it("calls onUpdate optimistically and updateBlueprint on click (manual -> autopilot)", async () => {
    render(<AutopilotToggle {...defaultProps} />);

    fireEvent.click(screen.getByRole("button"));

    // Optimistic update called immediately
    expect(defaultProps.onUpdate).toHaveBeenCalledWith({ executionMode: "autopilot" });
    // API called
    await waitFor(() => {
      expect(apiMocks.updateBlueprint).toHaveBeenCalledWith("bp-1", { executionMode: "autopilot" });
    });
  });

  it("calls onUpdate optimistically and updateBlueprint on click (autopilot -> manual)", async () => {
    const onUpdate = vi.fn();
    render(
      <AutopilotToggle {...defaultProps} executionMode="autopilot" onUpdate={onUpdate} />,
    );

    fireEvent.click(screen.getByRole("button"));

    expect(onUpdate).toHaveBeenCalledWith({ executionMode: "manual" });
    await waitFor(() => {
      expect(apiMocks.updateBlueprint).toHaveBeenCalledWith("bp-1", { executionMode: "manual" });
    });
  });

  it("reverts on API error", async () => {
    apiMocks.updateBlueprint.mockRejectedValueOnce(new Error("fail"));
    const onUpdate = vi.fn();
    render(
      <AutopilotToggle {...defaultProps} onUpdate={onUpdate} />,
    );

    fireEvent.click(screen.getByRole("button"));

    // First call: optimistic update to "autopilot"
    expect(onUpdate).toHaveBeenCalledWith({ executionMode: "autopilot" });

    // After error: revert to "manual"
    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith({ executionMode: "manual" });
    });
  });

  it("disables button and shows spinner during toggling", async () => {
    let resolveApi: () => void;
    apiMocks.updateBlueprint.mockImplementationOnce(
      () => new Promise<object>((resolve) => { resolveApi = () => resolve({}); }),
    );
    const { container } = render(<AutopilotToggle {...defaultProps} />);
    const btn = screen.getByRole("button");

    fireEvent.click(btn);

    // Button should be disabled during mutation
    expect(btn).toBeDisabled();
    expect(btn.className).toContain("opacity-disabled");
    // Spinner SVG should be visible
    const spinner = container.querySelector("svg.animate-spin");
    expect(spinner).toBeInTheDocument();
    // Dot should not be visible
    const dot = container.querySelector(".bg-text-muted");
    expect(dot).not.toBeInTheDocument();

    // Resolve the API call
    resolveApi!();
    await waitFor(() => {
      expect(btn).not.toBeDisabled();
    });
    // Spinner should be gone
    expect(container.querySelector("svg.animate-spin")).not.toBeInTheDocument();
  });

  it("does not trigger toggle when disabled (draft)", () => {
    render(
      <AutopilotToggle {...defaultProps} blueprintStatus="draft" />,
    );

    fireEvent.click(screen.getByRole("button"));

    expect(defaultProps.onUpdate).not.toHaveBeenCalled();
    expect(apiMocks.updateBlueprint).not.toHaveBeenCalled();
  });

  it("handles undefined executionMode as manual", () => {
    render(
      <AutopilotToggle {...defaultProps} executionMode={undefined} />,
    );

    const btn = screen.getByRole("button");
    expect(btn).toHaveTextContent("Manual");
    expect(btn.className).toContain("bg-bg-tertiary");
  });

  describe("ARIA accessibility", () => {
    it("has aria-pressed=false when in manual mode", () => {
      render(<AutopilotToggle {...defaultProps} />);
      const btn = screen.getByRole("button");
      expect(btn).toHaveAttribute("aria-pressed", "false");
    });

    it("has aria-pressed=true when in autopilot mode", () => {
      render(<AutopilotToggle {...defaultProps} executionMode="autopilot" />);
      const btn = screen.getByRole("button");
      expect(btn).toHaveAttribute("aria-pressed", "true");
    });

    it("has aria-pressed=false when executionMode is undefined", () => {
      render(<AutopilotToggle {...defaultProps} executionMode={undefined} />);
      const btn = screen.getByRole("button");
      expect(btn).toHaveAttribute("aria-pressed", "false");
    });
  });
});
