import type { AgentRuntime } from "./agent-runtime.js";
import { createLogger } from "./logger.js";

// Child process tracking — populated by index.ts at startup
let trackPid: ((pid: number) => void) | undefined;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function setChildPidTracker(track: (pid: number) => void, _untrack: (pid: number) => void): void {
  trackPid = track;
}

const log = createLogger("cli-runner");

/**
 * Validate that a sessionId is safe for use in shell commands and file paths.
 * Claude session IDs are UUIDs (hex + hyphens). Reject anything else to prevent
 * Tcl code injection (expect scripts) and path traversal.
 */
export function validateSessionId(sessionId: string): void {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) {
    throw new Error(`Invalid session ID: contains disallowed characters`);
  }
}

const SUGGESTION_SUFFIX = ` Also, at the very end of your response, append exactly this marker on its own line: ---SUGGESTIONS--- followed by a JSON array of 3 suggested next steps: [{"title":"short title","description":"one sentence description","prompt":"the exact prompt to run"}]. No markdown code blocks around it.`;

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
    // Failed to parse suggestions — return output without them
  }

  return { cleanOutput, suggestions: [] };
}

/**
 * Run a prompt on an existing session via the agent runtime.
 * Dispatches through AgentRuntime.resumeSession() for multi-agent support.
 * Automatically appends suggestion suffix and parses suggestions from output.
 */
export async function runPrompt(
  sessionId: string,
  prompt: string,
  cwd?: string,
  runtime?: AgentRuntime,
): Promise<RunResult> {
  const fullPrompt = prompt + SUGGESTION_SUFFIX;

  if (!runtime) {
    throw new Error(`No agent runtime provided for session ${sessionId}`);
  }

  if (!runtime.capabilities.supportsResume) {
    throw new Error(`Agent runtime "${runtime.type}" does not support session resume`);
  }

  log.debug(`runPrompt: dispatching via ${runtime.type} runtime, session=${sessionId.slice(0, 8)}...`);

  const onPid = (pid: number) => {
    trackPid?.(pid);
    // Schedule untrack when the process exits (handled by the runtime,
    // but we untrack here as a safety net on completion)
  };

  let rawOutput: string;
  try {
    rawOutput = await runtime.resumeSession(sessionId, fullPrompt, cwd, onPid);
  } finally {
    // Note: PID untracking happens when the process exits naturally.
    // The onPid callback above only tracks; the runtime's own cleanup handles exit.
  }

  const { cleanOutput, suggestions } = parseSuggestions(rawOutput);
  return { output: cleanOutput, suggestions };
}
