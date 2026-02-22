import { execFile } from "node:child_process";

const SUGGESTION_SUFFIX = ` Also, at the very end of your response, append exactly this marker on its own line: ---SUGGESTIONS--- followed by a JSON array of 3 suggested next steps: [{"title":"short title","description":"one sentence description","prompt":"the exact prompt to run"}]. No markdown code blocks around it.`;

const EXEC_TIMEOUT = 180_000; // 3 minutes

export interface Suggestion {
  title: string;
  description: string;
  prompt: string;
}

function runClaude(
  sessionId: string,
  prompt: string,
  cwd?: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const claudePath = process.env.CLAUDE_PATH || "/Users/leizhou/.local/bin/claude";
    
    execFile(
      claudePath,
      [
        "--dangerously-skip-permissions",
        "--resume",
        sessionId,
        "-p",
        prompt,
      ],
      {
        timeout: EXEC_TIMEOUT,
        maxBuffer: 10 * 1024 * 1024, // 10MB
        cwd: cwd || process.cwd(),
        env: { ...process.env },
      },
      (error, stdout, stderr) => {
        // Claude CLI sometimes exits with non-zero but still produces valid output
        if (stdout && stdout.trim().length > 0) {
          resolve(stdout);
          return;
        }
        if (error) {
          reject(new Error(`Claude CLI error: ${error.message}\n${stderr}`));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

export interface RunResult {
  output: string;
  suggestions: Suggestion[];
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
