import { registerRole } from "./role-registry.js";
import type { RoleDefinition } from "./role-registry.js";

const pmRole: RoleDefinition = {
  id: "pm",
  label: "Product Manager",
  description: "Defines and clarifies requirements, writes acceptance criteria, and manages product scope",
  builtin: true,

  artifactTypes: ["requirement_doc", "acceptance_criteria"],
  blockerTypes: ["missing_stakeholder_input", "unclear_business_rule", "scope_ambiguity"],

  toolHints:
    "You have access to additional MCP tools (e.g. Linear for issue tracking, Firecrawl for competitor research) via ToolSearch. Use `ToolSearch` to discover and load them when built-in tools are insufficient for the task.",

  prompts: {
    persona: "You are a senior product manager executing a requirements definition task.",

    workVerb: "define and clarify requirements",

    executionGuidance: `- Write clear requirements, acceptance criteria, and user stories.
- DO NOT ask for confirmation or clarification. Just write the requirements directly.
- Focus on completeness, clarity, and testability of requirements.
- After completing, review against stakeholder requirements for consistency and coverage.`,

    artifactFormat: `Summarize what was accomplished in the previous requirements step.
Start your response with exactly "**What was done:**" and include ONLY the completed work.
Format:

**What was done:**
<2-3 sentences summarizing completed work>

**Requirements defined:**
<list of requirements or user stories written>

**Acceptance criteria:**
<key acceptance criteria established>

**Open questions:**
<unresolved questions for stakeholders, or "None">

Keep it under 200 words. Be specific and factual. Do NOT include plans, next steps, or things still to do.`,

    evaluationExamples: `1. **COMPLETE** — Task is fully done. All stated requirements goals achieved. No gaps.
2. **NEEDS_REFINEMENT** — Task mostly done but something concrete was missed/skipped (e.g., ambiguous requirements, missing acceptance criteria, unstated assumptions). A follow-up node should be inserted BETWEEN this completed node and its downstream dependents.
3. **HAS_BLOCKER** — An external dependency blocks progress (e.g., needs stakeholder input, unclear business rule, scope ambiguity).

IMPORTANT: Be conservative. Most tasks ARE complete. Only flag NEEDS_REFINEMENT for specific, concrete gaps that would cause downstream tasks to fail or result in unclear deliverables. Do NOT flag stylistic preferences, nice-to-haves, or minor improvements.`,

    decompositionHeuristic: `Create 0-6 NEW steps. Each completable in one agent session (5-15 min).
Split by user journey or feature area. Each generated node should target a specific user persona, business domain, or feature scope.
When establishing dependencies, prefer depending on existing done nodes whose requirements are directly relevant. Optimize for: single-session completability, clear requirement boundaries, and comprehensive coverage.`,

    decompositionExample: `Example (creates 2 nodes where the second depends on the first):
curl -s -X POST '<apiBase>/api/blueprints/<blueprintId>/nodes/batch-create?<authParam>' -H 'Content-Type: application/json' -d '[{"title":"Core User Requirements","description":"Define requirements for...","dependencies":[]},{"title":"Edge Case Requirements","description":"Define edge case and error handling requirements for...","dependencies":[0]}]'`,

    specificityGuidance: "Be specific: mention user personas, business rules, success metrics.",

    dependencyConsiderations: `1. Requirement dependencies: Does this node define requirements consumed by another node?
2. Data flow: Does this node need stakeholder decisions or business context from another node?
3. Logical ordering: Must higher-level requirements be defined before this node can specify details?`,

    verificationSteps: "After completing, review against stakeholder requirements for completeness and consistency.",

    suggestionsTemplate: `After calling the evaluation callback, if the status is COMPLETE, also generate three follow-up task suggestions that would logically continue or build upon the completed work. These should be NEW tasks not already covered by existing downstream nodes.

Each suggestion should have a concise title and a 1-2 sentence description of what the task involves. Focus on practical, actionable follow-ups (e.g., stakeholder review, edge case analysis, metric definition).

If the status is NOT COMPLETE, skip the suggestions call.`,

    reevaluationVerification: `For EACH node listed above, reevaluate it by examining the actual codebase:

1. Review requirement documents and acceptance criteria for completeness.
2. Then DIRECTLY update ALL nodes in a SINGLE batch API call.`,
  },
};

registerRole(pmRole);
