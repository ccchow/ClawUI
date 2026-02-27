# Windows Support — All Workstreams Master Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make ClawUI fully functional on Windows across all layers — CLI execution, path handling, npm scripts, shell scripts, CI, and the global CLI launcher.

**Architecture:** Five independent workstreams, each buildable and testable in isolation. Workstream 1 (CLI/TTY) is the critical path — everything else can proceed in parallel. Unix behavior is never changed; all modifications are additive `if (process.platform === "win32")` branches or cross-platform replacements.

**Tech Stack:** Node.js child_process (spawn/execFile), cross-env, cross-spawn, node:path, node:os

**Workstream dependency graph:**
```
WS1 (CLI/TTY + paths)  ← Must be first — unblocks core functionality
WS2 (npm scripts)      ← Independent, quick win
WS3 (CLI launcher)     ← Independent, quick win
WS4 (shell scripts)    ← Independent, most work
WS5 (CI + .gitattributes) ← Independent, low risk
```

---

## Workstream 1: CLI Execution + Path Handling (BLOCKING)

> This workstream has its own detailed plan: `docs/plans/2026-02-26-windows-cli-support.md`
> It covers Tasks 1-9: cli-utils.ts, config.ts, cli-runner.ts, plan-generator.ts, plan-executor.ts, jsonl-parser.ts, db.ts, verification, and failure regex.
>
> **Execute that plan first.** The tasks below start at Task 10.

---

## Workstream 2: npm Scripts — cross-env for Inline Env Vars

### Task 10: Add `cross-env` dependency

**Files:**
- Modify: `package.json` (root devDependencies)

**Step 1: Install cross-env**

Run: `npm install --save-dev cross-env`

This adds it to the root package.json devDependencies, available to all workspaces.

**Step 2: Verify install**

