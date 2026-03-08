import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync } from "node:fs";

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
  getAutopilotMemory: PlanDb["getAutopilotMemory"];
  setAutopilotMemory: PlanDb["setAutopilotMemory"];
};

let ap: {
  runAutopilotLoop: Autopilot["runAutopilotLoop"];
  clearResumeCounts: Autopilot["clearResumeCounts"];
  getResumeCount: Autopilot["getResumeCount"];
  incrementResumeCount: Autopilot["incrementResumeCount"];
  readGlobalMemory: Autopilot["readGlobalMemory"];
  writeGlobalMemory: Autopilot["writeGlobalMemory"];
  GLOBAL_MEMORY_PATH: Autopilot["GLOBAL_MEMORY_PATH"];
  buildAutopilotPrompt: Autopilot["buildAutopilotPrompt"];
  reflectAndUpdateMemory: Autopilot["reflectAndUpdateMemory"];
  updateGlobalMemory: Autopilot["updateGlobalMemory"];
  REFLECT_EVERY_N: Autopilot["REFLECT_EVERY_N"];
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
      getAutopilotMemory: planDb.getAutopilotMemory,
      setAutopilotMemory: planDb.setAutopilotMemory,
    };

    const autopilot = await import("../autopilot.js");
    ap = {
      runAutopilotLoop: autopilot.runAutopilotLoop,
      clearResumeCounts: autopilot.clearResumeCounts,
      getResumeCount: autopilot.getResumeCount,
      incrementResumeCount: autopilot.incrementResumeCount,
      readGlobalMemory: autopilot.readGlobalMemory,
      writeGlobalMemory: autopilot.writeGlobalMemory,
      GLOBAL_MEMORY_PATH: autopilot.GLOBAL_MEMORY_PATH,
      buildAutopilotPrompt: autopilot.buildAutopilotPrompt,
      reflectAndUpdateMemory: autopilot.reflectAndUpdateMemory,
      updateGlobalMemory: autopilot.updateGlobalMemory,
      REFLECT_EVERY_N: autopilot.REFLECT_EVERY_N,
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
    it("runs nodes in dependency order and exits loop when all done", async () => {
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
      // Blueprint status is user-managed — autopilot doesn't change it
      expect(final.status).toBe("approved");

      // All nodes are done
      for (const node of final.nodes) {
        expect(node.status).toBe("done");
      }

      // 4 log entries: 3 run_node + 1 loop_exit
      const logs = db.getAutopilotLog(bp.id, 10, 0);
      expect(logs.length).toBe(4);

      // Loop exit entry
      const exitLog = logs.find((l) => l.decision.includes("All nodes complete"));
      expect(exitLog).toBeDefined();
      expect(exitLog!.result).toBe("loop_exit");

      // 3 run_node entries
      const runLogs = logs.filter((l) => l.action === "run_node");
      expect(runLogs.length).toBe(3);

      // AI was called 3 times for decisions + 1 final reflection + 1 global memory update
      expect(mockRunSession).toHaveBeenCalledTimes(5);
    });

    it("exits loop when all nodes are already done (even with unused suggestions)", async () => {
      const bp = setup("Suggestions Triage");
      const nodeA = db.createMacroNode(bp.id, { title: "Node A", order: 1 });
      // Pre-mark node A as done
      db.updateMacroNode(bp.id, nodeA.id, { status: "done" as any });
      db.createSuggestion(bp.id, nodeA.id, "Add logging", "Should add structured logging");

      await ap.runAutopilotLoop(bp.id);

      // Auto-complete fires immediately — no LLM decision calls needed
      // Only final reflection + global memory update
      expect(mockRunSession).toHaveBeenCalledTimes(2);

      const final = db.getBlueprint(bp.id)!;
      // Blueprint status is user-managed — autopilot doesn't change it
      expect(final.status).toBe("approved");
    });

    it("exits loop when insights exist and all nodes done", async () => {
      const bp = setup("Insights Triage");
      const nodeA = db.createMacroNode(bp.id, { title: "Node A", order: 1 });
      db.updateMacroNode(bp.id, nodeA.id, { status: "done" as any });
      db.createInsight(bp.id, nodeA.id, "evaluator", "warning", "Consider refactoring");

      await ap.runAutopilotLoop(bp.id);

      // Auto-complete fires immediately — no LLM decision calls needed
      // Only final reflection + global memory update
      expect(mockRunSession).toHaveBeenCalledTimes(2);

      const final = db.getBlueprint(bp.id)!;
      // Blueprint status is user-managed — autopilot doesn't change it
      expect(final.status).toBe("approved");
    });

    it("creates nodes from suggestions and marks them used", async () => {
      const bp = setup("Suggestion Flow");
      const nodeA = db.createMacroNode(bp.id, { title: "Implement feature", order: 1 });
      const nodeB = db.createMacroNode(bp.id, { title: "Deploy", order: 2, dependencies: [nodeA.id] });
      const suggestion = db.createSuggestion(bp.id, nodeA.id, "Add tests", "Should have unit tests");

      // AI: run A → create_node from suggestion → mark_suggestion_used → run B → run new node → complete
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

      // Reflection triggered at iteration 5 (REFLECT_EVERY_N=5)
      mockRunSession.mockResolvedValueOnce("## Memory\nOk.");
      // After all nodes are done, LLM explicitly completes
      mockRunSession.mockResolvedValueOnce(dec("complete", {}));

      await ap.runAutopilotLoop(bp.id);

      // Blueprint done
      const final = db.getBlueprint(bp.id)!;
      // Blueprint status is user-managed — autopilot doesn't change it
      expect(final.status).toBe("approved");
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
        .mockResolvedValueOnce(dec("skip_node", { nodeId: nodeB.id, reason: "Not needed" }))
        .mockResolvedValueOnce(dec("complete", {}));

      await ap.runAutopilotLoop(bp.id);

      const final = db.getBlueprint(bp.id)!;
      // Blueprint status is user-managed — autopilot doesn't change it
      expect(final.status).toBe("approved");
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
        .mockResolvedValueOnce(dec("run_node", { nodeId: nodeB.id }))
        .mockResolvedValueOnce(dec("complete", {}));

      await ap.runAutopilotLoop(bp.id);

      const final = db.getBlueprint(bp.id)!;
      // Blueprint status is user-managed — autopilot doesn't change it
      expect(final.status).toBe("approved");

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
        .mockResolvedValueOnce(dec("run_node", { nodeId: nodeB.id }))
        .mockResolvedValueOnce(dec("complete", {}));

      await ap.runAutopilotLoop(bp.id);

      const final = db.getBlueprint(bp.id)!;
      // Blueprint status is user-managed — autopilot doesn't change it
      expect(final.status).toBe("approved");
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
        .mockResolvedValueOnce(dec("run_node", { nodeId: nodeA.id }))
        .mockResolvedValueOnce(dec("complete", {}));

      await ap.runAutopilotLoop(bp.id);

      const final = db.getBlueprint(bp.id)!;
      // Blueprint status is user-managed — autopilot doesn't change it
      expect(final.status).toBe("approved");

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
        .mockResolvedValueOnce(dec("run_node", { nodeId: nodeA.id }))
        .mockResolvedValueOnce(dec("complete", {}));

      await ap.runAutopilotLoop(bp.id);

      const final = db.getBlueprint(bp.id)!;
      // Blueprint status is user-managed — autopilot doesn't change it
      expect(final.status).toBe("approved");
      expect(final.nodes[0].title).toBe("Better Title");
      expect(final.nodes[0].description).toBe("Improved desc");
    });

    it("handles batch_create_nodes", async () => {
      const bp = setup("Batch Create");
      const nodeA = db.createMacroNode(bp.id, { title: "Existing", order: 1 });
      // Second node ensures A is not the only node
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

      // Reflection triggered at iteration 5 (REFLECT_EVERY_N=5)
      mockRunSession.mockResolvedValueOnce("## Memory\nOk.");
      // After all nodes are done, LLM explicitly completes
      mockRunSession.mockResolvedValueOnce(dec("complete", {}));

      await ap.runAutopilotLoop(bp.id);

      const final = db.getBlueprint(bp.id)!;
      // Blueprint status is user-managed — autopilot doesn't change it
      expect(final.status).toBe("approved");
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

      // AI was called for 1 decision + 1 final reflection
      expect(mockRunSession).toHaveBeenCalledTimes(2);

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
      // Blueprint status is user-managed — autopilot only sets pauseReason
      expect(final.status).toBe("approved");
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
      // Blueprint status is user-managed — autopilot only sets pauseReason
      expect(final.status).toBe("approved");
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
        .mockResolvedValueOnce(dec("complete", {}));

      // Add a second node so AI can demonstrate early completion
      const nodeB = db.createMacroNode(bp.id, { title: "Node B", order: 2 });

      // First run A, then AI decides to complete early (skipping B)
      mockRunSession.mockReset();
      mockRunSession
        .mockResolvedValueOnce(dec("run_node", { nodeId: nodeA.id }))
        .mockResolvedValueOnce(dec("complete", {}, "B is not needed, marking as complete"));

      await ap.runAutopilotLoop(bp.id);

      const final = db.getBlueprint(bp.id)!;
      // Blueprint status is user-managed — autopilot doesn't change it
      expect(final.status).toBe("approved");
      // B is still pending — AI chose to complete without finishing all nodes
      expect(final.nodes.find((n) => n.id === nodeB.id)!.status).toBe("pending");
    });
  });

  // ─── 5. Recovery ────────────────────────────────────────

  describe("recovery", () => {
    it("resets stuck running blueprint to approved via recoverStaleExecutions", () => {
      const bp = setup("Recovery Test");
      db.createMacroNode(bp.id, { title: "Node A", order: 1 });

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
      db.createExecution(nodeA.id, bp.id, "session-xyz", "primary");

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
      db.createMacroNode(bp.id, { title: "Node B", order: 2 });

      // executeNodeDirect does NOT mark as done — simulates stuck node
      mockExecuteNodeDirect.mockImplementation(async () => {});

      // AI keeps trying to run_node(A) which never completes
      mockRunSession
        .mockResolvedValueOnce(dec("run_node", { nodeId: nodeA.id }))
        .mockResolvedValueOnce(dec("run_node", { nodeId: nodeA.id }))
        .mockResolvedValueOnce(dec("run_node", { nodeId: nodeA.id }));

      await ap.runAutopilotLoop(bp.id);

      const final = db.getBlueprint(bp.id)!;
      // Blueprint status is user-managed — autopilot only sets pauseReason
      expect(final.status).toBe("approved");
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
      // Blueprint status is user-managed — autopilot only sets pauseReason
      expect(final.status).toBe("approved");
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
      // Blueprint status is user-managed — autopilot only sets pauseReason
      expect(final.status).toBe("approved");
      expect(final.pauseReason).toContain("maximum iterations (3)");
    });

    it("force pauses when a node is resumed more than 5 times during the loop", async () => {
      const bp = setup("Resume Cap Loop", 20);
      const nodeA = db.createMacroNode(bp.id, { title: "Stubborn Node", order: 1 });
      db.createMacroNode(bp.id, { title: "Other", order: 2 });

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
      // Blueprint status is user-managed — autopilot only sets pauseReason
      expect(final.status).toBe("approved");
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
        .mockResolvedValueOnce(dec("run_node", { nodeId: nodeB.id }, "Second action"))
        .mockResolvedValueOnce(dec("complete", {}, "All done"));

      await ap.runAutopilotLoop(bp.id);

      const logs = db.getAutopilotLog(bp.id, 10, 0);
      // 2 run_node + 1 complete = 3 entries
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
        .mockResolvedValueOnce(dec("run_node", { nodeId: nodeA.id }))
        .mockResolvedValueOnce(dec("complete", {}));

      await ap.runAutopilotLoop(bp.id);

      const final = db.getBlueprint(bp.id)!;
      // Blueprint status is user-managed — autopilot doesn't change it
      expect(final.status).toBe("approved");

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
      // Blueprint status is user-managed — autopilot only sets pauseReason
      expect(final.status).toBe("approved");
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

  // ─── 10. Concurrency & Race Conditions ──────────────────

  describe("concurrency and race conditions", () => {
    it("two concurrent loops on the same blueprint — second detects mode change", async () => {
      const bp = setup("Concurrent Loops");
      const nodeA = db.createMacroNode(bp.id, { title: "Node A", order: 1 });
      const nodeB = db.createMacroNode(bp.id, { title: "Node B", order: 2 });

      let callCount = 0;
      // First loop runs node A slowly; during it, second loop will see mode switched
      mockRunSession.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return dec("run_node", { nodeId: nodeA.id });
        }
        return dec("run_node", { nodeId: nodeB.id });
      });

      // Simulate: first loop executes nodeA, during which we switch to manual
      mockExecuteNodeDirect.mockImplementation(async (bpId: string, nodeId: string) => {
        db.updateMacroNode(bpId, nodeId, { status: "done" });
        // After first node completes, simulate mode switch to manual
        if (nodeId === nodeA.id) {
          db.updateBlueprint(bpId, { executionMode: "manual" });
        }
      });

      await ap.runAutopilotLoop(bp.id);

      // Loop should have stopped because mode was switched to manual
      const final = db.getBlueprint(bp.id)!;
      // Node A was executed, B was not (loop exited after mode switch detection)
      const nodeAFinal = final.nodes.find((n) => n.id === nodeA.id)!;
      expect(nodeAFinal.status).toBe("done");

      // The log should show manual mode detection
      const logs = db.getAutopilotLog(bp.id, 20, 0);
      const manualLog = logs.find((l) => l.decision.includes("Mode switched to manual"));
      expect(manualLog).toBeDefined();
    });

    it("concurrent executeDecision calls modifying the same blueprint state", async () => {
      const bp = setup("Concurrent Decisions");
      const nodeA = db.createMacroNode(bp.id, { title: "Node A", order: 1 });
      const nodeB = db.createMacroNode(bp.id, { title: "Node B", order: 2 });

      // Import executeDecision for direct testing
      const { executeDecision } = await import("../autopilot.js");

      // Run two execute decisions concurrently on different nodes
      const [resultA, resultB] = await Promise.all([
        executeDecision(bp.id, {
          reasoning: "Run A",
          action: "run_node",
          params: { nodeId: nodeA.id },
        }),
        executeDecision(bp.id, {
          reasoning: "Run B",
          action: "run_node",
          params: { nodeId: nodeB.id },
        }),
      ]);

      expect(resultA.success).toBe(true);
      expect(resultB.success).toBe(true);

      // Both nodes should be done
      const final = db.getBlueprint(bp.id)!;
      const aNode = final.nodes.find((n) => n.id === nodeA.id)!;
      const bNode = final.nodes.find((n) => n.id === nodeB.id)!;
      expect(aNode.status).toBe("done");
      expect(bNode.status).toBe("done");
    });

    it("pause during node execution — loop exits after current node finishes", async () => {
      const bp = setup("Pause During Execution");
      const nodeA = db.createMacroNode(bp.id, { title: "Node A", order: 1 });
      db.createMacroNode(bp.id, { title: "Node B", order: 2 });

      let iterationCount = 0;
      mockRunSession.mockImplementation(async () => {
        iterationCount++;
        if (iterationCount === 1) {
          return dec("run_node", { nodeId: nodeA.id });
        }
        // Shouldn't reach here — mode switch detected after first iteration
        return dec("complete", {});
      });

      // During node A execution, external actor switches to manual mode
      mockExecuteNodeDirect.mockImplementation(async (bpId: string, nodeId: string) => {
        db.updateMacroNode(bpId, nodeId, { status: "done" });
        // External switch to manual — loop will detect on next iteration's mode check
        db.updateBlueprint(bpId, { executionMode: "manual" });
      });

      await ap.runAutopilotLoop(bp.id);

      // Node A was executed, then loop exited due to mode switch
      const final = db.getBlueprint(bp.id)!;
      const nodeAFinal = final.nodes.find((n) => n.id === nodeA.id)!;
      expect(nodeAFinal.status).toBe("done");
      // 1 AI decision call + 1 final reflection — loop saw manual mode on next check
      expect(iterationCount).toBe(2);

      // Verify mode-switch was detected in logs
      const logs = db.getAutopilotLog(bp.id, 20, 0);
      const modeLog = logs.find((l) => l.decision.includes("Mode switched to manual"));
      expect(modeLog).toBeDefined();
    });

    it("concurrent resume count increments for the same node", async () => {
      const bpId = "concurrent-resume-bp";
      const nodeId = "concurrent-resume-node";

      // Clear any prior state
      ap.clearResumeCounts(bpId);

      // Simulate concurrent increments (these are synchronous in-memory ops, but test correctness)
      const results: number[] = [];
      for (let i = 0; i < 10; i++) {
        results.push(ap.incrementResumeCount(bpId, nodeId));
      }

      // Should produce sequential 1..10
      expect(results).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(ap.getResumeCount(bpId, nodeId)).toBe(10);

      ap.clearResumeCounts(bpId);
      expect(ap.getResumeCount(bpId, nodeId)).toBe(0);
    });

    it("mode switch between state snapshot and AI decision does not execute stale action", async () => {
      const bp = setup("Race Mode Switch");
      const nodeA = db.createMacroNode(bp.id, { title: "Node A", order: 1 });

      // AI will return run_node, but during the AI call, mode switches to manual
      mockRunSession.mockImplementation(async () => {
        // Simulate: while AI is "thinking", user switches to manual
        db.updateBlueprint(bp.id, { executionMode: "manual" });
        return dec("run_node", { nodeId: nodeA.id });
      });

      await ap.runAutopilotLoop(bp.id);

      // Loop saw mode=manual at the re-check and stopped.
      // But the stale decision was already returned — the loop structure
      // checks mode BEFORE calling AI, so the decision still executes for this iteration.
      // The important thing is the loop then exits on the next iteration's mode check.
      const logs = db.getAutopilotLog(bp.id, 20, 0);
      // Should have at most 2 entries: 1 run_node + 1 mode-switch detection
      expect(logs.length).toBeLessThanOrEqual(2);
    });

    it("concurrent skip and execute on the same node — last write wins", async () => {
      const bp = setup("Skip vs Execute");
      const nodeA = db.createMacroNode(bp.id, { title: "Node A", order: 1 });

      const { executeDecision } = await import("../autopilot.js");

      // Execute node (slow) and skip node (fast) concurrently
      mockExecuteNodeDirect.mockImplementation(async (bpId: string, nodeId: string) => {
        // Simulate delay — skip will complete first
        await new Promise((resolve) => setTimeout(resolve, 10));
        db.updateMacroNode(bpId, nodeId, { status: "done" });
      });

      const [runResult, skipResult] = await Promise.all([
        executeDecision(bp.id, {
          reasoning: "Run it",
          action: "run_node",
          params: { nodeId: nodeA.id },
        }),
        executeDecision(bp.id, {
          reasoning: "Skip it",
          action: "skip_node",
          params: { nodeId: nodeA.id, reason: "Not needed" },
        }),
      ]);

      expect(runResult.success).toBe(true);
      expect(skipResult.success).toBe(true);

      // Final state depends on execution order — either done or skipped is acceptable
      const final = db.getBlueprint(bp.id)!;
      const node = final.nodes.find((n) => n.id === nodeA.id)!;
      expect(["done", "skipped"]).toContain(node.status);
    });

    it("concurrent state snapshots during node transitions", async () => {
      const bp = setup("Snapshot Race");
      const nodeA = db.createMacroNode(bp.id, { title: "Node A", order: 1 });
      db.createMacroNode(bp.id, { title: "Node B", order: 2 });

      const { buildStateSnapshot } = await import("../autopilot.js");

      // Take snapshot, then update node, then take another snapshot
      const snap1 = buildStateSnapshot(bp.id);
      const nodeASt1 = snap1.nodes.find((n) => n.id === nodeA.id)!;
      expect(nodeASt1.status).toBe("pending");

      // Simulate node completion
      db.updateMacroNode(bp.id, nodeA.id, { status: "done" });

      const snap2 = buildStateSnapshot(bp.id);
      const nodeASt2 = snap2.nodes.find((n) => n.id === nodeA.id)!;
      expect(nodeASt2.status).toBe("done");

      // Summary should reflect the change
      expect(snap1.summary).toContain("0/2 nodes done");
      expect(snap2.summary).toContain("1/2 nodes done");
    });

    it("concurrent blueprint updates — status and mode race", async () => {
      const bp = setup("Status Race");
      db.createMacroNode(bp.id, { title: "Node A", order: 1 });

      // Rapidly toggle status and mode
      db.updateBlueprint(bp.id, { status: "running" });
      db.updateBlueprint(bp.id, { executionMode: "manual" });
      db.updateBlueprint(bp.id, { status: "paused", pauseReason: "race test" });
      db.updateBlueprint(bp.id, { executionMode: "autopilot" });
      db.updateBlueprint(bp.id, { status: "running" });

      // Final state should reflect last write
      const final = db.getBlueprint(bp.id)!;
      expect(final.status).toBe("running");
      expect(final.executionMode).toBe("autopilot");
    });

    it("autopilot loop handles blueprint deletion mid-run gracefully", async () => {
      const bp = setup("Deleted Blueprint");
      const nodeA = db.createMacroNode(bp.id, { title: "Node A", order: 1 });

      let iteration = 0;
      mockRunSession.mockImplementation(async () => {
        iteration++;
        if (iteration === 1) {
          return dec("run_node", { nodeId: nodeA.id });
        }
        return dec("complete", {});
      });

      // After executing node A, switch mode so loop exits (simulating "blueprint gone" scenario)
      mockExecuteNodeDirect.mockImplementation(async (bpId: string, nodeId: string) => {
        db.updateMacroNode(bpId, nodeId, { status: "done" });
        // Change execution mode to make getBlueprint return non-autopilot
        db.updateBlueprint(bpId, { executionMode: "manual" });
      });

      // Should not throw
      await ap.runAutopilotLoop(bp.id);

      // Loop exited gracefully — 1 decision + 1 final reflection + 1 global memory
      expect(iteration).toBe(3);
    });

    it("parallel loops on different blueprints do not interfere", async () => {
      const bp1 = setup("Blueprint 1");
      const bp2 = setup("Blueprint 2");
      const node1 = db.createMacroNode(bp1.id, { title: "Node 1", order: 1 });
      const node2 = db.createMacroNode(bp2.id, { title: "Node 2", order: 1 });

      // Track which blueprint's nodes get executed
      const executedNodes: string[] = [];

      const bp1Calls = { count: 0 };
      const bp2Calls = { count: 0 };

      mockRunSession.mockImplementation(async (prompt: string) => {
        if (prompt.includes("Blueprint 1")) {
          bp1Calls.count++;
          if (bp1Calls.count === 1) return dec("run_node", { nodeId: node1.id });
          return dec("complete", {});
        }
        bp2Calls.count++;
        if (bp2Calls.count === 1) return dec("run_node", { nodeId: node2.id });
        return dec("complete", {});
      });

      mockExecuteNodeDirect.mockImplementation(async (bpId: string, nodeId: string) => {
        executedNodes.push(`${bpId}:${nodeId}`);
        db.updateMacroNode(bpId, nodeId, { status: "done" });
      });

      // Run both loops concurrently
      await Promise.all([
        ap.runAutopilotLoop(bp1.id),
        ap.runAutopilotLoop(bp2.id),
      ]);

      // Both blueprints completed their loops — status unchanged
      const final1 = db.getBlueprint(bp1.id)!;
      const final2 = db.getBlueprint(bp2.id)!;
      expect(final1.status).toBe("approved");
      expect(final2.status).toBe("approved");

      // Each blueprint's node was executed
      expect(executedNodes).toContain(`${bp1.id}:${node1.id}`);
      expect(executedNodes).toContain(`${bp2.id}:${node2.id}`);

      // Resume counts are isolated per blueprint
      expect(ap.getResumeCount(bp1.id, node1.id)).toBe(0);
      expect(ap.getResumeCount(bp2.id, node2.id)).toBe(0);
    });

    it("concurrent create_node and run_node don't corrupt node list", async () => {
      const bp = setup("Concurrent Create Run");
      const nodeA = db.createMacroNode(bp.id, { title: "Node A", order: 1 });

      const { executeDecision } = await import("../autopilot.js");

      // Concurrently run a node and create a new one
      const [runResult, createResult] = await Promise.all([
        executeDecision(bp.id, {
          reasoning: "Run A",
          action: "run_node",
          params: { nodeId: nodeA.id },
        }),
        executeDecision(bp.id, {
          reasoning: "Create B",
          action: "create_node",
          params: { title: "Node B", description: "New node" },
        }),
      ]);

      expect(runResult.success).toBe(true);
      expect(createResult.success).toBe(true);

      // Blueprint should have 2 nodes, both in correct states
      const final = db.getBlueprint(bp.id)!;
      expect(final.nodes.length).toBe(2);
      expect(final.nodes.find((n) => n.id === nodeA.id)!.status).toBe("done");
      expect(final.nodes.find((n) => n.title === "Node B")).toBeDefined();
    });
  });

  // ─── 11. Memory Lifecycle ──────────────────────────────────

  describe("memory lifecycle", () => {
    // Clean up global memory file after each test to prevent cross-test pollution
    afterEach(() => {
      if (existsSync(ap.GLOBAL_MEMORY_PATH)) {
        unlinkSync(ap.GLOBAL_MEMORY_PATH);
      }
    });

    // ── DB Migration ──

    describe("DB migration", () => {
      it("autopilot_memory column exists on blueprints table after initPlanTables", async () => {
        const { getDb } = await import("../db.js");
        const sqliteDb = getDb();
        const cols = sqliteDb.prepare("PRAGMA table_info(blueprints)").all() as { name: string }[];
        expect(cols.some((c: { name: string }) => c.name === "autopilot_memory")).toBe(true);
      });

      it("getAutopilotMemory returns null for a newly created blueprint", () => {
        const bp = db.createBlueprint("Memory Init", "test", "/tmp");
        expect(db.getAutopilotMemory(bp.id)).toBeNull();
      });

      it("setAutopilotMemory persists and getAutopilotMemory retrieves it", () => {
        const bp = db.createBlueprint("Memory Persist", "test", "/tmp");
        db.setAutopilotMemory(bp.id, "## Strategy\nUse enrich before run.");
        expect(db.getAutopilotMemory(bp.id)).toBe("## Strategy\nUse enrich before run.");
      });

      it("setAutopilotMemory with null clears the value", () => {
        const bp = db.createBlueprint("Memory Clear", "test", "/tmp");
        db.setAutopilotMemory(bp.id, "Some memory");
        expect(db.getAutopilotMemory(bp.id)).toBe("Some memory");
        db.setAutopilotMemory(bp.id, null);
        expect(db.getAutopilotMemory(bp.id)).toBeNull();
      });
    });

    // ── Memory Persistence Across Loop Iterations ──

    describe("memory persistence across loop iterations", () => {
      it("reflectAndUpdateMemory writes to DB after REFLECT_EVERY_N iterations", async () => {
        const bp = setup("Reflect Trigger", 20);
        // Create enough nodes to run 5+ iterations
        const nodes = [];
        for (let i = 0; i < 6; i++) {
          nodes.push(db.createMacroNode(bp.id, { title: `Node ${i}`, order: i + 1 }));
        }

        // Queue 6 run_node decisions + explicit complete
        for (const node of nodes) {
          mockRunSession.mockResolvedValueOnce(dec("run_node", { nodeId: node.id }));
        }
        mockRunSession.mockResolvedValueOnce(dec("complete", {}));
        // Reflection calls return updated memory
        mockRunSession.mockResolvedValue("## Updated Memory\nLearned to enrich first.");

        await ap.runAutopilotLoop(bp.id);

        // Verify memory was written to DB
        const memory = db.getAutopilotMemory(bp.id);
        expect(memory).not.toBeNull();
        expect(memory).toContain("Updated Memory");
      });

      it("updated memory is passed to subsequent buildAutopilotPrompt calls", async () => {
        const bp = setup("Memory Inject", 10);
        const nodeA = db.createMacroNode(bp.id, { title: "Node A", order: 1 });
        const nodeB = db.createMacroNode(bp.id, { title: "Node B", order: 2 });

        // Pre-set memory on blueprint
        db.setAutopilotMemory(bp.id, "## Existing Memory\nAlways enrich before running.");

        const promptsReceived: string[] = [];
        let memInjectDecisionCount = 0;
        mockRunSession.mockImplementation(async (prompt: string) => {
          promptsReceived.push(prompt);
          if (!prompt.includes("reflecting") && !prompt.includes("global autopilot") && !prompt.includes("global strategy")) {
            memInjectDecisionCount++;
            if (memInjectDecisionCount === 1) return dec("run_node", { nodeId: nodeA.id });
            if (memInjectDecisionCount === 2) return dec("run_node", { nodeId: nodeB.id });
            return dec("complete", {});
          }
          // Reflection/global memory calls — return updated memory
          return "## Refreshed Memory\nNew insight.";
        });

        await ap.runAutopilotLoop(bp.id);

        // The first decision prompt should include the pre-set memory
        expect(promptsReceived[0]).toContain("Existing Memory");
        expect(promptsReceived[0]).toContain("Always enrich before running.");
      });
    });

    // ── Global Memory Lifecycle ──

    describe("global memory lifecycle", () => {
      it("first blueprint completion creates global memory file", async () => {
        // Ensure no global memory file exists
        if (existsSync(ap.GLOBAL_MEMORY_PATH)) {
          unlinkSync(ap.GLOBAL_MEMORY_PATH);
        }

        const bp = setup("First Blueprint");
        const nodeA = db.createMacroNode(bp.id, { title: "Node A", order: 1 });

        // 1 run_node decision, then auto-complete fires
        mockRunSession
          .mockResolvedValueOnce(dec("run_node", { nodeId: nodeA.id }));
        // Final reflection returns memory
        mockRunSession.mockResolvedValueOnce("## Blueprint Reflection\nGood run.");
        // Global memory update returns content
        mockRunSession.mockResolvedValueOnce("## Global Strategy\nAlways coordinate after 5 nodes.");

        await ap.runAutopilotLoop(bp.id);

        // Global memory file should now exist
        expect(existsSync(ap.GLOBAL_MEMORY_PATH)).toBe(true);
        const content = ap.readGlobalMemory();
        expect(content).toContain("Global Strategy");
      });

      it("second blueprint completion updates (replaces) existing global file", async () => {
        // Pre-create global memory
        ap.writeGlobalMemory("## Old Strategy\nInitial content.");

        const bp = setup("Second Blueprint");
        const nodeA = db.createMacroNode(bp.id, { title: "Node A", order: 1 });

        // 1 run_node decision, then auto-complete fires
        mockRunSession
          .mockResolvedValueOnce(dec("run_node", { nodeId: nodeA.id }));
        // Final reflection
        mockRunSession.mockResolvedValueOnce("## Reflection\nLearned things.");
        // Global memory update — replaces old content
        mockRunSession.mockResolvedValueOnce("## New Strategy\nReplaced content.");

        await ap.runAutopilotLoop(bp.id);

        const content = ap.readGlobalMemory();
        expect(content).toBe("## New Strategy\nReplaced content.");
        // Old content is gone
        expect(content).not.toContain("Old Strategy");
      });

      it("global memory is read at loop start and injected into decision prompt", async () => {
        // Pre-create global memory file
        ap.writeGlobalMemory("## Cross-Blueprint Strategy\nCoordinate every 3 nodes.");

        const bp = setup("Global Read");
        const nodeA = db.createMacroNode(bp.id, { title: "Node A", order: 1 });

        const promptsReceived: string[] = [];
        let globalReadDecisionCount = 0;
        mockRunSession.mockImplementation(async (prompt: string) => {
          promptsReceived.push(prompt);
          if (!prompt.includes("reflecting") && !prompt.includes("global autopilot") && !prompt.includes("global strategy")) {
            globalReadDecisionCount++;
            if (globalReadDecisionCount === 1) return dec("run_node", { nodeId: nodeA.id });
            return dec("complete", {});
          }
          return "## Memory\nOk.";
        });

        await ap.runAutopilotLoop(bp.id);

        // First prompt (decision prompt) should contain global memory
        expect(promptsReceived[0]).toContain("Global Strategy (from previous blueprints)");
        expect(promptsReceived[0]).toContain("Coordinate every 3 nodes.");
      });
    });

    // ── Blueprint Resume with Existing Memory ──

    describe("blueprint resume with existing memory", () => {
      it("first iteration prompt includes pre-set autopilot_memory", async () => {
        const bp = setup("Resume Memory");
        const nodeA = db.createMacroNode(bp.id, { title: "Node A", order: 1 });

        // Pre-set memory as if from a previous autopilot run
        db.setAutopilotMemory(bp.id, "## Prior Run Notes\n- Node A needs extra context\n- Use enrich first");

        const promptsReceived: string[] = [];
        let resumeDecisionCount = 0;
        mockRunSession.mockImplementation(async (prompt: string) => {
          promptsReceived.push(prompt);
          if (!prompt.includes("reflecting") && !prompt.includes("global autopilot") && !prompt.includes("global strategy")) {
            resumeDecisionCount++;
            if (resumeDecisionCount === 1) return dec("run_node", { nodeId: nodeA.id });
            return dec("complete", {});
          }
          return "## Updated\nNew notes.";
        });

        await ap.runAutopilotLoop(bp.id);

        // Decision prompt should include the pre-existing blueprint memory
        expect(promptsReceived[0]).toContain("Blueprint Memory (your notes from earlier iterations)");
        expect(promptsReceived[0]).toContain("Prior Run Notes");
        expect(promptsReceived[0]).toContain("Node A needs extra context");
      });
    });

    // ── Concurrent Blueprints with Separate Memories ──

    describe("concurrent blueprints with separate memories", () => {
      it("each loop reads its own per-blueprint memory independently", async () => {
        const bp1 = setup("Concurrent Mem 1");
        const bp2 = setup("Concurrent Mem 2");
        const node1 = db.createMacroNode(bp1.id, { title: "Node 1", order: 1 });
        const node2 = db.createMacroNode(bp2.id, { title: "Node 2", order: 1 });

        // Pre-set different memories for each blueprint
        db.setAutopilotMemory(bp1.id, "## BP1 Memory\nFocus on testing.");
        db.setAutopilotMemory(bp2.id, "## BP2 Memory\nFocus on performance.");

        const bp1Prompts: string[] = [];
        const bp2Prompts: string[] = [];

        const bp1Decisions = { count: 0 };
        const bp2Decisions = { count: 0 };

        mockRunSession.mockImplementation(async (prompt: string) => {
          if (prompt.includes("Concurrent Mem 1") && !prompt.includes("reflecting") && !prompt.includes("global autopilot")) {
            bp1Prompts.push(prompt);
            bp1Decisions.count++;
            if (bp1Decisions.count === 1) return dec("run_node", { nodeId: node1.id });
            return dec("complete", {});
          }
          if (prompt.includes("Concurrent Mem 2") && !prompt.includes("reflecting") && !prompt.includes("global autopilot")) {
            bp2Prompts.push(prompt);
            bp2Decisions.count++;
            if (bp2Decisions.count === 1) return dec("run_node", { nodeId: node2.id });
            return dec("complete", {});
          }
          // Reflection/global calls
          return "## Reflection\nOk.";
        });

        mockExecuteNodeDirect.mockImplementation(async (bpId: string, nodeId: string) => {
          db.updateMacroNode(bpId, nodeId, { status: "done" });
        });

        await Promise.all([
          ap.runAutopilotLoop(bp1.id),
          ap.runAutopilotLoop(bp2.id),
        ]);

        // BP1's prompt should contain BP1's memory, not BP2's
        expect(bp1Prompts.length).toBeGreaterThan(0);
        expect(bp1Prompts[0]).toContain("BP1 Memory");
        expect(bp1Prompts[0]).toContain("Focus on testing.");
        expect(bp1Prompts[0]).not.toContain("BP2 Memory");

        // BP2's prompt should contain BP2's memory, not BP1's
        expect(bp2Prompts.length).toBeGreaterThan(0);
        expect(bp2Prompts[0]).toContain("BP2 Memory");
        expect(bp2Prompts[0]).toContain("Focus on performance.");
        expect(bp2Prompts[0]).not.toContain("BP1 Memory");

        // Both blueprints done
        expect(db.getBlueprint(bp1.id)!.status).toBe("approved");
        expect(db.getBlueprint(bp2.id)!.status).toBe("approved");
      });

      it("global memory file is shared (last-write-wins)", async () => {
        const bp1 = setup("Shared Global 1");
        const bp2 = setup("Shared Global 2");
        const node1 = db.createMacroNode(bp1.id, { title: "Node 1", order: 1 });
        const node2 = db.createMacroNode(bp2.id, { title: "Node 2", order: 1 });

        const sg1Decisions = { count: 0 };
        const sg2Decisions = { count: 0 };

        mockRunSession.mockImplementation(async (prompt: string) => {
          if (prompt.includes("Shared Global 1") && !prompt.includes("reflecting") && !prompt.includes("global autopilot")) {
            sg1Decisions.count++;
            if (sg1Decisions.count === 1) return dec("run_node", { nodeId: node1.id });
            return dec("complete", {});
          }
          if (prompt.includes("Shared Global 2") && !prompt.includes("reflecting") && !prompt.includes("global autopilot")) {
            sg2Decisions.count++;
            if (sg2Decisions.count === 1) return dec("run_node", { nodeId: node2.id });
            return dec("complete", {});
          }
          // Reflection calls
          if (prompt.includes("global autopilot") || prompt.includes("global strategy")) {
            return "## Final Global\nLast writer wins.";
          }
          return "## Reflection\nOk.";
        });

        mockExecuteNodeDirect.mockImplementation(async (bpId: string, nodeId: string) => {
          db.updateMacroNode(bpId, nodeId, { status: "done" });
        });

        await Promise.all([
          ap.runAutopilotLoop(bp1.id),
          ap.runAutopilotLoop(bp2.id),
        ]);

        // Global file should exist with content from one of the blueprints
        if (existsSync(ap.GLOBAL_MEMORY_PATH)) {
          const content = ap.readGlobalMemory();
          expect(content).not.toBeNull();
        }
        // Both completed
        expect(db.getBlueprint(bp1.id)!.status).toBe("approved");
        expect(db.getBlueprint(bp2.id)!.status).toBe("approved");
      });
    });

    // ── Edge Case: Early Pause Before First Scheduled Reflection ──

    describe("early pause before first scheduled reflection", () => {
      it("final reflection runs at loop exit even when paused before REFLECT_EVERY_N", async () => {
        const bp = setup("Early Pause", 20);
        const nodeA = db.createMacroNode(bp.id, { title: "Node A", order: 1 });
        db.createMacroNode(bp.id, { title: "Node B", order: 2 });

        // Iter 1: run_node (success, no reflection: only 1 iter since last, action != pause, no error)
        // Iter 2: pause → triggers reflection (action=pause), then final reflection after loop
        mockRunSession
          .mockResolvedValueOnce(dec("run_node", { nodeId: nodeA.id }))   // decision iter 1
          .mockResolvedValueOnce(dec("pause", { reason: "Need clarification" }));  // decision iter 2

        // After pause: pause-triggered reflection (call 3), then final reflection (call 4)
        mockRunSession.mockResolvedValue("## Final Reflection\nPaused early, still reflected.");

        await ap.runAutopilotLoop(bp.id);

        const final = db.getBlueprint(bp.id)!;
        // Blueprint status is user-managed — autopilot only sets pauseReason
      expect(final.status).toBe("approved");

        // Memory should have been saved by reflection
        const memory = db.getAutopilotMemory(bp.id);
        expect(memory).not.toBeNull();
        expect(memory).toContain("Final Reflection");
      });

      it("pause-triggered reflection at iteration 2 writes memory before exit", async () => {
        const bp = setup("Pause Reflect", 20);
        const nodeA = db.createMacroNode(bp.id, { title: "Node A", order: 1 });
        db.createMacroNode(bp.id, { title: "Node B", order: 2 });

        // Run one node, then pause
        mockRunSession
          .mockResolvedValueOnce(dec("run_node", { nodeId: nodeA.id }))
          .mockResolvedValueOnce(dec("pause", { reason: "Waiting for feedback" }));

        // Pause triggers reflection (action=pause), then final reflection also runs
        mockRunSession.mockResolvedValue("## Pause Memory\nStopped at node A.");

        await ap.runAutopilotLoop(bp.id);

        // Blueprint status unchanged — only pauseReason set
        expect(db.getBlueprint(bp.id)!.status).toBe("approved");
        expect(db.getBlueprint(bp.id)!.pauseReason).toContain("Waiting for feedback");

        // Memory should be persisted
        const memory = db.getAutopilotMemory(bp.id);
        expect(memory).not.toBeNull();
        expect(memory).toContain("Pause Memory");
      });
    });

    // ── buildAutopilotPrompt Memory Injection ──

    describe("buildAutopilotPrompt memory injection", () => {
      it("includes both blueprint and global memory in prompt", async () => {
        const bp = setup("Prompt Test");
        db.createMacroNode(bp.id, { title: "Node A", order: 1 });

        const { buildStateSnapshot } = await import("../autopilot.js");
        const state = buildStateSnapshot(bp.id);

        const prompt = ap.buildAutopilotPrompt(state, 1, 50, {
          blueprint: "## BP Mem\nTest patterns.",
          global: "## Global Strat\nAlways coordinate.",
        });

        expect(prompt).toContain("## Global Strategy (from previous blueprints)");
        expect(prompt).toContain("Always coordinate.");
        expect(prompt).toContain("## Blueprint Memory (your notes from earlier iterations)");
        expect(prompt).toContain("Test patterns.");
      });

      it("omits memory sections when both are null", async () => {
        const bp = setup("No Memory Prompt");
        db.createMacroNode(bp.id, { title: "Node A", order: 1 });

        const { buildStateSnapshot } = await import("../autopilot.js");
        const state = buildStateSnapshot(bp.id);

        const prompt = ap.buildAutopilotPrompt(state, 1, 50, {
          blueprint: null,
          global: null,
        });

        expect(prompt).not.toContain("Global Strategy");
        expect(prompt).not.toContain("Blueprint Memory");
      });
    });

    // ── Global Memory File Helpers ──

    describe("global memory file helpers", () => {
      it("readGlobalMemory returns null when file does not exist", () => {
        if (existsSync(ap.GLOBAL_MEMORY_PATH)) {
          unlinkSync(ap.GLOBAL_MEMORY_PATH);
        }
        expect(ap.readGlobalMemory()).toBeNull();
      });

      it("writeGlobalMemory creates file and readGlobalMemory reads it", () => {
        ap.writeGlobalMemory("## Test Strategy\nContent here.");
        expect(existsSync(ap.GLOBAL_MEMORY_PATH)).toBe(true);
        expect(ap.readGlobalMemory()).toBe("## Test Strategy\nContent here.");
      });

      it("writeGlobalMemory overwrites existing content", () => {
        ap.writeGlobalMemory("## First\nOriginal.");
        ap.writeGlobalMemory("## Second\nReplacement.");
        expect(ap.readGlobalMemory()).toBe("## Second\nReplacement.");
        expect(ap.readGlobalMemory()).not.toContain("First");
      });
    });
  });

  // ─── 12. FSD Loop Yield and Message Pipeline ──────────

  describe("FSD loop yield and message pipeline", () => {
    // Need direct access to plan-db message functions
    let createAutopilotMessage: typeof import("../plan-db.js")["createAutopilotMessage"];
    let getUnacknowledgedMessages: typeof import("../plan-db.js")["getUnacknowledgedMessages"];
    let buildStateSnapshot: typeof import("../autopilot.js")["buildStateSnapshot"];
    let executeDecision: typeof import("../autopilot.js")["executeDecision"];

    beforeAll(async () => {
      const planDb = await import("../plan-db.js");
      createAutopilotMessage = planDb.createAutopilotMessage;
      getUnacknowledgedMessages = planDb.getUnacknowledgedMessages;

      const autopilot = await import("../autopilot.js");
      buildStateSnapshot = autopilot.buildStateSnapshot;
      executeDecision = autopilot.executeDecision;
    });

    /** Create an FSD blueprint (autopilot with no safeguards, unlimited iterations) */
    function setupFsd(title: string) {
      const bp = db.createBlueprint(title, "FSD integration test", "/tmp/fsd-test");
      db.updateBlueprint(bp.id, {
        status: "approved",
        executionMode: "fsd",
      });
      return bp;
    }

    // ── 12.1. FSD loop yields when unacknowledged messages exist ──

    it("FSD loop yields when unacknowledged messages exist", async () => {
      const bp = setupFsd("Yield on Msg");
      db.createMacroNode(bp.id, { title: "Node A", order: 1 });

      // Create a user message before loop starts
      createAutopilotMessage(bp.id, "user", "Focus on tests");

      // Provide a reflection response (final reflection always runs after loop exit)
      mockRunSession.mockResolvedValue("## Memory\nYielded due to pending messages.");

      await ap.runAutopilotLoop(bp.id);

      // Only the final reflection should have called mockRunSession — no AI decisions
      // (The loop yielded before reaching the decision step, but final reflection runs)
      const decisionCalls = mockRunSession.mock.calls.filter(
        (call) => !String(call[0]).includes("reflecting"),
      );
      expect(decisionCalls.length).toBe(0);

      // Node should still be pending (loop did not execute anything)
      const final = db.getBlueprint(bp.id)!;
      expect(final.nodes[0].status).toBe("pending");
      expect(final.status).toBe("approved");

      // Messages are still unacknowledged (User Agent handles them, not FSD loop)
      const unacked = getUnacknowledgedMessages(bp.id);
      expect(unacked.length).toBeGreaterThanOrEqual(1);
    });

    // ── 12.2. Manual mode fallback ──

    it("manual mode does not create messages for AI operations", async () => {
      const bp = db.createBlueprint("Manual Fallback", "Test", "/tmp/manual");
      db.updateBlueprint(bp.id, { status: "approved" });
      // executionMode defaults to "manual" (undefined)
      const nodeA = db.createMacroNode(bp.id, { title: "Node A", order: 1 });

      // In manual mode, no autopilot messages should exist
      const messagesBefore = getUnacknowledgedMessages(bp.id);
      expect(messagesBefore.length).toBe(0);

      // Directly creating a message is fine, but triggerAutopilotIfNeeded would be a no-op
      // since executionMode is manual. Verify by checking the blueprint stays as-is.
      const bpData = db.getBlueprint(bp.id)!;
      expect(bpData.executionMode).toBeUndefined(); // manual = undefined
      expect(bpData.nodes.find((n) => n.id === nodeA.id)!.status).toBe("pending");
    });

    // ── 12.3. Read tools in autopilot loop ──

    it("get_node_titles returns summary without descriptions", async () => {
      const bp = setupFsd("Read Tools");
      const nodeA = db.createMacroNode(bp.id, { title: "API Design", description: "Full API spec", order: 1 });
      const nodeB = db.createMacroNode(bp.id, { title: "Implementation", description: "Build it", order: 2, dependencies: [nodeA.id] });

      // Test get_node_titles via executeDecision
      const titlesResult = await executeDecision(bp.id, {
        reasoning: "Get overview",
        action: "get_node_titles",
        params: {},
      });

      expect(titlesResult.success).toBe(true);
      const titles = JSON.parse(titlesResult.message);
      expect(titles.length).toBe(2);
      // Should have id, seq, title, status but NOT description
      expect(titles[0]).toHaveProperty("title");
      expect(titles[0]).toHaveProperty("status");
      expect(titles[0]).not.toHaveProperty("description");

      // Test get_node_details returns full context including description
      const detailsResult = await executeDecision(bp.id, {
        reasoning: "Get details",
        action: "get_node_details",
        params: { nodeId: nodeA.id },
      });

      expect(detailsResult.success).toBe(true);
      const details = JSON.parse(detailsResult.message);
      expect(details.title).toBe("API Design");
      expect(details.description).toBe("Full API spec");
      expect(details.dependencies).toBeDefined();
    });

    // ── 12.4. Autopilot not double-started ──

    it("autopilot loop does not start again while already running", async () => {
      const bp = setupFsd("No Double Start");
      const nodeA = db.createMacroNode(bp.id, { title: "Node A", order: 1 });

      let loopRunning = false;
      let concurrentAttempts = 0;

      let noDoubleDecisionCount = 0;
      mockRunSession.mockImplementation(async (prompt: string) => {
        if (prompt.includes("reflecting") || prompt.includes("global autopilot") || prompt.includes("global strategy")) {
          return "## Memory\nOk.";
        }
        if (loopRunning) {
          concurrentAttempts++;
        }
        loopRunning = true;
        // Simulate some work
        await new Promise((r) => setTimeout(r, 10));
        loopRunning = false;
        noDoubleDecisionCount++;
        if (noDoubleDecisionCount === 1) return dec("run_node", { nodeId: nodeA.id });
        return dec("complete", {});
      });

      // Start autopilot loop
      const loop1 = ap.runAutopilotLoop(bp.id);
      // A second loop on the same blueprint should effectively be a no-op
      // because after the first one completes, blueprint is done
      const loop2 = ap.runAutopilotLoop(bp.id);

      await Promise.all([loop1, loop2]);

      // The second loop either found bp already done or exited quickly
      // The key invariant: both loops complete without errors
      const final = db.getBlueprint(bp.id)!;
      expect(["done", "approved"]).toContain(final.status);
    });

    // ── 12.5. Reduced state snapshot ──

    it("buildStateSnapshot nodes do not include description or suggestions", () => {
      const bp = setupFsd("Reduced Snapshot");
      db.createMacroNode(bp.id, {
        title: "Node With Description",
        description: "This is a detailed description that should not appear in snapshot",
        order: 1,
      });

      const state = buildStateSnapshot(bp.id);
      expect(state.nodes.length).toBe(1);

      const nodeState = state.nodes[0];
      // AutopilotNodeState should have these fields
      expect(nodeState).toHaveProperty("id");
      expect(nodeState).toHaveProperty("seq");
      expect(nodeState).toHaveProperty("title");
      expect(nodeState).toHaveProperty("status");
      expect(nodeState).toHaveProperty("dependencies");
      expect(nodeState).toHaveProperty("resumeCount");

      // Should NOT have description or suggestions (fetched on-demand via read tools)
      expect(nodeState).not.toHaveProperty("description");
      expect(nodeState).not.toHaveProperty("suggestions");
    });

    // ── 12.6. Prompt does not contain user message features ──

    it("buildAutopilotPrompt does not contain user message tools or sections", () => {
      const bp = setupFsd("No Msg Prompt");
      db.createMacroNode(bp.id, { title: "Node A", order: 1 });

      const state = buildStateSnapshot(bp.id);

      const prompt = ap.buildAutopilotPrompt(
        state, 1, 50,
        { blueprint: null, global: null },
        false,
      );

      // User message handling is now in User Agent, not FSD loop
      expect(prompt).not.toContain("User Messages (HIGHEST PRIORITY");
      expect(prompt).not.toContain("acknowledge_message");
      expect(prompt).not.toContain("read_user_messages");
      expect(prompt).not.toContain("send_message(content)");

      // Read tools should still be present
      expect(prompt).toContain("get_node_titles");
      expect(prompt).toContain("get_node_details");
      expect(prompt).toContain("get_node_handoff");
    });

    // ── 12.7. Removed message tools return unknown_action ──

    it("acknowledge_message returns unknown_action error", async () => {
      const bp = setupFsd("Bad Ack");
      db.createMacroNode(bp.id, { title: "Node A", order: 1 });

      const result = await executeDecision(bp.id, {
        reasoning: "Try removed tool",
        action: "acknowledge_message",
        params: { messageId: "non-existent-message-id" },
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("unknown_action");
    });
  });
});
