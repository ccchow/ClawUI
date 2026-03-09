import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { LOG_LEVEL, CLAWUI_DB_DIR } from "./config.js";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_LABELS: Record<LogLevel, string> = {
  debug: "DEBUG",
  info: "INFO",
  warn: "WARN",
  error: "ERROR",
};

// ─── File logging ────────────────────────────────────────────

const LOG_DIR = join(CLAWUI_DB_DIR, "logs");
const LOG_FILE = join(LOG_DIR, "server.log");
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_ROTATED_FILES = 5;

let fileLoggingEnabled = false;

try {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
  fileLoggingEnabled = true;
} catch {
  // If we can't create the log dir, fall back to console-only
  console.warn(`[logger] Could not create log directory ${LOG_DIR}, file logging disabled`);
}

function rotateIfNeeded(): void {
  try {
    if (!existsSync(LOG_FILE)) return;
    const stat = statSync(LOG_FILE);
    if (stat.size < MAX_LOG_SIZE) return;

    // Rotate: server.log.4 → delete, server.log.3 → .4, ... server.log → .1
    for (let i = MAX_ROTATED_FILES - 1; i >= 1; i--) {
      const from = `${LOG_FILE}.${i}`;
      const to = `${LOG_FILE}.${i + 1}`;
      if (existsSync(from)) {
        renameSync(from, to);
      }
    }
    renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch {
    // Rotation failure is non-fatal
  }
}

function writeToFile(formatted: string): void {
  if (!fileLoggingEnabled) return;
  try {
    rotateIfNeeded();
    appendFileSync(LOG_FILE, formatted + "\n");
  } catch {
    // File write failure is non-fatal
  }
}

// ─── Logger ──────────────────────────────────────────────────

function shouldLog(level: LogLevel): boolean {
  const threshold = LEVEL_ORDER[LOG_LEVEL as LogLevel] ?? LEVEL_ORDER.info;
  return LEVEL_ORDER[level] >= threshold;
}

function formatMessage(level: LogLevel, module: string, msg: string): string {
  return `[${new Date().toISOString()}] [${LEVEL_LABELS[level]}] [${module}] ${msg}`;
}

function formatArgs(msg: string, args: unknown[]): string {
  if (args.length === 0) return msg;
  // Simple %s substitution like console.log does
  let result = msg;
  for (const arg of args) {
    result = result.replace("%s", String(arg));
  }
  return result;
}

export interface Logger {
  debug: (msg: string, ...args: unknown[]) => void;
  info: (msg: string, ...args: unknown[]) => void;
  warn: (msg: string, ...args: unknown[]) => void;
  error: (msg: string, ...args: unknown[]) => void;
}

export function createLogger(module: string): Logger {
  return {
    debug(msg: string, ...args: unknown[]) {
      if (shouldLog("debug")) {
        const formatted = formatMessage("debug", module, formatArgs(msg, args));
        console.debug(formatted);
        writeToFile(formatted);
      }
    },
    info(msg: string, ...args: unknown[]) {
      if (shouldLog("info")) {
        const formatted = formatMessage("info", module, formatArgs(msg, args));
        console.log(formatted);
        writeToFile(formatted);
      }
    },
    warn(msg: string, ...args: unknown[]) {
      if (shouldLog("warn")) {
        const formatted = formatMessage("warn", module, formatArgs(msg, args));
        console.warn(formatted);
        writeToFile(formatted);
      }
    },
    error(msg: string, ...args: unknown[]) {
      if (shouldLog("error")) {
        const formatted = formatMessage("error", module, formatArgs(msg, args));
        console.error(formatted);
        writeToFile(formatted);
      }
    },
  };
}
