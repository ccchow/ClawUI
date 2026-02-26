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
