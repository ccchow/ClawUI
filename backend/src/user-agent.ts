import { getBlueprint, getUnacknowledgedMessages, acknowledgeMessage, createAutopilotMessage } from "./plan-db.js";
import type { AutopilotMessage } from "./plan-db.js";
import { enqueueBlueprintTask, addPendingTask, removePendingTask } from "./plan-executor.js";
import { getActiveRuntime } from "./agent-runtime.js";
import { getApiBase, getAuthParam } from "./plan-generator.js";
import { createLogger } from "./logger.js";

// Side-effect imports: ensure all runtimes are registered
import "./agent-claude.js";
import "./agent-pimono.js";
import "./agent-openclaw.js";
import "./agent-codex.js";

const log = createLogger("user-agent");

export function buildUserAgentPrompt(
  blueprintId: string,
  messages: AutopilotMessage[],
): string {
  const blueprint = getBlueprint(blueprintId);
  if (!blueprint) throw new Error(`Blueprint ${blueprintId} not found`);

  const baseUrl = getApiBase();
  const authParam = getAuthParam();
  const messageList = messages.map((m) => `- ${m.content}`).join("\n");

  // Build lightweight node summary
  const nodeSummary = blueprint.nodes.map((n) =>
    `  - [${n.seq}] ${n.title} (${n.status})${n.dependencies.length ? ` deps: ${n.dependencies.join(", ")}` : ""}`
  ).join("\n");

  return `You are a User Agent for ClawUI, a blueprint-based task management system. You act as an expert user, translating the user's natural language requests into ClawUI operations.

You are equivalent to a human user on the ClawUI web interface. You operate by calling the ClawUI REST API.

## Current Blueprint
- ID: ${blueprintId}
- Title: ${blueprint.title}
- Description: ${blueprint.description}
- Status: ${blueprint.status}
- Execution Mode: ${blueprint.executionMode}

## Current Nodes
${nodeSummary || "  (no nodes yet)"}

## User Messages
${messageList}

## API Access
Base URL: ${baseUrl}
Auth: append \`?${authParam}\` to all API calls.
Content-Type: application/json

Example:
\`\`\`bash
curl -s -X POST '${baseUrl}/api/blueprints/${blueprintId}/nodes?${authParam}' \\
  -H 'Content-Type: application/json' \\
  -d '{"title": "Example Node", "description": "..."}'
\`\`\`

## Available API Endpoints

### Node Operations
- POST /api/blueprints/${blueprintId}/nodes — Create node: \`{"title", "description", "dependencies?": ["nodeId"], "roles?": ["roleId"]}\`
- POST /api/blueprints/${blueprintId}/nodes/batch-create — Batch create nodes: \`[{"title", "description", ...}]\`
- PUT /api/blueprints/${blueprintId}/nodes/{nodeId} — Update node: \`{"title?", "description?", "status?", "dependencies?"}\`
- DELETE /api/blueprints/${blueprintId}/nodes/{nodeId} — Delete node
- POST /api/blueprints/${blueprintId}/nodes/reorder — Reorder: \`[{"id", "order"}]\`

### AI Operations
- POST /api/blueprints/${blueprintId}/enrich-node — Smart create/enrich: \`{"title", "description?", "nodeId?"}\`
- POST /api/blueprints/${blueprintId}/nodes/{nodeId}/split — Split node into sub-nodes
- POST /api/blueprints/${blueprintId}/nodes/{nodeId}/smart-dependencies — Auto-detect deps
- POST /api/blueprints/${blueprintId}/reevaluate-all — Re-evaluate all non-done nodes

### Execution Control
- POST /api/blueprints/${blueprintId}/nodes/{nodeId}/run — Queue node for execution
- POST /api/blueprints/${blueprintId}/run-all — Start autopilot / run all nodes
- PUT /api/blueprints/${blueprintId} — Update blueprint: \`{"executionMode?", "status?", "title?", "description?"}\`

### Read State
- GET /api/blueprints/${blueprintId} — Full blueprint with nodes
- GET /api/blueprints/${blueprintId}/nodes/summary — Lightweight node overview
- GET /api/blueprints/${blueprintId}/nodes/{nodeId}/context — Node context with deps/handoff
- GET /api/blueprints/${blueprintId}/progress — Node status counts
- GET /api/blueprints/${blueprintId}/queue — Queue status

## Instructions
1. Understand what the user wants from their message(s).
2. For **codebase Q&A** (questions about the project, code, architecture): read files and search the codebase directly to answer. No API calls needed.
3. For **blueprint Q&A** (questions about node status, progress, errors): use the Read State API endpoints to get details.
4. For **simple tasks** (git commit, run tests, quick file edits): execute directly using bash.
5. For **complex tasks** (new features, refactors, multi-step work): decompose into nodes using the Node Operations API. Create nodes with appropriate dependencies.
6. For **AI operations** the user requests (split, enrich, smart-deps): call the corresponding AI endpoint.
7. Check existing nodes before creating new ones to avoid duplicates.
8. Do NOT call POST /messages — your text output is automatically delivered to the user as a reply.

## Response
Write a concise summary of what you did. This text will be shown to the user.`;
}

export async function handleUserMessage(blueprintId: string): Promise<void> {
  const messages = getUnacknowledgedMessages(blueprintId);
  if (messages.length === 0) return;

  const blueprint = getBlueprint(blueprintId);
  if (!blueprint) {
    log.error(`User agent: blueprint ${blueprintId} not found`);
    return;
  }

  addPendingTask(blueprintId, { type: "autopilot", queuedAt: new Date().toISOString() });

  try {
    const prompt = buildUserAgentPrompt(blueprintId, messages);
    const runtime = getActiveRuntime();
    const output = await runtime.runSession(prompt, blueprint.projectCwd);
    log.info(`User agent session completed (${output.length} chars)`);

    // Send session output as assistant reply to the user
    if (output.trim()) {
      createAutopilotMessage(blueprintId, "assistant", output.slice(0, 5000));
    }

    for (const msg of messages) {
      acknowledgeMessage(msg.id);
    }
  } catch (err) {
    log.error(`User agent failed: ${err instanceof Error ? err.message : err}`);
    createAutopilotMessage(blueprintId, "assistant",
      "Failed to process your message. Please try again or switch to manual mode.");
  } finally {
    removePendingTask(blueprintId, undefined, "autopilot");
  }

  // Dynamic import to avoid circular dependency
  const { triggerFsdLoopIfNeeded } = await import("./autopilot.js");
  triggerFsdLoopIfNeeded(blueprintId);
}

export function triggerUserAgent(blueprintId: string): void {
  const bp = getBlueprint(blueprintId);
  if (!bp) return;
  const isAutopilot = bp.executionMode === "autopilot" || bp.executionMode === "fsd";
  if (!isAutopilot) return;

  enqueueBlueprintTask(blueprintId, () => handleUserMessage(blueprintId)).catch((err) => {
    log.error(`User agent trigger failed: ${err instanceof Error ? err.message : err}`);
  });
}
