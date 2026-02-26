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
