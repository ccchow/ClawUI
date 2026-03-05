import {
  getBlueprint,
  getConveneSession,
  getConveneMessages,
  createConveneMessage,
  updateConveneSessionStatus,
} from "./plan-db.js";
import type { ConveneSession, BatchCreateNode } from "./plan-db.js";
import { runAgentInteractive, getApiBase, getAuthParam } from "./plan-generator.js";
import { getRole } from "./roles/role-registry.js";
import { stripAnsi } from "./cli-utils.js";
import { createLogger } from "./logger.js";

// Side-effect imports: ensure all runtimes are registered before runAgentInteractive()
import "./agent-claude.js";
import "./agent-pimono.js";
import "./agent-openclaw.js";
import "./agent-codex.js";

// Side-effect: auto-discovers and registers all roles before getRole()
import "./roles/load-all-roles.js";

const log = createLogger("plan-convene");

/**
 * Build the prompt for a contributing role in a convene round.
 * Uses curl-based panel reading and contribution posting instead of injecting prior messages.
 */
function buildContributionPrompt(
  session: ConveneSession,
  roleId: string,
  round: number,
  blueprintTitle: string,
  blueprintDescription: string,
  contextNodeSummaries: string[],
  panelUrl: string,
  contributeUrl: string,
): string {
  const role = getRole(roleId);
  const persona = role?.prompts?.persona ?? `You are a ${roleId} role.`;

  let prompt = `${persona}

You are participating in a structured multi-role discussion (round ${round} of ${session.maxRounds}).

## Blueprint
Title: ${blueprintTitle}
${blueprintDescription ? `Description: ${blueprintDescription}` : ""}

## Discussion Topic
${session.topic}
`;

  if (contextNodeSummaries.length > 0) {
    prompt += `
## Context Nodes
${contextNodeSummaries.join("\n")}
`;
  }

  prompt += `
## Instructions

1. First, read the current discussion panel to see what other roles have said:

curl -s '${panelUrl}'

2. Think about the topic from your perspective as ${role?.label ?? roleId}.
${round > 1 ? "Do NOT repeat points already made. Only add new insights, refine disagreements, or respond to questions." : "Be specific and actionable."}

3. When you have formed your conclusion, post it by running:

curl -s -X POST '${contributeUrl}' \\
  -H 'Content-Type: application/json' \\
  -d '{"roleId": "${roleId}", "round": ${round}, "content": "<your conclusion in markdown — escape quotes properly>"}'

IMPORTANT: Your conclusion MUST be posted via the curl command above. This is how your contribution is recorded in the discussion panel.`;

  return prompt;
}

/**
 * Build the synthesis prompt. Instructs agent to read the panel via curl instead of
 * injecting message text, eliminating deduplication logic.
 */
function buildSynthesisPrompt(
  session: ConveneSession,
  blueprintTitle: string,
  panelUrl: string,
  proposeNodesUrl: string,
): string {
  return `You are synthesizing a multi-role discussion into action items.

## Blueprint: ${blueprintTitle}

## Discussion Topic
${session.topic}

## Instructions

1. First, read the full discussion panel:

curl -s '${panelUrl}'

2. Read all contributions. Produce a JSON array of concrete tasks that should be added to the blueprint.
Each task object must have:
- "title": string (concise task title)
- "description": string (detailed description in markdown)
- "roles": string[] (optional, role IDs like "sde", "qa", "pm", "uxd")
- "dependencies": number[] (optional, 0-indexed references within this array)

3. When you have your list, POST it:

curl -s -X POST '${proposeNodesUrl}' \\
  -H 'Content-Type: application/json' \\
  -d '{"nodes": <your JSON array>}'

IMPORTANT: Your proposed nodes MUST be posted via the curl command above.`;
}

/**
 * Extract a JSON array from agent output using depth-counting brace extraction.
 * Handles CLI echo by searching last-to-first for the outermost [...] block.
 */
