import { execFile } from "node:child_process";
import { writeFileSync, unlinkSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import {
  getBlueprint,
  updateBlueprint,
  updateMacroNode,
  createExecution,
  updateExecution,
  createArtifact,
  getArtifactsForNode,
} from "./plan-db.js";
import { syncSession } from "./db.js";
import type { Blueprint, MacroNode, NodeExecution, Artifact } from "./plan-db.js";

const EXEC_TIMEOUT = 300_000; // 5 minutes per node
const CLAUDE_PATH = process.env.CLAUDE_PATH || "/Users/leizhou/.local/bin/claude";
const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

// ─── Session detection ─────────────────────────────────────

/**
 * Find the newest JSONL session file created after `beforeTimestamp`
 * in the Claude projects directory matching `projectCwd`.
 * Returns the session ID (filename minus .jsonl) or null.
 */
export function detectNewSession(
  projectCwd: string,
  beforeTimestamp: Date,
): string | null {
  // Claude encodes CWD as path with / replaced by -
  // e.g. /Users/leizhou/Git/ClawUI → -Users-leizhou-Git-ClawUI
  const encodedDir = projectCwd.replace(/\//g, "-");
  const projDir = join(CLAUDE_PROJECTS_DIR, encodedDir);

  if (!existsSync(projDir)) return null;

  let newestId: string | null = null;
  let newestMtime = beforeTimestamp.getTime();

  for (const file of readdirSync(projDir)) {
    if (!file.endsWith(".jsonl")) continue;
    const filePath = join(projDir, file);
    const stat = statSync(filePath);
    if (stat.mtime.getTime() > newestMtime) {
      newestMtime = stat.mtime.getTime();
      newestId = basename(file, ".jsonl");
    }
  }

  return newestId;
}

// ─── Low-level Claude runner (no --resume) ─────────────────

function runClaude(prompt: string, cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const tmpFile = join(tmpdir(), `clawui-plan-prompt-${randomUUID()}.txt`);
    writeFileSync(tmpFile, prompt, "utf-8");

    // Read prompt via Tcl file read, pass to claude via sh -c with single quotes
    // Single quotes in prompt are escaped as: '\''
    const expectScript = `
set timeout 300
set stty_init "columns 2000"
set fp [open "${tmpFile}" r]
set prompt [read -nonewline $fp]
close $fp
file delete "${tmpFile}"
# Escape single quotes for shell: replace ' with '\''
regsub -all {(')} $prompt {'\\'\\''} escaped_prompt
spawn /bin/sh -c "exec ${CLAUDE_PATH} --dangerously-skip-permissions -p '$escaped_prompt'"
expect eof
`;

    const tmpExpect = join(tmpdir(), `clawui-plan-expect-${randomUUID()}.exp`);
    writeFileSync(tmpExpect, expectScript, "utf-8");

    execFile(
      "/usr/bin/expect",
      [tmpExpect],
      {
        timeout: EXEC_TIMEOUT,
        maxBuffer: 10 * 1024 * 1024,
        cwd: cwd || process.cwd(),
        env: { ...process.env },
      },
      (error, stdout, _stderr) => {
        try { unlinkSync(tmpExpect); } catch { /* ignore */ }
        try { unlinkSync(tmpFile); } catch { /* ignore */ }

        const lines = stdout.split("\n");
        const spawnIdx = lines.findIndex((l) => l.includes("spawn") && l.includes("claude"));
        const cleanLines = spawnIdx >= 0 ? lines.slice(spawnIdx + 1) : lines;
        const clean = cleanLines
          .join("\n")
          .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "")
          .replace(/\x1B\][^\x07]*\x07/g, "")
          .replace(/\r/g, "")
          .trim();

        if (clean.length > 0) {
          resolve(clean);
          return;
        }
        if (error) {
          reject(new Error(`Claude CLI error: ${error.message}`));
          return;
        }
        resolve(clean);
      },
    );
  });
}

// ─── Prompt builders ────────────────────────────────────────

