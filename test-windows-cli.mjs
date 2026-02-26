#!/usr/bin/env node
/**
 * Test: Can Claude CLI run on Windows without expect/TTY wrapping?
 * Tests various invocation modes that ClawUI uses.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

// Find claude binary
const candidates = [
  "Q:\\.tools\\.npm-global\\claude.cmd",
  "Q:\\.tools\\.npm-global\\claude",
  "claude",
];
const CLAUDE = candidates.find(c => {
  try { return existsSync(c); } catch { return false; }
}) || "claude";

function cleanEnv() {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  return env;
}

function runTest(name, args, timeout = 30000) {
  return new Promise((resolve) => {
    console.log(`\n=== TEST: ${name} ===`);
    console.log(`  cmd: claude ${args.join(" ")}`);
    const start = Date.now();

    const child = execFile(CLAUDE, args, {
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      env: cleanEnv(),
      shell: true,  // needed on Windows for .cmd files
    }, (error, stdout, stderr) => {
      const elapsed = Date.now() - start;
      console.log(`  elapsed: ${elapsed}ms`);
      console.log(`  exit code: ${error ? error.code ?? "error" : 0}`);
      console.log(`  stdout length: ${stdout.length}`);
      console.log(`  stderr length: ${stderr.length}`);
      if (stdout.length > 0) {
        console.log(`  stdout (first 500 chars):\n    ${stdout.slice(0, 500).replace(/\n/g, "\n    ")}`);
      }
      if (stderr.length > 0) {
        console.log(`  stderr (first 500 chars):\n    ${stderr.slice(0, 500).replace(/\n/g, "\n    ")}`);
      }
      if (error && error.message) {
        console.log(`  error: ${error.message.slice(0, 200)}`);
      }
      resolve({ name, success: !error, stdout, stderr, elapsed });
    });

    console.log(`  pid: ${child.pid}`);
  });
}

async function main() {
  console.log(`Claude binary: ${CLAUDE}`);
  console.log(`Platform: ${process.platform}`);
  console.log(`Node: ${process.version}`);

  // Test 1: Simple prompt with text output
  await runTest(
    "Simple prompt (text output)",
    ["-p", "Reply with exactly: PONG", "--output-format", "text"]
  );

  // Test 2: Simple prompt with JSON output
  await runTest(
    "Simple prompt (JSON output)",
    ["-p", "Reply with exactly: PONG", "--output-format", "json"]
  );

  // Test 3: With --dangerously-skip-permissions (how ClawUI runs it)
  await runTest(
    "With --dangerously-skip-permissions (text)",
    ["--dangerously-skip-permissions", "-p", "Reply with exactly: PONG", "--output-format", "text"]
  );

  console.log("\n=== ALL TESTS COMPLETE ===");
}

main().catch(console.error);
