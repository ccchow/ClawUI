import { execFile } from "node:child_process";
import { writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getBlueprint, getArtifactsForNode } from "./plan-db.js";
import { CLAUDE_PATH, PORT } from "./config.js";
import { LOCAL_AUTH_TOKEN } from "./auth.js";
import { createLogger } from "./logger.js";

const log = createLogger("plan-generator");

const INTERACTIVE_TIMEOUT = 10 * 60 * 1000; // 10 min

/**
 * Run Claude in text output mode (no tool use). Used for simple tasks that
 * only need text output (e.g., enrich-node, artifact generation).
 */
export function runClaude(prompt: string, cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Claude Code requires TTY even in -p mode, so we must use expect.
    // log_user 0 suppresses TTY echo; we capture output via a temp output file.
    const promptFile = join(tmpdir(), `clawui-gen-${randomUUID()}.txt`);
    const outputFile = join(tmpdir(), `clawui-gen-${randomUUID()}.out`);
    const expectFile = join(tmpdir(), `clawui-gen-${randomUUID()}.exp`);
    writeFileSync(promptFile, prompt, "utf-8");

    const expectScript = `
log_user 0
set timeout 180
set stty_init "columns 2000"
match_max 1000000

set fp [open "${promptFile}" r]
set prompt_text [read -nonewline $fp]
close $fp

set of [open "${outputFile}" w]
set output ""

spawn ${CLAUDE_PATH} --dangerously-skip-permissions --output-format text --max-turns 200 -p $prompt_text
expect {
  -re ".+" {
    append output $expect_out(0,string)
    exp_continue
  }
  eof {}
  timeout {
    puts -nonewline $of $output
    close $of
    exit 1
  }
}
puts -nonewline $of $output
close $of
`;
    writeFileSync(expectFile, expectScript, "utf-8");

    execFile("/usr/bin/expect", [expectFile], {
      timeout: 200_000,
      maxBuffer: 10 * 1024 * 1024,
      cwd: cwd || process.cwd(),
      env: { ...process.env },
    }, (error) => {
      // Read output from file (avoids TTY echo contamination)
      let output = "";
      try {
        output = readFileSync(outputFile, "utf-8").trim();
      } catch { /* no output file */ }

      // Cleanup
      try { unlinkSync(promptFile); } catch { /* */ }
      try { unlinkSync(outputFile); } catch { /* */ }
      try { unlinkSync(expectFile); } catch { /* */ }

      // Strip ANSI escapes
      output = output
        .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "")
        .replace(/\x1B\][^\x07]*\x07/g, "")
        .replace(/\r/g, "")
        .trim();

      if (output.length === 0) {
        reject(new Error(`Claude returned empty output. expect error: ${error?.message?.slice(0, 300) ?? "none"}`));
        return;
      }
      log.debug(`Claude output length: ${output.length}, first 200 chars: ${output.slice(0, 200).replace(/\n/g, "\\n")}`);
      resolve(output);
    });
  });
}

/**
 * Run Claude in interactive mode (full tool use). Used for tasks where
 * Claude directly calls ClawUI API endpoints.
 */
export function runClaudeInteractiveGen(prompt: string, cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const tmpFile = join(tmpdir(), `clawui-gen-prompt-${randomUUID()}.txt`);
    writeFileSync(tmpFile, prompt, "utf-8");

    const fullScript = `
set timeout 600
set stty_init "columns 2000"
set fp [open "${tmpFile}" r]
set prompt [read -nonewline $fp]
close $fp
file delete "${tmpFile}"
spawn ${CLAUDE_PATH} --dangerously-skip-permissions --max-turns 200 -p $prompt
expect eof
catch {wait}
`;

    const tmpExpect = join(tmpdir(), `clawui-gen-expect-${randomUUID()}.exp`);
    writeFileSync(tmpExpect, fullScript, "utf-8");

    execFile(
      "/usr/bin/expect",
      [tmpExpect],
      {
        timeout: INTERACTIVE_TIMEOUT,
        maxBuffer: 10 * 1024 * 1024,
        cwd: cwd || process.cwd(),
        env: { ...process.env },
      },
      (error, stdout) => {
        try { unlinkSync(tmpExpect); } catch { /* ignore */ }
        try { unlinkSync(tmpFile); } catch { /* ignore */ }

        if (error) {
          reject(new Error(`Claude interactive (generator) failed: ${error.message}`));
          return;
        }
        resolve(stdout || "");
      },
    );
  });
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
        ? `Handoff: ${latestArtifact.content.slice(0, 300)}`
        : (n.description || "").slice(0, 200);
      return `  [id: ${n.id}] [${n.status}] ${n.title} — ${summary}`;
    });
    nodesContext += `\n\nCompleted nodes (DO NOT touch these — use their IDs as dependencies for new nodes when relevant):\n${doneLines.join("\n")}`;
  }
  if (runningNodes.length > 0) {
    nodesContext += `\n\nCurrently running (DO NOT touch):\n${runningNodes.map(n => `  [id: ${n.id}] [running] ${n.title}`).join("\n")}`;
  }
  if (pendingNodes.length > 0) {
    nodesContext += `\n\nPending nodes (DO NOT modify or remove — only add new nodes that complement these):\n${pendingNodes.map(n => `  [id: ${n.id}] [${n.status}] ${n.title} — ${n.description || ""}`).join("\n")}`;
  }

  const apiBase = getApiBase();
  const authParam = getAuthParam();

  const prompt = `You are a senior software architect reviewing and planning a development task.

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
- "description": detailed description string (be specific about files, functions, endpoints)
- "dependencies": array supporting two formats:
  - String node ID (e.g. "abc-123") to depend on an existing completed/pending node
  - Integer index (e.g. 0, 1) to depend on another new node in this same batch (0-based)

Example (creates 2 nodes where the second depends on the first):
curl -s -X POST '${apiBase}/api/blueprints/${blueprintId}/nodes/batch-create?${authParam}' -H 'Content-Type: application/json' -d '[{"title":"Backend API","description":"Create REST endpoints...","dependencies":[]},{"title":"Frontend UI","description":"Build React components...","dependencies":[0]}]'

Rules:
- Create 0-6 NEW steps. Each completable in one Claude Code session (5-15 min).
- When establishing dependencies, prefer depending on existing done nodes whose work is directly relevant (leaf nodes with no existing successors are ideal candidates). Within new nodes, create sequential dependencies for modular work: e.g., backend → frontend → integration test.
- Each generated node should be self-contained and reusable. Split by architectural layer when appropriate — e.g., a feature module becomes: (1) backend API node, (2) frontend UI node, (3) E2E integration node — with sequential dependencies. Optimize for: single-session completability, clear handoff boundaries, and maximum reuse as dependency targets.
- Never touch any existing nodes (completed, running, or pending). Only add new nodes.
- Be specific: mention file paths, function names, API endpoints.
- If no new work is needed, do not call the API.
- Make ONE batch-create call with ALL new nodes.`;

  await runClaudeInteractiveGen(prompt, blueprint.projectCwd || undefined);
}