function buildNodePrompt(
  blueprint: Blueprint,
  node: MacroNode,
  inputArtifacts: { node: MacroNode; artifact: Artifact }[],
): string {
  const total = blueprint.nodes.length;
  let prompt = `You are executing step ${node.order + 1}/${total} of a development plan: "${blueprint.title}"\n\n`;

  if (blueprint.description) {
    prompt += `## Plan Description\n${blueprint.description}\n\n`;
  }

  if (inputArtifacts.length > 0) {
    prompt += `## Context from previous steps:\n`;
    for (const { node: depNode, artifact } of inputArtifacts) {
      prompt += `### Step ${depNode.order + 1}: ${depNode.title}\n${artifact.content}\n\n`;
    }
  }

  prompt += `## Your Task (Step ${node.order + 1}): ${node.title}\n`;
  if (node.description) {
    prompt += `${node.description}\n\n`;
  }
  if (node.prompt) {
    prompt += `${node.prompt}\n\n`;
  }

  if (blueprint.projectCwd) {
    prompt += `## Working Directory: ${blueprint.projectCwd}\n\n`;
  }

  prompt += `## Instructions
- Complete this step thoroughly. Focus only on THIS step.
- DO NOT ask for confirmation or clarification. Just write the code directly.
- If you encounter a blocker you cannot resolve, output a section at the end:
  ---BLOCKER---
  {"type": "missing_dependency" | "unclear_requirement" | "access_issue" | "technical_limitation",
   "description": "What is blocking you",
   "suggestion": "What the human could do to unblock"}
- After completing, verify your changes compile (run tsc --noEmit if applicable).`;
  return prompt;
}

const ARTIFACT_PROMPT = `Summarize what was accomplished in the previous coding step. Include:
1. What was done (2-3 sentences)
2. Key files created or modified (list paths)
3. Important decisions made
4. Any issues or notes for the next step

Keep it under 200 words. Be specific and factual. Output plain text, no markdown headers.`;

// ─── Artifact generation ────────────────────────────────────

async function generateArtifact(
  blueprintId: string,
  nodeId: string,
  executionOutput: string,
  cwd?: string,
): Promise<Artifact> {
  const summaryPrompt = `Here is the output from a coding step:\n\n---\n${executionOutput.slice(0, 4000)}\n---\n\n${ARTIFACT_PROMPT}`;

  let summary: string;
  try {
    summary = await runClaude(summaryPrompt, cwd);
  } catch {
    summary = executionOutput.slice(0, 500);
  }

  return createArtifact(blueprintId, nodeId, "handoff_summary", summary);
}

// ─── Node execution ─────────────────────────────────────────

