import { describe, it, expect, beforeEach } from "vitest";
import {
  registerRole,
  getRole,
  getAllRoles,
  getBuiltinRoles,
  clearRoles,
} from "../roles/role-registry.js";
import type { RoleDefinition, RolePrompts } from "../roles/role-registry.js";

function makePrompts(overrides: Partial<RolePrompts> = {}): RolePrompts {
  return {
    persona: "test persona",
    workVerb: "test",
    executionGuidance: "test guidance",
    artifactFormat: "test format",
    evaluationExamples: "test examples",
    decompositionHeuristic: "test heuristic",
    decompositionExample: "test example",
    specificityGuidance: "test specificity",
    dependencyConsiderations: "test deps",
    verificationSteps: "test verify",
    suggestionsTemplate: "test suggestions",
    reevaluationVerification: "test reevaluation",
    ...overrides,
  };
}

function makeRole(overrides: Partial<RoleDefinition> = {}): RoleDefinition {
  return {
    id: "test-role",
    label: "Test Role",
    description: "A test role",
    builtin: false,
    prompts: makePrompts(),
    artifactTypes: ["custom"],
    blockerTypes: ["technical_limitation"],
    ...overrides,
  };
}

describe("role-registry", () => {
  beforeEach(() => {
    clearRoles();
  });

  it("registers and retrieves a role", () => {
    const role = makeRole({ id: "sde", label: "Software Engineer", builtin: true });
    registerRole(role);

    const retrieved = getRole("sde");
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe("sde");
    expect(retrieved!.label).toBe("Software Engineer");
    expect(retrieved!.builtin).toBe(true);
    expect(retrieved!.prompts.persona).toBe("test persona");
  });

  it("returns undefined for unknown role", () => {
    const result = getRole("nonexistent");
    expect(result).toBeUndefined();
  });

  it("lists all registered roles", () => {
    registerRole(makeRole({ id: "sde", label: "SDE", builtin: true }));
    registerRole(makeRole({ id: "qa", label: "QA", builtin: true }));
    registerRole(makeRole({ id: "custom-1", label: "Custom", builtin: false }));

    const all = getAllRoles();
    expect(all).toHaveLength(3);
    const ids = all.map((r) => r.id);
    expect(ids).toContain("sde");
    expect(ids).toContain("qa");
    expect(ids).toContain("custom-1");
  });

  it("filters builtin roles only", () => {
    registerRole(makeRole({ id: "sde", builtin: true }));
    registerRole(makeRole({ id: "qa", builtin: true }));
    registerRole(makeRole({ id: "custom-1", builtin: false }));

    const builtins = getBuiltinRoles();
    expect(builtins).toHaveLength(2);
    expect(builtins.every((r) => r.builtin)).toBe(true);
    const ids = builtins.map((r) => r.id);
    expect(ids).toContain("sde");
    expect(ids).toContain("qa");
    expect(ids).not.toContain("custom-1");
  });

  it("clearRoles empties the registry", () => {
    registerRole(makeRole({ id: "sde" }));
    registerRole(makeRole({ id: "qa" }));
    expect(getAllRoles()).toHaveLength(2);

    clearRoles();
    expect(getAllRoles()).toHaveLength(0);
    expect(getRole("sde")).toBeUndefined();
  });

  it("overwrites role with same id on re-register", () => {
    registerRole(makeRole({ id: "sde", label: "Original" }));
    registerRole(makeRole({ id: "sde", label: "Updated" }));

    const role = getRole("sde");
    expect(role!.label).toBe("Updated");
    expect(getAllRoles()).toHaveLength(1);
  });

  it("preserves optional fields like icon and toolHints", () => {
    registerRole(makeRole({
      id: "sde",
      icon: "💻",
      toolHints: "Use Playwright for testing",
    }));

    const role = getRole("sde");
    expect(role!.icon).toBe("💻");
    expect(role!.toolHints).toBe("Use Playwright for testing");
  });

  it("handles role without optional icon and toolHints", () => {
    const role = makeRole({ id: "minimal" });
    delete (role as unknown as Record<string, unknown>).icon;
    delete (role as unknown as Record<string, unknown>).toolHints;
    registerRole(role);

    const retrieved = getRole("minimal");
    expect(retrieved).toBeDefined();
    expect(retrieved!.icon).toBeUndefined();
    expect(retrieved!.toolHints).toBeUndefined();
  });
});
