/**
 * Shared utility for reading session JSONL headers across agent runtimes.
 *
 * Both Codex and OpenClaw (and Pi) store session metadata in the first line
 * of their JSONL files, but with different formats:
 *   - Codex:    {type:"session_meta", payload:{id, cwd, ...}}
 *   - OpenClaw: {type:"session", version:3, cwd:"...", ...}
 *   - Pi:       {type:"session", version:3, ...}  (cwd encoded in dir name)
 *
 * This module normalizes the first-line read into a common shape.
 */

import { readFileSync } from "node:fs";

export interface SessionHeader {
  id?: string;
  cwd?: string;
}

/**
 * Read and normalize the session header (first line) of any agent JSONL file.
 * Returns null if the file can't be read or parsed.
 */
export function readSessionHeader(filePath: string): SessionHeader | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const firstNewline = raw.indexOf("\n");
    const firstLine = firstNewline >= 0 ? raw.slice(0, firstNewline) : raw;
    const header = JSON.parse(firstLine) as Record<string, unknown>;

    // Codex format: {type:"session_meta", payload:{id, cwd}}
    if (header.type === "session_meta") {
      const payload = header.payload as Record<string, unknown> | undefined;
      return {
        id: (payload?.id as string) ?? undefined,
        cwd: (payload?.cwd as string) ?? undefined,
      };
    }

    // OpenClaw/Pi format: {type:"session", cwd, ...}
    if (header.type === "session") {
      return {
        id: (header.id as string) ?? undefined,
        cwd: (header.cwd as string) ?? undefined,
      };
    }
  } catch {
    // Can't read or parse
  }
  return null;
}
