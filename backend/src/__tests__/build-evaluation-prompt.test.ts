import { describe, it, expect, vi } from "vitest";

// ─── Mocks ──────────────────────────────────────────────────

const mockGetRole = vi.hoisted(() => vi.fn());
const mockGetApiBase = vi.hoisted(() => vi.fn(() => "http://localhost:3001"));
const mockGetAuthParam = vi.hoisted(() => vi.fn(() => "auth=test-token"));

vi.mock("../roles/role-registry.js", () => ({
  getRole: mockGetRole,
  registerRole: vi.fn(),
  getAllRoles: vi.fn(() => []),
  getBuiltinRoles: vi.fn(() => []),
}));

vi.mock("../roles/load-all-roles.js", () => ({}));

vi.mock("../plan-generator.js", () => ({
  getApiBase: mockGetApiBase,
  getAuthParam: mockGetAuthParam,
}));

vi.mock("../plan-db.js", () => ({
  getBlueprint: vi.fn(),
  updateBlueprint: vi.fn(),
  updateMacroNode: vi.fn(),
  createMacroNode: vi.fn(),
  createExecution: vi.fn(),
  updateExecution: vi.fn(),
  getExecution: vi.fn(),
  createArtifact: vi.fn(),
  getArtifactsForNode: vi.fn(),
  getOrphanedQueuedNodes: vi.fn(() => []),
  getStaleRunningExecutions: vi.fn(() => []),
  getRecentRestartFailedExecutions: vi.fn(() => []),
  getExecutionBySession: vi.fn(),
  recoverStaleExecutions: vi.fn(),
  createRelatedSession: vi.fn(),
  completeRelatedSession: vi.fn(),
  getInsightsForBlueprint: vi.fn(() => []),
  getExecutionsForNode: vi.fn(() => []),
}));

vi.mock("../db.js", () => ({
  syncSession: vi.fn(),
  getDb: vi.fn(),
}));

vi.mock("../agent-runtime.js", () => ({
  getActiveRuntime: vi.fn(),
}));

vi.mock("../session-lock.js", () => ({
  acquireSessionLock: vi.fn(),
  releaseSessionLock: vi.fn(),
}));

vi.mock("../agent-claude.js", () => ({}));
vi.mock("../agent-pimono.js", () => ({}));
vi.mock("../agent-openclaw.js", () => ({}));
vi.mock("../agent-codex.js", () => ({}));

import { buildEvaluationPrompt } from "../plan-executor.js";
import type { Blueprint, MacroNode } from "../plan-db.js";

// ─── Helpers ────────────────────────────────────────────────

function makeRole(id: string, label: string) {
  return {
    id,
    label,
    description: `${label} role`,
    builtin: true,
    artifactTypes: [],
    blockerTypes: [],
    prompts: {
      evaluationExamples: `${id} evaluation examples`,
      suggestionsTemplate: `${id} suggestions template`,
      insightsTemplate: `${id} insights template`,
      nodePromptPrefix: "",
      artifactFormat: "",
    },
  };
}

