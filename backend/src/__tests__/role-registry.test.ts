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
    insightsTemplate: "test insights",
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

/**
 * Expected shape for assertRoleRegistration.
 * `promptContains` maps RolePrompts keys to substrings that must appear in each field.
 */
interface RoleExpectedShape {
  label: string;
  builtin: boolean;
  artifactTypes: string[];
  blockerTypes?: string[];
  workVerb: string;
  promptContains: Partial<Record<keyof RolePrompts, string>>;
  toolHintsContain?: string;
}

/**
 * Shared helper that validates a role was registered correctly via side-effect import.
 * Asserts: existence, id, label, builtin, artifactTypes, blockerTypes (if provided),
 * workVerb, prompt substring matches, and toolHints substring.
 *
 * Usage: await import("../roles/role-foo.js"); assertRoleRegistration("foo", { ... });
 */
function assertRoleRegistration(
  roleId: string,
  expected: RoleExpectedShape
): void {
  const role = getRole(roleId);
  expect(role).toBeDefined();
  expect(role!.id).toBe(roleId);
  expect(role!.label).toBe(expected.label);
  expect(role!.builtin).toBe(expected.builtin);
  expect(role!.artifactTypes).toEqual(expected.artifactTypes);

  if (expected.blockerTypes) {
    expect(role!.blockerTypes).toEqual(expected.blockerTypes);
  }

  expect(role!.prompts.workVerb).toBe(expected.workVerb);

  // Validate prompt field substrings
  for (const [key, substring] of Object.entries(expected.promptContains)) {
    expect(
      role!.prompts[key as keyof RolePrompts],
      `prompts.${key} should contain "${substring}"`
    ).toContain(substring);
  }

  if (expected.toolHintsContain) {
    expect(role!.toolHints).toContain(expected.toolHintsContain);
  }
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

describe("role-sde (side-effect registration)", () => {
  beforeEach(() => {
    clearRoles();
  });

  it("registers SDE role with correct fields after import", async () => {
    await import("../roles/role-sde.js");

    assertRoleRegistration("sde", {
      label: "Software Engineer",
      builtin: true,
      artifactTypes: ["file_diff", "test_report"],
      workVerb: "implement",
      promptContains: {
        persona: "software engineer",
        executionGuidance: "Complete this step thoroughly",
        artifactFormat: "What was done:",
        evaluationExamples: "NEEDS_REFINEMENT",
        decompositionHeuristic: "5-15 min",
        decompositionExample: "Backend API",
        dependencyConsiderations: "Code dependencies",
        verificationSteps: "typecheck",
        reevaluationVerification: "Read the relevant source files",
      },
      toolHintsContain: "MCP tools",
    });
  });
});

describe("role-qa (side-effect registration)", () => {
  beforeEach(() => {
    clearRoles();
  });

  it("registers QA role with correct fields after import", async () => {
    await import("../roles/role-qa.js");

    assertRoleRegistration("qa", {
      label: "QA Engineer",
      builtin: true,
      artifactTypes: ["test_plan", "bug_report"],
      blockerTypes: [
        "missing_test_data",
        "environment_issue",
        "flaky_dependency",
        "access_issue",
      ],
      workVerb: "test and validate",
      promptContains: {
        persona: "QA engineer",
        executionGuidance: "test cases",
        artifactFormat: "Test cases",
        evaluationExamples: "test coverage",
        decompositionHeuristic: "test scope",
        specificityGuidance: "test file paths",
        dependencyConsiderations: "Test dependencies",
        verificationSteps: "test suite",
        reevaluationVerification: "test files",
      },
      toolHintsContain: "Playwright",
    });
  });
});

describe("role-pm (side-effect registration)", () => {
  beforeEach(() => {
    clearRoles();
  });

  it("registers PM role with correct fields after import", async () => {
    await import("../roles/role-pm.js");

    assertRoleRegistration("pm", {
      label: "Product Manager",
      builtin: true,
      artifactTypes: ["requirement_doc", "acceptance_criteria"],
      blockerTypes: [
        "missing_stakeholder_input",
        "unclear_business_rule",
        "scope_ambiguity",
      ],
      workVerb: "define and clarify requirements",
      promptContains: {
        persona: "product manager",
        executionGuidance: "requirements",
        artifactFormat: "Requirements defined",
        evaluationExamples: "acceptance criteria",
        decompositionHeuristic: "user journey",
        specificityGuidance: "user personas",
        dependencyConsiderations: "Requirement dependencies",
        verificationSteps: "stakeholder",
        reevaluationVerification: "requirement documents",
      },
      toolHintsContain: "Linear",
    });
  });
});

describe("role-uxd (side-effect registration)", () => {
  beforeEach(() => {
    clearRoles();
  });

  it("registers UXD role with correct fields after import", async () => {
    await import("../roles/role-uxd.js");

    assertRoleRegistration("uxd", {
      label: "UX Designer",
      builtin: true,
      artifactTypes: ["design_spec", "component_audit"],
      blockerTypes: [
        "missing_design_system_token",
        "accessibility_violation",
        "inconsistent_pattern",
      ],
      workVerb: "design and specify",
      promptContains: {
        persona: "UI/UX designer",
        executionGuidance: "DO NOT write implementation code",
        artifactFormat: "Components specified",
        evaluationExamples: "responsive breakpoints",
        decompositionHeuristic: "component",
        specificityGuidance: "accent-blue",
        dependencyConsiderations: "Audit dependencies",
        verificationSteps: "WCAG AA",
        reevaluationVerification: "FRONTEND-PATTERNS.md",
      },
      toolHintsContain: "FRONTEND-PATTERNS.md",
    });
  });
});

describe("role-sa (side-effect registration)", () => {
  beforeEach(() => {
    clearRoles();
  });

  it("registers SA role with correct fields after import", async () => {
    await import("../roles/role-sa.js");

    assertRoleRegistration("sa", {
      label: "Software Architect",
      builtin: true,
      artifactTypes: ["architecture_doc", "feasibility_report"],
      blockerTypes: [
        "missing_context",
        "unclear_requirement",
        "technical_constraint",
        "scale_uncertainty",
      ],
      workVerb: "design and analyze",
      promptContains: {
        persona: "software architect",
        executionGuidance: "refactoring",
        artifactFormat: "Key decisions",
        evaluationExamples: "migration path",
        decompositionHeuristic: "architectural concern",
        specificityGuidance: "module paths",
        dependencyConsiderations: "Analysis dependencies",
        verificationSteps: "backward-compatible",
        reevaluationVerification: "module structures",
      },
      toolHintsContain: "Serena",
    });
  });
});

describe("role-mle (side-effect registration)", () => {
  beforeEach(() => {
    clearRoles();
  });

  it("registers MLE role with correct fields after import", async () => {
    await import("../roles/role-mle.js");

    assertRoleRegistration("mle", {
      label: "ML Engineer",
      builtin: true,
      artifactTypes: ["model_spec", "experiment_report"],
      blockerTypes: [
        "missing_data",
        "compute_constraint",
        "model_limitation",
        "unclear_metric",
      ],
      workVerb: "build and evaluate",
      promptContains: {
        persona: "machine learning engineer",
        executionGuidance: "reproducible",
        artifactFormat: "Model/data details",
        evaluationExamples: "API rate limits",
        decompositionHeuristic: "ML pipeline stage",
        specificityGuidance: "model architectures",
        dependencyConsiderations: "Data dependencies",
        verificationSteps: "data pipelines",
        reevaluationVerification: "data pipeline correctness",
      },
      toolHintsContain: "Serena",
    });
  });
});
