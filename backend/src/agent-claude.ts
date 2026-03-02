/**
 * Claude Code agent runtime implementation.
 *
 * Extracts all Claude-specific CLI invocation logic (expect scripts, TTY handling,
 * env cleaning, session detection) into a single class implementing AgentRuntime.
 */

import { execFile, spawn } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { CLAUDE_PATH, EXPECT_PATH, CLAUDE_CLI_JS } from "./config.js";
import { cleanEnvForClaude, stripAnsi } from "./cli-utils.js";
import { createLogger } from "./logger.js";
import type { AgentRuntime, AgentCapabilities } from "./agent-runtime.js";
import { registerRuntime } from "./agent-runtime.js";
import { analyzeSessionHealth as analyzeClaudeSessionHealth } from "./jsonl-parser.js";
import type { SessionAnalysis } from "./jsonl-parser.js";

const log = createLogger("agent-claude");
const EXEC_TIMEOUT = 30 * 60 * 1000; // 30 minutes per node

// ─── Windows spawn helper ────────────────────────────────────

/**
 * Spawn Claude CLI directly on Windows (no expect/TTY needed).
 * Returns captured stdout (ANSI-stripped) and the child PID.
 */
function spawnClaudeWindows(
  args: string[],
  opts: { cwd?: string; timeout?: number },
): Promise<{ stdout: string; pid?: number }> {
  return new Promise((resolve, reject) => {
    const cmd = CLAUDE_CLI_JS ? process.execPath : "claude";
    const spawnArgs = CLAUDE_CLI_JS ? [CLAUDE_CLI_JS, ...args] : args;
    const useShell = !CLAUDE_CLI_JS;

    log.debug(`Spawning Claude (Windows): args=${args.slice(0, 4).join(" ")}, cwd=${opts.cwd || process.cwd()}`);

    const child = spawn(cmd, spawnArgs, {
      timeout: opts.timeout ?? EXEC_TIMEOUT,
      cwd: opts.cwd || process.cwd(),
      env: cleanEnvForClaude(),
      shell: useShell,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // Detach so the CLI process survives backend restarts (tsx watch).
      // On Unix, expect-spawned children are naturally orphaned to init;
      // on Windows, children in the same process group are killed together.
      detached: true,
    });

    // Allow the backend to exit without waiting for this child.
    // We still collect output via the piped stdio streams.
    child.unref();

    const pid = child.pid;
    child.stdin.end();

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on("error", (err) => {
      reject(new Error(`Claude CLI spawn error: ${err.message}`));
    });

    child.on("close", (code) => {
      const clean = stripAnsi(stdout).trim();

      if (clean.length > 0) {
        resolve({ stdout: clean, pid });
        return;
      }
      if (code !== 0) {
        reject(new Error(`Claude CLI error (exit ${code}): ${stderr.slice(0, 500)}`));
        return;
      }
      resolve({ stdout: clean, pid });
    });
  });
}

export class ClaudeAgentRuntime implements AgentRuntime {
  readonly type = "claude" as const;

  readonly capabilities: AgentCapabilities = {
    supportsResume: true,
    supportsInteractive: true,
    supportsTextOutput: true,
    supportsDangerousMode: true,
  };

  getSessionsDir(): string {
    return join(homedir(), ".claude", "projects");
  }

  encodeProjectCwd(cwd: string): string {
    return cwd
      .replace(/:/g, "-")          // replace drive letter colon (C: → C-)
      .replace(/[/\\]\./g, "/-")   // encode leading dots in path components
      .replace(/[/\\]/g, "-");     // encode path separators (both / and \)
  }

  cleanEnv(): NodeJS.ProcessEnv {
    return cleanEnvForClaude();
  }

