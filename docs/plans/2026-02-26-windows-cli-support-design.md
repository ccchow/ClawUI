# Windows CLI Support — Design

## Context

ClawUI's backend wraps Claude CLI invocations in Unix `expect` for TTY emulation. `expect` doesn't exist on Windows, blocking all CLI functionality. Testing confirmed Claude CLI works perfectly via direct `execFile`/`spawn` on Windows without TTY wrapping.

## Tested Approach

```js
// Runs node.exe directly against cli.js — no .cmd, no shell, no quoting issues
spawn(process.execPath, [cliJsPath, ...args], {
  shell: false,
  env: cleanEnvForClaude(),
  stdio: ["pipe", "pipe", "pipe"],
});
child.stdin.end(); // prevent hanging
```

All modes verified: `--output-format text`, `--output-format json`, `--dangerously-skip-permissions`, multi-word prompts.

## Changes

### New: `backend/src/cli-utils.ts`

Shared utilities extracted from 3 files:
- `cleanEnvForClaude()` — consolidated (was duplicated in cli-runner, plan-executor, plan-generator)
- `resolveClaudeCliJs()` — parse `claude.cmd` to find `cli.js` path on Windows
- `spawnClaude(args, opts)` → `{ stdout, stderr, exitCode, pid }` — platform-aware:
  - Windows: `spawn(node, [cli.js, ...args])` with stdin.end()
  - Unix: existing expect script (unchanged)
- `spawnClaudeStreaming(args, opts)` → `ChildProcess` — for long-running executions needing PID tracking
- `isProcessAlive(pid)` — Windows: `tasklist` check; Unix: `kill(pid, 0)`

### Modified: `backend/src/config.ts`

- `resolveClaudePath()`: Add Windows candidates (`%APPDATA%\npm\claude.cmd`), use `where.exe` instead of `/usr/bin/which`
- `resolveExpectPath()`: Return empty string on `win32` (not needed)
- Export new `CLAUDE_CLI_JS` for direct node invocation on Windows

### Modified: `backend/src/cli-runner.ts`

- Import `spawnClaude` from cli-utils
- `runClaude()`: Windows branch uses `spawnClaude()` instead of expect script
- Keep Unix expect path unchanged

### Modified: `backend/src/plan-executor.ts`

- Import from cli-utils, remove local `cleanEnvForClaude()`
- `runClaude()`, `runClaudeInteractive()`, `runClaudeResume()`: Add Windows branches
- `isProcessAlive()`: Use platform-aware version from cli-utils
- `detectNewSession()`, `getSessionFileMtime()`, `generateArtifactFromSession()`: Fix path encoding to handle `\` and `:`

### Modified: `backend/src/plan-generator.ts`

- Import from cli-utils, remove local `cleanEnvForClaude()`
- `runClaudeInteractiveGen()`: Add Windows branch

### Modified: `backend/src/jsonl-parser.ts`

- `decodeProjectPath()`: Detect Windows drive letter paths, start walk from `C:\` instead of `/`

### Modified: `backend/src/db.ts`

- Display path decode: platform-aware for Windows backslash paths

## Not In Scope

- Shell script rewrites (`.sh` → Node.js or `.ps1`)
- `cross-env` for npm scripts
- CI Windows matrix
- `.gitattributes`
- Auth token file permissions
