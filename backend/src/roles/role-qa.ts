import { registerRole } from "./role-registry.js";
import type { RoleDefinition } from "./role-registry.js";

const qaRole: RoleDefinition = {
  id: "qa",
  label: "QA Engineer",
  description: "Tests and validates features, writes test plans, reports bugs, and verifies quality",
  builtin: true,

  artifactTypes: ["test_plan", "bug_report"],
  blockerTypes: ["missing_test_data", "environment_issue", "flaky_dependency", "access_issue"],

  toolHints:
    "You have access to additional MCP tools (e.g. Playwright for e2e testing, Serena for code analysis to identify test targets) via ToolSearch. Use `ToolSearch` to discover and load them when built-in tools are insufficient for the task.",

  prompts: {
    persona: "You are a senior QA engineer executing a testing and validation task.",

    workVerb: "test and validate",

    executionGuidance: `- Write test cases and execute them. Verify coverage and edge cases.
- DO NOT ask for confirmation or clarification. Just write the tests directly.
- Focus on identifying bugs, gaps in coverage, and regression risks.
- After completing, run the test suite to verify all tests pass and check coverage.`,

    artifactFormat: `Summarize what was accomplished in the previous testing step.
Start your response with exactly "**What was done:**" and include ONLY the completed work.
Format:

**What was done:**
<2-3 sentences summarizing completed work>

**Test cases written:**
<list of test files and what they cover>

**Coverage:**
<coverage summary if applicable>

**Bugs found:**
<list of bugs discovered, or "None">

Keep it under 200 words. Be specific and factual. Do NOT include plans, next steps, or things still to do.`,

    evaluationExamples: `1. **COMPLETE** — Task is fully done. All stated testing goals achieved. No gaps.
2. **NEEDS_REFINEMENT** — Task mostly done but something concrete was missed/skipped (e.g., insufficient test coverage, missing edge case tests, no regression tests). A follow-up node should be inserted BETWEEN this completed node and its downstream dependents.
3. **HAS_BLOCKER** — An external dependency blocks progress (e.g., needs test data, environment unavailable, flaky dependency).

IMPORTANT: Be conservative. Most tasks ARE complete. Only flag NEEDS_REFINEMENT for specific, concrete gaps that would cause downstream tasks to fail or result in inadequate quality assurance. Do NOT flag stylistic preferences, nice-to-haves, or minor improvements.`,

    decompositionHeuristic: `Create 0-6 NEW steps. Each completable in one agent session (5-15 min).
Split by test scope (unit, integration, e2e). Each generated node should target a specific testing layer or test category.
When establishing dependencies, prefer depending on existing done nodes whose implementation is directly relevant to testing. Optimize for: single-session completability, clear test boundaries, and thorough coverage.`,

    decompositionExample: `Example (creates 2 nodes where the second depends on the first):
curl -s -X POST '<apiBase>/api/blueprints/<blueprintId>/nodes/batch-create?<authParam>' -H 'Content-Type: application/json' -d '[{"title":"Unit Tests","description":"Write unit tests for...","dependencies":[]},{"title":"Integration Tests","description":"Write integration tests for...","dependencies":[0]}]'`,

    specificityGuidance: "Be specific: mention test file paths, assertion types, coverage targets.",

    dependencyConsiderations: `1. Test dependencies: Does this node test functionality created by another node?
2. Data flow: Does this node need test data or fixtures from another node?
3. Logical ordering: Must the implementation be complete before this test node can run?`,

    verificationSteps: "After completing, run the test suite and check the coverage report to verify testing status.",

    suggestionsTemplate: `After calling the evaluation callback, if the status is COMPLETE, also generate three follow-up task suggestions that would logically continue or build upon the completed work. These should be NEW tasks not already covered by existing downstream nodes.

Each suggestion should have a concise title and a 1-2 sentence description of what the task involves. Focus on practical, actionable follow-ups (e.g., regression testing, load testing, security testing, accessibility).

If the status is NOT COMPLETE, skip the suggestions call.`,

    reevaluationVerification: `For EACH node listed above, reevaluate it by examining the actual codebase:

1. Read test files and coverage reports to verify testing status.
2. Then DIRECTLY update ALL nodes in a SINGLE batch API call.`,

    insightsTemplate: `After evaluating this node, consider cross-cutting quality observations:
- Test coverage gaps: Are there related features or modules that lack adequate test coverage based on changes in this node?
- Regression risks: Could the changes tested here introduce regressions in other parts of the system?
- Quality patterns: Are there recurring issues (flaky tests, missing error handling, inconsistent validation) observed across multiple nodes?
Surface these as blueprint-level insights with appropriate severity (info for coverage notes, warning for regression risks, critical for systemic quality issues).`,
  },
};

registerRole(qaRole);
