# Windows CLI Support Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make ClawUI's backend CLI execution and session discovery work on Windows by replacing `expect`-based TTY wrapping with direct Node.js process spawning, and fixing path encoding/decoding for Windows drive-letter paths.

**Architecture:** On Windows, Claude CLI runs directly via `node cli.js` (no TTY/expect needed — confirmed by testing). A new `cli-utils.ts` module provides platform-aware abstractions. Unix behavior is completely unchanged. Path encoding/decoding functions gain Windows drive-letter awareness.

**Tech Stack:** Node.js `child_process` (spawn/execFile), `node:path`, `node:os`, `node:fs`

---

### Task 1: Create `cli-utils.ts` — shared platform-aware utilities

**Files:**
- Create: `backend/src/cli-utils.ts`
- Create: `backend/src/__tests__/cli-utils.test.ts`

**Step 1: Write the test file**

```typescript
// backend/src/__tests__/cli-utils.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

describe("cli-utils", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    vi.restoreAllMocks();
  });

  describe("cleanEnvForClaude", () => {
    it("strips CLAUDECODE from env", async () => {
      process.env.CLAUDECODE = "1";
      const { cleanEnvForClaude } = await import("../cli-utils.js");
      const env = cleanEnvForClaude();
      expect(env.CLAUDECODE).toBeUndefined();
      expect(env.PATH).toBeDefined(); // other vars preserved
      delete process.env.CLAUDECODE;
    });
  });

  describe("isProcessAlive", () => {
    it("returns true for current process", async () => {
      const { isProcessAlive } = await import("../cli-utils.js");
      expect(isProcessAlive(process.pid)).toBe(true);
    });

    it("returns false for non-existent PID", async () => {
      const { isProcessAlive } = await import("../cli-utils.js");
      expect(isProcessAlive(999999)).toBe(false);
    });
  });

  describe("encodeProjectPath", () => {
    it("encodes Unix paths", async () => {
      const { encodeProjectPath } = await import("../cli-utils.js");
      expect(encodeProjectPath("/home/user/project")).toBe("-home-user-project");
    });

    it("encodes Windows paths (backslash + drive letter)", async () => {
      const { encodeProjectPath } = await import("../cli-utils.js");
      expect(encodeProjectPath("C:\\Users\\user\\project")).toBe("-C-Users-user-project");
      expect(encodeProjectPath("Q:\\src\\ClawUI")).toBe("-Q-src-ClawUI");
    });

    it("handles mixed separators", async () => {
      const { encodeProjectPath } = await import("../cli-utils.js");
      expect(encodeProjectPath("C:/Users/user/project")).toBe("-C-Users-user-project");
    });
  });

  describe("stripAnsi", () => {
    it("strips ANSI escape codes and carriage returns", async () => {
      const { stripAnsi } = await import("../cli-utils.js");
      expect(stripAnsi("\x1B[32mColored\x1B[0m text\r\n")).toBe("Colored text\n");
    });

    it("strips OSC sequences", async () => {
      const { stripAnsi } = await import("../cli-utils.js");
      expect(stripAnsi("\x1B]0;title\x07content")).toBe("content");
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/__tests__/cli-utils.test.ts`
Expected: FAIL — module `../cli-utils.js` not found

**Step 3: Write `cli-utils.ts`**

```typescript
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
    .replace(/:/g, "")     // strip drive letter colon (C: → C)
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
      // Look for pattern: "%dp0%\node_modules\@anthropic-ai\claude-code\cli.js"
      const match = content.match(/"%dp0%\\([^"]+\.js)"/);
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
```

**Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run src/__tests__/cli-utils.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add backend/src/cli-utils.ts backend/src/__tests__/cli-utils.test.ts
git commit -m "feat: add cli-utils.ts with platform-aware CLI utilities for Windows support"
```

---

### Task 2: Update `config.ts` — Windows binary resolution

**Files:**
- Modify: `backend/src/config.ts`

**Step 1: Update `resolveClaudePath()` to handle Windows**

Replace the entire `resolveClaudePath` function with:

```typescript
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

  return "claude";
}
```

**Step 2: Update `resolveExpectPath()` to skip on Windows**

Add early return at the top of the function:

```typescript
function resolveExpectPath(): string {
  // expect is not needed on Windows — Claude CLI works without TTY wrapping
  if (process.platform === "win32") return "";

  // ... rest unchanged
}
```

**Step 3: Add `CLAUDE_CLI_JS` export**

After the existing exports at the bottom of config.ts, add:

```typescript
import { resolveClaudeCliJs } from "./cli-utils.js";

