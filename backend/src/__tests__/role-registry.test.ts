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

describe("role-qa (side-effect registration)", () => {
  beforeEach(() => {
    clearRoles();
  });

  it("registers QA role with correct fields after import", async () => {
    await import("../roles/role-qa.js");

    const qa = getRole("qa");
    expect(qa).toBeDefined();
    expect(qa!.id).toBe("qa");
    expect(qa!.label).toBe("QA Engineer");
    expect(qa!.builtin).toBe(true);
    expect(qa!.artifactTypes).toEqual(["test_plan", "bug_report"]);
    expect(qa!.blockerTypes).toEqual([
      "missing_test_data",
      "environment_issue",
      "flaky_dependency",
      "access_issue",
    ]);
    expect(qa!.prompts.workVerb).toBe("test and validate");

    // Verify key prompt strings are non-empty and role-appropriate
    expect(qa!.prompts.persona).toContain("QA engineer");
    expect(qa!.prompts.executionGuidance).toContain("test cases");
    expect(qa!.prompts.artifactFormat).toContain("Test cases");
    expect(qa!.prompts.evaluationExamples).toContain("test coverage");
    expect(qa!.prompts.decompositionHeuristic).toContain("test scope");
    expect(qa!.prompts.specificityGuidance).toContain("test file paths");
    expect(qa!.prompts.dependencyConsiderations).toContain("Test dependencies");
    expect(qa!.prompts.verificationSteps).toContain("test suite");
    expect(qa!.prompts.reevaluationVerification).toContain("test files");
    expect(qa!.toolHints).toContain("Playwright");
  });
});

describe("role-pm (side-effect registration)", () => {
  beforeEach(() => {
    clearRoles();
  });

  it("registers PM role with correct fields after import", async () => {
    await import("../roles/role-pm.js");

    const pm = getRole("pm");
    expect(pm).toBeDefined();
    expect(pm!.id).toBe("pm");
    expect(pm!.label).toBe("Product Manager");
    expect(pm!.builtin).toBe(true);
    expect(pm!.artifactTypes).toEqual(["requirement_doc", "acceptance_criteria"]);
    expect(pm!.blockerTypes).toEqual([
      "missing_stakeholder_input",
      "unclear_business_rule",
      "scope_ambiguity",
    ]);
    expect(pm!.prompts.workVerb).toBe("define and clarify requirements");

    // Verify key prompt strings are non-empty and role-appropriate
    expect(pm!.prompts.persona).toContain("product manager");
    expect(pm!.prompts.executionGuidance).toContain("requirements");
    expect(pm!.prompts.artifactFormat).toContain("Requirements defined");
    expect(pm!.prompts.evaluationExamples).toContain("acceptance criteria");
    expect(pm!.prompts.decompositionHeuristic).toContain("user journey");
    expect(pm!.prompts.specificityGuidance).toContain("user personas");
    expect(pm!.prompts.dependencyConsiderations).toContain("Requirement dependencies");
    expect(pm!.prompts.verificationSteps).toContain("stakeholder");
    expect(pm!.prompts.reevaluationVerification).toContain("requirement documents");
    expect(pm!.toolHints).toContain("Linear");
  });
});

describe("role-sde (side-effect registration)", () => {
  beforeEach(() => {
    clearRoles();
  });

  it("registers SDE role with correct fields after import", async () => {
    // Side-effect import triggers registration
    await import("../roles/role-sde.js");

    const sde = getRole("sde");
    expect(sde).toBeDefined();
    expect(sde!.id).toBe("sde");
    expect(sde!.label).toBe("Software Engineer");
    expect(sde!.builtin).toBe(true);
    expect(sde!.artifactTypes).toEqual(["file_diff", "test_report"]);
    expect(sde!.prompts.workVerb).toBe("implement");

    // Verify key prompt strings are non-empty
    expect(sde!.prompts.persona).toContain("software engineer");
    expect(sde!.prompts.executionGuidance).toContain("Complete this step thoroughly");
    expect(sde!.prompts.artifactFormat).toContain("What was done:");
    expect(sde!.prompts.evaluationExamples).toContain("NEEDS_REFINEMENT");
    expect(sde!.prompts.decompositionHeuristic).toContain("5-15 min");
    expect(sde!.prompts.decompositionExample).toContain("Backend API");
    expect(sde!.prompts.dependencyConsiderations).toContain("Code dependencies");
    expect(sde!.prompts.verificationSteps).toContain("typecheck");
    expect(sde!.prompts.reevaluationVerification).toContain("Read the relevant source files");
    expect(sde!.toolHints).toContain("MCP tools");
  });
});
