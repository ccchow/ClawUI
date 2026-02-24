import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { computeDepLayout, DepGutter, type DepRowLayout } from "./DependencyGraph";
import type { MacroNode } from "@/lib/api";

function makeMockNode(overrides: Partial<MacroNode>): MacroNode {
  return {
    id: "node-1",
    blueprintId: "bp-1",
    order: 0,
    title: "Test Node",
    description: "",
    status: "pending",
    dependencies: [],
    inputArtifacts: [],
    outputArtifacts: [],
    executions: [],
    createdAt: "2025-01-01",
    updatedAt: "2025-01-01",
    ...overrides,
  };
}

describe("computeDepLayout", () => {
  it("returns empty array for empty displayedNodes", () => {
    const result = computeDepLayout([], []);
    expect(result).toEqual([]);
  });

  it("returns layouts with no segments when there are no dependencies", () => {
    const nodes = [
      makeMockNode({ id: "a", order: 0 }),
      makeMockNode({ id: "b", order: 1 }),
    ];
    const result = computeDepLayout(nodes, nodes);
    expect(result).toHaveLength(2);
    result.forEach((row) => {
      expect(row.segments).toEqual([]);
      expect(row.totalLanes).toBe(0);
    });
  });

  it("creates edges for dependencies between displayed nodes", () => {
    const nodeA = makeMockNode({ id: "a", order: 0, status: "done" });
    const nodeB = makeMockNode({ id: "b", order: 1, dependencies: ["a"] });
    const nodes = [nodeA, nodeB];
    const result = computeDepLayout(nodes, nodes);

    expect(result).toHaveLength(2);
    expect(result[0].totalLanes).toBe(1);
    // First row should have a "top" segment, second row a "bottom" segment
    expect(result[0].segments.some((s) => s.type === "top")).toBe(true);
    expect(result[1].segments.some((s) => s.type === "bottom")).toBe(true);
  });

  it("assigns lanes to non-overlapping edges", () => {
    const nodeA = makeMockNode({ id: "a", order: 0, status: "done" });
    const nodeB = makeMockNode({ id: "b", order: 1, status: "done" });
    const nodeC = makeMockNode({ id: "c", order: 2, dependencies: ["a", "b"] });
    const nodes = [nodeA, nodeB, nodeC];
    const result = computeDepLayout(nodes, nodes);

    expect(result).toHaveLength(3);
    // Middle row should have pass-through segments
    expect(result[1].segments.length).toBeGreaterThan(0);
  });

  it("handles dependencies to nodes not displayed", () => {
    const nodeA = makeMockNode({ id: "a", order: 0 });
    const nodeC = makeMockNode({ id: "c", order: 2, dependencies: ["b"] }); // b not displayed
    const displayed = [nodeA, nodeC];
    const all = [nodeA, makeMockNode({ id: "b", order: 1 }), nodeC];
    const result = computeDepLayout(all, displayed);

    // Should have no edges since 'b' is not in displayed
    expect(result[0].segments).toEqual([]);
    expect(result[1].segments).toEqual([]);
  });

  it("uses running color for running status nodes", () => {
    const nodeA = makeMockNode({ id: "a", order: 0, status: "running" });
    const nodeB = makeMockNode({ id: "b", order: 1, dependencies: ["a"] });
    const nodes = [nodeA, nodeB];
    const result = computeDepLayout(nodes, nodes);

    const segments = result.flatMap((r) => r.segments);
    expect(segments.some((s) => s.animate === true)).toBe(true);
    expect(segments.some((s) => s.color === "#3b82f6")).toBe(true); // blue for running
  });
});

describe("DepGutter", () => {
  it("renders status dot", () => {
    const layout: DepRowLayout = { segments: [], totalLanes: 1 };
    const { container } = render(<DepGutter layout={layout} status="done" />);
    expect(container.firstChild).toBeInTheDocument();
  });

  it("renders running status when running prop is true", () => {
    const layout: DepRowLayout = { segments: [], totalLanes: 1 };
    const { container } = render(
      <DepGutter layout={layout} status="pending" running={true} />,
    );
    // SVG circle should use running color (blue) and pulse animation
    const circle = container.querySelector("circle");
    expect(circle).toBeInTheDocument();
    expect(circle?.getAttribute("fill")).toBe("#3b82f6");
    expect(circle?.classList.contains("animate-pulse")).toBe(true);
  });

  it("renders queued status when reevaluateQueued is true", () => {
    const layout: DepRowLayout = { segments: [], totalLanes: 1 };
    const { container } = render(
      <DepGutter layout={layout} status="done" reevaluateQueued={true} />,
    );
    // SVG circle should use queued color (amber) and pulse animation
    const circle = container.querySelector("circle");
    expect(circle).toBeInTheDocument();
    expect(circle?.getAttribute("fill")).toBe("#f59e0b");
    expect(circle?.classList.contains("animate-pulse")).toBe(true);
  });
});
