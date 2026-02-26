# `npx claw-ui` CLI Package — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Publish ClawUI to npm as `claw-ui` so users can run `npx claw-ui` to start the full stack.

**Architecture:** Add a `bin/claw-ui.mjs` CLI entry that spawns backend + frontend as child processes. The `postinstall` script runs `npm run build` to compile TypeScript and Next.js. An `.npmignore` excludes tests, docs, and dev artifacts.

**Tech Stack:** Node.js ESM (`import.meta`), `node:child_process`, `node:net`, `node:fs`

---

### Task 1: Create the CLI entry point

**Files:**
- Create: `bin/claw-ui.mjs`

**Step 1: Create `bin/claw-ui.mjs`**

```js
#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, readFileSync, watchFile, unwatchFile } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

// ── Resolve package root ──
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const BACKEND_DIR = join(ROOT, "backend");
const FRONTEND_DIR = join(ROOT, "frontend");

const BACKEND_PORT = parseInt(process.env.PORT || "3001", 10);
const FRONTEND_PORT = parseInt(process.env.FRONTEND_PORT || "3000", 10);

// ── Pre-flight checks ──
function checkBuilds() {
  if (!existsSync(join(BACKEND_DIR, "dist", "index.js"))) {
    console.error("❌ Backend not built. Run: npm rebuild");
    process.exit(1);
  }
  if (!existsSync(join(FRONTEND_DIR, ".next"))) {
    console.error("❌ Frontend not built. Run: npm rebuild");
    process.exit(1);
  }
}

function checkPort(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close();
      resolve(true);
    });
    server.listen(port, "127.0.0.1");
  });
}

async function checkPorts() {
  const backendFree = await checkPort(BACKEND_PORT);
  const frontendFree = await checkPort(FRONTEND_PORT);
  if (!backendFree || !frontendFree) {
    const busy = [];
    if (!backendFree) busy.push(`${BACKEND_PORT} (backend)`);
    if (!frontendFree) busy.push(`${FRONTEND_PORT} (frontend)`);
    console.error(`❌ Port(s) already in use: ${busy.join(", ")}`);
    console.error(`   Override with: PORT=3002 FRONTEND_PORT=3003 claw-ui`);
    process.exit(1);
  }
}

// ── Wait for auth token file ──
function waitForAuthToken(timeout = 30000) {
  const tokenPath = join(process.cwd(), ".clawui", "auth-token");
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      if (existsSync(tokenPath)) {
        const token = readFileSync(tokenPath, "utf-8").trim();
        if (token) return resolve(token);
      }
      if (Date.now() - start > timeout) return resolve(null);
      setTimeout(check, 200);
    };
    check();
  });
}

// ── Main ──
async function main() {
  checkBuilds();
  await checkPorts();

  console.log("🐾 Starting ClawUI...");
  console.log("");

  // Start backend
  const backend = spawn("node", ["dist/index.js"], {
    cwd: BACKEND_DIR,
    stdio: "inherit",
    env: { ...process.env, PORT: String(BACKEND_PORT) },
  });

  // Start frontend
  const frontend = spawn("npx", ["next", "start", "--port", String(FRONTEND_PORT), "--hostname", "127.0.0.1"], {
    cwd: FRONTEND_DIR,
    stdio: "inherit",
    env: { ...process.env, NEXT_PUBLIC_API_PORT: String(BACKEND_PORT) },
  });

  // Wait for auth token and print URL
  const token = await waitForAuthToken();
  if (token) {
    console.log("");
    console.log("========================================================");
    console.log("  🐾 ClawUI Ready");
    console.log(`  Local:  http://localhost:${FRONTEND_PORT}/?auth=${token}`);
    console.log("========================================================");
    console.log("");
  }

  // Clean shutdown
  let exiting = false;
  const cleanup = (signal) => {
    if (exiting) return;
    exiting = true;
    backend.kill(signal);
    frontend.kill(signal);
  };

  process.on("SIGINT", () => cleanup("SIGINT"));
  process.on("SIGTERM", () => cleanup("SIGTERM"));

  // Exit when either child dies
  backend.on("exit", (code) => {
    if (!exiting) {
      cleanup("SIGTERM");
      process.exit(code ?? 1);
    }
  });
  frontend.on("exit", (code) => {
    if (!exiting) {
      cleanup("SIGTERM");
      process.exit(code ?? 1);
    }
  });
}

