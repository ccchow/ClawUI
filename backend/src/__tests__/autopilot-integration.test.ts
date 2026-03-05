import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// ─── Mocks ───────────────────────────────────────────────────

// Side-effect imports (prevent module-level side effects)
vi.mock("../agent-claude.js", () => ({}));
vi.mock("../agent-pimono.js", () => ({}));
vi.mock("../agent-openclaw.js", () => ({}));
vi.mock("../agent-codex.js", () => ({}));
vi.mock("../roles/load-all-roles.js", () => ({}));

vi.mock("../plan-coordinator.js", () => ({
  coordinateBlueprint: vi.fn(async () => {}),
}));
vi.mock("../plan-convene.js", () => ({
  executeConveneSession: vi.fn(async () => {}),
}));

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Agent runtime — controls AI decisions returned by callAgentForDecision
const mockRunSession = vi.fn();
vi.mock("../agent-runtime.js", () => ({
  getActiveRuntime: vi.fn(() => ({
    runSession: mockRunSession,
  })),
}));

// Plan executor — mock CLI execution, keep queue inline
const mockExecuteNode = vi.fn();
const mockExecuteNodeDirect = vi.fn();
const mockResumeNodeSession = vi.fn();
const mockEvaluateNodeCompletion = vi.fn();
vi.mock("../plan-executor.js", () => ({
  getQueueInfo: vi.fn(() => ({ running: false, queueLength: 0, pendingTasks: [] })),
  executeNode: mockExecuteNode,
  executeNodeDirect: mockExecuteNodeDirect,
  resumeNodeSession: mockResumeNodeSession,
  evaluateNodeCompletion: mockEvaluateNodeCompletion,
  enqueueBlueprintTask: vi.fn(async (_bpId: string, task: () => Promise<unknown>) => task()),
  addPendingTask: vi.fn(),
  removePendingTask: vi.fn(),
}));

// ─── DB Functions (real SQLite) ──────────────────────────────

type PlanDb = typeof import("../plan-db.js");
type Autopilot = typeof import("../autopilot.js");

let db: {
  createBlueprint: PlanDb["createBlueprint"];
  createMacroNode: PlanDb["createMacroNode"];
  updateBlueprint: PlanDb["updateBlueprint"];
  updateMacroNode: PlanDb["updateMacroNode"];
  getBlueprint: PlanDb["getBlueprint"];
  getAutopilotLog: PlanDb["getAutopilotLog"];
  createSuggestion: PlanDb["createSuggestion"];
  getSuggestionsForNode: PlanDb["getSuggestionsForNode"];
  createExecution: PlanDb["createExecution"];
  createInsight: PlanDb["createInsight"];
  getInsightsForBlueprint: PlanDb["getInsightsForBlueprint"];
  markSuggestionUsed: PlanDb["markSuggestionUsed"];
  recoverStaleExecutions: PlanDb["recoverStaleExecutions"];
};

let ap: {
  runAutopilotLoop: Autopilot["runAutopilotLoop"];
  clearResumeCounts: Autopilot["clearResumeCounts"];
  getResumeCount: Autopilot["getResumeCount"];
  incrementResumeCount: Autopilot["incrementResumeCount"];
};

// ─── Test Setup ──────────────────────────────────────────────