function extractJsonArray(rawOutput: string): BatchCreateNode[] | null {
  // Strip ANSI escape sequences — CLI output contains terminal control codes
  // whose `[` characters corrupt the depth-counting brace extraction.
  const output = stripAnsi(rawOutput);

  // Search from end of output for the last complete JSON array
  let depth = 0;
  let endIdx = -1;
  let startIdx = -1;

  for (let i = output.length - 1; i >= 0; i--) {
    const ch = output[i];
    if (ch === "]") {
      if (depth === 0) endIdx = i;
      depth++;
    } else if (ch === "[") {
      depth--;
      if (depth === 0) {
        startIdx = i;
        break;
      }
    }
  }

  if (startIdx === -1 || endIdx === -1) return null;

  try {
    const jsonStr = output.slice(startIdx, endIdx + 1);
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) return null;
    return parsed as BatchCreateNode[];
  } catch {
    return null;
  }
}

/**
 * Execute a convene session: round-robin role contributions + synthesis.
 * Called within the blueprint's serial queue via enqueueBlueprintTask().
 *
 * Uses the panel pattern: each role reads GET /panel and posts via POST /contribute.
 * If the agent fails to POST, falls back to storing stdout as the contribution.
 */
export async function executeConveneSession(sessionId: string): Promise<void> {
  const session = getConveneSession(sessionId);
  if (!session || session.status !== "active") {
    log.warn(`Convene session ${sessionId} not found or not active`);
    return;
  }

  const blueprint = getBlueprint(session.blueprintId);
  if (!blueprint) {
    log.error(`Blueprint ${session.blueprintId} not found for convene session ${sessionId}`);
    updateConveneSessionStatus(sessionId, "cancelled");
    return;
  }

  // Build panel + contribute URLs
  const apiBase = getApiBase();
  const authParam = getAuthParam();
  const panelUrl = `${apiBase}/api/blueprints/${blueprint.id}/convene-sessions/${sessionId}/panel?${authParam}`;
  const contributeUrl = `${apiBase}/api/blueprints/${blueprint.id}/convene-sessions/${sessionId}/contribute?${authParam}`;

  // Build context node summaries
  const contextNodeSummaries: string[] = [];
  if (session.contextNodeIds && session.contextNodeIds.length > 0) {
    for (const nodeId of session.contextNodeIds) {
      const node = blueprint.nodes.find((n) => n.id === nodeId);
      if (node) {
        contextNodeSummaries.push(`- **#${node.seq} ${node.title}**: ${node.description.slice(0, 200)}${node.description.length > 200 ? "..." : ""}`);
      }
    }
  }

  log.info(`Starting convene session ${sessionId.slice(0, 8)} — topic: "${session.topic.slice(0, 60)}", roles: [${session.participatingRoles.join(", ")}], rounds: ${session.maxRounds}`);

  // Round-robin execution with convergence detection
  for (let round = 1; round <= session.maxRounds; round++) {
    // Re-check session status (could be cancelled mid-execution)
    const currentSession = getConveneSession(sessionId);
    if (!currentSession || currentSession.status === "cancelled") {
      log.info(`Convene session ${sessionId.slice(0, 8)} was cancelled during round ${round}`);
      return;
    }

    let roundHasNewContent = false;

    for (const roleId of session.participatingRoles) {
      // Re-check cancellation before each role
      const checkSession = getConveneSession(sessionId);
      if (!checkSession || checkSession.status === "cancelled") {
        log.info(`Convene session ${sessionId.slice(0, 8)} was cancelled during round ${round}, role ${roleId}`);
        return;
      }

      // Count messages before this role's turn
      const beforeCount = getConveneMessages(sessionId).length;

      const prompt = buildContributionPrompt(
        session,
        roleId,
        round,
        blueprint.title,
        blueprint.description,
        contextNodeSummaries,
        panelUrl,
        contributeUrl,
      );

      log.debug(`Convene ${sessionId.slice(0, 8)} — round ${round}, role ${roleId}: sending prompt`);

      let stdout: string;
      try {
        const { parseAgentParams: parseParams } = await import("./plan-executor.js");
        stdout = await runAgentInteractive(prompt, blueprint.projectCwd || undefined, parseParams(blueprint.agentParams));
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error(`Convene ${sessionId.slice(0, 8)} — agent error for role ${roleId} round ${round}: ${errMsg}`);
        // Fallback: store error as contribution
        createConveneMessage(sessionId, roleId, round, `[Agent error: ${errMsg}]`);
        continue;
      }

      // Verify contribution was posted via the endpoint
      const afterMessages = getConveneMessages(sessionId);
      const contributed = afterMessages.length > beforeCount;

      if (!contributed) {
        // Agent didn't POST — fall back to using stdout
        log.warn(`Convene ${sessionId.slice(0, 8)} — role ${roleId} did not POST contribution, using stdout fallback`);
        createConveneMessage(sessionId, roleId, round, stdout);
      }

      // Convergence detection on the actual stored message
      const latestMsg = getConveneMessages(sessionId).filter(
        (m) => m.roleId === roleId && m.round === round,
      );
      if (latestMsg.length > 0 && latestMsg[0].content.length >= 100) {
        roundHasNewContent = true;
      }
    }

    // Early exit if all roles in this round produced only brief agreement responses
    if (round > 1 && !roundHasNewContent) {
      log.info(`Convene ${sessionId.slice(0, 8)} — convergence detected at round ${round}, all responses brief`);
      break;
    }
  }

  // Synthesis turn
  await synthesizeConveneResults(sessionId);
}