Run: `npx cross-env --version`
Expected: Version number printed (e.g., `7.0.3`)

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add cross-env for Windows-compatible npm scripts"
```

---

### Task 11: Update `backend/package.json` scripts to use cross-env

**Files:**
- Modify: `backend/package.json` (scripts section)

**Step 1: Update dev:stable and dev:dev scripts**

Replace:
```json
"dev:stable": "PORT=3001 CLAWUI_DB_DIR=.clawui CLAWUI_DEV=1 node dist/index.js",
"dev:dev": "PORT=3101 CLAWUI_DB_DIR=.clawui-dev tsx watch src/index.ts"
```

With:
```json
"dev:stable": "cross-env PORT=3001 CLAWUI_DB_DIR=.clawui CLAWUI_DEV=1 node dist/index.js",
"dev:dev": "cross-env PORT=3101 CLAWUI_DB_DIR=.clawui-dev tsx watch src/index.ts"
```

**Step 2: Verify scripts parse correctly**

Run: `cd backend && npm run dev:stable --dry-run 2>&1 || true`
(Just verify no npm parse errors — the script itself will fail without a built backend)

**Step 3: Commit**

```bash
git add backend/package.json
git commit -m "feat: use cross-env in backend npm scripts for Windows compat"
```

---

### Task 12: Update `frontend/package.json` scripts to use cross-env

**Files:**
- Modify: `frontend/package.json` (scripts section)

**Step 1: Update dev:stable and dev:dev scripts**

Replace:
```json
"dev:stable": "NEXT_PUBLIC_API_PORT=3001 next start --port 3000 --hostname 127.0.0.1",
"dev:dev": "NEXT_PUBLIC_API_PORT=3101 next dev --port 3100 --hostname 127.0.0.1"
```

With:
```json
"dev:stable": "cross-env NEXT_PUBLIC_API_PORT=3001 next start --port 3000 --hostname 127.0.0.1",
"dev:dev": "cross-env NEXT_PUBLIC_API_PORT=3101 next dev --port 3100 --hostname 127.0.0.1"
```

**Step 2: Commit**

```bash
git add frontend/package.json
git commit -m "feat: use cross-env in frontend npm scripts for Windows compat"
```

---

### Task 13: Update root `package.json` build script

**Files:**
- Modify: `package.json` (root)

**Step 1: Replace fragile cd-chaining with workspace commands**

Replace:
```json
"build": "cd backend && npm run build && cd ../frontend && npm run build",
"build:backend": "cd backend && npm run build",
"build:frontend": "cd frontend && npm run build"
```

With:
```json
"build": "npm run build --workspace=backend && npm run build --workspace=frontend",
"build:backend": "npm run build --workspace=backend",
"build:frontend": "npm run build --workspace=frontend"
```

**Step 2: Verify build works**

Run: `npm run build`
Expected: Both backend and frontend build successfully

**Step 3: Commit**

```bash
git add package.json
git commit -m "refactor: use npm workspace commands for build scripts (cross-platform)"
```

---

## Workstream 3: CLI Launcher (`bin/claw-ui.mjs`)

### Task 14: Fix `spawn("npx")` for Windows

**Files:**
- Modify: `bin/claw-ui.mjs`

**Step 1: Fix the npx spawn issue**

On Windows, `npx` is `npx.cmd` — `spawn("npx", ...)` without `shell: true` fails with ENOENT.

Replace lines 92-97:
```javascript
// Start frontend
const frontend = spawn("npx", ["next", "start", "--port", String(FRONTEND_PORT), "--hostname", "127.0.0.1"], {
  cwd: FRONTEND_DIR,
  stdio: "inherit",
  env: { ...process.env, NEXT_PUBLIC_API_PORT: String(BACKEND_PORT) },
});
```

With:
```javascript
// Start frontend
// On Windows, invoke next directly via node to avoid npx.cmd ENOENT issues.
// On Unix, npx works fine.
const isWin = process.platform === "win32";
const nextBin = join(FRONTEND_DIR, "node_modules", ".next", "..", "..", ".bin", "next");
let frontend;
if (isWin) {
  // Use node to run next's CLI entry point directly
  const nextCliJs = join(FRONTEND_DIR, "node_modules", "next", "dist", "bin", "next");
  frontend = spawn("node", [nextCliJs, "start", "--port", String(FRONTEND_PORT), "--hostname", "127.0.0.1"], {
    cwd: FRONTEND_DIR,
    stdio: "inherit",
    env: { ...process.env, NEXT_PUBLIC_API_PORT: String(BACKEND_PORT) },
  });
} else {
  frontend = spawn("npx", ["next", "start", "--port", String(FRONTEND_PORT), "--hostname", "127.0.0.1"], {
    cwd: FRONTEND_DIR,
    stdio: "inherit",
    env: { ...process.env, NEXT_PUBLIC_API_PORT: String(BACKEND_PORT) },
  });
}
```

**Step 2: Add process exit handler for Windows**

The existing `SIGINT`/`SIGTERM` handlers work on Unix. On Windows, `SIGTERM` is not reliably caught. Add a universal fallback.

After line 123, add:
```javascript
// On Windows, SIGTERM isn't reliably caught. Use 'exit' event as fallback.
if (process.platform === "win32") {
  process.on("exit", () => {
    if (!exiting) {
      exiting = true;
      try { backend.kill(); } catch {}
      try { frontend.kill(); } catch {}
    }
  });
}
```

**Step 3: Test the launcher (manual)**

Run: `node bin/claw-ui.mjs` (requires built backend + frontend)
Expected: Both services start, auth URL printed, Ctrl+C shuts down both

**Step 4: Commit**

```bash
git add bin/claw-ui.mjs
git commit -m "feat: fix CLI launcher for Windows (npx.cmd, signal handling)"
```

---

## Workstream 4: Shell Scripts → Node.js Cross-Platform

### Task 15: Create `scripts/deploy-stable.mjs` (Node.js replacement for deploy-stable.sh)

**Files:**
- Create: `scripts/deploy-stable.mjs`

**Step 1: Write the cross-platform deploy script**

```javascript
#!/usr/bin/env node

import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

console.log("Building backend...");
try {
  execSync("npm run build", { cwd: join(ROOT, "backend"), stdio: "inherit" });
} catch {
  console.error("Backend build failed");
  process.exit(1);
}

console.log("Building frontend...");
try {
  execSync("npm run build", { cwd: join(ROOT, "frontend"), stdio: "inherit" });
} catch {
  console.error("Frontend build failed");
  process.exit(1);
}

console.log("");
console.log("Builds ready. Restart stable to pick up changes:");
console.log("   node scripts/start-stable.mjs");
```

**Step 2: Verify it works**

Run: `node scripts/deploy-stable.mjs`
Expected: Both backend and frontend build successfully

**Step 3: Commit**

```bash
git add scripts/deploy-stable.mjs
git commit -m "feat: add cross-platform deploy-stable.mjs (Node.js replacement for .sh)"
```

---

### Task 16: Create `scripts/start-stable.mjs` (Node.js replacement for start-stable.sh)

**Files:**
- Create: `scripts/start-stable.mjs`

**Step 1: Write the cross-platform start script**

```javascript
#!/usr/bin/env node

import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const isWin = process.platform === "win32";

