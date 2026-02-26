import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { homedir } from "node:os";

/**
 * Resolve the path to the Claude CLI binary.
 * Priority: CLAUDE_PATH env → common install locations → PATH lookup.
 */
function resolveClaudePath(): string {
  // 1. Explicit env var
  if (process.env.CLAUDE_PATH) {
    return process.env.CLAUDE_PATH;
  }

  if (process.platform === "win32") {
    // Windows install locations
    const winCandidates = [
      join(homedir(), "AppData", "Roaming", "npm", "claude.cmd"),
      join(homedir(), ".npm-global", "claude.cmd"),
    ];
    for (const candidate of winCandidates) {
      if (existsSync(candidate)) return candidate;
    }
    // PATH lookup via where.exe
    try {
      const resolved = execFileSync("where", ["claude"], {
        encoding: "utf-8",
        timeout: 5000,
        windowsHide: true,
      }).trim().split(/\r?\n/)[0];
      if (resolved) return resolved;
    } catch { /* where failed */ }
  } else {
    // Unix install locations
    const candidates = [
      join(homedir(), ".local", "bin", "claude"),
      "/usr/local/bin/claude",
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
    // PATH lookup via which
    try {
      const resolved = execFileSync("/usr/bin/which", ["claude"], { encoding: "utf-8" }).trim();
      if (resolved) return resolved;
    } catch { /* which failed */ }
  }

  // Last resort: bare command name (will fail at runtime if not in PATH)
  return "claude";
}

export const CLAUDE_PATH = resolveClaudePath();

/**
 * Resolve the path to the `expect` binary.
 * Priority: EXPECT_PATH env → common install locations → PATH lookup via `which` → bare "expect".
 */
function resolveExpectPath(): string {
  // expect is not needed on Windows — Claude CLI works without TTY wrapping
  if (process.platform === "win32") return "";

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

import { resolveClaudeCliJs } from "./cli-utils.js";

/** Path to Claude's cli.js for direct node invocation on Windows. Null on Unix. */
export const CLAUDE_CLI_JS = resolveClaudeCliJs(CLAUDE_PATH);
