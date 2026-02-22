import * as pty from "node-pty";

const SUGGESTION_SUFFIX = ` Also, at the very end of your response, append exactly this marker on its own line: ---SUGGESTIONS--- followed by a JSON array of 3 suggested next steps: [{"title":"short title","description":"one sentence description","prompt":"the exact prompt to run"}]. No markdown code blocks around it.`;

const EXEC_TIMEOUT = 180_000; // 3 minutes

export interface Suggestion {
  title: string;
  description: string;
  prompt: string;
}

export interface RunResult {
  output: string;
  suggestions: Suggestion[];
}

function runClaude(
  sessionId: string,
  prompt: string,
  cwd?: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const claudePath = process.env.CLAUDE_PATH || "/Users/leizhou/.local/bin/claude";
    let output = "";
    let timer: NodeJS.Timeout;

    const proc = pty.spawn(claudePath, [
      "--dangerously-skip-permissions",
      "--resume",
      sessionId,
      "-p",
      prompt,
    ], {
      name: "xterm-256color",
      cols: 200,
      rows: 50,
      cwd: cwd || process.cwd(),
      env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
    });

    timer = setTimeout(() => {
      proc.kill();
      reject(new Error("Claude CLI timed out after 3 minutes"));
    }, EXEC_TIMEOUT);

    proc.onData((data: string) => {
      output += data;
    });

    proc.onExit(({ exitCode }) => {
      clearTimeout(timer);
      // Strip ANSI escape codes
      const clean = output.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "")
        .replace(/\x1B\][^\x07]*\x07/g, "")  // OSC sequences
        .replace(/\r/g, "")
        .trim();
      
      if (clean.length > 0) {
        resolve(clean);
      } else if (exitCode !== 0) {
        reject(new Error(`Claude CLI exited with code ${exitCode}`));
      } else {
        resolve(clean);
      }
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
 * Run a prompt on a session. Automatically appends suggestion suffix
 * so Claude returns 3 next-step suggestions alongside the response.
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