  /**
   * Run Claude in text output mode (--output-format text).
   * Uses expect for TTY on Unix; direct spawn on Windows.
   */
  runSession(prompt: string, cwd?: string, onPid?: (pid: number) => void): Promise<string> {
    // ── Windows: direct spawn ──
    if (process.platform === "win32") {
      return (async () => {
        const { stdout, pid } = await spawnClaudeWindows(
          ["--dangerously-skip-permissions", "--output-format", "text", "-p", prompt],
          { cwd, timeout: EXEC_TIMEOUT },
        );
        if (pid && onPid) onPid(pid);
        return stdout;
      })();
    }

    // ── Unix: expect script ──
    return new Promise((resolve, reject) => {
      const tmpFile = join(tmpdir(), `clawui-plan-prompt-${randomUUID()}.txt`);
      writeFileSync(tmpFile, prompt, "utf-8");

      const outputFile = join(tmpdir(), `clawui-plan-output-${randomUUID()}.out`);
      const expectScript = `
log_user 0
set timeout 1800
set stty_init "columns 2000"
match_max 1000000

set fp [open "${tmpFile}" r]
set prompt [read -nonewline $fp]
close $fp
file delete "${tmpFile}"

set of [open "${outputFile}" w]
set output ""

spawn ${CLAUDE_PATH} --dangerously-skip-permissions --output-format text -p $prompt
expect {
  -re ".+" {
    append output $expect_out(0,string)
    exp_continue
  }
  eof {}
  timeout {
    puts -nonewline $of $output
    close $of
    exit 1
  }
}

# Wait for the spawned process to fully exit
catch {wait}

puts -nonewline $of $output
close $of
`;

      const tmpExpect = join(tmpdir(), `clawui-plan-expect-${randomUUID()}.exp`);
      writeFileSync(tmpExpect, expectScript, "utf-8");

      const child = execFile(
        EXPECT_PATH,
        [tmpExpect],
        {
          timeout: EXEC_TIMEOUT,
          maxBuffer: 10 * 1024 * 1024,
          cwd: cwd || process.cwd(),
          env: cleanEnvForClaude(),
        },
        (error, _stdout, stderr) => {
          // Read output from file (avoids TTY echo contamination)
          let clean = "";
          try {
            clean = stripAnsi(readFileSync(outputFile, "utf-8")).trim();
          } catch { /* no output file */ }

          // Cleanup
          try { unlinkSync(tmpExpect); } catch { /* ignore */ }
          try { unlinkSync(tmpFile); } catch { /* ignore */ }
          try { unlinkSync(outputFile); } catch { /* ignore */ }

          if (clean.length > 0) {
            resolve(clean);
            return;
          }
          if (error) {
            reject(new Error(`Claude CLI error: ${error.message}${stderr ? `\n${stderr.slice(0, 1000)}` : ""}`));
            return;
          }
          resolve(clean);
        },
      );

      // Notify caller of the expect process PID for liveness tracking
      if (child.pid && onPid) {
        onPid(child.pid);
      }
    });
  }

  /**
   * Run Claude in interactive mode (full tool use, no --output-format text).
   * Used for tasks where Claude directly calls API endpoints.
   */
  runSessionInteractive(prompt: string, cwd?: string): Promise<string> {
    // ── Windows: direct spawn ──
    if (process.platform === "win32") {
      return spawnClaudeWindows(
        ["--dangerously-skip-permissions", "-p", prompt],
        { cwd, timeout: EXEC_TIMEOUT },
      ).then(({ stdout }) => stdout);
    }

    // ── Unix: expect script ──
    return new Promise((resolve, reject) => {
      const tmpFile = join(tmpdir(), `clawui-plan-prompt-${randomUUID()}.txt`);
      writeFileSync(tmpFile, prompt, "utf-8");

      const fullScript = `
set timeout 1800
set stty_init "columns 2000"
set fp [open "${tmpFile}" r]
set prompt [read -nonewline $fp]
close $fp
file delete "${tmpFile}"
spawn ${CLAUDE_PATH} --dangerously-skip-permissions -p $prompt
expect eof
catch {wait}
`;

      const tmpExpect = join(tmpdir(), `clawui-plan-expect-${randomUUID()}.exp`);
      writeFileSync(tmpExpect, fullScript, "utf-8");

      execFile(
        EXPECT_PATH,
        [tmpExpect],
        {
          timeout: EXEC_TIMEOUT,
          maxBuffer: 10 * 1024 * 1024,
          cwd: cwd || process.cwd(),
          env: cleanEnvForClaude(),
        },
        (error, stdout, stderr) => {
          try { unlinkSync(tmpExpect); } catch { /* ignore */ }
          try { unlinkSync(tmpFile); } catch { /* ignore */ }

          if (error) {
            reject(new Error(`Claude interactive failed: ${error.message}${stderr ? `\n${stderr.slice(0, 1000)}` : ""}`));
            return;
          }

          resolve(stdout || "");
        },
      );
    });
  }