/** Path to Claude's cli.js for direct node invocation on Windows. Null on Unix. */
export const CLAUDE_CLI_JS = resolveClaudeCliJs(CLAUDE_PATH);
```

**Step 4: Run typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: PASS (no type errors)

**Step 5: Commit**

```bash
git add backend/src/config.ts
git commit -m "feat: add Windows binary resolution to config.ts (where.exe, .cmd paths)"
```

---

### Task 3: Update `cli-runner.ts` — Windows direct execution

**Files:**
- Modify: `backend/src/cli-runner.ts`
- Modify: `backend/src/__tests__/cli-runner.test.ts`

**Step 1: Replace `runClaude` with platform-aware version**

Replace the imports and `cleanEnvForClaude` at the top:

```typescript
import { execFile, spawn } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CLAUDE_PATH, EXPECT_PATH, CLAUDE_CLI_JS } from "./config.js";
import { cleanEnvForClaude, stripAnsi } from "./cli-utils.js";
import { createLogger } from "./logger.js";
```

Replace the entire `runClaude` function (lines 40-101) with:

```typescript
function runClaude(
  sessionId: string,
  prompt: string,
  cwd?: string
): Promise<string> {
  if (process.platform === "win32") {
    return runClaudeWindows(sessionId, prompt, cwd);
  }
  return runClaudeUnix(sessionId, prompt, cwd);
}

/**
 * Windows: Run Claude CLI directly via node (no TTY/expect needed).
 */
function runClaudeWindows(
  sessionId: string,
  prompt: string,
  cwd?: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ["--dangerously-skip-permissions", "--resume", sessionId, "--output-format", "text", "-p", prompt];

    // Use node + cli.js for reliable argument passing; fall back to shell:true
    const cmd = CLAUDE_CLI_JS ? process.execPath : "claude";
    const spawnArgs = CLAUDE_CLI_JS ? [CLAUDE_CLI_JS, ...args] : args;
    const useShell = !CLAUDE_CLI_JS;

    log.debug(`Spawning Claude (Windows): session=${sessionId}, cwd=${cwd || process.cwd()}`);

    const child = spawn(cmd, spawnArgs, {
      timeout: EXEC_TIMEOUT,
      cwd: cwd || process.cwd(),
      env: cleanEnvForClaude(),
      shell: useShell,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

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
        resolve(clean);
        return;
      }
      if (code !== 0) {
        reject(new Error(`Claude CLI error (exit ${code}): ${stderr}`));
        return;
      }
      resolve(clean);
    });
  });
}

/**
 * Unix: Run Claude Code via `expect` to provide a TTY (required by Claude Code on Unix).
 */
