import express from "express";
import cors from "cors";
import router from "./routes.js";
import planRouter from "./plan-routes.js";
import { initDb, syncAll } from "./db.js";
import { initPlanTables } from "./plan-db.js";

const PORT = parseInt(process.env.PORT || "3001", 10);

// Initialize SQLite database and run initial sync
initDb();
initPlanTables();
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

app.use(cors());
app.use(express.json());

// Increase timeout for long-running Claude CLI calls
app.use((_req, res, next) => {
  res.setTimeout(180_000); // 3 minutes
  next();
});

app.use(router);
app.use(planRouter);

app.listen(PORT, () => {
  console.log(`ClawUI backend running on http://localhost:${PORT}`);
});
