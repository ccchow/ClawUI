import {
  getBlueprint,
  getInsightsForBlueprint,
  markAllInsightsRead,
} from "./plan-db.js";
import type { BlueprintInsight } from "./plan-db.js";
import { getApiBase, getAuthParam, runAgentInteractive } from "./plan-generator.js";
import { createLogger } from "./logger.js";

// Side-effect imports: ensure all runtimes are registered before runAgentInteractive()
import "./agent-claude.js";
import "./agent-pimono.js";
import "./agent-openclaw.js";
import "./agent-codex.js";

// Side-effect: auto-discovers and registers all roles
import "./roles/load-all-roles.js";

const log = createLogger("plan-coordinator");

/**
 * Build the coordinator prompt from unread insights and current blueprint state.
 * Exported for testing.
 */
export function buildCoordinatorPrompt(
  blueprintId: string,
  insights: BlueprintInsight[],
  blueprint: { title: string; description: string; projectCwd?: string; nodes: Array<{ id: string; title: string; status: string; dependencies: string[]; roles?: string[] }> },
): string {
  const apiBase = getApiBase();
  const authParam = getAuthParam();

  // Format insights
  const insightLines = insights.map((i, idx) => {
    const sourceInfo = i.sourceNodeId ? ` (source node: ${i.sourceNodeId})` : "";
    return `  ${idx + 1}. [${i.severity.toUpperCase()}] [role: ${i.role}] ${i.message}${sourceInfo} — insight ID: ${i.id}`;
  }).join("\n");

  // Format current node graph
  const nodeLines = blueprint.nodes.map((n) => {
    const deps = n.dependencies.length > 0 ? ` deps=[${n.dependencies.join(", ")}]` : "";
    const roles = n.roles && n.roles.length > 0 ? ` roles=[${n.roles.join(", ")}]` : "";
    return `  - [${n.status}] ${n.title} (id: ${n.id}${deps}${roles})`;
  }).join("\n");

  return `You are a Blueprint Coordinator analyzing insights from completed node evaluations and deciding what corrective actions to take.

Blueprint: "${blueprint.title}" (ID: ${blueprintId})
${blueprint.description ? `Description: ${blueprint.description}` : ""}
Working directory: ${blueprint.projectCwd || "not specified"}

## Unread Insights

${insightLines}

## Current Node Graph

${nodeLines}

## Your Task

Analyze the insights above in the context of the current blueprint state. For each insight, decide one of:

1. **Create new nodes** — if the insight reveals missing work (e.g., missing tests, undocumented API, security gap)
2. **Update existing nodes** — if the insight suggests changes to pending/failed nodes (e.g., add acceptance criteria, adjust scope)
3. **Dismiss** — if the insight is already addressed or no longer relevant

## Available API Endpoints

### Create new nodes (batch):
\`\`\`
curl -s -X POST '${apiBase}/api/blueprints/${blueprintId}/nodes/batch-create?${authParam}' \\
  -H 'Content-Type: application/json' \\
  -d '[{"title": "Node title", "description": "Detailed description", "dependencies": ["existing-node-id"], "roles": ["qa"]}]'
\`\`\`

### Update an existing node:
\`\`\`
curl -s -X PUT '${apiBase}/api/blueprints/${blueprintId}/nodes/<nodeId>?${authParam}' \\
  -H 'Content-Type: application/json' \\
  -d '{"description": "Updated description with new acceptance criteria"}'
\`\`\`

### Mark an insight as read (after processing):
\`\`\`
curl -s -X POST '${apiBase}/api/blueprints/${blueprintId}/insights/<insightId>/mark-read?${authParam}'
\`\`\`

### Dismiss an irrelevant insight:
\`\`\`
curl -s -X POST '${apiBase}/api/blueprints/${blueprintId}/insights/<insightId>/dismiss?${authParam}'
\`\`\`

## Rules

- Process EVERY insight — either act on it or dismiss it
- Mark each insight as read or dismissed after processing
- When creating nodes, use a single batch-create call with all new nodes
- **Assign roles from insights**: Each insight has a \`role\` field (e.g., "qa", "sde", "sa"). When creating a new node from an insight, set the node's \`"roles"\` array to include the insight's role. If multiple insights with different roles lead to the same new node, combine them (e.g., \`"roles": ["sde", "qa"]\`)
- Only update pending or failed nodes — never touch done/running nodes
- Keep node titles and descriptions specific and actionable
- Do NOT output your analysis as text — only make API calls`;
}

/**
 * Coordinate a blueprint by analyzing unread insights and instructing the agent
 * to take corrective actions (create/update nodes, dismiss insights).
 */
export async function coordinateBlueprint(blueprintId: string): Promise<void> {
  // 1. Fetch unread insights
  const insights = getInsightsForBlueprint(blueprintId, { unreadOnly: true });

  // 2. Early return if nothing to coordinate
  if (insights.length === 0) {
    log.debug(`No unread insights for blueprint ${blueprintId.slice(0, 8)} — skipping coordination`);
    return;
  }

  // 3. Fetch full blueprint state
  const blueprint = getBlueprint(blueprintId);
  if (!blueprint) {
    log.error(`Blueprint ${blueprintId} not found for coordination`);
    return;
  }

  log.info(`Coordinating blueprint ${blueprintId.slice(0, 8)} "${blueprint.title}" with ${insights.length} unread insight(s)`);

  // 4. Build coordinator prompt
  const prompt = buildCoordinatorPrompt(blueprintId, insights, blueprint);

  // 5. Run agent in interactive mode
  try {
    await runAgentInteractive(prompt, blueprint.projectCwd || undefined);
  } catch (err) {
    log.error(`Coordinator agent call failed for blueprint ${blueprintId.slice(0, 8)}: ${err instanceof Error ? err.message : err}`);
  }

  // 6. Safety fallback: mark all insights read
  markAllInsightsRead(blueprintId);
  log.debug(`Fallback: marked all insights read for blueprint ${blueprintId.slice(0, 8)}`);
}
