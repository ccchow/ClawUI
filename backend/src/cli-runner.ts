import { execFile } from "node:child_process";

const SUGGEST_PROMPT = `Based on the current session context, suggest exactly 3 possible next steps I could take. Return ONLY a JSON array with no other text: [{"title":"short title","description":"one sentence description","prompt":"the exact prompt to run"}]`;

const EXEC_TIMEOUT = 120_000; // 2 minutes

export interface Suggestion {
  title: string;
  description: string;
  prompt: string;
}

function runClaude(
  sessionId: string,
  prompt: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "claude",
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
        env: { ...process.env },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Claude CLI error: ${error.message}\n${stderr}`));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

export async function getSuggestions(
  sessionId: string
): Promise<Suggestion[]> {
  const output = await runClaude(sessionId, SUGGEST_PROMPT);

  // Try to extract JSON array from output
  const jsonMatch = output.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error("Could not parse suggestions from Claude output");
  }

  const suggestions: Suggestion[] = JSON.parse(jsonMatch[0]);

  if (!Array.isArray(suggestions) || suggestions.length === 0) {
    throw new Error("Invalid suggestions format");
  }

  return suggestions.slice(0, 3);
}

export async function runPrompt(
  sessionId: string,
  prompt: string
): Promise<string> {
  return runClaude(sessionId, prompt);
}
