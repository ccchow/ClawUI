import { execFile } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const SUGGESTION_SUFFIX = ` Also, at the very end of your response, append exactly this marker on its own line: ---SUGGESTIONS--- followed by a JSON array of 3 suggested next steps: [{"title":"short title","description":"one sentence description","prompt":"the exact prompt to run"}]. No markdown code blocks around it.`;

const EXEC_TIMEOUT = 180_000; // 3 minutes
const CLAUDE_PATH = process.env.CLAUDE_PATH || "/Users/leizhou/.local/bin/claude";

export interface Suggestion {
  title: string;
  description: string;
  prompt: string;
}

export interface RunResult {
  output: string;
  suggestions: Suggestion[];
}

/**
 * Run Claude Code via `expect` to provide a TTY (required by Claude Code).
 */
function runClaude(
  sessionId: string,
  prompt: string,
  cwd?: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    // Write prompt to temp file to avoid shell escaping issues
    const tmpFile = join(tmpdir(), `clawui-prompt-${randomUUID()}.txt`);
    writeFileSync(tmpFile, prompt, "utf-8");

    // Expect script that reads prompt from file
    const expectScript = `
set timeout 180
set fp [open "${tmpFile}" r]
set prompt [read $fp]
close $fp
file delete "${tmpFile}"
spawn ${CLAUDE_PATH} --dangerously-skip-permissions --resume ${sessionId} -p $prompt
expect eof
`;

    const tmpExpect = join(tmpdir(), `clawui-expect-${randomUUID()}.exp`);
    writeFileSync(tmpExpect, expectScript, "utf-8");

    execFile("/usr/bin/expect", [tmpExpect], {
      timeout: EXEC_TIMEOUT,
      maxBuffer: 10 * 1024 * 1024,
      cwd: cwd || process.cwd(),
      env: { ...process.env },
    }, (error, stdout, stderr) => {
      // Clean up expect script
      try { unlinkSync(tmpExpect); } catch {}
      try { unlinkSync(tmpFile); } catch {}

      // Strip the "spawn ..." line from expect output
      const lines = stdout.split("\n");
      const spawnIdx = lines.findIndex(l => l.includes("spawn") && l.includes("claude"));
      const cleanLines = spawnIdx >= 0 ? lines.slice(spawnIdx + 1) : lines;
      const clean = cleanLines.join("\n")
        .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "")  // ANSI escape codes
        .replace(/\x1B\][^\x07]*\x07/g, "")      // OSC sequences
        .replace(/\r/g, "")
        .trim();

      if (clean.length > 0) {
        resolve(clean);
        return;
      }
      if (error) {
        reject(new Error(`Claude CLI error: ${error.message}\n${stderr}`));
        return;
      }
      resolve(clean);
    });
  });
}

/**
 * Parse suggestions from Claude output that contains ---SUGGESTIONS--- marker.
 */
function parseSuggestions(output: string): { cleanOutput: string; suggestions: Suggestion[] } {
  const marker = "---SUGGESTIONS---";
  const idx = output.lastIndexOf(marker);
  
  if (idx === -1) {
    return { cleanOutput: output, suggestions: [] };
  }

  const cleanOutput = output.substring(0, idx).trim();
  const suggestionsRaw = output.substring(idx + marker.length).trim();

  try {
    const jsonMatch = suggestionsRaw.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const suggestions: Suggestion[] = JSON.parse(jsonMatch[0]);
      return { cleanOutput, suggestions: suggestions.slice(0, 3) };
    }
  } catch {
    // Failed to parse, return empty suggestions
  }

  return { cleanOutput, suggestions: [] };
}

/**
 * Run a prompt on a session with TTY via expect.
 * Automatically appends suggestion suffix.
 */
export async function runPrompt(
  sessionId: string,
  prompt: string,
  cwd?: string
): Promise<RunResult> {
  const fullPrompt = prompt + SUGGESTION_SUFFIX;
  const rawOutput = await runClaude(sessionId, fullPrompt, cwd);
  const { cleanOutput, suggestions } = parseSuggestions(rawOutput);
  return { output: cleanOutput, suggestions };
}
