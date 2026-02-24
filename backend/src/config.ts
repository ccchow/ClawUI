import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Resolve the path to the Claude CLI binary.
 * Priority: CLAUDE_PATH env → common install locations → PATH lookup via `which`.
 */
function resolveClaudePath(): string {
  // 1. Explicit env var
  if (process.env.CLAUDE_PATH) {
    return process.env.CLAUDE_PATH;
  }

  // 2. Common install locations
  const candidates = [
    join(homedir(), ".local", "bin", "claude"),
    "/usr/local/bin/claude",
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  // 3. Fallback: check PATH via `which`
  try {
    const resolved = execFileSync("/usr/bin/which", ["claude"], { encoding: "utf-8" }).trim();
    if (resolved) return resolved;
  } catch {
    // `which` failed — claude not in PATH
  }

  // 4. Last resort: bare command name (will fail at runtime if not in PATH)
  return "claude";
}

export const CLAUDE_PATH = resolveClaudePath();

export const PORT = parseInt(process.env.PORT || "3001", 10);

export const CLAWUI_DB_DIR = process.env.CLAWUI_DB_DIR || ".clawui";

export const NEXT_PUBLIC_API_PORT = process.env.NEXT_PUBLIC_API_PORT || "3001";

/** Log verbosity: "debug" | "info" | "warn" | "error". Default "info". */
export const LOG_LEVEL = process.env.LOG_LEVEL || "info";

/** Dev mode flag — reuses auth token, enables dev UI features. */
export const CLAWUI_DEV = process.env.CLAWUI_DEV === "1";
