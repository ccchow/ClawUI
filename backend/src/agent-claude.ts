/**
 * Claude Code agent runtime implementation.
 *
 * Extracts all Claude-specific CLI invocation logic (expect scripts, TTY handling,
 * env cleaning, session detection) into a single class implementing AgentRuntime.
 */

import { execFile } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { CLAUDE_PATH, EXPECT_PATH } from "./config.js";
import { createLogger } from "./logger.js";
import type { AgentRuntime, AgentCapabilities } from "./agent-runtime.js";
import { registerRuntime } from "./agent-runtime.js";

const log = createLogger("agent-claude");

const EXEC_TIMEOUT = 30 * 60 * 1000; // 30 minutes per node

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
      .replace(/\/\./g, "/-")   // encode leading dots in path components
      .replace(/\//g, "-");      // encode path separators
  }

  cleanEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    return env;
  }

  /**
   * Strip ANSI escape codes and carriage returns from CLI output.
   */
  private stripAnsi(text: string): string {
    return text
      .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "")
      .replace(/\x1B\][^\x07]*\x07/g, "")
      .replace(/\r/g, "")
      .trim();
  }

  /**
   * Run Claude in text output mode (--output-format text).
   * Uses expect for TTY, captures output via temp file to avoid echo contamination.
   */
  runSession(prompt: string, cwd?: string, onPid?: (pid: number) => void): Promise<string> {
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
          env: this.cleanEnv(),
        },
        (error) => {
          // Read output from file (avoids TTY echo contamination)
          let clean = "";
          try {
            clean = this.stripAnsi(readFileSync(outputFile, "utf-8"));
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
            reject(new Error(`Claude CLI error: ${error.message}`));
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
          env: this.cleanEnv(),
        },
        (error, stdout) => {
          try { unlinkSync(tmpExpect); } catch { /* ignore */ }
          try { unlinkSync(tmpFile); } catch { /* ignore */ }

          if (error) {
            reject(new Error(`Claude interactive failed: ${error.message}`));
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
          env: this.cleanEnv(),
        },
        (error) => {
          let clean = "";
          try {
            clean = this.stripAnsi(readFileSync(outputFile, "utf-8"));
          } catch { /* no output file */ }

          try { unlinkSync(tmpExpect); } catch { /* ignore */ }
          try { unlinkSync(tmpFile); } catch { /* ignore */ }
          try { unlinkSync(outputFile); } catch { /* ignore */ }

          if (clean.length > 0) {
            resolve(clean);
            return;
          }
          if (error) {
            reject(new Error(`Claude CLI resume error: ${error.message}`));
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
}

// ─── Plan-generator compatible helpers ───────────────────────

/**
 * Run Claude in text output mode for simple generation tasks (e.g. artifact generation).
 * This is a simpler variant used by plan-generator.ts with shorter timeouts.
 *
 * Note: This is kept as a standalone function (not a class method) because
 * plan-generator.ts uses slightly different expect scripts (shorter timeout,
 * log_user 0, etc.). The runtime class methods are used by plan-executor.ts.
 */
export function runClaudeTextMode(prompt: string, cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const promptFile = join(tmpdir(), `clawui-gen-${randomUUID()}.txt`);
    const outputFile = join(tmpdir(), `clawui-gen-${randomUUID()}.out`);
    const expectFile = join(tmpdir(), `clawui-gen-${randomUUID()}.exp`);
    writeFileSync(promptFile, prompt, "utf-8");

    const expectScript = `
log_user 0
set timeout 180
set stty_init "columns 2000"
match_max 1000000

set fp [open "${promptFile}" r]
set prompt_text [read -nonewline $fp]
close $fp

set of [open "${outputFile}" w]
set output ""

spawn ${CLAUDE_PATH} --dangerously-skip-permissions --output-format text -p $prompt_text
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
puts -nonewline $of $output
close $of
`;
    writeFileSync(expectFile, expectScript, "utf-8");

    const env = { ...process.env };
    delete env.CLAUDECODE;

    execFile(EXPECT_PATH, [expectFile], {
      timeout: 200_000,
      maxBuffer: 10 * 1024 * 1024,
      cwd: cwd || process.cwd(),
      env,
    }, (error) => {
      let output = "";
      try {
        output = readFileSync(outputFile, "utf-8").trim();
      } catch { /* no output file */ }

      try { unlinkSync(promptFile); } catch { /* */ }
      try { unlinkSync(outputFile); } catch { /* */ }
      try { unlinkSync(expectFile); } catch { /* */ }

      output = output
        .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "")
        .replace(/\x1B\][^\x07]*\x07/g, "")
        .replace(/\r/g, "")
        .trim();

      if (output.length === 0) {
        reject(new Error(`Claude returned empty output. expect error: ${error?.message?.slice(0, 300) ?? "none"}`));
        return;
      }
      log.debug(`Claude output length: ${output.length}, first 200 chars: ${output.slice(0, 200).replace(/\n/g, "\\n")}`);
      resolve(output);
    });
  });
}

/**
 * Run Claude in interactive mode for generator tasks.
 * Shorter timeout variant used by plan-generator.ts.
 */
export function runClaudeInteractiveMode(prompt: string, cwd?: string): Promise<string> {
  const INTERACTIVE_TIMEOUT = 10 * 60 * 1000; // 10 min

  return new Promise((resolve, reject) => {
    const tmpFile = join(tmpdir(), `clawui-gen-prompt-${randomUUID()}.txt`);
    writeFileSync(tmpFile, prompt, "utf-8");

    const fullScript = `
set timeout 600
set stty_init "columns 2000"
set fp [open "${tmpFile}" r]
set prompt [read -nonewline $fp]
close $fp
file delete "${tmpFile}"
spawn ${CLAUDE_PATH} --dangerously-skip-permissions -p $prompt
expect eof
catch {wait}
`;

    const tmpExpect = join(tmpdir(), `clawui-gen-expect-${randomUUID()}.exp`);
    writeFileSync(tmpExpect, fullScript, "utf-8");

    const env = { ...process.env };
    delete env.CLAUDECODE;

    execFile(
      EXPECT_PATH,
      [tmpExpect],
      {
        timeout: INTERACTIVE_TIMEOUT,
        maxBuffer: 10 * 1024 * 1024,
        cwd: cwd || process.cwd(),
        env,
      },
      (error, stdout) => {
        try { unlinkSync(tmpExpect); } catch { /* ignore */ }
        try { unlinkSync(tmpFile); } catch { /* ignore */ }

        if (error) {
          reject(new Error(`Claude interactive (generator) failed: ${error.message}`));
          return;
        }
        resolve(stdout || "");
      },
    );
  });
}

// ─── Self-registration ───────────────────────────────────────

registerRuntime("claude", () => new ClaudeAgentRuntime());
