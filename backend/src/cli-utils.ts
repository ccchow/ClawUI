// backend/src/cli-utils.ts
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "./logger.js";

const log = createLogger("cli-utils");

const IS_WIN = process.platform === "win32";

// ─── Environment ─────────────────────────────────────────────

/**
 * Build a clean environment for spawning Claude CLI subprocesses.
 * Strips CLAUDECODE to prevent "cannot be launched inside another Claude Code session".
 */
export function cleanEnvForClaude(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  return env;
}

// ─── Process liveness ────────────────────────────────────────

/**
 * Platform-aware process liveness check.
 * Unix: signal 0. Windows: tasklist lookup (signal 0 is unreliable on Windows).
 */
export function isProcessAlive(pid: number): boolean {
  if (IS_WIN) {
    try {
      const result = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], {
        encoding: "utf-8",
        timeout: 5000,
        windowsHide: true,
      });
      return result.includes(String(pid));
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ─── Path encoding ───────────────────────────────────────────

/**
 * Encode a project path the same way Claude CLI does: replace path separators with `-`.
 * Handles both Unix `/` and Windows `\` separators, and strips drive letter colons.
 *
 * Examples:
 *   /home/user/project     → -home-user-project
 *   C:\Users\user\project  → -C-Users-user-project
 *   Q:\src\ClawUI          → -Q-src-ClawUI
 */
export function encodeProjectPath(projectCwd: string): string {
  return projectCwd
    .replace(/:/g, "-")     // replace drive letter colon with - (C: → C-)
    .replace(/[\\/]/g, "-"); // replace both / and \ with -
}

// ─── ANSI stripping ──────────────────────────────────────────

/**
 * Strip ANSI escape codes, OSC sequences, and carriage returns from CLI output.
 */
export function stripAnsi(text: string): string {
  return text
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "")  // ANSI escape codes
    .replace(/\x1B\][^\x07]*\x07/g, "")      // OSC sequences
    .replace(/\r/g, "");                       // carriage returns
}

// ─── Claude CLI JS path resolution (Windows) ────────────────

let _claudeCliJs: string | null = null;

/**
 * On Windows, resolve the path to Claude's cli.js entry point.
 * Parses the claude.cmd shim to find the node_modules path.
 * Returns null on non-Windows or if resolution fails.
 */
export function resolveClaudeCliJs(claudePath: string): string | null {
  if (!IS_WIN) return null;
  if (_claudeCliJs !== null) return _claudeCliJs;

  // If CLAUDE_PATH points directly to a .js file, use it
  if (claudePath.endsWith(".js") || claudePath.endsWith(".mjs")) {
    _claudeCliJs = claudePath;
    return _claudeCliJs;
  }

  // Try to parse the .cmd shim to find cli.js
  const cmdPath = claudePath.endsWith(".cmd") ? claudePath : claudePath + ".cmd";
  try {
    if (existsSync(cmdPath)) {
      const content = readFileSync(cmdPath, "utf-8");
      // Look for pattern: "%~dp0\node_modules\@anthropic-ai\claude-code\cli.js"
      const match = content.match(/"%~dp0\\([^"]+\.js)"/);
      if (match) {
        const cmdDir = join(cmdPath, "..");
        const cliJs = join(cmdDir, match[1]);
        if (existsSync(cliJs)) {
          _claudeCliJs = cliJs;
          log.info(`Resolved Claude CLI JS: ${_claudeCliJs}`);
          return _claudeCliJs;
        }
      }
    }
  } catch (e) {
    log.debug(`Failed to parse claude.cmd: ${e instanceof Error ? e.message : e}`);
  }

  // Fallback: check common npm global locations
  const fallbacks = [
    join(homedir(), "AppData", "Roaming", "npm", "node_modules", "@anthropic-ai", "claude-code", "cli.js"),
    join(homedir(), ".npm-global", "node_modules", "@anthropic-ai", "claude-code", "cli.js"),
  ];
  for (const fb of fallbacks) {
    if (existsSync(fb)) {
      _claudeCliJs = fb;
      log.info(`Resolved Claude CLI JS (fallback): ${_claudeCliJs}`);
      return _claudeCliJs;
    }
  }

  _claudeCliJs = null;
  return null;
}

/** Reset cached CLI JS path (for testing). */
export function _resetCliJsCache(): void {
  _claudeCliJs = null;
}
