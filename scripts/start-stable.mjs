#!/usr/bin/env node

import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