/**
 * Run the synthesis turn: agent reads the panel via curl and produces JSON nodes.
 */
async function synthesizeConveneResults(sessionId: string): Promise<void> {
  const session = getConveneSession(sessionId);
  if (!session) return;

  // Check for cancellation
  if (session.status === "cancelled") return;

  updateConveneSessionStatus(sessionId, "synthesizing");

  const blueprint = getBlueprint(session.blueprintId);
  if (!blueprint) {
    log.error(`Blueprint ${session.blueprintId} not found during synthesis`);
    updateConveneSessionStatus(sessionId, "failed");
    return;
  }

  const apiBase = getApiBase();
  const authParam = getAuthParam();
  const panelUrl = `${apiBase}/api/blueprints/${blueprint.id}/convene-sessions/${sessionId}/panel?${authParam}`;
  const proposeNodesUrl = `${apiBase}/api/blueprints/${blueprint.id}/convene-sessions/${sessionId}/propose-nodes?${authParam}`;

  const prompt = buildSynthesisPrompt(session, blueprint.title, panelUrl, proposeNodesUrl);

  log.info(`Convene ${sessionId.slice(0, 8)} — starting synthesis`);

  let output: string;
  try {
    const { parseAgentParams: parseSynthParams } = await import("./plan-executor.js");
    output = await runAgentInteractive(prompt, blueprint.projectCwd || undefined, parseSynthParams(blueprint.agentParams));
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error(`Convene ${sessionId.slice(0, 8)} — synthesis agent error: ${errMsg}`);
    createConveneMessage(sessionId, "system", session.maxRounds + 1, `[Agent error: ${errMsg}]`, "synthesis");
    updateConveneSessionStatus(sessionId, "failed");
    return;
  }

  // Store the raw synthesis output as a message
  createConveneMessage(sessionId, "system", session.maxRounds + 1, output, "synthesis");

  // Check if synthesis_result was populated via the POST endpoint
  const updated = getConveneSession(sessionId);
  if (updated?.synthesisResult && updated.synthesisResult.length > 0) {
    log.info(`Convene ${sessionId.slice(0, 8)} — synthesis complete via POST, ${updated.synthesisResult.length} nodes`);
  } else {
    // Stdout fallback: try extracting JSON from agent output
    const parsed = extractJsonArray(output);
    if (parsed && parsed.length > 0) {
      updateConveneSessionStatus(sessionId, "synthesizing", parsed);
      log.info(`Convene ${sessionId.slice(0, 8)} — synthesis complete via stdout fallback, ${parsed.length} nodes`);
    } else {
      updateConveneSessionStatus(sessionId, "failed");
      log.warn(`Convene ${sessionId.slice(0, 8)} — synthesis failed: no nodes via POST or stdout`);
    }
  }
}
