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
});
