import { execFile } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getBlueprint, createMacroNode } from "./plan-db.js";
import type { MacroNode } from "./plan-db.js";

const CLAUDE_PATH = process.env.CLAUDE_PATH || "/Users/leizhou/.local/bin/claude";

function runClaude(prompt: string, cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const tmpFile = join(tmpdir(), `clawui-gen-${randomUUID()}.txt`);
    writeFileSync(tmpFile, prompt, "utf-8");
    const expectScript = `
set timeout 120
set fp [open "${tmpFile}" r]
set prompt [read -nonewline $fp]
close $fp
file delete "${tmpFile}"
set stty_init "columns 2000"
regsub -all {(')} $prompt {'\\'\\''} escaped_prompt
spawn /bin/sh -c "exec ${CLAUDE_PATH} --dangerously-skip-permissions -p '$escaped_prompt'"
expect eof
`;
    const tmpExpect = join(tmpdir(), `clawui-gen-${randomUUID()}.exp`);
    writeFileSync(tmpExpect, expectScript, "utf-8");
    execFile("/usr/bin/expect", [tmpExpect], {
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
      cwd: cwd || process.cwd(),
      env: { ...process.env },
    }, (error, stdout) => {
      try { unlinkSync(tmpExpect); } catch { /* ignore */ }
      try { unlinkSync(tmpFile); } catch { /* ignore */ }
      const lines = stdout.split("\n");
      const spawnIdx = lines.findIndex(l => l.includes("spawn") && l.includes("claude"));
      const cleanLines = spawnIdx >= 0 ? lines.slice(spawnIdx + 1) : lines;
      const clean = cleanLines.join("\n")
        .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "")
        .replace(/\x1B\][^\x07]*\x07/g, "")
        .replace(/\r/g, "")
        .trim();
      if (clean.length > 0) {
        resolve(clean);
        return;
      }
      if (error) {
        reject(new Error(`Claude error: ${error.message}`));
        return;
      }
      resolve(clean);
    });
  });
}

function extractJSON(text: string): unknown {
  // Try direct parse
  try { return JSON.parse(text); } catch { /* fall through */ }
  // Try extracting from markdown code block
  const match = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (match) {
    try { return JSON.parse(match[1]); } catch { /* fall through */ }
  }
  // Try finding array in text
  const arrMatch = text.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try { return JSON.parse(arrMatch[0]); } catch { /* fall through */ }
  }
  throw new Error("Could not parse JSON from Claude output");
}

export async function generatePlan(blueprintId: string, taskDescription?: string): Promise<MacroNode[]> {
  const blueprint = getBlueprint(blueprintId);
  if (!blueprint) throw new Error("Blueprint not found");

  const desc = taskDescription || blueprint.description;
  if (!desc) throw new Error("No task description provided");

  const existingCount = blueprint.nodes.length;

  // Build context of existing nodes so AI doesn't generate duplicates
  let existingNodesContext = "";
  if (blueprint.nodes.length > 0) {
    const nodeList = blueprint.nodes.map(n =>
      `  #${n.order}. [${n.status}] ${n.title}`
    ).join("\n");
    existingNodesContext = `\n\nAlready completed/existing nodes in this blueprint:\n${nodeList}\n\nDo NOT regenerate these. Only generate NEW nodes for remaining work.`;
  }

  const prompt = `You are a senior software architect planning a development task.

Task: ${desc}
Working directory: ${blueprint.projectCwd || "not specified"}
Project context: This is ClawUI, a Claude Code session viewer built with Express (backend) + Next.js (frontend), using SQLite for data, expect for Claude CLI TTY. See CLAUDE.md and docs/ for architecture details.${existingNodesContext}

Generate the NEXT 2-6 concrete steps that still need to be done.
Each step will be executed by a separate Claude Code session.

Output ONLY a JSON array (no markdown, no explanation):
[
  {
    "title": "Short title",
    "description": "Detailed description of what to implement. Be specific about files to create/modify, functions to add, and expected behavior.",
    "dependencies": []
  }
]

Rules:
- Each step should be completable in one Claude Code session (5-15 min)
- Be specific: mention file paths, function names, API endpoints
- Dependencies use 0-based indices referring to earlier steps in THIS array
- First step should have dependencies: []
- Keep it focused — dont over-decompose simple tasks`;

  const output = await runClaude(prompt, blueprint.projectCwd || undefined);
  const parsed = extractJSON(output) as Array<{ title: string; description: string; dependencies?: number[] }>;

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("Claude returned invalid plan structure");
  }

  // Create nodes, mapping dependency indices to real IDs
  const createdNodes: MacroNode[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const step = parsed[i];
    const depIds = (step.dependencies || [])
      .map(idx => {
        if (idx >= 0 && idx < createdNodes.length) return createdNodes[idx].id;
        return null;
      })
      .filter((id): id is string => id !== null);

    const node = createMacroNode(blueprintId, {
      title: step.title,
      description: step.description,
      order: existingCount + i + 1,
      dependencies: depIds.length > 0 ? depIds : undefined,
    });
    createdNodes.push(node);
  }

  return createdNodes;
}