main();
```

**Step 2: Make it executable**

Run: `chmod +x bin/claw-ui.mjs`

**Step 3: Test locally**

Run: `node bin/claw-ui.mjs`
Expected: Backend + frontend start, auth URL printed, Ctrl+C kills both.

**Step 4: Commit**

```bash
git add bin/claw-ui.mjs
git commit -m "feat: add CLI entry point for npx claw-ui"
```

---

### Task 2: Update root package.json for npm publishing

**Files:**
- Modify: `package.json`

**Step 1: Apply changes to root `package.json`**

Changes:
- `"name"`: `"clawui"` → `"claw-ui"`
- `"version"`: `"1.0.0"` → `"0.2.0"`
- Remove `"private": true`
- Add `"bin": { "claw-ui": "./bin/claw-ui.mjs" }`
- Add `"postinstall"` to scripts: `"npm run build"`
- Add `"files"` array to control what ships

The `"files"` array should include:
```json
"files": [
  "bin/",
  "backend/src/",
  "backend/package.json",
  "backend/tsconfig.json",
  "frontend/src/",
  "frontend/public/",
  "frontend/package.json",
  "frontend/tsconfig.json",
  "frontend/next.config.mjs",
  "frontend/tailwind.config.ts",
  "frontend/postcss.config.mjs",
  "README.md",
  "LICENSE"
]
```

**Step 2: Verify the package contents**

Run: `npm pack --dry-run 2>&1 | head -60`
Expected: Lists files that would be included. Verify no `docs/`, `scripts/`, `__tests__/`, `.github/`, `.clawui/`, or screenshots.

**Step 3: Commit**

```bash
git add package.json
git commit -m "feat: configure package.json for npm publish as claw-ui"
```

---

### Task 3: Create `.npmignore`

**Files:**
- Create: `.npmignore`

**Step 1: Create `.npmignore`**

```
# Dev/CI
.github/
scripts/
docs/
.clawui/
.clawui-dev/
.worktrees/

# Tests
**/__tests__/
**/*.test.*
**/*.test.tsx
coverage/

# Build artifacts (rebuilt by postinstall)
backend/dist/
frontend/.next/

# IDE / tooling
.idea/
.vscode/
.firecrawl/
.playwright-mcp/
.serena/
.DS_Store

# Env / secrets
.env
.env.*
*.log

# Config files not needed at runtime
eslint.config.mjs
CLAUDE.md
CONTRIBUTING.md
```

**Step 2: Verify with `npm pack --dry-run`**

Run: `npm pack --dry-run 2>&1 | tail -5`
Expected: Total file count is reasonable (~50-80 files, no test files).

**Step 3: Commit**

```bash
git add .npmignore
git commit -m "chore: add .npmignore for npm publish"
```

---

### Task 4: Remove `"private": true` from workspace packages

**Files:**
- Modify: `backend/package.json`
- Modify: `frontend/package.json`

**Step 1: Remove `"private": true` from both workspace packages**

npm workspaces with `"private": true` on sub-packages can cause issues with `npm pack` and `npm publish` when the root is not private. Remove it from both since they aren't published individually — only the root package is.

**Step 2: Verify pack still works**

Run: `npm pack --dry-run 2>&1 | head -5`
Expected: No errors about private packages.

**Step 3: Commit**

```bash
git add backend/package.json frontend/package.json
git commit -m "chore: remove private flag from workspace packages for npm publish"
```

---

### Task 5: End-to-end test via `npm pack` + local install

**Step 1: Pack the tarball**

Run: `npm pack`
Expected: Creates `claw-ui-0.2.0.tgz`

**Step 2: Install in a temp directory**

```bash
mkdir /tmp/clawui-test && cd /tmp/clawui-test
npm init -y
npm install /path/to/ClawUI/claw-ui-0.2.0.tgz
```
Expected: Install succeeds, `postinstall` runs `npm run build`, backend compiles, frontend builds.

**Step 3: Run the CLI**

Run: `npx claw-ui`
Expected: Backend starts on 3001, frontend on 3000, auth URL printed. Ctrl+C kills both.

**Step 4: Clean up**

```bash
rm -rf /tmp/clawui-test
rm claw-ui-0.2.0.tgz
```

---

### Task 6: Publish to npm

**Step 1: Login to npm**

Run: `npm login`

**Step 2: Publish**

Run: `npm publish`
Expected: Package published as `claw-ui@0.2.0`.

**Step 3: Verify**

Run: `npm info claw-ui`
Expected: Shows the published package info.

**Step 4: Test `npx`**

```bash
cd /tmp && npx claw-ui
```
Expected: Downloads, installs, builds, starts. Auth URL printed.

---

### Task 7: Update README with npm install instructions

**Files:**
- Modify: `README.md`

**Step 1: Add npx option to Quick Start**

In the Installation section, add `npx claw-ui` as the primary option above the git clone instructions.

**Step 2: Commit and push**

```bash
git add README.md
git commit -m "docs: add npx claw-ui install option to README"
git push
```
