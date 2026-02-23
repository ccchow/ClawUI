import express from "express";
import cors from "cors";
import router from "./routes.js";
import planRouter from "./plan-routes.js";
import { initDb, syncAll } from "./db.js";
import { initPlanTables } from "./plan-db.js";
import { requeueOrphanedNodes, smartRecoverStaleExecutions } from "./plan-executor.js";
import { PORT } from "./config.js";
import { createLogger } from "./logger.js";
import { requireLocalAuth, LOCAL_AUTH_TOKEN } from "./auth.js";

const log = createLogger("server");

// Initialize SQLite database and run initial sync
initDb();
initPlanTables();
smartRecoverStaleExecutions();
requeueOrphanedNodes();
syncAll();

// Background sync every 30 seconds
setInterval(() => {
  try {
    syncAll();
  } catch {
    // sync errors are non-fatal
  }
}, 30_000);

const app = express();

app.use(cors({ origin: "http://127.0.0.1:3000" }));
app.use(express.json({ limit: "10mb" }));

// Increase timeout for long-running Claude CLI calls
app.use((_req, res, next) => {
  res.setTimeout(180_000); // 3 minutes
  next();
});

// Auth middleware — must be before route handlers
app.use(requireLocalAuth);

app.use(router);
app.use(planRouter);

const HOST = "127.0.0.1";

app.listen(PORT, HOST, () => {
  log.info(`ClawUI backend locked to http://${HOST}:${PORT}`);
  log.info("");
  log.info("========================================================");
  log.info("  ClawUI Secure Dashboard Ready");
  log.info("  Local:     http://localhost:3000");
  log.info(`  Tailscale: http://<your-tailscale-ip>:3000/?auth=${LOCAL_AUTH_TOKEN}`);
  log.info("========================================================");
  log.info("");
});