function makeNode(overrides: Partial<MacroNode> = {}): MacroNode {
  return {
    id: "node-1",
    blueprintId: "bp-1",
    order: 0,
    seq: 1,
    title: "Test Node",
    description: "A test node",
    status: "done",
    dependencies: [],
    inputArtifacts: [],
    outputArtifacts: [],
    executions: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeBlueprint(overrides: Partial<Blueprint> = {}): Blueprint {
  return {
    id: "bp-1",
    title: "Test Blueprint",
    description: "A test blueprint",
    status: "running",
    nodes: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────

describe("buildEvaluationPrompt insights use all blueprint roles", () => {
  it("includes insight templates from roles not assigned to the evaluated node", () => {
    const sdeRole = makeRole("sde", "SDE");
    const qaRole = makeRole("qa", "QA");
    const pmRole = makeRole("pm", "PM");

    mockGetRole.mockImplementation((id: string) => {
      if (id === "sde") return sdeRole;
      if (id === "qa") return qaRole;
      if (id === "pm") return pmRole;
      return undefined;
    });

    // Node only has SDE role
    const node = makeNode({ roles: ["sde"] });

    // Blueprint has nodes with QA and PM roles too
    const blueprint = makeBlueprint({
      nodes: [
        node,
        makeNode({ id: "node-2", roles: ["qa"], seq: 2 }),
        makeNode({ id: "node-3", roles: ["pm"], seq: 3 }),
      ],
    });

    const prompt = buildEvaluationPrompt(
      blueprint,
      node,
      "Artifact content here",
      [],
      "bp-1",
      "node-1",
    );

    // Insights section should include ALL blueprint roles
    expect(prompt).toContain("qa insights template");
    expect(prompt).toContain("pm insights template");
    expect(prompt).toContain("sde insights template");

    // Evaluation section should only use the node's own roles (SDE)
    expect(prompt).toContain("sde evaluation examples");
    // Should NOT include QA/PM evaluation examples
    expect(prompt).not.toContain("qa evaluation examples");
    expect(prompt).not.toContain("pm evaluation examples");
  });

  it("includes defaultRole in insights even if no node has it", () => {
    const sdeRole = makeRole("sde", "SDE");
    const uxdRole = makeRole("uxd", "UXD");

    mockGetRole.mockImplementation((id: string) => {
      if (id === "sde") return sdeRole;
      if (id === "uxd") return uxdRole;
      return undefined;
    });

    const node = makeNode({ roles: ["sde"] });
    const blueprint = makeBlueprint({
      defaultRole: "uxd",
      nodes: [node],
    });

    const prompt = buildEvaluationPrompt(
      blueprint,
      node,
      "Artifact content",
      [],
      "bp-1",
      "node-1",
    );

    // Both SDE (from node) and UXD (from defaultRole) insights should appear
    expect(prompt).toContain("sde insights template");
    expect(prompt).toContain("uxd insights template");
  });

  it("falls back to SDE insights when no roles exist anywhere", () => {
    const sdeRole = makeRole("sde", "SDE");
    mockGetRole.mockImplementation((id: string) => {
      if (id === "sde") return sdeRole;
      return undefined;
    });

    const node = makeNode({ roles: undefined });
    const blueprint = makeBlueprint({
      nodes: [node],
    });

    const prompt = buildEvaluationPrompt(
      blueprint,
      node,
      "Artifact content",
      [],
      "bp-1",
      "node-1",
    );

    expect(prompt).toContain("sde insights template");
  });

  it("deduplicates roles across nodes", () => {
    const sdeRole = makeRole("sde", "SDE");
    const qaRole = makeRole("qa", "QA");

    mockGetRole.mockImplementation((id: string) => {
      if (id === "sde") return sdeRole;
      if (id === "qa") return qaRole;
      return undefined;
    });

    const node = makeNode({ roles: ["sde"] });
    const blueprint = makeBlueprint({
      nodes: [
        node,
        makeNode({ id: "node-2", roles: ["sde", "qa"], seq: 2 }),
        makeNode({ id: "node-3", roles: ["qa"], seq: 3 }),
      ],
    });

    const prompt = buildEvaluationPrompt(
      blueprint,
      node,
      "Artifact content",
      [],
      "bp-1",
      "node-1",
    );

    // SDE insights should appear exactly once (using ### header format for multi-role)
    const sdeInsightMatches = prompt.match(/### SDE \(role ID: "sde"\)\nsde insights template/g);
    expect(sdeInsightMatches).toHaveLength(1);

    // QA insights should also appear exactly once
    const qaInsightMatches = prompt.match(/### QA \(role ID: "qa"\)\nqa insights template/g);
    expect(qaInsightMatches).toHaveLength(1);
  });
});

describe("buildEvaluationPrompt suggestion roles use all blueprint roles", () => {
  it("lists all blueprint-wide roles as valid suggestion role IDs", () => {
    const sdeRole = makeRole("sde", "SDE");
    const qaRole = makeRole("qa", "QA");
    const pmRole = makeRole("pm", "PM");

    mockGetRole.mockImplementation((id: string) => {
      if (id === "sde") return sdeRole;
      if (id === "qa") return qaRole;
      if (id === "pm") return pmRole;
      return undefined;
    });

    const node = makeNode({ roles: ["sde"] });
    const blueprint = makeBlueprint({
      nodes: [
        node,
        makeNode({ id: "node-2", roles: ["qa"], seq: 2 }),
        makeNode({ id: "node-3", roles: ["pm"], seq: 3 }),
      ],
    });

    const prompt = buildEvaluationPrompt(
      blueprint,
      node,
      "Artifact content here",
      [],
      "bp-1",
      "node-1",
    );

    // Valid role IDs for suggestions should include all blueprint roles
    expect(prompt).toContain('"sde"');
    expect(prompt).toContain('"qa"');
    expect(prompt).toContain('"pm"');
    // Suggestion section should reference roles array
    expect(prompt).toContain('"roles"');
  });

  it("uses defaultRole in valid suggestion roles even when no node has it", () => {
    const sdeRole = makeRole("sde", "SDE");
    const saRole = makeRole("sa", "SA");

    mockGetRole.mockImplementation((id: string) => {
      if (id === "sde") return sdeRole;
      if (id === "sa") return saRole;
      return undefined;
    });

    const node = makeNode({ roles: ["sde"] });
    const blueprint = makeBlueprint({
      defaultRole: "sa",
      nodes: [node],
    });

    const prompt = buildEvaluationPrompt(
      blueprint,
      node,
      "Artifact content",
      [],
      "bp-1",
      "node-1",
    );

    // Both SDE and SA should be valid suggestion roles
    expect(prompt).toContain('"sde"');
    expect(prompt).toContain('"sa"');
  });

  it("falls back to SDE as valid suggestion role when no roles exist", () => {
    const sdeRole = makeRole("sde", "SDE");
    mockGetRole.mockImplementation((id: string) => {
      if (id === "sde") return sdeRole;
      return undefined;
    });

    const node = makeNode({ roles: undefined });
    const blueprint = makeBlueprint({ nodes: [node] });

    const prompt = buildEvaluationPrompt(
      blueprint,
      node,
      "Artifact content",
      [],
      "bp-1",
      "node-1",
    );

    // SDE should be the fallback valid suggestion role
    expect(prompt).toContain('"sde"');
  });

  it("includes suggestion templates from each role in suggestions section", () => {
    const sdeRole = makeRole("sde", "SDE");
    const qaRole = makeRole("qa", "QA");

    mockGetRole.mockImplementation((id: string) => {
      if (id === "sde") return sdeRole;
      if (id === "qa") return qaRole;
      return undefined;
    });

    const node = makeNode({ roles: ["sde"] });
    const blueprint = makeBlueprint({
      nodes: [
        node,
        makeNode({ id: "node-2", roles: ["qa"], seq: 2 }),
      ],
    });

    const prompt = buildEvaluationPrompt(
      blueprint,
      node,
      "Artifact content",
      [],
      "bp-1",
      "node-1",
    );

    // Suggestion templates should appear for the evaluated node's roles
    expect(prompt).toContain("sde suggestions template");
  });
});
