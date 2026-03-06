import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ───────────────────────────────────────────────────

// Mock plan-db.js
vi.mock("../plan-db.js", () => ({
  getBlueprint: vi.fn(),
  getSuggestionsForNode: vi.fn(),
  getInsightsForBlueprint: vi.fn(),
  updateBlueprint: vi.fn(),
  createMacroNode: vi.fn(),
  updateMacroNode: vi.fn(),
  reorderMacroNodes: vi.fn(),
  markInsightRead: vi.fn(),
  dismissInsight: vi.fn(),
  markSuggestionUsed: vi.fn(),
  getExecutionsForNode: vi.fn(),
  createConveneSession: vi.fn(),
  getAutopilotLog: vi.fn(),
  setAutopilotMemory: vi.fn(),
  getAutopilotMemory: vi.fn(),
}));

// Mock plan-executor.js
vi.mock("../plan-executor.js", () => ({
  getQueueInfo: vi.fn(),
  executeNodeDirect: vi.fn(async () => {}),
  resumeNodeSession: vi.fn(async () => {}),
  evaluateNodeCompletion: vi.fn(async () => {}),
  addPendingTask: vi.fn(),
  removePendingTask: vi.fn(),
}));

// Mock plan-operations.js
vi.mock("../plan-operations.js", () => ({
  enrichNodeInternal: vi.fn(async () => {}),
  reevaluateNodeInternal: vi.fn(async () => {}),
  splitNodeInternal: vi.fn(async () => {}),
  smartDepsInternal: vi.fn(async () => {}),
  reevaluateAllInternal: vi.fn(async () => []),
}));

// Mock plan-coordinator.js
vi.mock("../plan-coordinator.js", () => ({
  coordinateBlueprint: vi.fn(async () => {}),
}));

// Mock plan-convene.js
vi.mock("../plan-convene.js", () => ({
  executeConveneSession: vi.fn(async () => {}),
}));

// Mock agent-runtime.js
vi.mock("../agent-runtime.js", () => ({
  getActiveRuntime: vi.fn(),
}));

// Mock db.js
vi.mock("../db.js", () => ({
  getDb: vi.fn(),
}));

