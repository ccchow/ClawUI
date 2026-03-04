import { getBlueprint, getArtifactsForNode } from "./plan-db.js";
import { PORT } from "./config.js";
import { LOCAL_AUTH_TOKEN } from "./auth.js";
import { getActiveRuntime } from "./agent-runtime.js";
import { getRole } from "./roles/role-registry.js";
import type { RoleDefinition } from "./roles/role-registry.js";

// Side-effect imports: ensure all runtimes are registered before getActiveRuntime()
import "./agent-claude.js";
import "./agent-pimono.js";
import "./agent-openclaw.js";
import "./agent-codex.js";

// Side-effect: auto-discovers and registers all roles before getRole()
import "./roles/load-all-roles.js";

/**
 * Run the active agent in text output mode (no tool use). Used for simple tasks
 * that only need text output (e.g., enrich-node, artifact generation).
 *
 * Routes through AgentRuntime so the configured AGENT_TYPE is respected.
 */
export function runAgentText(prompt: string, cwd?: string): Promise<string> {
  return getActiveRuntime().runSession(prompt, cwd);
}

/**
 * Run the active agent in interactive mode (full tool use). Used for tasks where
 * the agent directly calls ClawUI API endpoints.
 *
 * Routes through AgentRuntime so the configured AGENT_TYPE is respected.
 */
export function runAgentInteractive(prompt: string, cwd?: string): Promise<string> {
  return getActiveRuntime().runSessionInteractive(prompt, cwd);
}

/**
 * Build the API base URL with auth token for Claude to call ClawUI endpoints.
 */
export function getApiBase(): string {
  return `http://localhost:${PORT}`;
}

/**
 * Get the auth query param string for API calls.
 */
export function getAuthParam(): string {
  return `auth=${LOCAL_AUTH_TOKEN}`;
}

/**
 * Generate plan nodes by having Claude Code directly call ClawUI's batch-create endpoint.
 * Claude runs in interactive mode with full tool access (bash, curl, etc.).
 * Returns void — nodes are created via API calls, not parsed from output.
 */