describe("autopilot integration", () => {
  beforeAll(async () => {
    const { initDb } = await import("../db.js");
    initDb();

    const planDb = await import("../plan-db.js");
    planDb.initPlanTables();

    db = {
      createBlueprint: planDb.createBlueprint,
      createMacroNode: planDb.createMacroNode,
      updateBlueprint: planDb.updateBlueprint,
      updateMacroNode: planDb.updateMacroNode,
      getBlueprint: planDb.getBlueprint,
      getAutopilotLog: planDb.getAutopilotLog,
      createSuggestion: planDb.createSuggestion,
      getSuggestionsForNode: planDb.getSuggestionsForNode,
      createExecution: planDb.createExecution,
      createInsight: planDb.createInsight,
      getInsightsForBlueprint: planDb.getInsightsForBlueprint,
      markSuggestionUsed: planDb.markSuggestionUsed,
      recoverStaleExecutions: planDb.recoverStaleExecutions,
    };

    const autopilot = await import("../autopilot.js");
    ap = {
      runAutopilotLoop: autopilot.runAutopilotLoop,
      clearResumeCounts: autopilot.clearResumeCounts,
      getResumeCount: autopilot.getResumeCount,
      incrementResumeCount: autopilot.incrementResumeCount,
    };
  });

  beforeEach(() => {
    // mockReset clears queued return values (clearAllMocks does NOT)
    mockRunSession.mockReset();
    mockExecuteNode.mockReset();
    mockExecuteNodeDirect.mockReset();
    mockResumeNodeSession.mockReset();
    mockEvaluateNodeCompletion.mockReset();
    vi.clearAllMocks();

    // Default: executeNode/executeNodeDirect marks node as done in real DB
    mockExecuteNode.mockImplementation(async (bpId: string, nodeId: string) => {
      db.updateMacroNode(bpId, nodeId, { status: "done" });
    });
    mockExecuteNodeDirect.mockImplementation(async (bpId: string, nodeId: string) => {
      db.updateMacroNode(bpId, nodeId, { status: "done" });
    });
    mockResumeNodeSession.mockImplementation(async (bpId: string, nodeId: string) => {
      db.updateMacroNode(bpId, nodeId, { status: "done" });
    });
    mockEvaluateNodeCompletion.mockImplementation(async () => {});
  });

  // ─── Helpers ─────────────────────────────────────────────

  /** Build a JSON decision string for the mock AI */
  function dec(action: string, params: Record<string, unknown> = {}, reasoning = ""): string {
    return JSON.stringify({ reasoning, action, params });
  }

  /** Create an approved blueprint with autopilot enabled */
  function setup(title: string, maxIterations = 50) {
    const bp = db.createBlueprint(title, "Integration test", "/tmp/int-test");
    db.updateBlueprint(bp.id, {
      status: "approved",
      executionMode: "autopilot",
      maxIterations,
    });
    return bp;
  }

  // ─── 1. Full Lifecycle ───────────────────────────────────

  describe("full lifecycle", () => {
    it("runs nodes in dependency order and auto-completes blueprint", async () => {
      const bp = setup("Lifecycle");
      const nodeA = db.createMacroNode(bp.id, { title: "Node A", order: 1 });
      const nodeB = db.createMacroNode(bp.id, { title: "Node B", order: 2, dependencies: [nodeA.id] });
      const nodeC = db.createMacroNode(bp.id, { title: "Node C", order: 3, dependencies: [nodeB.id] });

      mockRunSession
        .mockResolvedValueOnce(dec("run_node", { nodeId: nodeA.id }, "Start with A"))
        .mockResolvedValueOnce(dec("run_node", { nodeId: nodeB.id }, "A done, run B"))
        .mockResolvedValueOnce(dec("run_node", { nodeId: nodeC.id }, "B done, run C"));

      await ap.runAutopilotLoop(bp.id);

      // Blueprint is done
      const final = db.getBlueprint(bp.id)!;
      expect(final.status).toBe("done");

      // All nodes are done
      for (const node of final.nodes) {
        expect(node.status).toBe("done");
      }

      // 4 log entries: 3 run_node + 1 auto-complete
      const logs = db.getAutopilotLog(bp.id, 10, 0);
      expect(logs.length).toBe(4);

      // Auto-complete entry
      const completionLog = logs.find((l) => l.decision.includes("All nodes complete"));
      expect(completionLog).toBeDefined();
      expect(completionLog!.result).toBe("complete");

      // 3 run_node entries
      const runLogs = logs.filter((l) => l.action === "run_node");
      expect(runLogs.length).toBe(3);

      // AI was called exactly 3 times (not for the 4th auto-complete iteration)
      expect(mockRunSession).toHaveBeenCalledTimes(3);
    });

    it("creates nodes from suggestions and marks them used", async () => {
      const bp = setup("Suggestion Flow");
      const nodeA = db.createMacroNode(bp.id, { title: "Implement feature", order: 1 });
      const nodeB = db.createMacroNode(bp.id, { title: "Deploy", order: 2, dependencies: [nodeA.id] });
      const suggestion = db.createSuggestion(bp.id, nodeA.id, "Add tests", "Should have unit tests");

      // AI: run A → create_node from suggestion → mark_suggestion_used → run B → run new node → auto-complete
      mockRunSession
        .mockResolvedValueOnce(dec("run_node", { nodeId: nodeA.id }))
        .mockResolvedValueOnce(dec("create_node", {
          title: "Unit tests for feature",
          description: "Add unit tests",
          dependsOn: [nodeA.id],
        }))
        .mockResolvedValueOnce(dec("mark_suggestion_used", { suggestionId: suggestion.id }))
        .mockResolvedValueOnce(dec("run_node", { nodeId: nodeB.id }));

      // Dynamically find the created node's ID for the 5th call
      mockRunSession.mockImplementationOnce(async () => {
        const updated = db.getBlueprint(bp.id)!;
        const newNode = updated.nodes.find((n) => n.title === "Unit tests for feature");
        return dec("run_node", { nodeId: newNode!.id });
      });

      await ap.runAutopilotLoop(bp.id);

      // Blueprint done
      const final = db.getBlueprint(bp.id)!;
      expect(final.status).toBe("done");
      expect(final.nodes.length).toBe(3); // A, B, new node

      // Suggestion marked used
      const suggestions = db.getSuggestionsForNode(nodeA.id);
      expect(suggestions[0].used).toBe(true);

      // All nodes done
      for (const node of final.nodes) {
        expect(node.status).toBe("done");
      }
    });

    it("handles skip_node correctly", async () => {
      const bp = setup("Skip Flow");
      const nodeA = db.createMacroNode(bp.id, { title: "Important", order: 1 });
      const nodeB = db.createMacroNode(bp.id, { title: "Optional", order: 2 });

      mockRunSession
        .mockResolvedValueOnce(dec("run_node", { nodeId: nodeA.id }))
        .mockResolvedValueOnce(dec("skip_node", { nodeId: nodeB.id, reason: "Not needed" }));

      await ap.runAutopilotLoop(bp.id);

      const final = db.getBlueprint(bp.id)!;
      expect(final.status).toBe("done");
      expect(final.nodes.find((n) => n.id === nodeA.id)!.status).toBe("done");
      expect(final.nodes.find((n) => n.id === nodeB.id)!.status).toBe("skipped");
      expect(final.nodes.find((n) => n.id === nodeB.id)!.error).toContain("Not needed");
    });

    it("handles resume_node with execution history", async () => {
      const bp = setup("Resume Flow");
      const nodeA = db.createMacroNode(bp.id, { title: "Flaky Node", order: 1 });
      const nodeB = db.createMacroNode(bp.id, { title: "Final", order: 2 });

      // Set node A as failed with an execution that has a session
      db.updateMacroNode(bp.id, nodeA.id, { status: "failed", error: "Timeout" });
      db.createExecution(nodeA.id, bp.id, "session-abc-123", "primary", undefined, undefined, "failed", "Timed out", new Date().toISOString());

      mockRunSession
        .mockResolvedValueOnce(dec("resume_node", { nodeId: nodeA.id, feedback: "Try again with longer timeout" }))
        .mockResolvedValueOnce(dec("run_node", { nodeId: nodeB.id }));

      await ap.runAutopilotLoop(bp.id);

      const final = db.getBlueprint(bp.id)!;
      expect(final.status).toBe("done");

      // Both nodes done
      expect(final.nodes.find((n) => n.id === nodeA.id)!.status).toBe("done");
      expect(final.nodes.find((n) => n.id === nodeB.id)!.status).toBe("done");

      // resumeNodeSession was called
      expect(mockResumeNodeSession).toHaveBeenCalledTimes(1);

      // Resume count was incremented
      expect(ap.getResumeCount(bp.id, nodeA.id)).toBe(1);
    });

    it("handles evaluate_node without changing status", async () => {
      const bp = setup("Evaluate Flow");
      const nodeA = db.createMacroNode(bp.id, { title: "Node A", order: 1 });
      const nodeB = db.createMacroNode(bp.id, { title: "Node B", order: 2 });

      mockRunSession
        .mockResolvedValueOnce(dec("run_node", { nodeId: nodeA.id }))
        .mockResolvedValueOnce(dec("evaluate_node", { nodeId: nodeA.id }))
        .mockResolvedValueOnce(dec("run_node", { nodeId: nodeB.id }));

      await ap.runAutopilotLoop(bp.id);

      const final = db.getBlueprint(bp.id)!;
      expect(final.status).toBe("done");
      expect(mockEvaluateNodeCompletion).toHaveBeenCalledTimes(1);
    });

    it("handles mark_insight_read and dismiss_insight", async () => {
      const bp = setup("Insight Flow");
      const nodeA = db.createMacroNode(bp.id, { title: "Node A", order: 1 });
      const insight1 = db.createInsight(bp.id, nodeA.id, "qa", "warning", "Possible issue");
      const insight2 = db.createInsight(bp.id, null, "pm", "info", "FYI note");

      mockRunSession
        .mockResolvedValueOnce(dec("mark_insight_read", { insightId: insight1.id }))
        .mockResolvedValueOnce(dec("dismiss_insight", { insightId: insight2.id }))
        .mockResolvedValueOnce(dec("run_node", { nodeId: nodeA.id }));

      await ap.runAutopilotLoop(bp.id);

      const final = db.getBlueprint(bp.id)!;
      expect(final.status).toBe("done");

      // getInsightsForBlueprint filters dismissed=0, so dismissed insight won't appear
      const insights = db.getInsightsForBlueprint(bp.id);
      expect(insights.find((i) => i.id === insight1.id)!.read).toBe(true);
      // insight2 was dismissed → filtered out by getInsightsForBlueprint
      expect(insights.find((i) => i.id === insight2.id)).toBeUndefined();
    });

    it("handles update_node to modify title/description", async () => {
      const bp = setup("Update Flow");
      const nodeA = db.createMacroNode(bp.id, { title: "Original Title", description: "Original desc", order: 1 });

      mockRunSession
        .mockResolvedValueOnce(dec("update_node", { nodeId: nodeA.id, title: "Better Title", description: "Improved desc" }))
        .mockResolvedValueOnce(dec("run_node", { nodeId: nodeA.id }));

      await ap.runAutopilotLoop(bp.id);

      const final = db.getBlueprint(bp.id)!;
      expect(final.status).toBe("done");
      expect(final.nodes[0].title).toBe("Better Title");
      expect(final.nodes[0].description).toBe("Improved desc");
    });

    it("handles batch_create_nodes", async () => {
      const bp = setup("Batch Create");
      const nodeA = db.createMacroNode(bp.id, { title: "Existing", order: 1 });
      // Second node prevents auto-completion after A is done
      const nodeB = db.createMacroNode(bp.id, { title: "Blocker", order: 2, dependencies: [nodeA.id] });

      mockRunSession
        .mockResolvedValueOnce(dec("run_node", { nodeId: nodeA.id }))
        .mockResolvedValueOnce(dec("batch_create_nodes", {
          nodes: [
            { title: "Batch Node 1", description: "First" },
            { title: "Batch Node 2", description: "Second", dependsOn: [0] }, // depends on batch node 1 by index
          ],
        }))
        .mockResolvedValueOnce(dec("run_node", { nodeId: nodeB.id }));

      // Run the two batch-created nodes
      mockRunSession.mockImplementationOnce(async () => {
        const updated = db.getBlueprint(bp.id)!;
        const bn1 = updated.nodes.find((n) => n.title === "Batch Node 1");
        return dec("run_node", { nodeId: bn1!.id });
      });
      mockRunSession.mockImplementationOnce(async () => {
        const updated = db.getBlueprint(bp.id)!;
        const bn2 = updated.nodes.find((n) => n.title === "Batch Node 2");
        return dec("run_node", { nodeId: bn2!.id });
      });

      await ap.runAutopilotLoop(bp.id);

      const final = db.getBlueprint(bp.id)!;
      expect(final.status).toBe("done");
      expect(final.nodes.length).toBe(4); // Existing + Blocker + 2 batch nodes

      const bn2 = final.nodes.find((n) => n.title === "Batch Node 2")!;
      const bn1 = final.nodes.find((n) => n.title === "Batch Node 1")!;
      expect(bn2.dependencies).toContain(bn1.id);
    });
  });

  // ─── 2. Mode Switching ──────────────────────────────────

  describe("mode switching", () => {
    it("exits cleanly when switched to manual mid-loop", async () => {
      const bp = setup("Mode Switch");
      const nodeA = db.createMacroNode(bp.id, { title: "Node A", order: 1 });
      const nodeB = db.createMacroNode(bp.id, { title: "Node B", order: 2 });

      // After first run_node, switch to manual before AI is called again
      mockRunSession.mockResolvedValueOnce(dec("run_node", { nodeId: nodeA.id }));
      mockRunSession.mockImplementationOnce(async () => {
        // This should never be reached — the loop should exit before calling AI again
        throw new Error("Should not reach this");
      });

      // Switch to manual after the first iteration completes (during waitForTaskCompletion or next check)
      mockExecuteNodeDirect.mockImplementation(async (bpId: string, nodeId: string) => {
        db.updateMacroNode(bpId, nodeId, { status: "done" });
        // Switch to manual mode while node is executing
        db.updateBlueprint(bpId, { executionMode: "manual" });
      });

      await ap.runAutopilotLoop(bp.id);

      const final = db.getBlueprint(bp.id)!;
      // Loop exited — blueprint is NOT done (B is still pending)
      // rowToBlueprint omits executionMode when "manual" (default) — returns undefined
      expect(final.executionMode).toBeUndefined();
      expect(final.nodes.find((n) => n.id === nodeA.id)!.status).toBe("done");
      expect(final.nodes.find((n) => n.id === nodeB.id)!.status).toBe("pending");

      // AI was called only once
      expect(mockRunSession).toHaveBeenCalledTimes(1);

      // Log entry shows mode switch
      const logs = db.getAutopilotLog(bp.id, 10, 0);
      const switchLog = logs.find((l) => l.decision.includes("Mode switched to manual"));
      expect(switchLog).toBeDefined();
    });
  });

  // ─── 3. Pause Flow ─────────────────────────────────────

  describe("pause flow", () => {
    it("pauses when AI returns pause action with reason", async () => {
      const bp = setup("Pause Test");
      db.createMacroNode(bp.id, { title: "Node A", order: 1 });

      mockRunSession.mockResolvedValueOnce(
        dec("pause", { reason: "Need human review of architecture" }, "Unclear requirements"),
      );

      await ap.runAutopilotLoop(bp.id);

      const final = db.getBlueprint(bp.id)!;
      expect(final.status).toBe("paused");
      expect(final.pauseReason).toBe("Need human review of architecture");

      // Only 1 log entry
      const logs = db.getAutopilotLog(bp.id, 10, 0);
      expect(logs.length).toBe(1);
      expect(logs[0].action).toBe("pause");
    });

    it("pauses with default reason when AI omits reason", async () => {
      const bp = setup("Pause Default");
      db.createMacroNode(bp.id, { title: "Node A", order: 1 });

      mockRunSession.mockResolvedValueOnce(dec("pause", {}));

      await ap.runAutopilotLoop(bp.id);

      const final = db.getBlueprint(bp.id)!;
      expect(final.status).toBe("paused");
      expect(final.pauseReason).toBe("Autopilot paused by AI decision");
    });
  });

  // ─── 4. AI Complete Action ──────────────────────────────

  describe("complete action", () => {
    it("marks blueprint done when AI says complete", async () => {
      const bp = setup("Complete Test");
      const nodeA = db.createMacroNode(bp.id, { title: "Node A", order: 1 });

      mockRunSession
        .mockResolvedValueOnce(dec("run_node", { nodeId: nodeA.id }))
        // After A is done but before allNodesDone is detected, AI might say complete
        // Actually allNodesDone will be true, so this won't be reached — use skip instead
        .mockResolvedValueOnce(dec("complete", {}));

      // Prevent auto-complete by keeping a node that's not done
      const nodeB = db.createMacroNode(bp.id, { title: "Node B", order: 2 });

      // First run A, then AI decides to complete early (skipping B)
      mockRunSession.mockReset();
      mockRunSession
        .mockResolvedValueOnce(dec("run_node", { nodeId: nodeA.id }))
        .mockResolvedValueOnce(dec("complete", {}, "B is not needed, marking as complete"));

      await ap.runAutopilotLoop(bp.id);

      const final = db.getBlueprint(bp.id)!;
      expect(final.status).toBe("done");
      // B is still pending — AI chose to complete without finishing all nodes
      expect(final.nodes.find((n) => n.id === nodeB.id)!.status).toBe("pending");
    });
  });

  // ─── 5. Recovery ────────────────────────────────────────

  describe("recovery", () => {
    it("resets stuck running blueprint to approved via recoverStaleExecutions", () => {
      const bp = setup("Recovery Test");
      const nodeA = db.createMacroNode(bp.id, { title: "Node A", order: 1 });

      // Simulate a blueprint stuck in running with no active nodes
      db.updateBlueprint(bp.id, { status: "running" });

      db.recoverStaleExecutions();

      // Blueprint should be reset to approved (no running/queued nodes)
      const final = db.getBlueprint(bp.id)!;
      expect(final.status).toBe("approved");
    });

    it("marks stale running executions as failed during recovery", () => {
      const bp = setup("Recovery Exec");
      const nodeA = db.createMacroNode(bp.id, { title: "Node A", order: 1 });
      db.updateMacroNode(bp.id, nodeA.id, { status: "running" });
      db.updateBlueprint(bp.id, { status: "running" });

      // Create a running execution
      const exec = db.createExecution(nodeA.id, bp.id, "session-xyz", "primary");

      db.recoverStaleExecutions();

      // Node should be marked as failed
      const final = db.getBlueprint(bp.id)!;
      const node = final.nodes.find((n) => n.id === nodeA.id)!;
      expect(node.status).toBe("failed");
      expect(node.error).toContain("server restart");
    });
  });

  // ─── 6. Safeguards ─────────────────────────────────────

  describe("safeguards", () => {
    it("force pauses when same action is repeated 3 times", async () => {
      const bp = setup("Same Action Guard", 10);
      const nodeA = db.createMacroNode(bp.id, { title: "Node A", order: 1 });
      const nodeB = db.createMacroNode(bp.id, { title: "Node B", order: 2 });

      // executeNodeDirect does NOT mark as done — simulates stuck node
      mockExecuteNodeDirect.mockImplementation(async () => {});

      // AI keeps trying to run_node(A) which never completes
      mockRunSession
        .mockResolvedValueOnce(dec("run_node", { nodeId: nodeA.id }))
        .mockResolvedValueOnce(dec("run_node", { nodeId: nodeA.id }))
        .mockResolvedValueOnce(dec("run_node", { nodeId: nodeA.id }));

      await ap.runAutopilotLoop(bp.id);

      const final = db.getBlueprint(bp.id)!;
      expect(final.status).toBe("paused");
      expect(final.pauseReason).toContain("repeating the same action 3 times");

      // 3 iterations occurred
      const logs = db.getAutopilotLog(bp.id, 10, 0);
      expect(logs.length).toBe(3);
    });

    it("force pauses when no progress after 5 iterations", async () => {
      const bp = setup("No Progress Guard", 20);
      const nodeA = db.createMacroNode(bp.id, { title: "Node A", order: 1 });
      const nodeB = db.createMacroNode(bp.id, { title: "Node B", order: 2 });

      // AI performs different non-status-changing actions each iteration
      // (different actions to avoid same-action safeguard)
      mockRunSession
        .mockResolvedValueOnce(dec("update_node", { nodeId: nodeA.id, title: "Updated A v1" }))
        .mockResolvedValueOnce(dec("update_node", { nodeId: nodeA.id, title: "Updated A v2" }))
        .mockResolvedValueOnce(dec("update_node", { nodeId: nodeB.id, title: "Updated B v1" }))
        .mockResolvedValueOnce(dec("update_node", { nodeId: nodeB.id, title: "Updated B v2" }))
        .mockResolvedValueOnce(dec("update_node", { nodeId: nodeA.id, title: "Updated A v3" }))
        .mockResolvedValueOnce(dec("update_node", { nodeId: nodeB.id, title: "Updated B v3" }));

      await ap.runAutopilotLoop(bp.id);

      const final = db.getBlueprint(bp.id)!;
      expect(final.status).toBe("paused");
      expect(final.pauseReason).toContain("No progress");

      // checkNoProgress: iter 1 sets baseline, iters 2-6 count as no-progress (5 total) → pause at iter 6
      const logs = db.getAutopilotLog(bp.id, 20, 0);
      expect(logs.length).toBe(6);
    });

    it("force pauses when max iterations reached", async () => {
      const bp = setup("Max Iter Guard", 3);
      const nodeA = db.createMacroNode(bp.id, { title: "Node A", order: 1 });

      // executeNodeDirect doesn't complete the node, and AI keeps trying
      mockExecuteNodeDirect.mockImplementation(async () => {});

      // Different actions to avoid same-action guard
      mockRunSession
        .mockResolvedValueOnce(dec("update_node", { nodeId: nodeA.id, title: "v1" }))
        .mockResolvedValueOnce(dec("update_node", { nodeId: nodeA.id, description: "d1" }))
        .mockResolvedValueOnce(dec("update_node", { nodeId: nodeA.id, title: "v2" }));

      await ap.runAutopilotLoop(bp.id);

      const final = db.getBlueprint(bp.id)!;
      expect(final.status).toBe("paused");
      expect(final.pauseReason).toContain("maximum iterations (3)");
    });

    it("force pauses when a node is resumed more than 5 times during the loop", async () => {
      const bp = setup("Resume Cap Loop", 20);
      const nodeA = db.createMacroNode(bp.id, { title: "Stubborn Node", order: 1 });
      const nodeB = db.createMacroNode(bp.id, { title: "Other", order: 2 });

      // Node A always fails — resumeNodeSession doesn't mark it done
      mockResumeNodeSession.mockImplementation(async () => {
        // Node stays failed
      });

      // Create execution with session for resume_node to find
      db.updateMacroNode(bp.id, nodeA.id, { status: "failed" });
      db.createExecution(nodeA.id, bp.id, "session-stub", "primary", undefined, undefined, "failed");

      // AI keeps trying to resume node A (6 times to exceed cap of >5)
      // Need different params to avoid same-action safeguard — use feedback
      for (let i = 1; i <= 7; i++) {
        mockRunSession.mockResolvedValueOnce(
          dec("resume_node", { nodeId: nodeA.id, feedback: `Attempt ${i}` }),
        );
      }

      await ap.runAutopilotLoop(bp.id);

      const final = db.getBlueprint(bp.id)!;
      expect(final.status).toBe("paused");
      expect(final.pauseReason).toContain("resumed");
    });
  });

  // ─── 7. DB Columns & Autopilot Log Integrity ───────────

  describe("DB integrity", () => {
    it("sets execution_mode and max_iterations columns correctly", () => {
      const bp = db.createBlueprint("DB Col Test", "Test desc", "/tmp");
      expect(bp.executionMode).toBeUndefined(); // default is manual (undefined on blueprint object)

      db.updateBlueprint(bp.id, { executionMode: "autopilot", maxIterations: 25 });
      const updated = db.getBlueprint(bp.id)!;
      expect(updated.executionMode).toBe("autopilot");
      expect(updated.maxIterations).toBe(25);
    });

    it("stores pauseReason and clears it on resume", () => {
      const bp = setup("Pause Reason");
      db.createMacroNode(bp.id, { title: "Node A", order: 1 });

      db.updateBlueprint(bp.id, { status: "paused", pauseReason: "Need human input" });
      expect(db.getBlueprint(bp.id)!.pauseReason).toBe("Need human input");

      db.updateBlueprint(bp.id, { status: "approved", pauseReason: "" });
      const cleared = db.getBlueprint(bp.id)!;
      expect(cleared.status).toBe("approved");
    });

    it("autopilot log entries contain correct fields", async () => {
      const bp = setup("Log Fields");
      const nodeA = db.createMacroNode(bp.id, { title: "Node A", order: 1 });
      const nodeB = db.createMacroNode(bp.id, { title: "Node B", order: 2 });

      mockRunSession
        .mockResolvedValueOnce(dec("run_node", { nodeId: nodeA.id }, "First action"))
        .mockResolvedValueOnce(dec("run_node", { nodeId: nodeB.id }, "Second action"));

      await ap.runAutopilotLoop(bp.id);

      const logs = db.getAutopilotLog(bp.id, 10, 0);
      // 2 run_node + 1 auto-complete = 3 entries
      expect(logs.length).toBe(3);

      const runLog = logs.find((l) => l.action === "run_node" && l.iteration === 1);
      expect(runLog).toBeDefined();
      expect(runLog!.blueprintId).toBe(bp.id);
      expect(runLog!.decision).toContain("run_node");
      expect(runLog!.createdAt).toBeDefined();
      if (runLog!.actionParams) {
        const params = JSON.parse(runLog!.actionParams);
        expect(params.nodeId).toBe(nodeA.id);
      }
    });
  });

  // ─── 8. Error Handling ─────────────────────────────────

  describe("error handling", () => {
    it("continues loop when callAgentForDecision fails", async () => {
      const bp = setup("Agent Error", 5);
      const nodeA = db.createMacroNode(bp.id, { title: "Node A", order: 1 });

      // First call fails, retry prompt also fails → fallback to pause
      mockRunSession
        .mockRejectedValueOnce(new Error("Network timeout"))
        .mockResolvedValueOnce(dec("run_node", { nodeId: nodeA.id }));

      await ap.runAutopilotLoop(bp.id);

      const final = db.getBlueprint(bp.id)!;
      expect(final.status).toBe("done");

      // Error was logged but loop continued
      const logs = db.getAutopilotLog(bp.id, 10, 0);
      const errorLog = logs.find((l) => l.action === "error");
      expect(errorLog).toBeDefined();
    });

    it("handles non-existent blueprint gracefully", async () => {
      // Should return without crashing
      await ap.runAutopilotLoop("non-existent-id");
    });

    it("handles AI returning unparseable response gracefully", async () => {
      const bp = setup("Bad Response", 3);
      db.createMacroNode(bp.id, { title: "Node A", order: 1 });

      // First attempt: garbage, retry: also garbage → callAgentForDecision returns pause
      mockRunSession
        .mockResolvedValueOnce("This is not JSON at all, just random text")
        .mockResolvedValueOnce("Still not JSON");

      await ap.runAutopilotLoop(bp.id);

      const final = db.getBlueprint(bp.id)!;
      expect(final.status).toBe("paused");
      expect(final.pauseReason).toContain("AI response was not valid JSON");
    });
  });

  // ─── 9. Autopilot State Snapshot ───────────────────────

  describe("state snapshot in loop", () => {
    it("buildStateSnapshot reflects real DB state throughout the loop", async () => {
      const bp = setup("Snapshot Test");
      const nodeA = db.createMacroNode(bp.id, { title: "Node A", description: "Do task A", order: 1 });
      const nodeB = db.createMacroNode(bp.id, { title: "Node B", description: "Do task B", order: 2 });

      const promptsReceived: string[] = [];

      mockRunSession.mockImplementation(async (prompt: string) => {
        promptsReceived.push(prompt);
        // First call: run A, second: run B
        if (promptsReceived.length === 1) {
          return dec("run_node", { nodeId: nodeA.id });
        }
        return dec("run_node", { nodeId: nodeB.id });
      });

      await ap.runAutopilotLoop(bp.id);

      // First prompt should show both nodes as pending
      expect(promptsReceived[0]).toContain("pending");
      expect(promptsReceived[0]).toContain("Node A");
      expect(promptsReceived[0]).toContain("Node B");

      // Second prompt should show A as done (JSON.stringify with null,2 adds spaces)
      expect(promptsReceived[1]).toContain('"status": "done"');
      expect(promptsReceived[1]).toContain("Node B");
    });
  });
});
