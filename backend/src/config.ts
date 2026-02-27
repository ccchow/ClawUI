import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { homedir } from "node:os";
import type { AgentType } from "./agent-runtime.js";

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

/**
 * Resolve the path to the `expect` binary.
 * Priority: EXPECT_PATH env → common install locations → PATH lookup via `which` → bare "expect".
 */
function resolveExpectPath(): string {
  if (process.env.EXPECT_PATH) {
    return process.env.EXPECT_PATH;
  }

  const candidates = [
    "/usr/bin/expect",
    "/usr/local/bin/expect",
    "/opt/local/bin/expect",
    "/opt/homebrew/bin/expect",
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  try {
    const resolved = execFileSync("/usr/bin/which", ["expect"], { encoding: "utf-8" }).trim();
    if (resolved) return resolved;
  } catch {
    // `which` failed — expect not in PATH
  }

  return "expect";
}

export const EXPECT_PATH = resolveExpectPath();

export const PORT = parseInt(process.env.PORT || "3001", 10);

/** Raw value — may be relative (e.g. ".clawui") or absolute (e.g. "/Users/x/.clawui"). */
const CLAWUI_DB_DIR_RAW = process.env.CLAWUI_DB_DIR || ".clawui";

/** Resolved absolute path to the data directory. */
export const CLAWUI_DB_DIR = isAbsolute(CLAWUI_DB_DIR_RAW)
  ? CLAWUI_DB_DIR_RAW
  : join(import.meta.dirname, "..", "..", CLAWUI_DB_DIR_RAW);

export const NEXT_PUBLIC_API_PORT = process.env.NEXT_PUBLIC_API_PORT || "3001";

/** Log verbosity: "debug" | "info" | "warn" | "error". Default "info". */
export const LOG_LEVEL = process.env.LOG_LEVEL || "info";

/** Dev mode flag — reuses auth token, enables dev UI features. */
export const CLAWUI_DEV = process.env.CLAWUI_DEV === "1";

// ─── Multi-agent configuration ──────────────────────────────

/** Which backend AI agent to use. Default: "claude". */
function resolveAgentType(): AgentType {
  const raw = process.env.AGENT_TYPE || "claude";
  const valid: AgentType[] = ["claude", "openclaw", "pi-mono"];
  if (valid.includes(raw as AgentType)) return raw as AgentType;
  return "claude";
}

export const AGENT_TYPE: AgentType = resolveAgentType();

/**
 * Resolve the path to the OpenClaw binary.
 * Priority: OPENCLAW_PATH env → common install locations → PATH lookup via `which`.
 */
function resolveOpenClawPath(): string | null {
  if (process.env.OPENCLAW_PATH) {
    return process.env.OPENCLAW_PATH;
  }
  const candidates = [
    join(homedir(), ".local", "bin", "openclaw"),
    "/usr/local/bin/openclaw",
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  try {
    const resolved = execFileSync("/usr/bin/which", ["openclaw"], { encoding: "utf-8" }).trim();
    if (resolved) return resolved;
  } catch { /* not in PATH */ }
  return null;
}

export const OPENCLAW_PATH = resolveOpenClawPath();

/**
 * Resolve the path to the Pi Mono binary.
 * Priority: PI_PATH env → common install locations → PATH lookup via `which`.
 */
function resolvePiPath(): string | null {
  if (process.env.PI_PATH) {
    return process.env.PI_PATH;
  }
  const candidates = [
    join(homedir(), ".local", "bin", "pi-mono"),
    "/usr/local/bin/pi-mono",
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  try {
    const resolved = execFileSync("/usr/bin/which", ["pi-mono"], { encoding: "utf-8" }).trim();
    if (resolved) return resolved;
  } catch { /* not in PATH */ }
  return null;
}

export const PI_PATH = resolvePiPath();
