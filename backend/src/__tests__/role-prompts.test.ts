import { describe, it, expect } from "vitest";
import {
  getRole,
} from "../roles/role-registry.js";
import type { Blueprint, MacroNode } from "../plan-db.js";

// Import role modules for side-effect registration
import "../roles/role-sde.js";
import "../roles/role-qa.js";
import "../roles/role-pm.js";

// Import the functions under test
import { resolveNodeRoles, buildArtifactPrompt } from "../plan-executor.js";

// ─── Helpers ─────────────────────────────────────────────────

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

function makeNode(overrides: Partial<MacroNode> = {}): MacroNode {
  return {
    id: "node-1",
    blueprintId: "bp-1",
    order: 0,
    seq: 1,
    title: "Test Node",
    description: "A test node",
    status: "pending",
    dependencies: [],
    inputArtifacts: [],
    outputArtifacts: [],
    executions: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ─── resolveNodeRoles ────────────────────────────────────────

describe("resolveNodeRoles", () => {
  it("returns node.roles when set on the node", () => {
    const node = makeNode({ roles: ["qa", "pm"] });
    const blueprint = makeBlueprint({ defaultRole: "sde", enabledRoles: ["sde", "qa", "pm"] });
    expect(resolveNodeRoles(node, blueprint)).toEqual(["qa", "pm"]);
  });

  it("falls back to blueprint.defaultRole when node.roles is undefined", () => {
    const node = makeNode({ roles: undefined });
    const blueprint = makeBlueprint({ defaultRole: "qa" });
    expect(resolveNodeRoles(node, blueprint)).toEqual(["qa"]);
  });

  it("falls back to blueprint.defaultRole when node.roles is empty array", () => {
    const node = makeNode({ roles: [] });
    const blueprint = makeBlueprint({ defaultRole: "pm" });
    // Empty array means "not set" — should use blueprint default
    expect(resolveNodeRoles(node, blueprint)).toEqual(["pm"]);
  });

  it("falls back to ['sde'] when both node.roles and blueprint.defaultRole are missing", () => {
    const node = makeNode({ roles: undefined });
    const blueprint = makeBlueprint({ defaultRole: undefined });
    expect(resolveNodeRoles(node, blueprint)).toEqual(["sde"]);
  });

  it("falls back to ['sde'] when blueprint.defaultRole is empty string", () => {
    const node = makeNode({ roles: undefined });
    const blueprint = makeBlueprint({ defaultRole: "" });
    expect(resolveNodeRoles(node, blueprint)).toEqual(["sde"]);
  });
});

// ─── buildArtifactPrompt ─────────────────────────────────────

describe("buildArtifactPrompt", () => {
  it("returns SDE artifact format for single sde role", () => {
    const result = buildArtifactPrompt(["sde"]);
    const sdeRole = getRole("sde")!;
    expect(result).toBe(sdeRole.prompts.artifactFormat);
  });

  it("returns QA artifact format for single qa role", () => {
    const result = buildArtifactPrompt(["qa"]);
    const qaRole = getRole("qa")!;
    expect(result).toBe(qaRole.prompts.artifactFormat);
  });

  it("returns PM artifact format for single pm role", () => {
    const result = buildArtifactPrompt(["pm"]);
    const pmRole = getRole("pm")!;
    expect(result).toBe(pmRole.prompts.artifactFormat);
  });

  it("combines multiple role artifact formats with role labels as headers", () => {
    const result = buildArtifactPrompt(["sde", "qa"]);
    const sdeRole = getRole("sde")!;
    const qaRole = getRole("qa")!;

    // Should contain both role labels as headers
    expect(result).toContain(`### ${sdeRole.label}`);
    expect(result).toContain(`### ${qaRole.label}`);

    // Should contain both artifact formats
    expect(result).toContain(sdeRole.prompts.artifactFormat);
    expect(result).toContain(qaRole.prompts.artifactFormat);
  });

  it("falls back to SDE format for unknown role ID", () => {
    const result = buildArtifactPrompt(["nonexistent"]);
    const sdeRole = getRole("sde")!;
    expect(result).toBe(sdeRole.prompts.artifactFormat);
  });

  it("skips unknown roles in multi-role and only includes known ones", () => {
    const result = buildArtifactPrompt(["sde", "nonexistent"]);
    const sdeRole = getRole("sde")!;
    // With only one valid role resolved, should return its format directly
    expect(result).toBe(sdeRole.prompts.artifactFormat);
  });
});
