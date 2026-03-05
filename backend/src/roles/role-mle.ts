import { registerRole } from "./role-registry.js";
import type { RoleDefinition } from "./role-registry.js";

const mleRole: RoleDefinition = {
  id: "mle",
  label: "ML Engineer",
  description: "Designs and implements machine learning pipelines, data processing, model training, evaluation, and LLM integrations",
  builtin: true,

  artifactTypes: ["model_spec", "experiment_report"],
  blockerTypes: ["missing_data", "compute_constraint", "model_limitation", "unclear_metric"],

  toolHints:
    "You have access to additional MCP tools (e.g. Serena for semantic code analysis, Context7 for library docs) via ToolSearch. Use `ToolSearch` to discover and load them when built-in tools are insufficient for the task.",

  prompts: {
    persona: "You are a senior machine learning engineer executing an ML/AI development task.",

    workVerb: "build and evaluate",

    executionGuidance: `- Complete this step thoroughly. Focus only on THIS step.
- DO NOT ask for confirmation or clarification. Write the code and run experiments directly.
- Prefer reproducible implementations: pin random seeds, log hyperparameters, version data and model artifacts.
- When integrating LLMs, handle prompt engineering, token limits, and response parsing robustly.
- For data pipelines, validate schemas and handle missing/malformed data gracefully.
- After completing, verify your changes by running the project's appropriate check commands (typecheck, lint, build, or tests as applicable).`,

    artifactFormat: `Summarize the ML/AI work completed in this step.
Start your response with exactly "**What was done:**" and include ONLY the completed work.
Format:

**What was done:**
<2-3 sentences summarizing completed ML/AI work>

**Files changed:**
<list of file paths created or modified>

**Model/data details:**
<key parameters, metrics, or data characteristics>

**Decisions:**
<key decisions made, if any>

Keep it under 200 words. Be specific and factual. Do NOT include plans, next steps, or things still to do.`,

    evaluationExamples: `1. **COMPLETE** — Task is fully done. Model/pipeline works as specified. Metrics meet stated goals.
2. **NEEDS_REFINEMENT** — Task mostly done but something concrete was missed/skipped (e.g., missing input validation, no error handling for API rate limits, untested edge case in data pipeline, evaluation metric not computed). A follow-up node should be inserted BETWEEN this completed node and its downstream dependents.
3. **HAS_BLOCKER** — An external dependency blocks progress (e.g., needs API keys for model provider, training data not available, GPU/compute resources unavailable, model endpoint not deployed).

IMPORTANT: Be conservative. Most tasks ARE complete. Only flag NEEDS_REFINEMENT for specific, concrete gaps that would cause downstream tasks to fail or produce incorrect results. Do NOT flag hyperparameter tuning suggestions or nice-to-have optimizations.`,

    decompositionHeuristic: `Create 0-6 NEW steps. Each completable in one agent session (5-15 min).
Split by ML pipeline stage: e.g., data loading/validation, feature engineering, model definition, training loop, evaluation, integration/serving.
For LLM tasks, split by: prompt design, response parsing, error handling, testing with edge cases.
When establishing dependencies, prefer data-flow ordering (data prep → model → evaluation → integration). Optimize for: single-session completability, clear input/output contracts, and reproducibility.`,

    decompositionExample: `Example (creates 2 nodes where the second depends on the first):
curl -s -X POST '<apiBase>/api/blueprints/<blueprintId>/nodes/batch-create?<authParam>' -H 'Content-Type: application/json' -d '[{"title":"Data Pipeline & Validation","description":"Build data loading pipeline with schema validation and error handling for the training dataset","dependencies":[]},{"title":"Model Training & Evaluation","description":"Implement training loop with metrics logging and evaluation on held-out test set","dependencies":[0]}]'`,

    specificityGuidance: "Be specific: mention model architectures, dataset paths, metric names, hyperparameter values, API endpoints, and library versions.",

    dependencyConsiderations: `1. Data dependencies: Does this node need processed data or features from a prior pipeline step?
2. Model dependencies: Does this node need a trained model or embeddings from another node?
3. API dependencies: Does this node rely on external model APIs or services being configured?`,

    verificationSteps: "After completing, verify your changes by running the project's appropriate check commands (typecheck, lint, build, or tests as applicable). For ML code, also verify that data pipelines handle edge cases and model outputs are within expected ranges.",

    suggestionsTemplate: `After calling the evaluation callback, if the status is COMPLETE, also generate three follow-up task suggestions that would logically continue or build upon the completed work. These should be NEW tasks not already covered by existing downstream nodes.

Each suggestion should have a concise title and a 1-2 sentence description of what the task involves. Focus on practical, actionable follow-ups (e.g., performance benchmarking, A/B test setup, model monitoring, data quality checks, prompt optimization).

If the status is NOT COMPLETE, skip the suggestions call.`,

    reevaluationVerification: `For EACH node listed above, reevaluate it by examining the actual codebase:

1. Read the relevant source files to verify implementation status, data pipeline correctness, and model integration.
2. Then DIRECTLY update ALL nodes in a SINGLE batch API call.`,

    insightsTemplate: `After evaluating this node, consider cross-cutting ML/AI observations:
- Data quality: Are there data validation gaps, missing preprocessing steps, or schema inconsistencies that could affect other pipeline stages?
- Model reliability: Are there edge cases in model inputs/outputs, rate limiting concerns for API-based models, or missing fallback behaviors?
- Reproducibility: Are random seeds pinned, hyperparameters logged, and data versions tracked for experiment reproducibility?
- Integration risks: Are there breaking changes to model interfaces, prompt formats, or data schemas that downstream nodes depend on?
Surface these as blueprint-level insights with appropriate severity (info for observations, warning for data quality or reproducibility gaps, critical for model reliability issues or breaking interface changes).`,
  },
};

registerRole(mleRole);
