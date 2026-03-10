import express from "express";
import type { Request, Response, NextFunction } from "express";
import cors from "cors";
import router from "./routes.js";
import planRouter from "./plan-routes.js";
import { initDb, syncAll } from "./db.js";
import { initPlanTables, listBlueprints, getUnacknowledgedMessages } from "./plan-db.js";
import { requeueOrphanedNodes, smartRecoverStaleExecutions, enqueueBlueprintTask } from "./plan-executor.js";
import { existsSync } from "node:fs";
import { PORT, EXPECT_PATH, CLAUDE_PATH } from "./config.js";
import { createLogger } from "./logger.js";
import { requireLocalAuth, LOCAL_AUTH_TOKEN } from "./auth.js";
import { setChildPidTracker } from "./cli-runner.js";
import { getAvailableAgents } from "./db.js";
import { killProcessTree } from "./cli-utils.js";

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
  // Use "close" only — it always fires (after "finish" if the response completes,
  // or alone if the socket is destroyed early). Listening to both caused double-decrement.
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
    const killed = killProcessTree(pid);
    if (killed) {
      log.info(`Killed child process tree ${pid}`);
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

// ─── Resume FSD/autopilot loops after server restart ─────────
// If a blueprint was in FSD/autopilot mode when the server stopped,
// its in-memory loop was lost. Re-trigger it now.
// Only recover blueprints with a real projectCwd (filters out test DB entries).
{
  const blueprints = listBlueprints();
  let recovered = 0;
  for (const bp of blueprints) {
    const isAutopilot = bp.executionMode === "autopilot" || bp.executionMode === "fsd";
    const isActive = bp.status === "running" || bp.status === "approved";
    const hasPendingNodes = bp.nodes.some((n) => n.status === "pending" || n.status === "queued");
    const hasRealProject = bp.projectCwd && existsSync(bp.projectCwd);
    if (isAutopilot && isActive && hasPendingNodes && hasRealProject) {
      const unacked = getUnacknowledgedMessages(bp.id);
      if (unacked.length > 0) {
        // User messages pending — route through User Agent first
        import("./user-agent.js").then(({ triggerUserAgent }) => {
          triggerUserAgent(bp.id);
        });
        log.info(`Recovered blueprint ${bp.id.slice(0, 8)} "${bp.title}" — triggering User Agent (${unacked.length} pending message(s))`);
      } else {
        // No messages — start FSD loop directly
        import("./autopilot.js").then(({ runAutopilotLoop }) => {
          enqueueBlueprintTask(bp.id, () => runAutopilotLoop(bp.id)).catch((err) => {
            log.error(`FSD loop recovery failed for ${bp.id}: ${err instanceof Error ? err.message : err}`);
          });
        });
        log.info(`Recovered blueprint ${bp.id.slice(0, 8)} "${bp.title}" — resuming FSD loop`);
      }
      recovered++;
    }
  }
  if (recovered > 0) {
    log.info(`Auto-recovered ${recovered} blueprint(s) with active FSD/autopilot loops`);
  }
}

// Log detected agent runtimes
try {
  const agents = getAvailableAgents();
  for (const agent of agents) {
    if (agent.available) {
      log.info(`Agent detected: ${agent.name} (${agent.type}) — ${agent.sessionCount} sessions, path: ${agent.sessionsPath}`);
    } else {
      log.debug(`Agent not available: ${agent.name} (${agent.type}) — sessions dir not found: ${agent.sessionsPath}`);
    }
  }
} catch {
  // Agent detection is non-fatal
}

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

// Increase timeout for long-running Claude CLI calls.
// CLI-spawning endpoints (session run, blueprint execution) can take up to 30 minutes.
// Non-CLI endpoints use a shorter 3-minute timeout.
app.use((req, res, next) => {
  const isCliEndpoint =
    (req.method === "POST" && /\/api\/sessions\/[^/]+\/run$/.test(req.path)) ||
    (req.method === "POST" && /\/api\/blueprints\/[^/]+\/nodes\/[^/]+\/(run|resume)$/.test(req.path));
  res.setTimeout(isCliEndpoint ? 35 * 60 * 1000 : 180_000); // 35min for CLI, 3min otherwise
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