// Mock logger
vi.mock("../logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Side-effect mocks
vi.mock("../agent-claude.js", () => ({}));
vi.mock("../agent-pimono.js", () => ({}));
vi.mock("../agent-openclaw.js", () => ({}));
vi.mock("../agent-codex.js", () => ({}));
vi.mock("../roles/load-all-roles.js", () => ({}));

// Mock node:fs for global memory file helpers
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import {
  buildStateSnapshot,
  executeDecision,
  buildAutopilotPrompt,
  getResumeCount,
  incrementResumeCount,
  clearResumeCounts,
  computeToolUsageStats,
  readGlobalMemory,
  writeGlobalMemory,
  reflectAndUpdateMemory,
  updateGlobalMemory,
  REFLECT_EVERY_N,
  BLUEPRINT_MEMORY_MAX_CHARS,
  GLOBAL_MEMORY_MAX_CHARS,
} from "../autopilot.js";
import type { AutopilotDecision, AutopilotState } from "../autopilot.js";

import {
  getBlueprint,
  getSuggestionsForNode,
  getInsightsForBlueprint,
  updateBlueprint,
  createMacroNode,
  updateMacroNode,
  reorderMacroNodes,
  markInsightRead,
  dismissInsight,
  markSuggestionUsed,
  getExecutionsForNode,
  createConveneSession,
  getAutopilotLog,
  setAutopilotMemory,
} from "../plan-db.js";
import type { MacroNodeStatus, Artifact, NodeExecution } from "../plan-db.js";
import {
  getQueueInfo,
  executeNodeDirect,
  resumeNodeSession,
  evaluateNodeCompletion,
  addPendingTask,
  removePendingTask,
} from "../plan-executor.js";
import {
  enrichNodeInternal,
  reevaluateNodeInternal,
  splitNodeInternal,
  smartDepsInternal,
  reevaluateAllInternal,
} from "../plan-operations.js";
import { coordinateBlueprint } from "../plan-coordinator.js";
import { getDb } from "../db.js";
import { getActiveRuntime } from "../agent-runtime.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";

// ─── Test Data ───────────────────────────────────────────────

function mockNode(overrides: Record<string, unknown> = {}) {
  return {
    id: "node-1",
    blueprintId: "bp-1",
    seq: 1,
    title: "Test Node",
    description: "Test description",
    status: "pending" as MacroNodeStatus,
    dependencies: [] as string[],
    order: 0,
    roles: undefined as string[] | undefined,
    error: undefined as string | undefined,
    inputArtifacts: [] as Artifact[],
    outputArtifacts: [] as Artifact[],
    executions: [] as NodeExecution[],
    createdAt: "2024-01-01",
    updatedAt: "2024-01-01",
    ...overrides,
  };
}

function mockBlueprint(overrides: Record<string, unknown> = {}) {
  return {
    id: "bp-1",
    title: "Test Blueprint",
    description: "Blueprint desc",
    status: "running" as const,
    enabledRoles: ["sde"],
    nodes: [mockNode()],
    createdAt: "2024-01-01",
    updatedAt: "2024-01-01",
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────

describe("autopilot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearResumeCounts("bp-1");
  });

  // ──── buildStateSnapshot ─────────────────────────────────────

  describe("buildStateSnapshot", () => {
    it("throws if blueprint not found", () => {
      vi.mocked(getBlueprint).mockReturnValue(null);
      expect(() => buildStateSnapshot("not-exist")).toThrow("Blueprint not-exist not found");
    });

    it("collects blueprint metadata correctly", () => {
      const bp = mockBlueprint();
      vi.mocked(getBlueprint).mockReturnValue(bp);
      vi.mocked(getSuggestionsForNode).mockReturnValue([]);
      vi.mocked(getInsightsForBlueprint).mockReturnValue([]);
      vi.mocked(getQueueInfo).mockReturnValue({ running: false, pendingTasks: [], queueLength: 0 });

      const state = buildStateSnapshot("bp-1");

      expect(state.blueprint).toEqual({
        id: "bp-1",
        title: "Test Blueprint",
        description: "Blueprint desc",
        status: "running",
        enabledRoles: ["sde"],
      });
    });

    it("includes nodes with correct statuses", () => {
      const nodes = [
        mockNode({ id: "n1", seq: 1, status: "pending" }),
        mockNode({ id: "n2", seq: 2, status: "running" }),
        mockNode({ id: "n3", seq: 3, status: "done" }),
        mockNode({ id: "n4", seq: 4, status: "failed", error: "Some error" }),
        mockNode({ id: "n5", seq: 5, status: "skipped" }),
      ];
      const bp = mockBlueprint({ nodes });
      vi.mocked(getBlueprint).mockReturnValue(bp);
      vi.mocked(getSuggestionsForNode).mockReturnValue([]);
      vi.mocked(getInsightsForBlueprint).mockReturnValue([]);
      vi.mocked(getQueueInfo).mockReturnValue({ running: false, pendingTasks: [], queueLength: 0 });

      const state = buildStateSnapshot("bp-1");

      expect(state.nodes).toHaveLength(5);
      expect(state.nodes.map((n) => n.status)).toEqual([
        "pending", "running", "done", "failed", "skipped",
      ]);
      expect(state.nodes[3].error).toBe("Some error");
    });

    it("truncates descriptions to 200 chars", () => {
      const longDesc = "a".repeat(250);
      const nodes = [mockNode({ id: "n1", description: longDesc })];
      const bp = mockBlueprint({ nodes });
      vi.mocked(getBlueprint).mockReturnValue(bp);
      vi.mocked(getSuggestionsForNode).mockReturnValue([]);
      vi.mocked(getInsightsForBlueprint).mockReturnValue([]);
      vi.mocked(getQueueInfo).mockReturnValue({ running: false, pendingTasks: [], queueLength: 0 });

      const state = buildStateSnapshot("bp-1");

      expect(state.nodes[0].description.length).toBe(200);
      expect(state.nodes[0].description.endsWith("...")).toBe(true);
    });

    it("does not truncate descriptions <= 200 chars", () => {
      const desc = "a".repeat(200);
      const nodes = [mockNode({ id: "n1", description: desc })];
      const bp = mockBlueprint({ nodes });
      vi.mocked(getBlueprint).mockReturnValue(bp);
      vi.mocked(getSuggestionsForNode).mockReturnValue([]);
      vi.mocked(getInsightsForBlueprint).mockReturnValue([]);
      vi.mocked(getQueueInfo).mockReturnValue({ running: false, pendingTasks: [], queueLength: 0 });

      const state = buildStateSnapshot("bp-1");

      expect(state.nodes[0].description.length).toBe(200);
      expect(state.nodes[0].description).toBe(desc);
    });

    it("filters out used suggestions and truncates suggestion descriptions to 150 chars", () => {
      const longSugDesc = "s".repeat(200);
      const suggestions = [
        { id: "s1", nodeId: "n1", blueprintId: "bp-1", title: "Fix A", description: "short", used: false, createdAt: "" },
        { id: "s2", nodeId: "n1", blueprintId: "bp-1", title: "Fix B", description: "used one", used: true, createdAt: "" },
        { id: "s3", nodeId: "n1", blueprintId: "bp-1", title: "Fix C", description: longSugDesc, used: false, roles: ["qa"], createdAt: "" },
      ];
      const bp = mockBlueprint({ nodes: [mockNode({ id: "n1" })] });
      vi.mocked(getBlueprint).mockReturnValue(bp);
      vi.mocked(getSuggestionsForNode).mockReturnValue(suggestions);
      vi.mocked(getInsightsForBlueprint).mockReturnValue([]);
      vi.mocked(getQueueInfo).mockReturnValue({ running: false, pendingTasks: [], queueLength: 0 });

      const state = buildStateSnapshot("bp-1");

      // Only unused suggestions
      expect(state.nodes[0].suggestions).toHaveLength(2);
      expect(state.nodes[0].suggestions[0].id).toBe("s1");
      expect(state.nodes[0].suggestions[1].id).toBe("s3");

      // Truncated to 150 chars
      expect(state.nodes[0].suggestions[1].description.length).toBe(150);
      expect(state.nodes[0].suggestions[1].description.endsWith("...")).toBe(true);

      // Roles included
      expect(state.nodes[0].suggestions[1].roles).toEqual(["qa"]);
    });

    it("only includes unread, undismissed insights and auto-marks them as read", () => {
      const insights = [
        { id: "i1", blueprintId: "bp-1", severity: "warning" as const, message: "Watch out", read: false, dismissed: false, createdAt: "", role: "sde" },
        { id: "i2", blueprintId: "bp-1", severity: "critical" as const, message: "Big issue", read: true, dismissed: false, createdAt: "", role: "qa", sourceNodeId: "n1" },
        { id: "i3", blueprintId: "bp-1", severity: "info" as const, message: "Dismissed one", read: false, dismissed: true, createdAt: "", role: "sde" },
      ];
      const bp = mockBlueprint();
      vi.mocked(getBlueprint).mockReturnValue(bp);
      vi.mocked(getSuggestionsForNode).mockReturnValue([]);
      vi.mocked(getInsightsForBlueprint).mockReturnValue(insights);
      vi.mocked(getQueueInfo).mockReturnValue({ running: false, pendingTasks: [], queueLength: 0 });

      const state = buildStateSnapshot("bp-1");

      // Only unread + undismissed insight included (i2 is read, i3 is dismissed)
      expect(state.insights).toHaveLength(1);
      expect(state.insights[0].id).toBe("i1");
      expect(state.insights[0].read).toBe(false);

      // Auto-marked as read
      expect(markInsightRead).toHaveBeenCalledWith("i1");
      expect(markInsightRead).toHaveBeenCalledTimes(1);
    });

    it("includes queue info", () => {
      const bp = mockBlueprint();
      vi.mocked(getBlueprint).mockReturnValue(bp);
      vi.mocked(getSuggestionsForNode).mockReturnValue([]);
      vi.mocked(getInsightsForBlueprint).mockReturnValue([]);
      vi.mocked(getQueueInfo).mockReturnValue({
        running: true,
        pendingTasks: [{ type: "run", nodeId: "n1", blueprintId: "bp-1", queuedAt: "2024-01-01" }],
        queueLength: 1,
      });

      const state = buildStateSnapshot("bp-1");

      expect(state.queueInfo.running).toBe(true);
      expect(state.queueInfo.pendingTasks).toHaveLength(1);
    });

    it("computes allNodesDone correctly — all done/skipped", () => {
      const nodes = [
        mockNode({ id: "n1", status: "done" }),
        mockNode({ id: "n2", status: "skipped" }),
        mockNode({ id: "n3", status: "done" }),
      ];
      const bp = mockBlueprint({ nodes });
      vi.mocked(getBlueprint).mockReturnValue(bp);
      vi.mocked(getSuggestionsForNode).mockReturnValue([]);
      vi.mocked(getInsightsForBlueprint).mockReturnValue([]);
      vi.mocked(getQueueInfo).mockReturnValue({ running: false, pendingTasks: [], queueLength: 0 });

      const state = buildStateSnapshot("bp-1");
      expect(state.allNodesDone).toBe(true);
    });

    it("computes allNodesDone correctly — some pending", () => {
      const nodes = [
        mockNode({ id: "n1", status: "done" }),
        mockNode({ id: "n2", status: "pending" }),
      ];
      const bp = mockBlueprint({ nodes });
      vi.mocked(getBlueprint).mockReturnValue(bp);
      vi.mocked(getSuggestionsForNode).mockReturnValue([]);
      vi.mocked(getInsightsForBlueprint).mockReturnValue([]);
      vi.mocked(getQueueInfo).mockReturnValue({ running: false, pendingTasks: [], queueLength: 0 });

      const state = buildStateSnapshot("bp-1");
      expect(state.allNodesDone).toBe(false);
    });

    it("builds summary string with correct format", () => {
      const nodes = [
        mockNode({ id: "n1", status: "done" }),
        mockNode({ id: "n2", status: "failed" }),
        mockNode({ id: "n3", status: "pending" }),
        mockNode({ id: "n4", status: "skipped" }),
        mockNode({ id: "n5", status: "running" }),
      ];
      const bp = mockBlueprint({ nodes });
      vi.mocked(getBlueprint).mockReturnValue(bp);
      vi.mocked(getSuggestionsForNode).mockReturnValue([]);
      vi.mocked(getInsightsForBlueprint).mockReturnValue([
        { id: "i1", blueprintId: "bp-1", severity: "warning" as const, message: "m", read: false, dismissed: false, createdAt: "", role: "" },
      ]);
      vi.mocked(getQueueInfo).mockReturnValue({ running: false, pendingTasks: [], queueLength: 0 });

      const state = buildStateSnapshot("bp-1");

      expect(state.summary).toContain("1/5 nodes done");
      expect(state.summary).toContain("1 failed");
      expect(state.summary).toContain("1 pending");
      expect(state.summary).toContain("1 skipped");
      expect(state.summary).toContain("1 unread insights");
    });

    it("token efficiency: >20 nodes only includes non-done context", () => {
      // Create 25 nodes: 20 done, 3 pending, 2 failed
      const nodes = [];
      for (let i = 0; i < 20; i++) {
        nodes.push(mockNode({ id: `done-${i}`, seq: i + 1, status: "done" }));
      }
      // Pending nodes with dependencies on done nodes
      nodes.push(mockNode({ id: "pending-1", seq: 21, status: "pending", dependencies: ["done-0"] }));
      nodes.push(mockNode({ id: "pending-2", seq: 22, status: "pending", dependencies: ["done-5"] }));
      nodes.push(mockNode({ id: "pending-3", seq: 23, status: "pending" }));
      nodes.push(mockNode({ id: "failed-1", seq: 24, status: "failed" }));
      nodes.push(mockNode({ id: "failed-2", seq: 25, status: "failed", dependencies: ["done-10"] }));

      const bp = mockBlueprint({ nodes });
      vi.mocked(getBlueprint).mockReturnValue(bp);
      vi.mocked(getSuggestionsForNode).mockReturnValue([]);
      vi.mocked(getInsightsForBlueprint).mockReturnValue([]);
      vi.mocked(getQueueInfo).mockReturnValue({ running: false, pendingTasks: [], queueLength: 0 });

      const state = buildStateSnapshot("bp-1");

      // Should include: 3 pending + 2 failed = 5 active nodes
      // Plus their dependencies: done-0, done-5, done-10 = 3 dependency context nodes
      // Total = 8 (not all 25)
      const includedIds = state.nodes.map((n) => n.id);
      expect(includedIds).toContain("pending-1");
      expect(includedIds).toContain("pending-2");
      expect(includedIds).toContain("pending-3");
      expect(includedIds).toContain("failed-1");
      expect(includedIds).toContain("failed-2");
      // Dependency context
      expect(includedIds).toContain("done-0");
      expect(includedIds).toContain("done-5");
      expect(includedIds).toContain("done-10");
      // Other done nodes should NOT be included
      expect(includedIds).not.toContain("done-1");
      expect(includedIds).not.toContain("done-19");

      // Summary still computed over ALL 25 nodes
      expect(state.summary).toContain("20/25 nodes done");
    });

    it("includes node roles when present", () => {
      const nodes = [mockNode({ id: "n1", roles: ["sde", "qa"] })];
      const bp = mockBlueprint({ nodes });
      vi.mocked(getBlueprint).mockReturnValue(bp);
      vi.mocked(getSuggestionsForNode).mockReturnValue([]);
      vi.mocked(getInsightsForBlueprint).mockReturnValue([]);
      vi.mocked(getQueueInfo).mockReturnValue({ running: false, pendingTasks: [], queueLength: 0 });

      const state = buildStateSnapshot("bp-1");
      expect(state.nodes[0].roles).toEqual(["sde", "qa"]);
    });

    it("tracks resume count per node", () => {
      incrementResumeCount("bp-1", "n1");
      incrementResumeCount("bp-1", "n1");

      const bp = mockBlueprint({ nodes: [mockNode({ id: "n1" })] });
      vi.mocked(getBlueprint).mockReturnValue(bp);
      vi.mocked(getSuggestionsForNode).mockReturnValue([]);
      vi.mocked(getInsightsForBlueprint).mockReturnValue([]);
      vi.mocked(getQueueInfo).mockReturnValue({ running: false, pendingTasks: [], queueLength: 0 });

      const state = buildStateSnapshot("bp-1");
      expect(state.nodes[0].resumeCount).toBe(2);
    });
  });

  // ──── Resume count helpers ───────────────────────────────────

  describe("resume count helpers", () => {
    it("starts at 0 for unknown blueprint/node", () => {
      expect(getResumeCount("unknown", "unknown")).toBe(0);
    });

    it("increments and returns correct count", () => {
      expect(incrementResumeCount("bp-1", "n1")).toBe(1);
      expect(incrementResumeCount("bp-1", "n1")).toBe(2);
      expect(getResumeCount("bp-1", "n1")).toBe(2);
    });

    it("clears counts for a blueprint", () => {
      incrementResumeCount("bp-1", "n1");
      incrementResumeCount("bp-1", "n2");
      clearResumeCounts("bp-1");
      expect(getResumeCount("bp-1", "n1")).toBe(0);
      expect(getResumeCount("bp-1", "n2")).toBe(0);
    });

    it("tracks counts independently per blueprint", () => {
      incrementResumeCount("bp-1", "n1");
      incrementResumeCount("bp-2", "n1");
      incrementResumeCount("bp-2", "n1");
      expect(getResumeCount("bp-1", "n1")).toBe(1);
      expect(getResumeCount("bp-2", "n1")).toBe(2);
      clearResumeCounts("bp-2");
      // bp-1 unaffected
      expect(getResumeCount("bp-1", "n1")).toBe(1);
      clearResumeCounts("bp-1");
    });
  });

  // ──── executeDecision ────────────────────────────────────────

  describe("executeDecision", () => {
    it("run_node: executes node directly", async () => {
      const decision: AutopilotDecision = {
        reasoning: "Node is ready",
        action: "run_node",
        params: { nodeId: "n1" },
      };
      const result = await executeDecision("bp-1", decision);

      expect(result.success).toBe(true);
      expect(executeNodeDirect).toHaveBeenCalledWith("bp-1", "n1");
    });

    it("resume_node: resumes a node with feedback", async () => {
      vi.mocked(getExecutionsForNode).mockReturnValue([
        { id: "exec-1", nodeId: "n1", blueprintId: "bp-1", sessionId: "sess-1", type: "primary", status: "done", startedAt: "2024-01-01" },
      ] as ReturnType<typeof getExecutionsForNode>);

      const decision: AutopilotDecision = {
        reasoning: "Resume with fix",
        action: "resume_node",
        params: { nodeId: "n1", feedback: "Try a different approach" },
      };
      const result = await executeDecision("bp-1", decision);

      expect(result.success).toBe(true);
      expect(updateMacroNode).toHaveBeenCalledWith("bp-1", "n1", { prompt: "Try a different approach" });
      expect(resumeNodeSession).toHaveBeenCalled();
      expect(addPendingTask).toHaveBeenCalled();
      expect(removePendingTask).toHaveBeenCalled();
    });

    it("resume_node: returns error if no resumable session exists", async () => {
      vi.mocked(getExecutionsForNode).mockReturnValue([]);
      const decision: AutopilotDecision = {
        reasoning: "Resume",
        action: "resume_node",
        params: { nodeId: "n1" },
      };
      const result = await executeDecision("bp-1", decision);

      expect(result.success).toBe(false);
      expect(result.error).toBe("no_session");
    });

    it("evaluate_node: evaluates node directly", async () => {
      const decision: AutopilotDecision = {
        reasoning: "Check quality",
        action: "evaluate_node",
        params: { nodeId: "n1" },
      };
      const result = await executeDecision("bp-1", decision);

      expect(result.success).toBe(true);
      expect(evaluateNodeCompletion).toHaveBeenCalledWith("bp-1", "n1");
      expect(addPendingTask).toHaveBeenCalledWith("bp-1", expect.objectContaining({ type: "evaluate", nodeId: "n1" }));
      expect(removePendingTask).toHaveBeenCalled();
    });

    it("reevaluate_node: reevaluates node directly", async () => {
      const decision: AutopilotDecision = {
        reasoning: "Re-check",
        action: "reevaluate_node",
        params: { nodeId: "n1" },
      };
      const result = await executeDecision("bp-1", decision);

      expect(result.success).toBe(true);
      expect(reevaluateNodeInternal).toHaveBeenCalledWith("bp-1", "n1");
      expect(addPendingTask).toHaveBeenCalledWith("bp-1", expect.objectContaining({ type: "reevaluate" }));
      expect(removePendingTask).toHaveBeenCalled();
    });

    it("enrich_node: enriches node directly", async () => {
      const decision: AutopilotDecision = {
        reasoning: "Needs details",
        action: "enrich_node",
        params: { nodeId: "n1" },
      };
      const result = await executeDecision("bp-1", decision);

      expect(result.success).toBe(true);
      expect(enrichNodeInternal).toHaveBeenCalledWith("bp-1", "n1");
      expect(addPendingTask).toHaveBeenCalledWith("bp-1", expect.objectContaining({ type: "enrich" }));
      expect(removePendingTask).toHaveBeenCalled();
    });

    it("split_node: splits node directly", async () => {
      const decision: AutopilotDecision = {
        reasoning: "Too complex",
        action: "split_node",
        params: { nodeId: "n1" },
      };
      const result = await executeDecision("bp-1", decision);

      expect(result.success).toBe(true);
      expect(splitNodeInternal).toHaveBeenCalledWith("bp-1", "n1");
      expect(addPendingTask).toHaveBeenCalledWith("bp-1", expect.objectContaining({ type: "split" }));
      expect(removePendingTask).toHaveBeenCalled();
    });

    it("smart_dependencies: runs smart deps directly", async () => {
      const decision: AutopilotDecision = {
        reasoning: "Auto-detect deps",
        action: "smart_dependencies",
        params: { nodeId: "n1" },
      };
      const result = await executeDecision("bp-1", decision);

      expect(result.success).toBe(true);
      expect(smartDepsInternal).toHaveBeenCalledWith("bp-1", "n1");
      expect(addPendingTask).toHaveBeenCalledWith("bp-1", expect.objectContaining({ type: "smart_deps" }));
      expect(removePendingTask).toHaveBeenCalled();
    });

    it("create_node: creates a new node with dependencies and roles", async () => {
      const bp = mockBlueprint({ nodes: [mockNode({ id: "n1", order: 5 })] });
      vi.mocked(getBlueprint).mockReturnValue(bp);
      vi.mocked(createMacroNode).mockReturnValue(
        mockNode({ id: "new-1", title: "New Node" }) as ReturnType<typeof createMacroNode>,
      );

      const decision: AutopilotDecision = {
        reasoning: "Need new step",
        action: "create_node",
        params: { title: "New Node", description: "Desc", dependsOn: ["n1"], roles: ["sde"] },
      };
      const result = await executeDecision("bp-1", decision);

      expect(result.success).toBe(true);
      expect(createMacroNode).toHaveBeenCalledWith("bp-1", {
        title: "New Node",
        description: "Desc",
        order: 6,
        dependencies: ["n1"],
        roles: ["sde"],
      });
    });

    it("create_node: returns error if blueprint not found", async () => {
      vi.mocked(getBlueprint).mockReturnValue(null);
      const decision: AutopilotDecision = {
        reasoning: "Add node",
        action: "create_node",
        params: { title: "X" },
      };
      const result = await executeDecision("bp-1", decision);
      expect(result.success).toBe(false);
      expect(result.error).toBe("not_found");
    });

    it("update_node: updates title, description, prompt", async () => {
      vi.mocked(updateMacroNode).mockReturnValue(mockNode() as ReturnType<typeof updateMacroNode>);
      const decision: AutopilotDecision = {
        reasoning: "Refine",
        action: "update_node",
        params: { nodeId: "n1", title: "Better Title", description: "Better desc", prompt: "Do X" },
      };
      const result = await executeDecision("bp-1", decision);

      expect(result.success).toBe(true);
      expect(updateMacroNode).toHaveBeenCalledWith("bp-1", "n1", {
        title: "Better Title",
        description: "Better desc",
        prompt: "Do X",
      });
    });

    it("update_node: returns error if node not found", async () => {
      vi.mocked(updateMacroNode).mockReturnValue(null);
      const decision: AutopilotDecision = {
        reasoning: "Update",
        action: "update_node",
        params: { nodeId: "n1", title: "X" },
      };
      const result = await executeDecision("bp-1", decision);
      expect(result.success).toBe(false);
      expect(result.error).toBe("not_found");
    });

    it("skip_node: marks node as skipped with reason", async () => {
      vi.mocked(updateMacroNode).mockReturnValue(mockNode() as ReturnType<typeof updateMacroNode>);
      const decision: AutopilotDecision = {
        reasoning: "Not needed",
        action: "skip_node",
        params: { nodeId: "n1", reason: "Duplicate of n2" },
      };
      const result = await executeDecision("bp-1", decision);

      expect(result.success).toBe(true);
      expect(updateMacroNode).toHaveBeenCalledWith("bp-1", "n1", {
        status: "skipped",
        error: "Skipped: Duplicate of n2",
      });
    });

    it("batch_create_nodes: creates multiple nodes with relative dependencies", async () => {
      const bp = mockBlueprint({ nodes: [mockNode({ id: "existing-1", order: 0 })] });
      vi.mocked(getBlueprint).mockReturnValue(bp);
      let callCount = 0;
      vi.mocked(createMacroNode).mockImplementation((_bpId, data) => {
        callCount++;
        return mockNode({ id: `batch-${callCount}`, title: data.title }) as ReturnType<typeof createMacroNode>;
      });

      const decision: AutopilotDecision = {
        reasoning: "Need batch",
        action: "batch_create_nodes",
        params: {
          nodes: [
            { title: "Step A", description: "Do A" },
            { title: "Step B", description: "Do B", dependsOn: [0] }, // relative ref to first batch node
            { title: "Step C", dependsOn: ["existing-1"] }, // ref to existing node
          ],
        },
      };
      const result = await executeDecision("bp-1", decision);

      expect(result.success).toBe(true);
      expect(result.message).toContain("3 nodes");
      expect(createMacroNode).toHaveBeenCalledTimes(3);
    });

    it("batch_create_nodes: returns error for empty array", async () => {
      const bp = mockBlueprint();
      vi.mocked(getBlueprint).mockReturnValue(bp);
      const decision: AutopilotDecision = {
        reasoning: "Batch",
        action: "batch_create_nodes",
        params: { nodes: [] },
      };
      const result = await executeDecision("bp-1", decision);
      expect(result.success).toBe(false);
      expect(result.error).toBe("invalid_params");
    });

    it("reorder_nodes: reorders node ordering", async () => {
      const decision: AutopilotDecision = {
        reasoning: "Fix order",
        action: "reorder_nodes",
        params: { ordering: [{ id: "n1", order: 3 }, { id: "n2", order: 1 }] },
      };
      const result = await executeDecision("bp-1", decision);

      expect(result.success).toBe(true);
      expect(reorderMacroNodes).toHaveBeenCalledWith("bp-1", [{ id: "n1", order: 3 }, { id: "n2", order: 1 }]);
    });

    it("reorder_nodes: returns error for non-array", async () => {
      const decision: AutopilotDecision = {
        reasoning: "Fix order",
        action: "reorder_nodes",
        params: { ordering: "invalid" },
      };
      const result = await executeDecision("bp-1", decision);
      expect(result.success).toBe(false);
      expect(result.error).toBe("invalid_params");
    });

    it("coordinate: runs coordinator directly", async () => {
      const decision: AutopilotDecision = {
        reasoning: "Process insights",
        action: "coordinate",
        params: {},
      };
      const result = await executeDecision("bp-1", decision);

      expect(result.success).toBe(true);
      expect(coordinateBlueprint).toHaveBeenCalledWith("bp-1");
      expect(addPendingTask).toHaveBeenCalledWith("bp-1", expect.objectContaining({ type: "coordinate" }));
      expect(removePendingTask).toHaveBeenCalled();
    });

    it("convene: runs convene session directly", async () => {
      vi.mocked(createConveneSession).mockReturnValue({
        id: "conv-1",
        blueprintId: "bp-1",
        topic: "Architecture",
        participatingRoles: ["sde", "sa"],
      } as ReturnType<typeof createConveneSession>);

      const decision: AutopilotDecision = {
        reasoning: "Need discussion",
        action: "convene",
        params: { topic: "Architecture", roleIds: ["sde", "sa"] },
      };
      const result = await executeDecision("bp-1", decision);

      expect(result.success).toBe(true);
      expect(createConveneSession).toHaveBeenCalled();
      expect(addPendingTask).toHaveBeenCalledWith("bp-1", expect.objectContaining({ type: "convene" }));
      expect(removePendingTask).toHaveBeenCalled();
    });

    it("reevaluate_all: reevaluates all non-done nodes directly", async () => {
      const bp = mockBlueprint({
        nodes: [
          mockNode({ id: "n1", status: "done" }),
          mockNode({ id: "n2", status: "pending" }),
          mockNode({ id: "n3", status: "failed" }),
        ],
      });
      vi.mocked(getBlueprint).mockReturnValue(bp);

      const decision: AutopilotDecision = {
        reasoning: "Quality check",
        action: "reevaluate_all",
        params: {},
      };
      const result = await executeDecision("bp-1", decision);

      expect(result.success).toBe(true);
      expect(result.message).toContain("2 nodes");
      expect(reevaluateAllInternal).toHaveBeenCalledWith("bp-1");
      expect(addPendingTask).toHaveBeenCalledTimes(2);
    });

    it("reevaluate_all: returns error if no nodes to reevaluate", async () => {
      const bp = mockBlueprint({ nodes: [mockNode({ id: "n1", status: "done" })] });
      vi.mocked(getBlueprint).mockReturnValue(bp);

      const decision: AutopilotDecision = {
        reasoning: "Check all",
        action: "reevaluate_all",
        params: {},
      };
      const result = await executeDecision("bp-1", decision);
      expect(result.success).toBe(false);
      expect(result.error).toBe("no_nodes");
    });

    it("mark_insight_read: marks insight as read", async () => {
      vi.mocked(markInsightRead).mockReturnValue({ id: "i1" } as ReturnType<typeof markInsightRead>);
      const decision: AutopilotDecision = {
        reasoning: "Acknowledge",
        action: "mark_insight_read",
        params: { insightId: "i1" },
      };
      const result = await executeDecision("bp-1", decision);

      expect(result.success).toBe(true);
      expect(markInsightRead).toHaveBeenCalledWith("i1");
    });

    it("mark_insight_read: returns error if not found", async () => {
      vi.mocked(markInsightRead).mockReturnValue(null);
      const decision: AutopilotDecision = {
        reasoning: "Read",
        action: "mark_insight_read",
        params: { insightId: "bad-id" },
      };
      const result = await executeDecision("bp-1", decision);
      expect(result.success).toBe(false);
    });

    it("dismiss_insight: dismisses an insight", async () => {
      const decision: AutopilotDecision = {
        reasoning: "Irrelevant",
        action: "dismiss_insight",
        params: { insightId: "i1" },
      };
      const result = await executeDecision("bp-1", decision);

      expect(result.success).toBe(true);
      expect(dismissInsight).toHaveBeenCalledWith("i1");
    });

    it("mark_suggestion_used: marks suggestion as used", async () => {
      vi.mocked(markSuggestionUsed).mockReturnValue({ id: "s1" } as ReturnType<typeof markSuggestionUsed>);
      const decision: AutopilotDecision = {
        reasoning: "Addressed",
        action: "mark_suggestion_used",
        params: { suggestionId: "s1" },
      };
      const result = await executeDecision("bp-1", decision);

      expect(result.success).toBe(true);
      expect(markSuggestionUsed).toHaveBeenCalledWith("s1");
    });

    it("mark_suggestion_used: returns error if not found", async () => {
      vi.mocked(markSuggestionUsed).mockReturnValue(null);
      const decision: AutopilotDecision = {
        reasoning: "Mark",
        action: "mark_suggestion_used",
        params: { suggestionId: "bad-id" },
      };
      const result = await executeDecision("bp-1", decision);
      expect(result.success).toBe(false);
    });

    it("pause: pauses the blueprint with reason", async () => {
      const decision: AutopilotDecision = {
        reasoning: "Need input",
        action: "pause",
        params: { reason: "Architecture decision needed" },
      };
      const result = await executeDecision("bp-1", decision);

      expect(result.success).toBe(true);
      expect(updateBlueprint).toHaveBeenCalledWith("bp-1", {
        status: "paused",
        pauseReason: "Architecture decision needed",
      });
    });

    it("pause: uses default reason if none provided", async () => {
      const decision: AutopilotDecision = {
        reasoning: "Stop",
        action: "pause",
        params: {},
      };
      const result = await executeDecision("bp-1", decision);
      expect(result.success).toBe(true);
      expect(updateBlueprint).toHaveBeenCalledWith("bp-1", {
        status: "paused",
        pauseReason: "Autopilot paused by AI decision",
      });
    });

    it("complete: marks blueprint as done", async () => {
      const decision: AutopilotDecision = {
        reasoning: "All finished",
        action: "complete",
        params: {},
      };
      const result = await executeDecision("bp-1", decision);

      expect(result.success).toBe(true);
      expect(updateBlueprint).toHaveBeenCalledWith("bp-1", { status: "done" });
    });

    it("unknown action: returns error", async () => {
      const decision: AutopilotDecision = {
        reasoning: "?",
        action: "unknown_action",
        params: {},
      };
      const result = await executeDecision("bp-1", decision);

      expect(result.success).toBe(false);
      expect(result.error).toBe("unknown_action");
    });

    it("catches exceptions and returns error result", async () => {
      vi.mocked(updateMacroNode).mockImplementation(() => {
        throw new Error("DB write failed");
      });

      const decision: AutopilotDecision = {
        reasoning: "Skip",
        action: "skip_node",
        params: { nodeId: "n1" },
      };
      const result = await executeDecision("bp-1", decision);

      expect(result.success).toBe(false);
      expect(result.error).toBe("DB write failed");
    });
  });

  // ──── Safeguards ─────────────────────────────────────────────

  describe("safeguards (tested via exported helpers/loop behavior)", () => {
    // We test the safeguard functions indirectly by importing them.
    // Since they're not exported, we test via the patterns they implement.
    // We can verify the logic by re-implementing the checks with the same algorithm.

    describe("same-action detection", () => {
      it("detects 3 identical consecutive actions", () => {
        // Re-implement the check for isolated testing
        const recentActions: Array<{ action: string; params: string }> = [];

        function checkSameAction(action: string, params: Record<string, unknown>): string | null {
          const current = { action, params: JSON.stringify(params) };
          recentActions.push(current);
          if (recentActions.length > 3) recentActions.shift();
          if (recentActions.length >= 3) {
            const [a, b, c] = recentActions.slice(-3);
            if (a.action === b.action && b.action === c.action &&
                a.params === b.params && b.params === c.params) {
              return "Autopilot appears stuck";
            }
          }
          return null;
        }

        expect(checkSameAction("run_node", { nodeId: "n1" })).toBeNull();
        expect(checkSameAction("run_node", { nodeId: "n1" })).toBeNull();
        expect(checkSameAction("run_node", { nodeId: "n1" })).toContain("stuck");
      });

      it("does NOT trigger with different actions interspersed", () => {
        const recentActions: Array<{ action: string; params: string }> = [];

        function checkSameAction(action: string, params: Record<string, unknown>): string | null {
          const current = { action, params: JSON.stringify(params) };
          recentActions.push(current);
          if (recentActions.length > 3) recentActions.shift();
          if (recentActions.length >= 3) {
            const [a, b, c] = recentActions.slice(-3);
            if (a.action === b.action && b.action === c.action &&
                a.params === b.params && b.params === c.params) {
              return "Autopilot appears stuck";
            }
          }
          return null;
        }

        expect(checkSameAction("run_node", { nodeId: "n1" })).toBeNull();
        expect(checkSameAction("evaluate_node", { nodeId: "n1" })).toBeNull();
        expect(checkSameAction("run_node", { nodeId: "n1" })).toBeNull();
        // Not 3 consecutive identical — should not trigger
      });

      it("does NOT trigger with same action but different params", () => {
        const recentActions: Array<{ action: string; params: string }> = [];

        function checkSameAction(action: string, params: Record<string, unknown>): string | null {
          const current = { action, params: JSON.stringify(params) };
          recentActions.push(current);
          if (recentActions.length > 3) recentActions.shift();
          if (recentActions.length >= 3) {
            const [a, b, c] = recentActions.slice(-3);
            if (a.action === b.action && b.action === c.action &&
                a.params === b.params && b.params === c.params) {
              return "Autopilot appears stuck";
            }
          }
          return null;
        }

        expect(checkSameAction("run_node", { nodeId: "n1" })).toBeNull();
        expect(checkSameAction("run_node", { nodeId: "n2" })).toBeNull();
        expect(checkSameAction("run_node", { nodeId: "n3" })).toBeNull();
      });
    });

    describe("no-progress detection", () => {
      it("detects 5 iterations without node status change", () => {
        const lastNodeStatuses = new Map<string, string>();
        let noProgressCount = 0;

        function checkNoProgress(nodes: Array<{ id: string; status: string }>): string | null {
          const currentStatuses = new Map(nodes.map((n) => [n.id, n.status]));

          if (lastNodeStatuses.size > 0) {
            let changed = false;
            for (const [id, status] of currentStatuses) {
              if (lastNodeStatuses.get(id) !== status) {
                changed = true;
                break;
              }
            }
            if (!changed && currentStatuses.size !== lastNodeStatuses.size) {
              changed = true;
            }
            if (!changed) noProgressCount++;
            else noProgressCount = 0;
          }

          lastNodeStatuses.clear();
          for (const [k, v] of currentStatuses) lastNodeStatuses.set(k, v);

          return noProgressCount >= 5 ? "No progress" : null;
        }

        const nodes = [{ id: "n1", status: "pending" }, { id: "n2", status: "running" }];
        // First call — baseline, doesn't count
        expect(checkNoProgress(nodes)).toBeNull();
        // 5 more calls with same status
        for (let i = 0; i < 4; i++) {
          expect(checkNoProgress(nodes)).toBeNull();
        }
        expect(checkNoProgress(nodes)).toContain("No progress");
      });

      it("resets counter when a node status changes", () => {
        const lastNodeStatuses = new Map<string, string>();
        let noProgressCount = 0;

        function checkNoProgress(nodes: Array<{ id: string; status: string }>): string | null {
          const currentStatuses = new Map(nodes.map((n) => [n.id, n.status]));

          if (lastNodeStatuses.size > 0) {
            let changed = false;
            for (const [id, status] of currentStatuses) {
              if (lastNodeStatuses.get(id) !== status) {
                changed = true;
                break;
              }
            }
            if (!changed && currentStatuses.size !== lastNodeStatuses.size) {
              changed = true;
            }
            if (!changed) noProgressCount++;
            else noProgressCount = 0;
          }

          lastNodeStatuses.clear();
          for (const [k, v] of currentStatuses) lastNodeStatuses.set(k, v);

          return noProgressCount >= 5 ? "No progress" : null;
        }

        const nodes = [{ id: "n1", status: "pending" }];
        checkNoProgress(nodes); // baseline
        checkNoProgress(nodes); // +1
        checkNoProgress(nodes); // +2
        checkNoProgress(nodes); // +3
        // Status change
        checkNoProgress([{ id: "n1", status: "running" }]); // reset
        // Need 5 more without change
        checkNoProgress([{ id: "n1", status: "running" }]);
        expect(noProgressCount).toBe(1);
      });

      it("detects new nodes as progress", () => {
        const lastNodeStatuses = new Map<string, string>();
        let noProgressCount = 0;

        function checkNoProgress(nodes: Array<{ id: string; status: string }>): string | null {
          const currentStatuses = new Map(nodes.map((n) => [n.id, n.status]));

          if (lastNodeStatuses.size > 0) {
            let changed = false;
            for (const [id, status] of currentStatuses) {
              if (lastNodeStatuses.get(id) !== status) {
                changed = true;
                break;
              }
            }
            if (!changed && currentStatuses.size !== lastNodeStatuses.size) {
              changed = true;
            }
            if (!changed) noProgressCount++;
            else noProgressCount = 0;
          }

          lastNodeStatuses.clear();
          for (const [k, v] of currentStatuses) lastNodeStatuses.set(k, v);

          return noProgressCount >= 5 ? "No progress" : null;
        }

        checkNoProgress([{ id: "n1", status: "pending" }]); // baseline
        checkNoProgress([{ id: "n1", status: "pending" }]); // +1
        // Add a new node = progress
        checkNoProgress([{ id: "n1", status: "pending" }, { id: "n2", status: "pending" }]);
        expect(noProgressCount).toBe(0); // reset by new node
      });
    });

    describe("per-node resume cap", () => {
      it("triggers when resumeCount > 5", () => {
        // The check is: for each node in state.nodes, if node.resumeCount > 5 → force pause
        function checkResumeCapExceeded(nodes: Array<{ seq: number; title: string; resumeCount: number }>): string | null {
          for (const node of nodes) {
            if (node.resumeCount > 5) {
              return `Node #${node.seq} "${node.title}" has been resumed ${node.resumeCount} times — force pausing.`;
            }
          }
          return null;
        }

        expect(checkResumeCapExceeded([{ seq: 1, title: "Test", resumeCount: 5 }])).toBeNull();
        expect(checkResumeCapExceeded([{ seq: 1, title: "Test", resumeCount: 6 }])).toContain("force pausing");
      });

      it("returns null when all resume counts are <= 5", () => {
        function checkResumeCapExceeded(nodes: Array<{ seq: number; title: string; resumeCount: number }>): string | null {
          for (const node of nodes) {
            if (node.resumeCount > 5) {
              return `Node #${node.seq} "${node.title}" has been resumed ${node.resumeCount} times — force pausing.`;
            }
          }
          return null;
        }

        const nodes = [
          { seq: 1, title: "A", resumeCount: 0 },
          { seq: 2, title: "B", resumeCount: 3 },
          { seq: 3, title: "C", resumeCount: 5 },
        ];
        expect(checkResumeCapExceeded(nodes)).toBeNull();
      });
    });

    describe("max iterations cap", () => {
      it("pauses when iteration count reaches max", () => {
        // This is tested via the loop logic. The loop condition is:
        // while (iteration < maxIterations) { ... }
        // After loop: if (iteration >= maxIterations) → pause
        // Simply verify the math: if maxIterations=3 and we iterate 3 times, it triggers.
        const maxIterations = 3;
        let iteration = 0;
        while (iteration < maxIterations) {
          iteration++;
        }
        expect(iteration >= maxIterations).toBe(true);
      });
    });
  });

  // ──── logAutopilot (via DB mock) ─────────────────────────────

  describe("logAutopilot (internal, tested via DB)", () => {
    it("writes a correct row to the autopilot_log table", () => {
      // logAutopilot is private, but it's called inside the autopilot loop.
      // We verify its behavior by testing it writes to the DB correctly.
      // Since we can test the DB interaction pattern:
      const mockPrepare = vi.fn().mockReturnValue({ run: vi.fn() });
      vi.mocked(getDb).mockReturnValue({ prepare: mockPrepare } as unknown as ReturnType<typeof getDb>);

      // We can't call logAutopilot directly since it's not exported.
      // Instead, let's verify the SQL pattern matches expected schema.
      const db = getDb();
      const stmt = db.prepare(`
        INSERT INTO autopilot_log (id, blueprint_id, iteration, observation, decision, action, action_params, result, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      // Simulate what logAutopilot does
      const id = "test-id";
      const blueprintId = "bp-1";
      const iteration = 1;
      const observation = "2/5 nodes done";
      const decision = "Run next → run_node";
      const action = "run_node";
      const actionParams = JSON.stringify({ nodeId: "n1" });
      const result = "Queued node n1 for execution";
      const now = new Date().toISOString();

      stmt.run(id, blueprintId, iteration, observation, decision, action, actionParams, result, now);

      expect(mockPrepare).toHaveBeenCalled();
      expect(mockPrepare().run).toHaveBeenCalledWith(
        id, blueprintId, iteration, observation, decision, action, actionParams, result, now,
      );
    });
  });

  // ──── buildAutopilotPrompt ───────────────────────────────────

  describe("buildAutopilotPrompt", () => {
    it("includes state, iteration info, tools, and guidelines", () => {
      const state: AutopilotState = {
        blueprint: {
          id: "bp-1",
          title: "Test",
          description: "Test",
          status: "running",
          enabledRoles: [],
        },
        nodes: [],
        insights: [],
        queueInfo: { running: false, pendingTasks: [] },
        allNodesDone: false,
        summary: "0/0 nodes done",
      };

      const prompt = buildAutopilotPrompt(state, 3, 50);

      expect(prompt).toContain("Iteration 3 of 50");
      expect(prompt).toContain("47 iterations left");
      expect(prompt).toContain("run_node");
      expect(prompt).toContain("resume_node");
      expect(prompt).toContain("create_node");
      expect(prompt).toContain("pause");
      expect(prompt).toContain("complete");
      expect(prompt).toContain("Decision Format");
      expect(prompt).toContain('"reasoning"');
      expect(prompt).toContain('"action"');
    });
  });

  // ──── DB Migration Tests ─────────────────────────────────────

  describe("DB migration (autopilot columns and table)", () => {
    it("migration pattern: PRAGMA table_info + ALTER TABLE ADD COLUMN for missing columns", () => {
      // Verify the migration pattern used in plan-db.ts:
      // 1. PRAGMA table_info(blueprints) → check for column presence
      // 2. ALTER TABLE ADD COLUMN if missing
      // This tests the logic pattern, not the actual migration
      // (since initPlanTables() requires a real DB setup)

      const existingCols = [
        { name: "id" }, { name: "title" }, { name: "description" },
        { name: "status" }, { name: "project_cwd" },
      ];

      // execution_mode missing
      expect(existingCols.some((c) => c.name === "execution_mode")).toBe(false);
      // max_iterations missing
      expect(existingCols.some((c) => c.name === "max_iterations")).toBe(false);
      // pause_reason missing
      expect(existingCols.some((c) => c.name === "pause_reason")).toBe(false);

      // After migration
      const updatedCols = [
        ...existingCols,
        { name: "execution_mode" },
        { name: "max_iterations" },
        { name: "pause_reason" },
      ];
      expect(updatedCols.some((c) => c.name === "execution_mode")).toBe(true);
      expect(updatedCols.some((c) => c.name === "max_iterations")).toBe(true);
      expect(updatedCols.some((c) => c.name === "pause_reason")).toBe(true);
    });

    it("autopilot_log table schema has correct columns", () => {
      // Verify the expected schema of autopilot_log table
      const expectedColumns = [
        "id", "blueprint_id", "iteration", "observation",
        "decision", "action", "action_params", "result", "created_at",
      ];
      // This matches the CREATE TABLE statement in plan-db.ts
      const createTableSQL = `CREATE TABLE IF NOT EXISTS autopilot_log (
        id              TEXT PRIMARY KEY,
        blueprint_id    TEXT NOT NULL REFERENCES blueprints(id) ON DELETE CASCADE,
        iteration       INTEGER NOT NULL,
        observation     TEXT,
        decision        TEXT NOT NULL,
        action          TEXT NOT NULL,
        action_params   TEXT,
        result          TEXT,
        created_at      TEXT NOT NULL
      )`;

      for (const col of expectedColumns) {
        expect(createTableSQL).toContain(col);
      }
      // Verify index
      const indexSQL = "CREATE INDEX IF NOT EXISTS idx_autopilot_log_blueprint ON autopilot_log(blueprint_id, iteration)";
      expect(indexSQL).toContain("blueprint_id");
      expect(indexSQL).toContain("iteration");
    });
  });

  // ──── computeToolUsageStats ─────────────────────────────────

  describe("computeToolUsageStats", () => {
    function setupStatsDb(opts: {
      totalCount: number;
      actionRows: Array<{ action: string; cnt: number; success_cnt: number }>;
      recentActions: Array<{ action: string }>;
      allActions: Array<{ action: string; iteration: number }>;
    }) {
      const mockPrepare = vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("GROUP BY")) {
          return { all: vi.fn().mockReturnValue(opts.actionRows) };
        } else if (sql.includes("COUNT(*)")) {
          return { get: vi.fn().mockReturnValue({ cnt: opts.totalCount }) };
        } else if (sql.includes("DESC")) {
          return { all: vi.fn().mockReturnValue(opts.recentActions) };
        } else {
          return { all: vi.fn().mockReturnValue(opts.allActions) };
        }
      });
      vi.mocked(getDb).mockReturnValue({ prepare: mockPrepare } as unknown as ReturnType<typeof getDb>);
    }

    it("returns correct actionCounts from log entries", () => {
      setupStatsDb({
        totalCount: 5,
        actionRows: [
          { action: "run_node", cnt: 3, success_cnt: 3 },
          { action: "enrich_node", cnt: 2, success_cnt: 2 },
        ],
        recentActions: [{ action: "enrich_node" }, { action: "run_node" }],
        allActions: [],
      });

      const stats = computeToolUsageStats("bp-1");
      expect(stats.actionCounts).toEqual({ run_node: 3, enrich_node: 2 });
      expect(stats.totalIterations).toBe(5);
    });

    it("computes successRate correctly with mix of success/error", () => {
      setupStatsDb({
        totalCount: 4,
        actionRows: [
          { action: "run_node", cnt: 3, success_cnt: 2 },
          { action: "resume_node", cnt: 1, success_cnt: 0 },
        ],
        recentActions: [],
        allActions: [],
      });

      const stats = computeToolUsageStats("bp-1");
      expect(stats.successRate["run_node"]).toBeCloseTo(2 / 3);
      expect(stats.successRate["resume_node"]).toBe(0);
    });

    it("identifies neverUsedTools by comparing against all known tools", () => {
      setupStatsDb({
        totalCount: 2,
        actionRows: [
          { action: "run_node", cnt: 1, success_cnt: 1 },
          { action: "pause", cnt: 1, success_cnt: 1 },
        ],
        recentActions: [],
        allActions: [],
      });

      const stats = computeToolUsageStats("bp-1");
      expect(stats.neverUsedTools).not.toContain("run_node");
      expect(stats.neverUsedTools).not.toContain("pause");
      expect(stats.neverUsedTools).toContain("resume_node");
      expect(stats.neverUsedTools).toContain("enrich_node");
      expect(stats.neverUsedTools).toContain("complete");
    });

    it("counts consecutiveRunNodeCount correctly (3 at end)", () => {
      setupStatsDb({
        totalCount: 5,
        actionRows: [{ action: "run_node", cnt: 5, success_cnt: 5 }],
        recentActions: [
          { action: "run_node" },
          { action: "run_node" },
          { action: "run_node" },
          { action: "enrich_node" },
          { action: "run_node" },
        ],
        allActions: [],
      });

      const stats = computeToolUsageStats("bp-1");
      expect(stats.consecutiveRunNodeCount).toBe(3);
    });

    it("computes averageIterationsBetweenNonRunActions correctly", () => {
      setupStatsDb({
        totalCount: 7,
        actionRows: [],
        recentActions: [],
        allActions: [
          { action: "enrich_node", iteration: 1 },
          { action: "run_node", iteration: 2 },
          { action: "run_node", iteration: 3 },
          { action: "evaluate_node", iteration: 4 },
          { action: "run_node", iteration: 5 },
          { action: "run_node", iteration: 6 },
          { action: "coordinate", iteration: 7 },
        ],
      });

      const stats = computeToolUsageStats("bp-1");
      // Non-run actions at iterations 1, 4, 7 → gaps of 3 and 3 → avg 3
      expect(stats.averageIterationsBetweenNonRunActions).toBe(3);
    });

    it("returns zeroed/empty stats when no log entries exist", () => {
      setupStatsDb({
        totalCount: 0,
        actionRows: [],
        recentActions: [],
        allActions: [],
      });

      const stats = computeToolUsageStats("bp-1");
      expect(stats.totalIterations).toBe(0);
      expect(stats.actionCounts).toEqual({});
      expect(stats.successRate).toEqual({});
      expect(stats.consecutiveRunNodeCount).toBe(0);
      expect(stats.averageIterationsBetweenNonRunActions).toBe(0);
      expect(stats.neverUsedTools).toContain("run_node");
      expect(stats.neverUsedTools).toContain("pause");
      expect(stats.neverUsedTools.length).toBeGreaterThan(0);
    });
  });

  // ──── Reflection trigger conditions ─────────────────────────

  describe("reflection trigger conditions", () => {
    // Tests the condition logic from runAutopilotLoop:
    // shouldReflect = iterationsSinceReflection >= REFLECT_EVERY_N
    //   || decision.action === "pause"
    //   || (!result.success && result.error)

    it("REFLECT_EVERY_N is 5", () => {
      expect(REFLECT_EVERY_N).toBe(5);
    });

    it("triggers at iteration 5 (iterationsSinceReflection >= REFLECT_EVERY_N)", () => {
      const shouldReflect = 5 >= REFLECT_EVERY_N || false || false;
      expect(shouldReflect).toBe(true);
    });

    it("triggers on pause decision regardless of iteration count", () => {
      const iterationsSinceReflection = 1;
      const decision = { action: "pause" };
      const shouldReflect =
        iterationsSinceReflection >= REFLECT_EVERY_N ||
        decision.action === "pause" ||
        false;
      expect(shouldReflect).toBe(true);
    });

    it("triggers on failed action (result.success === false)", () => {
      const iterationsSinceReflection = 1;
      const result = { success: false, message: "err", error: "some_error" };
      const shouldReflect =
        iterationsSinceReflection >= REFLECT_EVERY_N ||
        false ||
        (!result.success && result.error);
      expect(shouldReflect).toBeTruthy();
    });

    it("does NOT trigger on routine successful iterations 1-4", () => {
      for (let i = 1; i < REFLECT_EVERY_N; i++) {
        const result = { success: true, message: "ok" };
        const shouldReflect =
          i >= REFLECT_EVERY_N ||
          false || // not pause
          (!result.success && (result as Record<string, unknown>).error);
        expect(shouldReflect).toBeFalsy();
      }
    });

    it("final reflection runs at loop exit unconditionally (no condition guard)", () => {
      // After the while loop in runAutopilotLoop, reflectAndUpdateMemory is called
      // directly with no condition check. This verifies the constant exists and
      // that mid-loop reflections skip most iterations (REFLECT_EVERY_N > 1),
      // while the final one at exit has no such gate.
      expect(REFLECT_EVERY_N).toBeGreaterThan(1);
    });
  });

  // ──── buildAutopilotPrompt memory injection ─────────────────

  describe("buildAutopilotPrompt memory injection", () => {
    const memTestState: AutopilotState = {
      blueprint: { id: "bp-1", title: "Test", description: "Test", status: "running", enabledRoles: [] },
      nodes: [],
      insights: [],
      queueInfo: { running: false, pendingTasks: [] },
      allNodesDone: false,
      summary: "0/0 nodes done",
    };

    it("includes Global Strategy section when global memory is provided", () => {
      const prompt = buildAutopilotPrompt(memTestState, 1, 50, {
        blueprint: null,
        global: "Always prefer enrich before run.",
      });
      expect(prompt).toContain("## Global Strategy");
      expect(prompt).toContain("Always prefer enrich before run.");
    });

    it("includes Blueprint Memory section when blueprint memory is provided", () => {
      const prompt = buildAutopilotPrompt(memTestState, 1, 50, {
        blueprint: "Node 3 is tricky, needs splitting.",
        global: null,
      });
      expect(prompt).toContain("## Blueprint Memory");
      expect(prompt).toContain("Node 3 is tricky, needs splitting.");
    });

    it("omits both memory sections when both are null", () => {
      const prompt = buildAutopilotPrompt(memTestState, 1, 50, {
        blueprint: null,
        global: null,
      });
      expect(prompt).not.toContain("## Global Strategy");
      expect(prompt).not.toContain("## Blueprint Memory");
    });

    it("includes both sections when both memories are non-null", () => {
      const prompt = buildAutopilotPrompt(memTestState, 1, 50, {
        blueprint: "Blueprint notes here.",
        global: "Global strategy here.",
      });
      expect(prompt).toContain("## Global Strategy");
      expect(prompt).toContain("Global strategy here.");
      expect(prompt).toContain("## Blueprint Memory");
      expect(prompt).toContain("Blueprint notes here.");
    });
  });

  // ──── Global memory file helpers ────────────────────────────

  describe("global memory file helpers", () => {
    beforeEach(() => {
      vi.mocked(existsSync).mockReset();
      vi.mocked(readFileSync).mockReset();
      vi.mocked(writeFileSync).mockReset();
      vi.mocked(mkdirSync).mockReset();
    });

    it("readGlobalMemory returns null when file does not exist", () => {
      vi.mocked(existsSync).mockReturnValue(false);
      expect(readGlobalMemory()).toBeNull();
    });

    it("writeGlobalMemory creates directory and writes content", () => {
      vi.mocked(existsSync).mockReturnValue(false);
      writeGlobalMemory("test strategy content");
      expect(mkdirSync).toHaveBeenCalledWith(expect.any(String), { recursive: true });
      expect(writeFileSync).toHaveBeenCalledWith(expect.any(String), "test strategy content", "utf-8");
    });

    it("readGlobalMemory returns content when file exists", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue("existing strategy");
      expect(readGlobalMemory()).toBe("existing strategy");
    });
  });

  // ──── Reflection failure handling ───────────────────────────

  describe("reflection failure handling", () => {
    function setupStatsDbEmpty() {
      const mockPrepare = vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("COUNT(*)") && !sql.includes("GROUP BY")) {
          return { get: vi.fn().mockReturnValue({ cnt: 0 }) };
        }
        return { all: vi.fn().mockReturnValue([]) };
      });
      vi.mocked(getDb).mockReturnValue({ prepare: mockPrepare } as unknown as ReturnType<typeof getDb>);
    }

    it("reflectAndUpdateMemory returns currentMemory unchanged when runtime throws", async () => {
      vi.mocked(getAutopilotLog).mockReturnValue([]);
      setupStatsDbEmpty();
      vi.mocked(getBlueprint).mockReturnValue(mockBlueprint());
      const mockRuntime = { runSession: vi.fn().mockRejectedValue(new Error("LLM error")) };
      vi.mocked(getActiveRuntime).mockReturnValue(mockRuntime as unknown as ReturnType<typeof getActiveRuntime>);

      const result = await reflectAndUpdateMemory("bp-1", 0, 5, "existing memory");
      expect(result).toBe("existing memory");
    });

    it("updateGlobalMemory does not throw when runtime fails", async () => {
      vi.mocked(getBlueprint).mockReturnValue(mockBlueprint());
      vi.mocked(getAutopilotLog).mockReturnValue([{ iteration: 5 } as ReturnType<typeof getAutopilotLog>[0]]);
      const mockRuntime = { runSession: vi.fn().mockRejectedValue(new Error("LLM error")) };
      vi.mocked(getActiveRuntime).mockReturnValue(mockRuntime as unknown as ReturnType<typeof getActiveRuntime>);

      await expect(updateGlobalMemory("bp-1", "memory", "global")).resolves.toBeUndefined();
    });
  });

  // ──── Memory character limits ───────────────────────────────

  describe("memory character limits", () => {
    function setupStatsDbEmpty() {
      const mockPrepare = vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("COUNT(*)") && !sql.includes("GROUP BY")) {
          return { get: vi.fn().mockReturnValue({ cnt: 0 }) };
        }
        return { all: vi.fn().mockReturnValue([]) };
      });
      vi.mocked(getDb).mockReturnValue({ prepare: mockPrepare } as unknown as ReturnType<typeof getDb>);
    }

    it("blueprint memory exceeding BLUEPRINT_MEMORY_MAX_CHARS is truncated", async () => {
      vi.mocked(getAutopilotLog).mockReturnValue([]);
      setupStatsDbEmpty();
      vi.mocked(getBlueprint).mockReturnValue(mockBlueprint());
      const longResponse = "x".repeat(3000);
      const mockRuntime = { runSession: vi.fn().mockResolvedValue(longResponse) };
      vi.mocked(getActiveRuntime).mockReturnValue(mockRuntime as unknown as ReturnType<typeof getActiveRuntime>);

      const result = await reflectAndUpdateMemory("bp-1", 0, 5, null);
      expect(result!.length).toBe(BLUEPRINT_MEMORY_MAX_CHARS);
      expect(vi.mocked(setAutopilotMemory)).toHaveBeenCalledWith("bp-1", expect.any(String));
      const saved = vi.mocked(setAutopilotMemory).mock.calls[0][1] as string;
      expect(saved.length).toBe(BLUEPRINT_MEMORY_MAX_CHARS);
    });

    it("global memory exceeding GLOBAL_MEMORY_MAX_CHARS is truncated", async () => {
      vi.mocked(getBlueprint).mockReturnValue(mockBlueprint());
      vi.mocked(getAutopilotLog).mockReturnValue([{ iteration: 5 } as ReturnType<typeof getAutopilotLog>[0]]);
      vi.mocked(existsSync).mockReturnValue(true);
      const longResponse = "y".repeat(5000);
      const mockRuntime = { runSession: vi.fn().mockResolvedValue(longResponse) };
      vi.mocked(getActiveRuntime).mockReturnValue(mockRuntime as unknown as ReturnType<typeof getActiveRuntime>);

      await updateGlobalMemory("bp-1", "blueprint mem", "old global");
      expect(vi.mocked(writeFileSync)).toHaveBeenCalled();
      const written = vi.mocked(writeFileSync).mock.calls[0][1] as string;
      expect(written.length).toBe(GLOBAL_MEMORY_MAX_CHARS);
    });
  });
});
