import React from "react";
import { render, type RenderOptions } from "@testing-library/react";
import { ToastProvider } from "@/components/Toast";
import type {
  Blueprint,
  MacroNode,
  NodeExecution,
  BlueprintInsight,
  BlueprintStatus,
  MacroNodeStatus,
} from "@/lib/api";
import { vi } from "vitest";

// --- Providers wrapper ---

function AllProviders({ children }: { children: React.ReactNode }) {
  return <ToastProvider>{children}</ToastProvider>;
}

export function renderWithProviders(
  ui: React.ReactElement,
  options?: Omit<RenderOptions, "wrapper">,
) {
  return render(ui, { wrapper: AllProviders, ...options });
}

// --- Mock factories ---

let _nodeSeq = 0;

export function makeMockBlueprint(overrides: Partial<Blueprint> = {}): Blueprint {
  return {
    id: "bp-1",
    title: "Test Blueprint",
    description: "A test blueprint",
    status: "approved" as BlueprintStatus,
    nodes: [],
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

export function makeMockNode(overrides: Partial<MacroNode> = {}): MacroNode {
  _nodeSeq++;
  return {
    id: `node-${_nodeSeq}`,
    blueprintId: "bp-1",
    order: 0,
    seq: _nodeSeq,
    title: "Test Node",
    description: "A test node description",
    status: "pending" as MacroNodeStatus,
    dependencies: [],
    inputArtifacts: [],
    outputArtifacts: [],
    executions: [],
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

export function makeMockExecution(overrides: Partial<NodeExecution> = {}): NodeExecution {
  return {
    id: "exec-1",
    nodeId: "node-1",
    blueprintId: "bp-1",
    type: "primary",
    status: "done",
    startedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

export function makeMockInsight(overrides: Partial<BlueprintInsight> = {}): BlueprintInsight {
  return {
    id: "insight-1",
    blueprintId: "bp-1",
    role: "sde",
    severity: "info",
    message: "Test insight message",
    read: false,
    dismissed: false,
    createdAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

// --- mockAllApi helper ---

/**
 * Returns a default mock map for all exported API functions.
 * Use with `vi.mock("@/lib/api", async () => { ... })`.
 */
export function mockAllApiDefaults() {
  return {
    // Auth / info
    getAgents: vi.fn(() => Promise.resolve([])),
    fetchRoles: vi.fn(() => Promise.resolve([])),
    fetchRole: vi.fn(() => Promise.resolve({ id: "sde", label: "SDE", description: "", builtin: true, artifactTypes: [], blockerTypes: [] })),
    getProjects: vi.fn(() => Promise.resolve([])),
    getSessions: vi.fn(() => Promise.resolve([])),
    getTimeline: vi.fn(() => Promise.resolve([])),
    getLastSessionMessage: vi.fn(() => Promise.resolve({ id: "n1", type: "assistant", timestamp: "", title: "", content: "" })),
    runPrompt: vi.fn(() => Promise.resolve({ output: "", suggestions: [] })),
    getSessionStatus: vi.fn(() => Promise.resolve({ running: false })),
    getSessionMeta: vi.fn(() => Promise.resolve(null)),
    updateSessionMeta: vi.fn(() => Promise.resolve()),
    updateNodeMeta: vi.fn(() => Promise.resolve()),
    getTags: vi.fn(() => Promise.resolve([])),
    getAppState: vi.fn(() => Promise.resolve({})),
    updateAppState: vi.fn(() => Promise.resolve()),

    // Blueprints
    listBlueprints: vi.fn(() => Promise.resolve([])),
    getBlueprint: vi.fn(() => Promise.resolve(makeMockBlueprint())),
    createBlueprint: vi.fn(() => Promise.resolve(makeMockBlueprint())),
    updateBlueprint: vi.fn(() => Promise.resolve(makeMockBlueprint())),
    deleteBlueprint: vi.fn(() => Promise.resolve({ ok: true })),
    archiveBlueprint: vi.fn(() => Promise.resolve(makeMockBlueprint({ archivedAt: "2025-01-01" }))),
    unarchiveBlueprint: vi.fn(() => Promise.resolve(makeMockBlueprint({ archivedAt: undefined }))),
    starBlueprint: vi.fn(() => Promise.resolve(makeMockBlueprint({ starred: true }))),
    unstarBlueprint: vi.fn(() => Promise.resolve(makeMockBlueprint({ starred: false }))),
    approveBlueprint: vi.fn(() => Promise.resolve(makeMockBlueprint({ status: "approved" }))),

    // Nodes
    enrichNode: vi.fn(() => Promise.resolve({ title: "Enriched", description: "desc" })),
    smartPickDependencies: vi.fn(() => Promise.resolve({ status: "queued", nodeId: "n1" })),
    reevaluateNode: vi.fn(() => Promise.resolve({ status: "queued", nodeId: "n1" })),
    reevaluateAllNodes: vi.fn(() => Promise.resolve({ message: "ok", blueprintId: "bp-1", nodeCount: 0 })),
    createMacroNode: vi.fn(() => Promise.resolve(makeMockNode())),
    updateMacroNode: vi.fn(() => Promise.resolve(makeMockNode())),
    deleteMacroNode: vi.fn(() => Promise.resolve({ ok: true })),

    // Generation
    generatePlan: vi.fn(() => Promise.resolve({ status: "queued", blueprintId: "bp-1" })),

    // Execution
    getSessionExecution: vi.fn(() => Promise.resolve(null)),
    runNode: vi.fn(() => Promise.resolve({ status: "queued", nodeId: "n1" })),
    recoverNodeSession: vi.fn(() => Promise.resolve({ recovered: false })),
    resumeNodeSession: vi.fn(() => Promise.resolve({ status: "queued" })),
    getNodeExecutions: vi.fn(() => Promise.resolve([])),
    getRelatedSessions: vi.fn(() => Promise.resolve([])),
    getActiveRelatedSession: vi.fn(() => Promise.resolve(null)),
    runNextNode: vi.fn(() => Promise.resolve({ message: "ok" })),
    runAllNodes: vi.fn(() => Promise.resolve({ message: "ok", blueprintId: "bp-1" })),

    // Queue
    unqueueNode: vi.fn(() => Promise.resolve({ status: "ok" })),
    splitNode: vi.fn(() => Promise.resolve({ status: "queued", nodeId: "n1" })),
    getQueueStatus: vi.fn(() => Promise.resolve({ running: false, queueLength: 0, pendingTasks: [] })),
    getGlobalStatus: vi.fn(() => Promise.resolve({ active: false, totalPending: 0, tasks: [] })),

    // Dev
    getDevStatus: vi.fn(() => Promise.resolve({ devMode: false })),
    redeployStable: vi.fn(() => Promise.resolve({ ok: true, message: "" })),

    // Health
    getSessionHealth: vi.fn(() => Promise.resolve({ failureReason: null, detail: "", compactCount: 0, peakTokens: 0, lastApiError: null, messageCount: 0 })),

    // Suggestions
    getSuggestionsForNode: vi.fn(() => Promise.resolve([])),
    markSuggestionUsed: vi.fn(() => Promise.resolve({ id: "s1", nodeId: "n1", blueprintId: "bp-1", title: "", description: "", used: true, createdAt: "" })),

    // Insights
    fetchBlueprintInsights: vi.fn(() => Promise.resolve([])),
    markInsightRead: vi.fn(() => Promise.resolve(makeMockInsight({ read: true }))),
    markAllInsightsRead: vi.fn(() => Promise.resolve({ success: true })),
    dismissInsight: vi.fn(() => Promise.resolve({ success: true })),
    getUnreadInsightCount: vi.fn(() => Promise.resolve({ count: 0 })),
    coordinateBlueprint: vi.fn(() => Promise.resolve({ status: "queued", blueprintId: "bp-1" })),

    // Upload
    uploadImage: vi.fn(() => Promise.resolve({ url: "/uploads/test.png" })),
  };
}
