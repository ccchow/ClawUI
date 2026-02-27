import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusIndicator } from "./StatusIndicator";

describe("StatusIndicator", () => {
  it("renders with correct title for known status", () => {
    render(<StatusIndicator status="done" />);
    const dot = screen.getByTitle("Completed");
    expect(dot).toBeInTheDocument();
  });

  it("renders 'queued' status with custom label", () => {
    render(<StatusIndicator status="queued" />);
    const dot = screen.getByTitle("Waiting in queue");
    expect(dot).toBeInTheDocument();
  });

  it("applies md size by default", () => {
    render(<StatusIndicator status="pending" />);
    const dot = screen.getByTitle("Pending");
    expect(dot.className).toContain("w-2.5");
    expect(dot.className).toContain("h-2.5");
  });

  it("applies sm size when specified", () => {
    render(<StatusIndicator status="pending" size="sm" />);
    const dot = screen.getByTitle("Pending");
    expect(dot.className).toContain("w-2");
    expect(dot.className).toContain("h-2");
  });

  it("uses correct color class for each status", () => {
    const statusColorMap: Record<string, [string, string]> = {
      pending: ["Pending", "bg-text-muted"],
      running: ["Running", "bg-accent-blue"],
      done: ["Completed", "bg-accent-green"],
      failed: ["Failed", "bg-accent-red"],
      blocked: ["Blocked", "bg-accent-amber"],
    };

    for (const [status, [label, expectedColor]] of Object.entries(statusColorMap)) {
      const { unmount } = render(<StatusIndicator status={status} />);
      const dot = screen.getByTitle(label);
      expect(dot.className).toContain(expectedColor);
      unmount();
    }
  });

  it("falls back to gray for unknown status", () => {
    render(<StatusIndicator status="unknown-status" />);
    const dot = screen.getByTitle("unknown-status");
    expect(dot.className).toContain("bg-gray-400");
  });

  it("renders as a span element with role img", () => {
    render(<StatusIndicator status="done" />);
    const dot = screen.getByRole("img", { name: "Completed" });
    expect(dot.tagName).toBe("SPAN");
  });

  it("has animate-pulse for running status", () => {
    render(<StatusIndicator status="running" />);
    const dot = screen.getByTitle("Running");
    expect(dot.className).toContain("animate-pulse");
  });

  it("has animate-pulse for queued status", () => {
    render(<StatusIndicator status="queued" />);
    const dot = screen.getByTitle("Waiting in queue");
    expect(dot.className).toContain("animate-pulse");
  });

  it("does not have animate-pulse for done status", () => {
    render(<StatusIndicator status="done" />);
    const dot = screen.getByTitle("Completed");
    expect(dot.className).not.toContain("animate-pulse");
  });

  it("renders skipped status with correct label and color", () => {
    render(<StatusIndicator status="skipped" />);
    const dot = screen.getByTitle("Skipped");
    expect(dot).toBeInTheDocument();
    expect(dot.className).toContain("bg-text-muted/50");
  });

  it("renders draft status with correct label", () => {
    render(<StatusIndicator status="draft" />);
    const dot = screen.getByTitle("Draft");
    expect(dot).toBeInTheDocument();
    expect(dot.className).toContain("bg-text-muted");
  });

  it("renders approved status with correct label", () => {
    render(<StatusIndicator status="approved" />);
    const dot = screen.getByTitle("Approved");
    expect(dot).toBeInTheDocument();
    expect(dot.className).toContain("bg-accent-blue");
  });

  it("renders paused status with correct label", () => {
    render(<StatusIndicator status="paused" />);
    const dot = screen.getByTitle("Paused");
    expect(dot).toBeInTheDocument();
    expect(dot.className).toContain("bg-accent-amber");
  });

  it("has correct aria-label for all standard statuses", () => {
    const expectedLabels: Record<string, string> = {
      pending: "Pending",
      running: "Running",
      done: "Completed",
      failed: "Failed",
      blocked: "Blocked",
      skipped: "Skipped",
      queued: "Waiting in queue",
      draft: "Draft",
      approved: "Approved",
      paused: "Paused",
    };

    for (const [status, label] of Object.entries(expectedLabels)) {
      const { unmount } = render(<StatusIndicator status={status} />);
      const dot = screen.getByRole("img", { name: label });
      expect(dot).toBeInTheDocument();
      unmount();
    }
  });

  it("uses status string as aria-label for unknown statuses", () => {
    render(<StatusIndicator status="custom-state" />);
    const dot = screen.getByRole("img", { name: "custom-state" });
    expect(dot).toBeInTheDocument();
  });

  it("renders inline-block with rounded-full", () => {
    render(<StatusIndicator status="done" />);
    const dot = screen.getByTitle("Completed");
    expect(dot.className).toContain("inline-block");
    expect(dot.className).toContain("rounded-full");
  });

  it("has flex-shrink-0 to prevent collapsing in flex containers", () => {
    render(<StatusIndicator status="done" />);
    const dot = screen.getByTitle("Completed");
    expect(dot.className).toContain("flex-shrink-0");
  });
});