export async function generatePlan(blueprintId: string, userInstruction?: string): Promise<void> {
  const blueprint = getBlueprint(blueprintId);
  if (!blueprint) throw new Error("Blueprint not found");

  const desc = blueprint.description;
  if (!desc && !userInstruction) throw new Error("No task description provided");

  // Categorize existing nodes
  const doneNodes = blueprint.nodes.filter(n => n.status === "done" || n.status === "skipped");
  const pendingNodes = blueprint.nodes.filter(n => n.status === "pending" || n.status === "failed");
  const runningNodes = blueprint.nodes.filter(n => n.status === "running");

  // Build node context with handoff summaries for done nodes
  let nodesContext = "";
  if (doneNodes.length > 0) {
    const doneLines = doneNodes.map(n => {
      const outputArtifacts = getArtifactsForNode(n.id, "output");
      const latestArtifact = outputArtifacts.length > 0 ? outputArtifacts[outputArtifacts.length - 1] : null;
      const summary = latestArtifact
        ? ` — Handoff: ${latestArtifact.content.slice(0, 300)}`
        : "";
      return `  [id: ${n.id}] [${n.status}] ${n.title}${summary}`;
    });
    nodesContext += `\n\nCompleted nodes (DO NOT touch these — use their IDs as dependencies for new nodes when relevant):\n${doneLines.join("\n")}`;
  }
  if (runningNodes.length > 0) {
    nodesContext += `\n\nCurrently running (DO NOT touch):\n${runningNodes.map(n => `  [id: ${n.id}] [running] ${n.title}`).join("\n")}`;
  }
  if (pendingNodes.length > 0) {
    nodesContext += `\n\nPending nodes (DO NOT modify or remove — only add new nodes that complement these):\n${pendingNodes.map(n => `  [id: ${n.id}] [${n.status}] ${n.title}`).join("\n")}`;
  }

  const apiBase = getApiBase();
  const authParam = getAuthParam();

  // Resolve enabled roles for role-aware generation
  const enabledRoleIds = blueprint.enabledRoles ?? ["sde"];
  const enabledRoles: RoleDefinition[] = enabledRoleIds
    .map((id) => getRole(id))
    .filter((r): r is RoleDefinition => r !== undefined);

  // Fallback to SDE if none resolved
  if (enabledRoles.length === 0) {
    const sde = getRole("sde");
    if (sde) enabledRoles.push(sde);
  }

  // Build role-aware persona
  const roleLabels = enabledRoles.map((r) => r.label).join(", ");
  const persona = enabledRoles.length > 1
    ? `You are an expert planner coordinating work across: ${roleLabels}.`
    : `You are a senior software architect reviewing and planning a development task.`;

  // Merge decomposition heuristics from all enabled roles
  const decompositionHeuristics = enabledRoles.length === 1
    ? enabledRoles[0].prompts.decompositionHeuristic
    : enabledRoles.map((r) => `### ${r.label}\n${r.prompts.decompositionHeuristic}`).join("\n\n");

  // Merge specificity guidance from all enabled roles
  const specificityGuidance = enabledRoles.length === 1
    ? enabledRoles[0].prompts.specificityGuidance
    : enabledRoles.map((r) => r.prompts.specificityGuidance).join(" ");

  // Collect decomposition examples from each role
  const decompositionExamples = enabledRoles
    .map((r) => r.prompts.decompositionExample
      .replace(/<apiBase>/g, apiBase)
      .replace(/<blueprintId>/g, blueprintId)
      .replace(/<authParam>/g, authParam))
    .join("\n\n");

  // When multiple roles are enabled, instruct agent to tag nodes with roles
  const rolesInstruction = enabledRoles.length > 1
    ? `\n- Tag each node with the appropriate role(s) using "roles": ["roleId"] in the JSON. Available roles: ${enabledRoles.map((r) => `"${r.id}" (${r.label})`).join(", ")}. If a node involves multiple roles, include all relevant IDs.`
    : "";

  const prompt = `${persona}

Task: ${desc || "(see user instruction below)"}
Blueprint ID: ${blueprintId}
Blueprint Title: ${blueprint.title}
Working directory: ${blueprint.projectCwd || "not specified"}
${nodesContext}${userInstruction ? `\n\n--- USER INSTRUCTION ---\n${userInstruction}\n--- END INSTRUCTION ---\nPrioritize the user's instruction above. It may ask to add specific features, change direction, or focus on a particular area.` : ""}

Your job: PLAN the next concrete steps that still need to be done. Only ADD new nodes — never modify or remove existing ones.

IMPORTANT: Do NOT output JSON. Instead, directly create nodes by calling the ClawUI batch-create API endpoint using curl.

Batch create endpoint: POST ${apiBase}/api/blueprints/${blueprintId}/nodes/batch-create?${authParam}
Content-Type: application/json

The body is a JSON ARRAY of node objects. Each element has:
- "title": (REQUIRED) node title string
- "description": detailed description string (${specificityGuidance})
- "dependencies": array supporting two formats:
  - String node ID (e.g. "abc-123") to depend on an existing completed/pending node
  - Integer index (e.g. 0, 1) to depend on another new node in this same batch (0-based)${enabledRoles.length > 1 ? `\n- "roles": (optional) array of role IDs for this node. Available: ${enabledRoles.map((r) => `"${r.id}"`).join(", ")}` : ""}

${decompositionExamples}

Rules:
${decompositionHeuristics}
- Never touch any existing nodes (completed, running, or pending). Only add new nodes.
- ${specificityGuidance}
- If no new work is needed, do not call the API.
- Make ONE batch-create call with ALL new nodes.${rolesInstruction}

## CRITICAL — DO NOT REPEAT
- Make exactly ONE batch-create curl call containing ALL new nodes. Do NOT make a second call.
- After the curl call succeeds, your task is COMPLETE. Do not verify, retry, or repeat the call.
- Do not output the nodes as JSON or text — only use the curl call.`;

  await runAgentInteractive(prompt, blueprint.projectCwd || undefined);
}