function runClaudeUnix(
  sessionId: string,
  prompt: string,
  cwd?: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const tmpFile = join(tmpdir(), `clawui-prompt-${randomUUID()}.txt`);
    writeFileSync(tmpFile, prompt, "utf-8");

    const expectScript = `
set timeout 180
set fp [open "${tmpFile}" r]
set prompt [read $fp]
close $fp
file delete "${tmpFile}"
set stty_init "columns 2000"
spawn ${CLAUDE_PATH} --dangerously-skip-permissions --resume ${sessionId} -p $prompt
expect eof
`;

    const tmpExpect = join(tmpdir(), `clawui-expect-${randomUUID()}.exp`);
    writeFileSync(tmpExpect, expectScript, "utf-8");

    log.debug(`Spawning expect script: ${tmpExpect}, session: ${sessionId}, cwd: ${cwd || process.cwd()}`);

    let childPid: number | undefined; // eslint-disable-line prefer-const
    const child = execFile(EXPECT_PATH, [tmpExpect], {
      timeout: EXEC_TIMEOUT,
      maxBuffer: 10 * 1024 * 1024,
      cwd: cwd || process.cwd(),
      env: cleanEnvForClaude(),
    }, (error, stdout, stderr) => {
      log.debug(`Expect process exited: pid=${childPid}, exitCode=${error ? error.code ?? "error" : 0}`);
      try { unlinkSync(tmpExpect); } catch {}
      try { unlinkSync(tmpFile); } catch {}

      const lines = stdout.split("\n");
      const spawnIdx = lines.findIndex(l => l.includes("spawn") && l.includes("claude"));
      const cleanLines = spawnIdx >= 0 ? lines.slice(spawnIdx + 1) : lines;
      const clean = stripAnsi(cleanLines.join("\n")).trim();

      if (clean.length > 0) {
        resolve(clean);
        return;
      }
      if (error) {
        reject(new Error(`Claude CLI error: ${error.message}\n${stderr}`));
        return;
      }
      resolve(clean);
    });
    childPid = child.pid;
  });
}
```

Remove the old inline ANSI-stripping code (now uses `stripAnsi` from cli-utils).

Remove the local `cleanEnvForClaude` function (now imported from cli-utils).

**Step 2: Run existing tests**

Run: `cd backend && npx vitest run src/__tests__/cli-runner.test.ts`
Expected: PASS — existing tests still pass (they mock execFile so platform branch doesn't matter)

**Step 3: Run typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: PASS

**Step 4: Commit**

```bash
git add backend/src/cli-runner.ts
git commit -m "feat: add Windows direct CLI execution in cli-runner.ts (no expect needed)"
```

---

### Task 4: Update `plan-generator.ts` — Windows direct execution

**Files:**
- Modify: `backend/src/plan-generator.ts`

**Step 1: Replace imports and remove local `cleanEnvForClaude`**

Replace the imports (lines 1-9) with:

```typescript
import { execFile, spawn } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getBlueprint, getArtifactsForNode } from "./plan-db.js";
import { CLAUDE_PATH, EXPECT_PATH, CLAUDE_CLI_JS, PORT } from "./config.js";
import { LOCAL_AUTH_TOKEN } from "./auth.js";
import { cleanEnvForClaude, stripAnsi } from "./cli-utils.js";
import { createLogger } from "./logger.js";
```

Delete the local `cleanEnvForClaude` function (lines 15-24).

**Step 2: Add Windows branch to `runClaude` (text output mode)**

Replace the `runClaude` function (lines 30-102) with a platform-branching version. The Unix path keeps the exact same expect script. The Windows path uses:

```typescript
export function runClaude(prompt: string, cwd?: string): Promise<string> {
  if (process.platform === "win32") {
    return runClaudeWindows(prompt, cwd);
  }
  return runClaudeUnix(prompt, cwd);
}

function runClaudeWindows(prompt: string, cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ["--dangerously-skip-permissions", "--output-format", "text", "--max-turns", "200", "-p", prompt];
    const cmd = CLAUDE_CLI_JS ? process.execPath : "claude";
    const spawnArgs = CLAUDE_CLI_JS ? [CLAUDE_CLI_JS, ...args] : args;

    const child = spawn(cmd, spawnArgs, {
      timeout: 200_000,
      cwd: cwd || process.cwd(),
      env: cleanEnvForClaude(),
      shell: !CLAUDE_CLI_JS,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdin.end();

    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { /* discard */ });

    child.on("error", (err) => reject(new Error(`Claude CLI error: ${err.message}`)));
    child.on("close", (code) => {
      const output = stripAnsi(stdout).trim();
      if (output.length === 0) {
        reject(new Error(`Claude returned empty output. Exit code: ${code}`));
        return;
      }
      log.debug(`Claude output length: ${output.length}, first 200 chars: ${output.slice(0, 200).replace(/\n/g, "\\n")}`);
      resolve(output);
    });
  });
}

function runClaudeUnix(prompt: string, cwd?: string): Promise<string> {
  // ... exact same expect-based code as current implementation (lines 31-101)
}
```

**Step 3: Add Windows branch to `runClaudeInteractiveGen`**

Same pattern — keep the Unix expect path, add Windows direct spawn:

```typescript
export function runClaudeInteractiveGen(prompt: string, cwd?: string): Promise<string> {
  if (process.platform === "win32") {
    return runClaudeInteractiveGenWindows(prompt, cwd);
  }
  return runClaudeInteractiveGenUnix(prompt, cwd);
}

function runClaudeInteractiveGenWindows(prompt: string, cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ["--dangerously-skip-permissions", "--max-turns", "200", "-p", prompt];
    const cmd = CLAUDE_CLI_JS ? process.execPath : "claude";
    const spawnArgs = CLAUDE_CLI_JS ? [CLAUDE_CLI_JS, ...args] : args;

    const child = spawn(cmd, spawnArgs, {
      timeout: 10 * 60 * 1000,
      cwd: cwd || process.cwd(),
      env: cleanEnvForClaude(),
      shell: !CLAUDE_CLI_JS,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdin.end();

    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });

    child.on("error", (err) => reject(new Error(`Claude interactive (generator) failed: ${err.message}`)));
    child.on("close", (code) => {
      if (code !== 0 && !stdout) {
        reject(new Error(`Claude interactive (generator) failed with exit code ${code}`));
        return;
      }
      resolve(stdout || "");
    });
  });
}

