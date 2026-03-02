export interface RolePrompts {
  /** "You are a senior software engineer..." */
  persona: string;
  /** "implement" | "test" | "define requirements" */
  workVerb: string;
  /** Execution-time guidance appended to buildNodePrompt() */
  executionGuidance: string;
  /** Handoff artifact format template (replaces ARTIFACT_PROMPT) */
  artifactFormat: string;
  /** Examples for NEEDS_REFINEMENT in evaluation */
  evaluationExamples: string;
  /** How plan-generator decomposes tasks for this role */
  decompositionHeuristic: string;
  /** JSON example for plan-generator few-shot learning */
  decompositionExample: string;
  /** "mention file paths, function names..." — specificity guidance */
  specificityGuidance: string;
  /** Smart-deps consideration (replaces "Code dependencies: ...") */
  dependencyConsiderations: string;
  /** "run typecheck, lint, build, tests" — post-completion checks */
  verificationSteps: string;
  /** Suggestion categories for evaluation follow-ups */
  suggestionsTemplate: string;
  /** Reevaluate-all: how to verify completion */
  reevaluationVerification: string;
  /** Cross-cutting observations this role should surface during evaluation */
  insightsTemplate: string;
}

export interface RoleDefinition {
  id: string;
  label: string;
  description: string;
  icon?: string;
  builtin: boolean;

  prompts: RolePrompts;

  /** Artifact types this role typically produces */
  artifactTypes: string[];

  /** Blocker types relevant to this role */
  blockerTypes: string[];

  /** MCP tool hints shown in execution prompt */
  toolHints?: string;
}

const roleRegistry = new Map<string, RoleDefinition>();

export function registerRole(role: RoleDefinition): void {
  roleRegistry.set(role.id, role);
}

export function getRole(id: string): RoleDefinition | undefined {
  return roleRegistry.get(id);
}

export function getAllRoles(): RoleDefinition[] {
  return Array.from(roleRegistry.values());
}

export function getBuiltinRoles(): RoleDefinition[] {
  return getAllRoles().filter((r) => r.builtin);
}

export function clearRoles(): void {
  roleRegistry.clear();
}
