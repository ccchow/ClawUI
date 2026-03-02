import { registerRole } from "./role-registry.js";
import type { RoleDefinition } from "./role-registry.js";

const sdeRole: RoleDefinition = {
  id: "sde",
  label: "Software Engineer",
  description: "Implements features, fixes bugs, writes tests, and performs code changes",
  builtin: true,

  artifactTypes: ["file_diff", "test_report"],
  blockerTypes: ["missing_dependency", "unclear_requirement", "access_issue", "technical_limitation"],

  toolHints:
    "You have access to additional MCP tools (e.g. Playwright for browser testing, Serena for semantic code analysis, Context7 for library docs, Linear for issue tracking) via ToolSearch. Use `ToolSearch` to discover and load them when built-in tools are insufficient for the task.",

  prompts: {
    persona: "You are a senior software engineer executing a development task.",

    workVerb: "implement",

    executionGuidance: `- Complete this step thoroughly. Focus only on THIS step.
- DO NOT ask for confirmation or clarification. Just write the code directly.
- After completing, verify your changes by running the project's appropriate check commands (typecheck, lint, build, or tests as applicable).
- IMPORTANT: After completing and verifying, run the skill command /claude-md-management:revise-claude-md to update CLAUDE.md with any learnings from this step. Do NOT ask for confirmation — apply updates directly without user interaction.`,

    artifactFormat: `Summarize what was accomplished in the previous coding step.
Start your response with exactly "**What was done:**" and include ONLY the completed work.
Format:

**What was done:**
<2-3 sentences summarizing completed work>

**Files changed:**
<list of file paths created or modified>

**Decisions:**
<key decisions made, if any>

Keep it under 200 words. Be specific and factual. Do NOT include plans, next steps, or things still to do.`,

    evaluationExamples: `1. **COMPLETE** — Task is fully done. All stated goals achieved. No gaps.
2. **NEEDS_REFINEMENT** — Task mostly done but something concrete was missed/skipped (e.g., missing validation, incomplete error handling, untested edge case). A follow-up node should be inserted BETWEEN this completed node and its downstream dependents.
3. **HAS_BLOCKER** — An external dependency blocks progress (e.g., needs human credentials, external API key, manual approval). A sibling blocker node should be created.

IMPORTANT: Be conservative. Most tasks ARE complete. Only flag NEEDS_REFINEMENT for specific, concrete gaps that would cause downstream tasks to fail or result in broken functionality. Do NOT flag stylistic preferences, nice-to-haves, or minor improvements.`,

    decompositionHeuristic: `Create 0-6 NEW steps. Each completable in one Claude Code session (5-15 min).
When establishing dependencies, prefer depending on existing done nodes whose work is directly relevant (leaf nodes with no existing successors are ideal candidates). Within new nodes, create sequential dependencies for modular work: e.g., backend → frontend → integration test.
Each generated node should be self-contained and reusable. Split by architectural layer when appropriate — e.g., a feature module becomes: (1) backend API node, (2) frontend UI node, (3) E2E integration node — with sequential dependencies. Optimize for: single-session completability, clear handoff boundaries, and maximum reuse as dependency targets.`,

    decompositionExample: `Example (creates 2 nodes where the second depends on the first):
curl -s -X POST '<apiBase>/api/blueprints/<blueprintId>/nodes/batch-create?<authParam>' -H 'Content-Type: application/json' -d '[{"title":"Backend API","description":"Create REST endpoints...","dependencies":[]},{"title":"Frontend UI","description":"Build React components...","dependencies":[0]}]'`,

    specificityGuidance: "Be specific: mention file paths, function names, API endpoints.",

    dependencyConsiderations: `1. Data flow: Does this node need output/artifacts from another node?
2. Code dependencies: Does this node modify code that another node creates?
3. Logical ordering: Must another task complete first for this one to make sense?`,

    verificationSteps: "After completing, verify your changes by running the project's appropriate check commands (typecheck, lint, build, or tests as applicable).",

    suggestionsTemplate: `After calling the evaluation callback, if the status is COMPLETE, also generate three follow-up task suggestions that would logically continue or build upon the completed work. These should be NEW tasks not already covered by existing downstream nodes.

Each suggestion should have a concise title and a 1-2 sentence description of what the task involves. Focus on practical, actionable follow-ups (e.g., testing, documentation, performance improvements, related features).

If the status is NOT COMPLETE, skip the suggestions call.`,

    reevaluationVerification: `For EACH node listed above, reevaluate it by examining the actual codebase:

1. Read the relevant source files to verify implementation status.
2. Then DIRECTLY update ALL nodes in a SINGLE batch API call.`,

    insightsTemplate: `After evaluating this node, consider cross-cutting observations visible from this work:
- Architectural impact: Does this change affect shared modules, interfaces, or data models used by other nodes?
- Dependency issues: Are there version conflicts, breaking changes, or deprecated APIs that other nodes should know about?
- Shared code changes: Were common utilities, helpers, or base classes modified in ways that could break other features?
Surface these as blueprint-level insights with appropriate severity (info for awareness, warning for potential issues, critical for breaking changes).`,
  },
};

registerRole(sdeRole);
