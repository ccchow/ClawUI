import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MacroNodeCard } from "./MacroNodeCard";
import type { MacroNode } from "@/lib/api";

// Mock next/link
vi.mock("next/link", () => ({
  default: ({ href, children, className, onClick }: { href: string; children: React.ReactNode; className?: string; onClick?: (e: React.MouseEvent) => void }) => (
    <a href={href} className={className} onClick={onClick}>{children}</a>
  ),
}));

// Mock API functions
vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<object>("@/lib/api");
  return {
    ...actual,
    runNode: vi.fn(() => Promise.resolve({ id: "exec-1", status: "running" })),
    updateMacroNode: vi.fn(() => Promise.resolve({ id: "n1" })),
    deleteMacroNode: vi.fn(() => Promise.resolve({ ok: true })),
    enrichNode: vi.fn(() => Promise.resolve({ title: "Enriched", description: "Better desc" })),
    reevaluateNode: vi.fn(() => Promise.resolve({ status: "queued", nodeId: "n1" })),
    resumeNodeSession: vi.fn(() => Promise.resolve({ status: "queued" })),
  };
});

function makeMockNode(overrides: Partial<MacroNode> = {}): MacroNode {
  return {
    id: "node-1",
    blueprintId: "bp-1",
    order: 0,
    title: "Test Node",
    description: "A test node description",
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

describe("MacroNodeCard", () => {
  it("renders node title and index", () => {
    render(
      <MacroNodeCard node={makeMockNode()} index={0} total={3} />,
    );
    expect(screen.getByText("Test Node")).toBeInTheDocument();
    expect(screen.getByText("#1")).toBeInTheDocument();
  });

  it("renders node description in collapsed view", () => {
    render(
      <MacroNodeCard node={makeMockNode()} index={0} total={3} />,
    );
    expect(screen.getByText("A test node description")).toBeInTheDocument();
  });

  it("shows status badge", () => {
    render(
      <MacroNodeCard node={makeMockNode({ status: "done" })} index={0} total={3} blueprintId="bp-1" />,
    );
    expect(screen.getByText("done")).toBeInTheDocument();
  });

  it("shows Run button for pending nodes with blueprintId", () => {
    render(
      <MacroNodeCard node={makeMockNode({ status: "pending" })} index={0} total={3} blueprintId="bp-1" />,
    );
    const runBtn = screen.getByText("Run", { exact: false });
    expect(runBtn).toBeInTheDocument();
  });

  it("shows Run button for failed nodes", () => {
    render(
      <MacroNodeCard node={makeMockNode({ status: "failed" })} index={0} total={3} blueprintId="bp-1" />,
    );
    expect(screen.getByText("Run", { exact: false })).toBeInTheDocument();
  });

  it("does not show Run button for done nodes", () => {
    render(
      <MacroNodeCard node={makeMockNode({ status: "done" })} index={0} total={3} blueprintId="bp-1" />,
    );
    expect(screen.queryByText(/^\u25B6/)).not.toBeInTheDocument();
  });

  it("does not show Run button without blueprintId", () => {
    render(
      <MacroNodeCard node={makeMockNode({ status: "pending" })} index={0} total={3} />,
    );
    // No run button without blueprintId
    const buttons = screen.queryAllByRole("button");
    const runButton = buttons.find((b) => b.textContent?.includes("Run"));
    expect(runButton).toBeUndefined();
  });

  it("toggles expansion on click", () => {
    render(
      <MacroNodeCard
        node={makeMockNode({ description: "Detailed description", prompt: "Do something" })}
        index={0}
        total={3}
        blueprintId="bp-1"
      />,
    );

    // Initially collapsed - description is visible as line-clamp
    expect(screen.getByText("Detailed description")).toBeInTheDocument();

    // Click to expand
    const card = screen.getByText("Test Node").closest("[class*='cursor-pointer']");
    if (card) fireEvent.click(card);

    // Expanded: should show Prompt section
    expect(screen.getByText("Prompt")).toBeInTheDocument();
    expect(screen.getByText("Do something")).toBeInTheDocument();
  });

  it("shows expanded details including prompt when expanded", () => {
    render(
      <MacroNodeCard
        node={makeMockNode({ prompt: "Run the tests" })}
        index={0}
        total={3}
        blueprintId="bp-1"
        defaultExpanded={true}
      />,
    );
    expect(screen.getByText("Run the tests")).toBeInTheDocument();
    expect(screen.getByText("Prompt")).toBeInTheDocument();
  });

  it("shows execution count when executions exist", () => {
    render(
      <MacroNodeCard
        node={makeMockNode({
          executions: [
            {
              id: "e1",
              nodeId: "n1",
              blueprintId: "bp-1",
              type: "primary",
              status: "done",
              startedAt: "2025-01-01",
            },
          ],
        })}
        index={0}
        total={3}
        blueprintId="bp-1"
      />,
    );
    expect(screen.getByText("1 exec")).toBeInTheDocument();
  });

  it("shows plural 'execs' for multiple executions", () => {
    render(
      <MacroNodeCard
        node={makeMockNode({
          executions: [
            { id: "e1", nodeId: "n1", blueprintId: "bp-1", type: "primary", status: "done", startedAt: "2025-01-01" },
            { id: "e2", nodeId: "n1", blueprintId: "bp-1", type: "retry", status: "done", startedAt: "2025-01-02" },
          ],
        })}
        index={0}
        total={3}
        blueprintId="bp-1"
      />,
    );
    expect(screen.getByText("2 execs")).toBeInTheDocument();
  });

  it("shows Queued badge when node status is queued", () => {
    render(
      <MacroNodeCard node={makeMockNode({ status: "queued" })} index={0} total={3} blueprintId="bp-1" />,
    );
    expect(screen.getByText("Queued")).toBeInTheDocument();
  });

  it("shows error message when expanded and node has error", () => {
    render(
      <MacroNodeCard
        node={makeMockNode({ error: "Something went wrong", status: "failed" })}
        index={0}
        total={3}
        blueprintId="bp-1"
        defaultExpanded={true}
      />,
    );
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
  });

  it("renders link to node detail page with blueprintId", () => {
    render(
      <MacroNodeCard node={makeMockNode()} index={0} total={3} blueprintId="bp-1" />,
    );
    const link = screen.getByText("Test Node").closest("a");
    expect(link?.getAttribute("href")).toBe("/blueprints/bp-1/nodes/node-1");
  });

  it("renders plain text title without blueprintId", () => {
    render(
      <MacroNodeCard node={makeMockNode()} index={0} total={3} />,
    );
    const title = screen.getByText("Test Node");
    expect(title.tagName).toBe("SPAN");
  });

  it("shows delete confirmation dialog on delete click", () => {
    render(
      <MacroNodeCard node={makeMockNode({ status: "pending" })} index={0} total={3} blueprintId="bp-1" />,
    );
    const deleteBtn = screen.getByTitle("Delete node");
    fireEvent.click(deleteBtn);
    expect(screen.getByText("Are you sure? This cannot be undone.")).toBeInTheDocument();
  });
});