export async function executeNode(
  blueprintId: string,
  nodeId: string,
): Promise<NodeExecution> {
  const blueprint = getBlueprint(blueprintId);
  if (!blueprint) throw new Error("Blueprint not found");

  const node = blueprint.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error("Node not found");

  if (node.status !== "pending" && node.status !== "failed") {
    throw new Error(`Node status is "${node.status}", must be "pending" or "failed" to run`);
  }

  // Check dependencies
  for (const depId of node.dependencies) {
    const depNode = blueprint.nodes.find((n) => n.id === depId);
    if (!depNode || depNode.status !== "done") {
      throw new Error(`Dependency "${depNode?.title ?? depId}" is not done (status: ${depNode?.status ?? "missing"})`);
    }
  }

  // Collect input artifacts from dependency nodes
  const inputArtifacts: { node: MacroNode; artifact: Artifact }[] = [];
  for (const depId of node.dependencies) {
    const depNode = blueprint.nodes.find((n) => n.id === depId)!;
    const arts = getArtifactsForNode(depId, "output");
    if (arts.length > 0) {
      inputArtifacts.push({ node: depNode, artifact: arts[arts.length - 1] });
    }
  }

  // Build prompt
  const prompt = buildNodePrompt(blueprint, node, inputArtifacts);

  // Update statuses
  const isRetry = node.status === "failed";
  updateMacroNode(blueprintId, nodeId, { status: "running", error: "" });
  updateBlueprint(blueprintId, { status: "running" });

  // Create execution record
  const execution = createExecution(
    nodeId,
    blueprintId,
    undefined,
    isRetry ? "retry" : "primary",
    prompt,
  );

  const startTime = Date.now();
  const beforeTimestamp = new Date();

  try {
    const output = await runClaude(prompt, blueprint.projectCwd);

    const elapsed = (Date.now() - startTime) / 60_000;

    // Detect the session created by claude -p
    let sessionId: string | undefined;
    if (blueprint.projectCwd) {
      const detected = detectNewSession(blueprint.projectCwd, beforeTimestamp);
      if (detected) {
        sessionId = detected;
        syncSession(detected);
      }
    }

    // Check for blocker in output
    const blockerMatch = output.match(/---BLOCKER---\s*([\s\S]*?)$/);
    if (blockerMatch) {
      const blockerText = blockerMatch[1].trim();
      let blockerInfo: string;
      try {
        const parsed = JSON.parse(blockerText);
        blockerInfo = `[${parsed.type}] ${parsed.description}. Suggestion: ${parsed.suggestion}`;
      } catch {
        blockerInfo = blockerText;
      }

      updateExecution(execution.id, {
        status: "done",
        outputSummary: `BLOCKER: ${blockerInfo}\n\n${output.slice(0, 1500)}`,
        completedAt: new Date().toISOString(),
        ...(sessionId ? { sessionId } : {}),
      });
      updateMacroNode(blueprintId, nodeId, {
        status: "blocked",
        error: `Blocker: ${blockerInfo}`,
        actualMinutes: Math.round(elapsed * 10) / 10,
      });

      await generateArtifact(blueprintId, nodeId, output, blueprint.projectCwd);
      return updateExecution(execution.id, {})!;
    }

    // Success — no blocker
    updateExecution(execution.id, {
      status: "done",
      outputSummary: output.slice(0, 2000),
      completedAt: new Date().toISOString(),
      ...(sessionId ? { sessionId } : {}),
    });
    updateMacroNode(blueprintId, nodeId, {
      status: "done",
      actualMinutes: Math.round(elapsed * 10) / 10,
    });

    // Generate handoff artifact
    await generateArtifact(blueprintId, nodeId, output, blueprint.projectCwd);

    return updateExecution(execution.id, {})!;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);

    updateExecution(execution.id, {
      status: "failed",
      outputSummary: errorMsg,
      completedAt: new Date().toISOString(),
    });
    updateMacroNode(blueprintId, nodeId, {
      status: "failed",
      error: errorMsg,
    });

    return updateExecution(execution.id, {})!;
  }
}

// ─── Sequential execution ───────────────────────────────────

export async function executeNextNode(
  blueprintId: string,
): Promise<NodeExecution | null> {
  const blueprint = getBlueprint(blueprintId);
  if (!blueprint) throw new Error("Blueprint not found");

  // Find first pending node whose dependencies are all done
  const candidate = blueprint.nodes.find((node) => {
    if (node.status !== "pending") return false;
    return node.dependencies.every((depId) => {
      const dep = blueprint.nodes.find((n) => n.id === depId);
      return dep?.status === "done";
    });
  });

  if (!candidate) {
    // Check if all nodes are done
    const allDone = blueprint.nodes.every((n) => n.status === "done" || n.status === "skipped");
    if (allDone) {
      updateBlueprint(blueprintId, { status: "done" });
    }
    return null;
  }

  return executeNode(blueprintId, candidate.id);
}

export async function executeAllNodes(
  blueprintId: string,
): Promise<void> {
  updateBlueprint(blueprintId, { status: "running" });

  while (true) {
    const execution = await executeNextNode(blueprintId);
    if (!execution) break;

    // Stop on failure
    if (execution.status === "failed") {
      updateBlueprint(blueprintId, { status: "failed" });
      break;
    }
  }
}