// ── Kill processes on a port ──
function killPort(port) {
  try {
    if (isWin) {
      // Windows: netstat + taskkill
      const result = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const pids = new Set();
      for (const line of result.trim().split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && pid !== "0") pids.add(pid);
      }
      for (const pid of pids) {
        console.log(`Killing existing process on port ${port} (PID: ${pid})`);
        try { execSync(`taskkill /PID ${pid} /F`, { stdio: "pipe" }); } catch {}
      }
    } else {
      // Unix: lsof + kill
      const pids = execSync(`lsof -ti tcp:${port} 2>/dev/null`, { encoding: "utf-8" }).trim();
      if (pids) {
        console.log(`Killing existing process on port ${port} (PID: ${pids})`);
        execSync(`echo "${pids}" | xargs kill -9 2>/dev/null`, { stdio: "pipe" });
      }
    }
  } catch {
    // No process on port — fine
  }
}

// ── Pre-flight checks ──
if (!existsSync(join(ROOT, "backend", "dist"))) {
  console.error("Backend not built. Run: cd backend && npm run build");
  process.exit(1);
}
if (!existsSync(join(ROOT, "frontend", ".next"))) {
  console.error("Frontend not built. Run: cd frontend && npm run build");
  process.exit(1);
}

// Kill existing processes
killPort(3000);
killPort(3001);

console.log("Starting STABLE environment (from compiled builds)...");
console.log("   Frontend: http://localhost:3000");
console.log("   Backend:  http://localhost:3001");
console.log("   Database: .clawui/");
console.log("");

// Start backend
const backend = spawn("node", ["dist/index.js"], {
  cwd: join(ROOT, "backend"),
  stdio: "inherit",
  env: { ...process.env, PORT: "3001", CLAWUI_DB_DIR: ".clawui", CLAWUI_DEV: "1" },
});

// Start frontend — use node directly on Windows to avoid npx.cmd issues
let frontend;
if (isWin) {
  const nextCliJs = join(ROOT, "frontend", "node_modules", "next", "dist", "bin", "next");
  frontend = spawn("node", [nextCliJs, "start", "--port", "3000", "--hostname", "127.0.0.1"], {
    cwd: join(ROOT, "frontend"),
    stdio: "inherit",
    env: { ...process.env, NEXT_PUBLIC_API_PORT: "3001" },
  });
} else {
  frontend = spawn("npx", ["next", "start", "--port", "3000", "--hostname", "127.0.0.1"], {
    cwd: join(ROOT, "frontend"),
    stdio: "inherit",
    env: { ...process.env, NEXT_PUBLIC_API_PORT: "3001" },
  });
}

console.log(`   Backend PID:  ${backend.pid}`);
console.log(`   Frontend PID: ${frontend.pid}`);

