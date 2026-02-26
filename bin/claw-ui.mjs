#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
      server.close(() => resolve(true));
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
// Backend writes token relative to its own cwd (BACKEND_DIR)
function waitForAuthToken(timeout = 30000) {
  const tokenPath = join(BACKEND_DIR, ".clawui", "auth-token");
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
  } else {
    console.error("⚠️  Auth token not found after 30s. Check backend logs.");
    console.error(`   Expected token at: ${join(BACKEND_DIR, ".clawui", "auth-token")}`);
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

  // Exit when either child dies (with grace period for sibling)
  backend.on("exit", (code) => {
    if (!exiting) {
      cleanup("SIGTERM");
      frontend.once("exit", () => process.exit(code ?? 1));
      setTimeout(() => process.exit(code ?? 1), 5000).unref();
    }
  });
  frontend.on("exit", (code) => {
    if (!exiting) {
      cleanup("SIGTERM");
      backend.once("exit", () => process.exit(code ?? 1));
      setTimeout(() => process.exit(code ?? 1), 5000).unref();
    }
  });
}

main();
