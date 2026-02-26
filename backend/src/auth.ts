import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Request, Response, NextFunction } from "express";
import { CLAWUI_DB_DIR, CLAWUI_DEV } from "./config.js";
import { createLogger } from "./logger.js";

const log = createLogger("auth");

const DEV_MODE = CLAWUI_DEV;
const tokenDir = CLAWUI_DB_DIR;
const tokenPath = join(tokenDir, "auth-token");

function resolveToken(): string {
  // In dev mode, reuse existing token file if present
  if (DEV_MODE && existsSync(tokenPath)) {
    const existing = readFileSync(tokenPath, "utf-8").trim();
    if (existing) {
      log.info("Dev mode: reusing existing auth token");
      return existing;
    }
  }
  return crypto.randomBytes(16).toString("hex");
}

export const LOCAL_AUTH_TOKEN = resolveToken();

// Write token to shared file so Next.js proxy can read it
try {
  mkdirSync(tokenDir, { recursive: true });
  writeFileSync(tokenPath, LOCAL_AUTH_TOKEN, { encoding: "utf-8", mode: 0o600 });
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