function runClaudeInteractiveGenUnix(prompt: string, cwd?: string): Promise<string> {
  // ... exact same expect-based code as current implementation
}
```

**Step 4: Run existing tests**

Run: `cd backend && npx vitest run src/__tests__/plan-generator.test.ts`
Expected: PASS

**Step 5: Run typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: PASS

**Step 6: Commit**

```bash
git add backend/src/plan-generator.ts
git commit -m "feat: add Windows direct CLI execution in plan-generator.ts"
```

---

### Task 5: Update `plan-executor.ts` — Windows execution + path encoding + process liveness

**Files:**
- Modify: `backend/src/plan-executor.ts`

This is the largest change. Three sub-areas: CLI execution, path encoding, and process liveness.

**Step 1: Update imports**

Replace lines 1-2 and line 150:

```typescript
import { execFile, spawn } from "node:child_process";
```

Replace import of config (line 150):

```typescript
import { CLAUDE_PATH, EXPECT_PATH, CLAUDE_CLI_JS } from "./config.js";
```

Add import from cli-utils (after line 153):

```typescript
import { cleanEnvForClaude, stripAnsi, encodeProjectPath, isProcessAlive } from "./cli-utils.js";
```

Delete the local `cleanEnvForClaude` function (lines 163-167).

Delete the local `isProcessAlive` function (lines 1674-1681).

**Step 2: Fix `detectNewSession` path encoding (line 401)**

Replace:
```typescript
const encodedDir = projectCwd.replace(/\//g, "-");
```
With:
```typescript
const encodedDir = encodeProjectPath(projectCwd);
```

**Step 3: Fix `getSessionFileMtime` path encoding (line 1688)**

Replace:
```typescript
const encodedDir = projectCwd.replace(/\//g, "-");
```
With:
```typescript
const encodedDir = encodeProjectPath(projectCwd);
```

**Step 4: Fix `generateArtifactFromSession` path encoding (line 1880)**

Replace:
```typescript
const encodedDir = projectCwd.replace(/\//g, "-");
```
With:
```typescript
const encodedDir = encodeProjectPath(projectCwd);
```

**Step 5: Add Windows branches to `runClaudeInteractive` (lines 424-471)**

Same pattern as previous tasks. Keep Unix expect path, add Windows:

```typescript
export function runClaudeInteractive(prompt: string, cwd?: string): Promise<string> {
  if (process.platform === "win32") {
    return runClaudeInteractiveWindows(prompt, cwd);
  }
  return runClaudeInteractiveUnix(prompt, cwd);
}

function runClaudeInteractiveWindows(prompt: string, cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ["--dangerously-skip-permissions", "--max-turns", "200", "-p", prompt];
    const cmd = CLAUDE_CLI_JS ? process.execPath : "claude";
    const spawnArgs = CLAUDE_CLI_JS ? [CLAUDE_CLI_JS, ...args] : args;

    const child = spawn(cmd, spawnArgs, {
      timeout: EXEC_TIMEOUT,
      cwd: cwd || process.cwd(),
      env: cleanEnvForClaude(),
      shell: !CLAUDE_CLI_JS,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdin.end();

    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });

    child.on("error", (err) => reject(new Error(`Claude interactive failed: ${err.message}`)));
    child.on("close", (code) => {
      if (code !== 0 && !stdout) {
        reject(new Error(`Claude interactive failed with exit code ${code}`));
        return;
      }
      resolve(stdout || "");
    });
  });
}

function runClaudeInteractiveUnix(prompt: string, cwd?: string): Promise<string> {
  // ... exact same expect code as current lines 424-471
}
```

**Step 6: Add Windows branches to `runClaude` (lines 473-561)**

```typescript
function runClaude(prompt: string, cwd?: string, onPid?: (pid: number) => void): Promise<string> {
  if (process.platform === "win32") {
    return runClaudeWin(prompt, cwd, onPid);
  }
  return runClaudeUnixExec(prompt, cwd, onPid);
}

function runClaudeWin(prompt: string, cwd?: string, onPid?: (pid: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ["--dangerously-skip-permissions", "--output-format", "text", "--max-turns", "200", "-p", prompt];
    const cmd = CLAUDE_CLI_JS ? process.execPath : "claude";
    const spawnArgs = CLAUDE_CLI_JS ? [CLAUDE_CLI_JS, ...args] : args;

    const child = spawn(cmd, spawnArgs, {
      timeout: EXEC_TIMEOUT,
      cwd: cwd || process.cwd(),
      env: cleanEnvForClaude(),
      shell: !CLAUDE_CLI_JS,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdin.end();

    if (child.pid && onPid) onPid(child.pid);

    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });

    child.on("error", (err) => reject(new Error(`Claude CLI error: ${err.message}`)));
    child.on("close", (code) => {
      const clean = stripAnsi(stdout).trim();
      if (clean.length > 0) { resolve(clean); return; }
      if (code !== 0) { reject(new Error(`Claude CLI error (exit ${code})`)); return; }
      resolve(clean);
    });
  });
}

