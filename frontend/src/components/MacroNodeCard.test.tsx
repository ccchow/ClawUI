import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MacroNodeCard } from "./MacroNodeCard";
import { ToastProvider } from "./Toast";
import type { MacroNode, PendingTask } from "@/lib/api";

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
    seq: 1,
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

  it("disables Run button when blueprintBusy is set", () => {
    render(
      <MacroNodeCard node={makeMockNode({ status: "pending" })} index={0} total={3} blueprintId="bp-1" blueprintBusy="Run All" />,
    );
    const runBtn = screen.getByRole("button", { name: "Run node" });
    expect(runBtn).toBeDisabled();
    expect(runBtn).toHaveAttribute("title", "Waiting for Run All to complete");
  });

  it("disables Re-evaluate, Edit, Skip, Delete buttons when blueprintBusy is set and shows tooltip", () => {
    render(
      <MacroNodeCard node={makeMockNode({ status: "pending" })} index={0} total={3} blueprintId="bp-1" blueprintBusy="Generate" />,
    );
    const busyTip = "Waiting for Generate to complete";
    // All action buttons should be disabled
    expect(screen.getByLabelText("Edit node")).toBeDisabled();
    expect(screen.getByLabelText("Skip node")).toBeDisabled();
    expect(screen.getByLabelText("Delete node")).toBeDisabled();
    expect(screen.getByLabelText("Re-evaluate node with AI")).toBeDisabled();
    // Each disabled button shows the operation-specific tooltip
    expect(screen.getByLabelText("Edit node")).toHaveAttribute("title", busyTip);
    expect(screen.getByLabelText("Skip node")).toHaveAttribute("title", busyTip);
    expect(screen.getByLabelText("Delete node")).toHaveAttribute("title", busyTip);
    expect(screen.getByLabelText("Re-evaluate node with AI")).toHaveAttribute("title", busyTip);
  });

  it("shows delete confirmation dialog on delete click", () => {
    render(
      <MacroNodeCard node={makeMockNode({ status: "pending" })} index={0} total={3} blueprintId="bp-1" />,
    );
    const deleteBtn = screen.getByTitle("Delete node");
    fireEvent.click(deleteBtn);
    expect(screen.getByText("Are you sure? This cannot be undone.")).toBeInTheDocument();
  });

  // --- Inherited role badges ---

  it("shows explicit role badges when node has roles", () => {
    render(
      <MacroNodeCard
        node={makeMockNode({ roles: ["sde", "qa"] })}
        index={0}
        total={3}
        blueprintId="bp-1"
        blueprintDefaultRole="pm"
      />,
    );
    expect(screen.getByText("SDE")).toBeInTheDocument();
    expect(screen.getByText("QA")).toBeInTheDocument();
    // Explicit roles should NOT have inherited styling
    const sdeBadge = screen.getByText("SDE").closest("span")!;
    expect(sdeBadge.className).not.toContain("border-dashed");
    expect(sdeBadge.className).not.toContain("opacity-60");
  });

  it("shows inherited role badge from blueprintDefaultRole when node has no roles", () => {
    render(
      <MacroNodeCard
        node={makeMockNode({ roles: [] })}
        index={0}
        total={3}
        blueprintId="bp-1"
        blueprintDefaultRole="qa"
      />,
    );
    expect(screen.getByText("QA")).toBeInTheDocument();
    const qaBadge = screen.getByText("QA").closest("span")!;
    // Inherited styling
    expect(qaBadge.className).toContain("border-dashed");
    expect(qaBadge.className).toContain("opacity-60");
  });

  it("shows inherited 'sde' fallback badge when no roles and no blueprintDefaultRole", () => {
    render(
      <MacroNodeCard
        node={makeMockNode({ roles: undefined })}
        index={0}
        total={3}
        blueprintId="bp-1"
      />,
    );
    expect(screen.getByText("SDE")).toBeInTheDocument();
    const sdeBadge = screen.getByText("SDE").closest("span")!;
    expect(sdeBadge.className).toContain("border-dashed");
    expect(sdeBadge.className).toContain("opacity-60");
  });

  it("shows inherited badges from blueprintEnabledRoles when node has no roles", () => {
    render(
      <MacroNodeCard
        node={makeMockNode({ roles: [] })}
        index={0}
        total={3}
        blueprintId="bp-1"
        blueprintEnabledRoles={["sde", "qa"]}
        blueprintDefaultRole="sde"
      />,
    );
    expect(screen.getByText("SDE")).toBeInTheDocument();
    expect(screen.getByText("QA")).toBeInTheDocument();
    // Both should be inherited
    const sdeBadge = screen.getByText("SDE").closest("span")!;
    const qaBadge = screen.getByText("QA").closest("span")!;
    expect(sdeBadge.className).toContain("border-dashed");
    expect(qaBadge.className).toContain("border-dashed");
  });

  // --- Toast transition detection ---

  it("shows toast when reevaluateQueued transitions from true to false", () => {
    const pendingWithReeval: PendingTask[] = [
      { type: "reevaluate", nodeId: "node-1", blueprintId: "bp-1", queuedAt: "2025-01-01T00:00:00Z" },
    ];
    const noPending: PendingTask[] = [];

    // Render with reevaluateQueued = true (pending task present)
    const { rerender } = render(
      <ToastProvider>
        <MacroNodeCard
          node={makeMockNode({ status: "done" })}
          pendingTasks={pendingWithReeval}
          index={0}
          total={3}
          blueprintId="bp-1"
        />
      </ToastProvider>,
    );

    // No toast yet
    expect(screen.queryByTestId("toast-item")).not.toBeInTheDocument();

    // Re-render with reevaluateQueued = false (task completed)
    rerender(
      <ToastProvider>
        <MacroNodeCard
          node={makeMockNode({ status: "done" })}
          pendingTasks={noPending}
          index={0}
          total={3}
          blueprintId="bp-1"
        />
      </ToastProvider>,
    );

    // Toast should appear
    expect(screen.getByTestId("toast-item")).toBeInTheDocument();
    expect(screen.getByText("Re-evaluation complete for #1")).toBeInTheDocument();
  });

  it("shows toast when enrichQueued transitions from true to false", () => {
    const pendingWithEnrich: PendingTask[] = [
      { type: "enrich", nodeId: "node-1", blueprintId: "bp-1", queuedAt: "2025-01-01T00:00:00Z" },
    ];
    const noPending: PendingTask[] = [];

    const { rerender } = render(
      <ToastProvider>
        <MacroNodeCard
          node={makeMockNode({ status: "done" })}
          pendingTasks={pendingWithEnrich}
          index={0}
          total={3}
          blueprintId="bp-1"
        />
      </ToastProvider>,
    );

    expect(screen.queryByTestId("toast-item")).not.toBeInTheDocument();

    rerender(
      <ToastProvider>
        <MacroNodeCard
          node={makeMockNode({ status: "done" })}
          pendingTasks={noPending}
          index={0}
          total={3}
          blueprintId="bp-1"
        />
      </ToastProvider>,
    );

    expect(screen.getByTestId("toast-item")).toBeInTheDocument();
    expect(screen.getByText("Enrichment complete for #1")).toBeInTheDocument();
  });

  it("does not show toast when reevaluateQueued is never true", () => {
    const noPending: PendingTask[] = [];

    const { rerender } = render(
      <ToastProvider>
        <MacroNodeCard
          node={makeMockNode({ status: "done" })}
          pendingTasks={noPending}
          index={0}
          total={3}
          blueprintId="bp-1"
        />
      </ToastProvider>,
    );

    // Re-render with still no pending tasks
    rerender(
      <ToastProvider>
        <MacroNodeCard
          node={makeMockNode({ status: "done" })}
          pendingTasks={noPending}
          index={0}
          total={3}
          blueprintId="bp-1"
        />
      </ToastProvider>,
    );

    expect(screen.queryByTestId("toast-item")).not.toBeInTheDocument();
  });

  // ─── Reset to Pending ──────────────────────────

  it("shows Reset button for done nodes when blueprint is approved", () => {
    render(
      <ToastProvider>
        <MacroNodeCard
          node={makeMockNode({ status: "done" })}
          index={0}
          total={3}
          blueprintId="bp-1"
          blueprintStatus="approved"
        />
      </ToastProvider>,
    );
    expect(screen.getByLabelText("Reset node to pending")).toBeInTheDocument();
  });

  it("does not show Reset button for done nodes when blueprint is not approved", () => {
    render(
      <ToastProvider>
        <MacroNodeCard
          node={makeMockNode({ status: "done" })}
          index={0}
          total={3}
          blueprintId="bp-1"
          blueprintStatus="done"
        />
      </ToastProvider>,
    );
    expect(screen.queryByLabelText("Reset node to pending")).not.toBeInTheDocument();
  });

  it("does not show Reset button for pending nodes even when blueprint is approved", () => {
    render(
      <ToastProvider>
        <MacroNodeCard
          node={makeMockNode({ status: "pending" })}
          index={0}
          total={3}
          blueprintId="bp-1"
          blueprintStatus="approved"
        />
      </ToastProvider>,
    );
    expect(screen.queryByLabelText("Reset node to pending")).not.toBeInTheDocument();
  });

  it("shows confirmation strip when Reset is clicked", () => {
    render(
      <ToastProvider>
        <MacroNodeCard
          node={makeMockNode({ status: "done" })}
          index={0}
          total={3}
          blueprintId="bp-1"
          blueprintStatus="approved"
        />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByLabelText("Reset node to pending"));
    expect(screen.getByText("Yes")).toBeInTheDocument();
    expect(screen.getByText("No")).toBeInTheDocument();
  });

  it("calls updateMacroNode with pending status on Reset confirmation", async () => {
    const { updateMacroNode: mockUpdateMacroNode } = await import("@/lib/api");
    render(
      <ToastProvider>
        <MacroNodeCard
          node={makeMockNode({ status: "done" })}
          index={0}
          total={3}
          blueprintId="bp-1"
          blueprintStatus="approved"
        />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByLabelText("Reset node to pending"));
    fireEvent.click(screen.getByText("Yes"));
    expect(mockUpdateMacroNode).toHaveBeenCalledWith("bp-1", "node-1", { status: "pending" });
  });

  it("dismisses Reset confirmation on No click", () => {
    render(
      <ToastProvider>
        <MacroNodeCard
          node={makeMockNode({ status: "done" })}
          index={0}
          total={3}
          blueprintId="bp-1"
          blueprintStatus="approved"
        />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByLabelText("Reset node to pending"));
    expect(screen.getByText("Yes")).toBeInTheDocument();
    fireEvent.click(screen.getByText("No"));
    expect(screen.queryByText("Reset?")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Reset node to pending")).toBeInTheDocument();
  });
});