  /**
   * Resume an existing session by ID with a continuation prompt.
   */
  resumeSession(sessionId: string, prompt: string, cwd?: string, onPid?: (pid: number) => void): Promise<string> {
    // ── Windows: direct spawn ──
    if (process.platform === "win32") {
      return (async () => {
        const { stdout, pid } = await spawnClaudeWindows(
          ["--dangerously-skip-permissions", "--output-format", "text", "--resume", sessionId, "-p", prompt],
          { cwd, timeout: EXEC_TIMEOUT },
        );
        if (pid && onPid) onPid(pid);
        return stdout;
      })();
    }

    // ── Unix: expect script ──
    return new Promise((resolve, reject) => {
      const tmpFile = join(tmpdir(), `clawui-plan-prompt-${randomUUID()}.txt`);
      writeFileSync(tmpFile, prompt, "utf-8");

      const outputFile = join(tmpdir(), `clawui-plan-output-${randomUUID()}.out`);
      const expectScript = `
log_user 0
set timeout 1800
set stty_init "columns 2000"
match_max 1000000

set fp [open "${tmpFile}" r]
set prompt [read -nonewline $fp]
close $fp
file delete "${tmpFile}"

set of [open "${outputFile}" w]
set output ""

spawn ${CLAUDE_PATH} --dangerously-skip-permissions --output-format text --resume ${sessionId} -p $prompt
expect {
  -re ".+" {
    append output $expect_out(0,string)
    exp_continue
  }
  eof {}
  timeout {
    puts -nonewline $of $output
    close $of
    exit 1
  }
}

# Wait for the spawned process to fully exit
catch {wait}

puts -nonewline $of $output
close $of
`;

      const tmpExpect = join(tmpdir(), `clawui-plan-expect-${randomUUID()}.exp`);
      writeFileSync(tmpExpect, expectScript, "utf-8");

      const child = execFile(
        EXPECT_PATH,
        [tmpExpect],
        {
          timeout: EXEC_TIMEOUT,
          maxBuffer: 10 * 1024 * 1024,
          cwd: cwd || process.cwd(),
          env: cleanEnvForClaude(),
        },
        (error, _stdout, stderr) => {
          let clean = "";
          try {
            clean = stripAnsi(readFileSync(outputFile, "utf-8")).trim();
          } catch { /* no output file */ }

          try { unlinkSync(tmpExpect); } catch { /* ignore */ }
          try { unlinkSync(tmpFile); } catch { /* ignore */ }
          try { unlinkSync(outputFile); } catch { /* ignore */ }

          if (clean.length > 0) {
            resolve(clean);
            return;
          }
          if (error) {
            reject(new Error(`Claude CLI resume error: ${error.message}${stderr ? `\n${stderr.slice(0, 1000)}` : ""}`));
            return;
          }
          resolve(clean);
        },
      );

      if (child.pid && onPid) {
        onPid(child.pid);
      }
    });
  }

  /**
   * Detect the newest session file created after `beforeTimestamp`
   * in the Claude projects directory matching `projectCwd`.
   */
  detectNewSession(projectCwd: string, beforeTimestamp: Date): string | null {
    const encodedDir = this.encodeProjectCwd(projectCwd);
    const projDir = join(this.getSessionsDir(), encodedDir);

    if (!existsSync(projDir)) return null;

    let newestId: string | null = null;
    let newestMtime = beforeTimestamp.getTime();

    for (const file of readdirSync(projDir)) {
      if (!file.endsWith(".jsonl")) continue;
      const filePath = join(projDir, file);
      const stat = statSync(filePath);
      if (stat.mtime.getTime() > newestMtime) {
        newestMtime = stat.mtime.getTime();
        newestId = basename(file, ".jsonl");
      }
    }

    return newestId;
  }

  /**
   * Analyze a Claude session JSONL file for health indicators.
   * Delegates to the shared implementation in jsonl-parser.ts.
   */
  analyzeSessionHealth(sessionId: string, knownFilePath?: string): SessionAnalysis | null {
    return analyzeClaudeSessionHealth(sessionId, knownFilePath);
  }
}

// ─── Self-registration ───────────────────────────────────────

registerRuntime("claude", () => new ClaudeAgentRuntime());