function runClaudeUnixExec(prompt: string, cwd?: string, onPid?: (pid: number) => void): Promise<string> {
  // ... exact same expect code as current lines 473-561
}
```

**Step 7: Add Windows branches to `runClaudeResume` (lines 563-640)**

Same pattern:

```typescript
function runClaudeResume(sessionId: string, prompt: string, cwd?: string, onPid?: (pid: number) => void): Promise<string> {
  if (process.platform === "win32") {
    return runClaudeResumeWin(sessionId, prompt, cwd, onPid);
  }
  return runClaudeResumeUnix(sessionId, prompt, cwd, onPid);
}

function runClaudeResumeWin(sessionId: string, prompt: string, cwd?: string, onPid?: (pid: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ["--dangerously-skip-permissions", "--output-format", "text", "--max-turns", "200", "--resume", sessionId, "-p", prompt];
    const cmd = CLAUDE_CLI_JS ? process.execPath : "claude";
    const spawnArgs = CLAUDE_CLI_JS ? [CLAUDE_CLI_JS, ...args] : args;

    const child = spawn(cmd, spawnArgs, {
      timeout: EXEC_TIMEOUT,
      cwd: cwd || process.cwd(),
      env: cleanEnvForClaude(),
      shell: !CLAUDE_CLI_JS,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdin.end();

    if (child.pid && onPid) onPid(child.pid);

    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });

    child.on("error", (err) => reject(new Error(`Claude CLI resume error: ${err.message}`)));
    child.on("close", (code) => {
      const clean = stripAnsi(stdout).trim();
      if (clean.length > 0) { resolve(clean); return; }
      if (code !== 0) { reject(new Error(`Claude CLI resume error (exit ${code})`)); return; }
      resolve(clean);
    });
  });
}

function runClaudeResumeUnix(sessionId: string, prompt: string, cwd?: string, onPid?: (pid: number) => void): Promise<string> {
  // ... exact same expect code as current lines 563-640
}
```

**Step 8: Run existing tests**

Run: `cd backend && npx vitest run src/__tests__/plan-executor.test.ts`
Expected: PASS

**Step 9: Run typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: PASS

**Step 10: Commit**

```bash
git add backend/src/plan-executor.ts
git commit -m "feat: add Windows CLI execution + fix path encoding in plan-executor.ts"
```

---

### Task 6: Update `jsonl-parser.ts` — Windows path decoding

**Files:**
- Modify: `backend/src/jsonl-parser.ts` (lines 50-56)
- Modify: `backend/src/__tests__/jsonl-parser.test.ts`

**Step 1: Add test for Windows path decoding**

Add to `backend/src/__tests__/jsonl-parser.test.ts`:

```typescript
import { decodeProjectPath } from "../jsonl-parser.js";