// Clean shutdown
let exiting = false;
function cleanup() {
  if (exiting) return;
  exiting = true;
  try { backend.kill(); } catch {}
  try { frontend.kill(); } catch {}
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
if (isWin) process.on("exit", cleanup);

// Exit when either child dies
backend.on("exit", (code) => { if (!exiting) { cleanup(); process.exit(code ?? 1); } });
frontend.on("exit", (code) => { if (!exiting) { cleanup(); process.exit(code ?? 1); } });
```

**Step 2: Verify it works**

Run: `node scripts/start-stable.mjs`
Expected: Both services start on ports 3000/3001

**Step 3: Commit**

```bash
git add scripts/start-stable.mjs
git commit -m "feat: add cross-platform start-stable.mjs (Node.js replacement for .sh)"
```

---

### Task 17: Create `scripts/start-dev.mjs` (Node.js replacement for start-dev.sh)

**Files:**
- Create: `scripts/start-dev.mjs`

**Step 1: Write the cross-platform dev start script**

```javascript
#!/usr/bin/env node

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const isWin = process.platform === "win32";

console.log("Starting DEV environment...");
console.log("   Frontend: http://localhost:3100");
console.log("   Backend:  http://localhost:3101");
console.log("   Database: .clawui-dev/");

// Start backend (tsx watch for hot reload)
const backend = spawn("npx", ["tsx", "watch", "src/index.ts"], {
  cwd: join(ROOT, "backend"),
  stdio: "inherit",
  shell: isWin, // needed for npx.cmd on Windows
  env: { ...process.env, PORT: "3101", CLAWUI_DB_DIR: ".clawui-dev" },
});

// Start frontend (next dev for hot reload)
let frontend;
if (isWin) {
  const nextCliJs = join(ROOT, "frontend", "node_modules", "next", "dist", "bin", "next");
  frontend = spawn("node", [nextCliJs, "dev", "--port", "3100", "--hostname", "127.0.0.1"], {
    cwd: join(ROOT, "frontend"),
    stdio: "inherit",
    env: { ...process.env, NEXT_PUBLIC_API_PORT: "3101" },
  });
} else {
  frontend = spawn("next", ["dev", "--port", "3100", "--hostname", "0.0.0.0"], {
    cwd: join(ROOT, "frontend"),
    stdio: "inherit",
    env: { ...process.env, NEXT_PUBLIC_API_PORT: "3101" },
  });
}

console.log(`   Backend PID:  ${backend.pid}`);
console.log(`   Frontend PID: ${frontend.pid}`);

let exiting = false;
function cleanup() {
  if (exiting) return;
  exiting = true;
  try { backend.kill(); } catch {}
  try { frontend.kill(); } catch {}
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
if (isWin) process.on("exit", cleanup);

backend.on("exit", (code) => { if (!exiting) { cleanup(); process.exit(code ?? 1); } });
frontend.on("exit", (code) => { if (!exiting) { cleanup(); process.exit(code ?? 1); } });
```

**Step 2: Commit**

```bash
git add scripts/start-dev.mjs
git commit -m "feat: add cross-platform start-dev.mjs (Node.js replacement for .sh)"
```

---

### Task 18: Update redeploy endpoint to use cross-platform scripts

**Files:**
- Modify: `backend/src/routes.ts` (lines 235-266, the `/api/dev/redeploy` handler)

**Step 1: Replace `/bin/bash` + `nohup` with platform-aware spawning**

Replace the redeploy handler body (after the `CLAWUI_DEV` check) with:

```typescript
  const projectRoot = join(process.cwd(), "..");
  const deployScript = join(projectRoot, "scripts", "deploy-stable.mjs");
  const startScript = join(projectRoot, "scripts", "start-stable.mjs");

  log.info("Dev redeploy: starting deploy-stable.mjs + start-stable.mjs");

  // Run deploy first (blocking — build must finish before restart)
  execFile("node", [deployScript], { cwd: projectRoot, timeout: 120_000 }, (deployErr, deployStdout, deployStderr) => {
    if (deployErr) {
      log.error(`Deploy failed: ${deployErr.message}`);
      res.status(500).json({ error: "Deploy failed", details: safeError(deployStderr || deployErr.message) });
      return;
    }
    log.info(`Deploy output: ${deployStdout.trim()}`);

    // Start stable in detached mode so it survives this process
    const child = spawn("node", [startScript], {
      cwd: projectRoot,
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    res.json({ status: "redeployed" });
    log.info("Stable environment restart triggered");
  });
```

Note: This uses `node scripts/deploy-stable.mjs` (cross-platform) instead of `/bin/bash deploy-stable.sh`. The `detached: true` + `child.unref()` replaces `nohup` for backgrounding.

**Step 2: Add `spawn` import if not already present**

At the top of routes.ts, ensure the import includes `spawn`:
```typescript
import { execFile, spawn } from "node:child_process";
```

**Step 3: Run typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: PASS

**Step 4: Commit**

```bash
git add backend/src/routes.ts
git commit -m "feat: update redeploy endpoint to use cross-platform Node.js scripts"
```

---

## Workstream 5: CI + .gitattributes

### Task 19: Create `.gitattributes` for line ending normalization

**Files:**
- Create: `.gitattributes`

**Step 1: Write the .gitattributes file**

```
# Auto-detect text files and normalize line endings
* text=auto

# Force LF for source code and scripts
*.ts text eol=lf
*.tsx text eol=lf
*.js text eol=lf
*.mjs text eol=lf
*.json text eol=lf
*.md text eol=lf
*.yml text eol=lf
*.yaml text eol=lf
*.css text eol=lf
*.html text eol=lf
*.sh text eol=lf
*.exp text eol=lf

# Binary files
*.png binary
*.jpg binary
*.gif binary
*.ico binary
*.wasm binary
```

**Step 2: Normalize existing files**

Run:
```bash
git add --renormalize .
```

This updates the index with the correct line endings without changing working tree files.

**Step 3: Commit**

```bash
git add .gitattributes
git commit -m "chore: add .gitattributes for consistent line endings (Windows compat)"
```

---

### Task 20: Add Windows to CI matrix

**Files:**
- Modify: `.github/workflows/ci.yml`

**Step 1: Add OS matrix and Windows runner**

Replace lines 10-15:
```yaml
jobs:
  build:
    runs-on: ubuntu-latest

    strategy:
      matrix:
        node-version: [20, 22]
```

With:
```yaml
jobs:
  build:
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest]
        node-version: [20, 22]
    runs-on: ${{ matrix.os }}
```

**Step 2: Fix `cd backend &&` patterns for Windows CI**

The `cd backend && npx vitest run` syntax works on both Ubuntu and Windows runners (GitHub Actions uses bash shell on both by default via `shell: bash`). No changes needed to the step commands.

**Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add Windows runner to CI matrix for cross-platform testing"
```

---

## Workstream Wrap-up

### Task 21: Update CLAUDE.md with Windows support notes

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Add Windows notes to Key Design Decisions section**

Add after the "expect for TTY" bullet:

```markdown
- **Windows support**: On Windows (`process.platform === "win32"`), Claude CLI runs directly via `node cli.js` without TTY/expect wrapping — confirmed to work with `--output-format text`, `--output-format json`, and `--dangerously-skip-permissions`. Path encoding handles both `/` and `\` separators via `encodeProjectPath()` from `cli-utils.ts`. `decodeProjectPath()` detects Windows drive letters. `isProcessAlive()` uses `tasklist` on Windows (signal 0 is unreliable). Shell scripts have Node.js `.mjs` equivalents in `scripts/`.
```

**Step 2: Add to Environment Variables section**

After the `EXPECT_PATH` entry, add:

```markdown
- `CLAUDE_PATH` — On Windows, auto-detects from `%APPDATA%\npm\claude.cmd`, PATH via `where.exe`, then falls back to bare `claude`. Set explicitly if Claude is installed in a non-standard location.
```

**Step 3: Add to Gotchas section**

```markdown
- **Windows `.cmd` shim resolution**: `spawn("npx", ...)` fails on Windows without `shell: true` because `npx` is actually `npx.cmd`. Use `spawn("node", [cliJsPath, ...])` to bypass the shim, or `shell: true` as a fallback. The `CLAUDE_CLI_JS` constant in `config.ts` resolves the path to Claude's `cli.js` for direct node invocation.
- **Windows path encoding**: `encodeProjectPath()` in `cli-utils.ts` handles both `/` and `\` separators and strips drive letter colons. Use it instead of `path.replace(/\//g, "-")` everywhere a Claude project directory name is constructed.
```

**Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add Windows support notes to CLAUDE.md"
```

---

### Task 22: Final verification across all workstreams

**Files:** None (verification only)

**Step 1: Run full backend typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: PASS

**Step 2: Run full backend test suite**

Run: `cd backend && npx vitest run`
Expected: All tests pass (same baseline as before)

**Step 3: Run lint**

Run: `npm run lint`
Expected: No new lint errors

**Step 4: Build all**

Run: `npm run build`
Expected: Both backend and frontend build successfully

**Step 5: Verify cross-platform scripts exist**

Run: `ls scripts/*.mjs`
Expected: deploy-stable.mjs, start-stable.mjs, start-dev.mjs

**Step 6: Final commit if any fixups**

```bash
git add -A
git commit -m "fix: address any remaining issues from Windows support implementation"
```

---

## Summary Table

| Task | Workstream | Description | Effort |
|------|-----------|-------------|--------|
| 1-9 | WS1: CLI/TTY + Paths | cli-utils, config, cli-runner, plan-generator, plan-executor, jsonl-parser, db | High |
| 10 | WS2: npm Scripts | Add cross-env dependency | Low |
| 11 | WS2: npm Scripts | Update backend package.json scripts | Low |
| 12 | WS2: npm Scripts | Update frontend package.json scripts | Low |
| 13 | WS2: npm Scripts | Update root build scripts to use workspaces | Low |
| 14 | WS3: CLI Launcher | Fix bin/claw-ui.mjs spawn + signals | Medium |
| 15 | WS4: Shell Scripts | Create deploy-stable.mjs | Medium |
| 16 | WS4: Shell Scripts | Create start-stable.mjs | Medium |
| 17 | WS4: Shell Scripts | Create start-dev.mjs | Medium |
| 18 | WS4: Shell Scripts | Update redeploy endpoint | Medium |
| 19 | WS5: CI + Config | Create .gitattributes | Low |
| 20 | WS5: CI + Config | Add Windows to CI matrix | Low |
| 21 | Wrap-up | Update CLAUDE.md | Low |
| 22 | Wrap-up | Final verification | Low |

**Total: 22 tasks across 5 workstreams. Estimated: ~13 are low effort, ~8 medium, ~1 high (covered by WS1 sub-plan).**
