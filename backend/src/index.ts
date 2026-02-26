import express from "express";
import type { Request, Response, NextFunction } from "express";
import cors from "cors";
import router from "./routes.js";
import planRouter from "./plan-routes.js";
import { initDb, syncAll } from "./db.js";
import { initPlanTables } from "./plan-db.js";
import { requeueOrphanedNodes, smartRecoverStaleExecutions } from "./plan-executor.js";
import { PORT, EXPECT_PATH, CLAUDE_PATH } from "./config.js";
import { createLogger } from "./logger.js";
import { requireLocalAuth, LOCAL_AUTH_TOKEN } from "./auth.js";
import { setChildPidTracker } from "./cli-runner.js";

const log = createLogger("server");

// ─── Lightweight rate limiter for CLI-spawning endpoints ─────

/** Track in-flight CLI requests to cap concurrency. */
let inFlightCliRequests = 0;
const MAX_CONCURRENT_CLI = 5;

function cliConcurrencyGuard(req: Request, res: Response, next: NextFunction): void {
  if (inFlightCliRequests >= MAX_CONCURRENT_CLI) {
    res.status(429).json({ error: "Too many concurrent CLI requests. Try again shortly." });
    return;
  }
  inFlightCliRequests++;
  res.on("finish", () => { inFlightCliRequests--; });
  res.on("close", () => { inFlightCliRequests--; });
  next();
}

// ─── Track child processes for cleanup on shutdown ───────────

const activeChildPids = new Set<number>();

export function trackChildPid(pid: number): void {
  activeChildPids.add(pid);
}

export function untrackChildPid(pid: number): void {
  activeChildPids.delete(pid);
}

function cleanupChildProcesses(): void {
  for (const pid of activeChildPids) {
    try {
      process.kill(pid, "SIGTERM");
      log.info(`Sent SIGTERM to child process ${pid}`);
    } catch {
      // Process already exited
    }
  }
  activeChildPids.clear();
}

process.on("SIGTERM", () => {
  log.info("Received SIGTERM — cleaning up child processes");
  cleanupChildProcesses();
  process.exit(0);
});

process.on("SIGINT", () => {
  log.info("Received SIGINT — cleaning up child processes");
  cleanupChildProcesses();
  process.exit(0);
});

// Wire up child process tracking for clean shutdown
setChildPidTracker(trackChildPid, untrackChildPid);

// Initialize SQLite database and run initial sync
initDb();
initPlanTables();
smartRecoverStaleExecutions();
requeueOrphanedNodes();
syncAll();

// Background sync every 30 seconds — run in next tick to avoid blocking concurrent requests
setInterval(() => {
  setImmediate(() => {
    try {
      syncAll();
    } catch {
      // sync errors are non-fatal
    }
  });
}, 30_000);

const app = express();

// CORS: allow any localhost origin (3000 for stable, 3100 for dev)
// External access via Tailscale serve proxy
app.use(cors({ origin: /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/ }));
// JSON body parser with Windows backslash recovery.
// Claude CLI curl callbacks may include Windows paths with unescaped backslashes
// (e.g., C:\src\file.ts where \s and \f are invalid JSON escapes). When standard
// JSON.parse fails, retry after escaping lone backslashes.
app.use(express.json({
  limit: "10mb",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reviver: undefined as any, // use default
}));
app.use((err: Error & { type?: string; status?: number; body?: string }, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err.type === "entity.parse.failed" && err.body) {
    try {
      // Fix lone backslashes: replace \ not followed by a valid JSON escape char
      const fixed = err.body.replace(/\\(?!["\\/bfnrtu])/g, "\\\\");
      req.body = JSON.parse(fixed);
      return next();
    } catch {
      // Still can't parse — fall through to error response
    }
  }
  if (err.status === 400 && err.type === "entity.parse.failed") {
    res.status(400).json({ error: "Invalid JSON in request body" });
    return;
  }
  next(err);
});

// Increase timeout for long-running Claude CLI calls
app.use((_req, res, next) => {
  res.setTimeout(180_000); // 3 minutes
  next();
});

// Auth middleware — must be before route handlers
app.use(requireLocalAuth);

// Rate-limit CLI-spawning endpoints (session run + blueprint node execution)
app.post("/api/sessions/:id/run", cliConcurrencyGuard);
app.post("/api/blueprints/:id/nodes/:nodeId/run", cliConcurrencyGuard);
app.post("/api/blueprints/:id/nodes/:nodeId/resume", cliConcurrencyGuard);

app.use(router);
app.use(planRouter);

const HOST = "127.0.0.1";

app.listen(PORT, HOST, () => {
  log.info(`ClawUI backend locked to http://${HOST}:${PORT}`);
  log.info(`Claude CLI: ${CLAUDE_PATH}`);
  log.info(`Expect binary: ${EXPECT_PATH}`);
  log.info("");
  log.info("========================================================");
  log.info("  ClawUI Secure Dashboard Ready");
  log.info(`  Local:     http://localhost:3000/?auth=${LOCAL_AUTH_TOKEN}`);
  if (process.stdout.isTTY) {
    log.info(`  Tailscale: http://<your-tailscale-ip>:3000/?auth=${LOCAL_AUTH_TOKEN}`);
  } else {
    log.info(`  Tailscale: http://<your-tailscale-ip>:3000/?auth=${LOCAL_AUTH_TOKEN.slice(0, 6)}...`);
  }
  log.info("========================================================");
  log.info("");
});