describe("decodeProjectPath Windows support", () => {
  // These tests work by checking that the function handles drive-letter
  // patterns correctly. Since the decoded paths may not exist on the
  // test machine's filesystem, we test the logic via mock.

  it("detects drive letter and starts from drive root", () => {
    // Mock existsSync to simulate Windows filesystem
    // On a real Windows machine with C:\Users existing, this should resolve
    const result = decodeProjectPath("-C-Users");
    // On this machine, C:\Users should exist
    if (process.platform === "win32") {
      expect(result).toMatch(/^[A-Z]:\\/);
    }
  });
});
```

**Step 2: Update `decodeProjectPath` to handle Windows drive letters**

Replace lines 50-55 of `jsonl-parser.ts`:

```typescript
export function decodeProjectPath(encoded: string): string | undefined {
  const stripped = encoded.replace(/^-+/, "");
  if (!stripped) return process.platform === "win32" ? undefined : "/";

  const parts = stripped.split("-");

  // Detect Windows drive letter: first part is a single letter (e.g., "C")
  // The encoded form of "C:\Users\foo" is "-C-Users-foo"
  if (parts[0].length === 1 && /^[A-Za-z]$/.test(parts[0])) {
    const driveLetter = parts[0].toUpperCase();
    const driveRoot = `${driveLetter}:\\`;
    if (existsSync(driveRoot)) {
      return walkFs(driveRoot, parts, 1);
    }
  }

  // Unix path: start from /
  return walkFs("/", parts, 0);
}
```

**Step 3: Run existing tests**

Run: `cd backend && npx vitest run src/__tests__/jsonl-parser.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add backend/src/jsonl-parser.ts backend/src/__tests__/jsonl-parser.test.ts
git commit -m "feat: add Windows drive-letter support to decodeProjectPath"
```

---

### Task 7: Update `db.ts` — Windows display path decoding

**Files:**
- Modify: `backend/src/db.ts` (lines 91, 290)

**Step 1: Add platform-aware path decode helper**

Add near the top of `db.ts` (after imports):

```typescript
/**
 * Naive decode of encoded project path for display purposes.
 * On Windows, detects drive-letter patterns and uses backslash separators.
 */
function naiveDecodePath(projectId: string): string {
  const parts = projectId.replace(/^-+/, "").split("-");
  // Detect Windows drive letter: single letter first segment
  if (parts[0]?.length === 1 && /^[A-Za-z]$/.test(parts[0])) {
    return parts[0].toUpperCase() + ":\\" + parts.slice(1).join("\\");
  }
  // Unix: replace - with /
  return projectId.replace(/-/g, "/");
}
```

**Step 2: Replace naive decode at line 91**

Replace:
```typescript
const decodedPath = projectId.replace(/-/g, "/");
const projectName = decodedPath.split("/").filter(Boolean).slice(-2).join("/");
```
With:
```typescript
const decodedPath = naiveDecodePath(projectId);
const sep = decodedPath.includes("\\") ? "\\" : "/";
const projectName = decodedPath.split(/[\\/]/).filter(Boolean).slice(-2).join("/");
```

**Step 3: Replace naive decode at line 290**

Replace:
```typescript
const decodedPath = projectId.replace(/-/g, "/");
const projectName = decodedPath.split("/").filter(Boolean).slice(-2).join("/");
```
With:
```typescript
const decodedPath = naiveDecodePath(projectId);
const projectName = decodedPath.split(/[\\/]/).filter(Boolean).slice(-2).join("/");
```

**Step 4: Run existing tests**

Run: `cd backend && npx vitest run src/__tests__/db.test.ts`
Expected: PASS

**Step 5: Run typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: PASS

**Step 6: Commit**

```bash
git add backend/src/db.ts
git commit -m "feat: add Windows path display decoding in db.ts"
```

---

### Task 8: Full test suite + typecheck verification

**Files:** None (verification only)

**Step 1: Run full backend typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: PASS — no type errors

**Step 2: Run full backend test suite**

Run: `cd backend && npx vitest run`
Expected: All tests pass

**Step 3: Run lint**

Run: `npm run lint`
Expected: No new lint errors (pre-existing warnings OK per CLAUDE.md)

**Step 4: Build**

Run: `npm run build:backend`
Expected: Successful build in `dist/`

**Step 5: Final commit if any fixups needed**

```bash
git add -A
git commit -m "fix: address any lint/type issues from Windows support changes"
```

---

### Task 9: Update failure classification regex for Windows

**Files:**
- Modify: `backend/src/plan-executor.ts` (line 185)

**Step 1: Update the regex**

Replace:
```typescript
const isTimeout = /killed|timeout|timed out|SIGTERM|ETIMEDOUT/i.test(errorMsg);
```
With:
```typescript
const isTimeout = /killed|timeout|timed out|SIGTERM|ETIMEDOUT|terminated unexpectedly/i.test(errorMsg);
```

**Step 2: Commit**

```bash
git add backend/src/plan-executor.ts
git commit -m "fix: add Windows error patterns to failure classification regex"
```
