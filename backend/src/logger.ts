import { LOG_LEVEL } from "./config.js";

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

function shouldLog(level: LogLevel): boolean {
  const threshold = LEVEL_ORDER[LOG_LEVEL as LogLevel] ?? LEVEL_ORDER.info;
  return LEVEL_ORDER[level] >= threshold;
}

function formatMessage(level: LogLevel, module: string, msg: string): string {
  return `[${new Date().toISOString()}] [${LEVEL_LABELS[level]}] [${module}] ${msg}`;
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
      if (shouldLog("debug")) console.debug(formatMessage("debug", module, msg), ...args);
    },
    info(msg: string, ...args: unknown[]) {
      if (shouldLog("info")) console.log(formatMessage("info", module, msg), ...args);
    },
    warn(msg: string, ...args: unknown[]) {
      if (shouldLog("warn")) console.warn(formatMessage("warn", module, msg), ...args);
    },
    error(msg: string, ...args: unknown[]) {
      if (shouldLog("error")) console.error(formatMessage("error", module, msg), ...args);
    },
  };
}
