import crypto from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Request, Response, NextFunction } from "express";
import { CLAWUI_DB_DIR } from "./config.js";
import { createLogger } from "./logger.js";

const log = createLogger("auth");

// Generate a fresh 32-char hex token each process start
export const LOCAL_AUTH_TOKEN = crypto.randomBytes(16).toString("hex");

// Write token to shared file so Next.js proxy can read it
const tokenDir = join(process.cwd(), CLAWUI_DB_DIR);
try {
  mkdirSync(tokenDir, { recursive: true });
  writeFileSync(join(tokenDir, "auth-token"), LOCAL_AUTH_TOKEN, { encoding: "utf-8", mode: 0o600 });
} catch (err) {
  log.warn(`Failed to write auth token file: ${err}`);
}

/**
 * Express middleware: require valid auth token on all /api/* routes.
 * Token can be provided via `x-clawui-token` header or `?auth=` query param.
 * Non-API paths are passed through (e.g. health checks).
 */
export const requireLocalAuth = (req: Request, res: Response, next: NextFunction) => {
  if (!req.path.startsWith("/api/")) {
    return next();
  }

  const raw = req.headers["x-clawui-token"] || req.query.auth;
  const clientToken = typeof raw === "string" ? raw : undefined;

  if (
    !clientToken ||
    clientToken.length !== LOCAL_AUTH_TOKEN.length ||
    !crypto.timingSafeEqual(Buffer.from(clientToken), Buffer.from(LOCAL_AUTH_TOKEN))
  ) {
    return res.status(403).json({
      error: "Forbidden",
      message: "Missing or invalid Local Auth Token.",
    });
  }
  next();
};
