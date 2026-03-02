import { createLogger } from "./logger.js";

const log = createLogger("session-lock");

/**
 * In-memory per-session run lock.
 * Prevents concurrent CLI processes (--resume) targeting the same session,
 * which could corrupt the shared JSONL file.
 */
const runningSessions = new Map<string, { since: number }>();

/** Attempt to acquire the lock for a session. Returns true if acquired. */
export function acquireSessionLock(sessionId: string): boolean {
  if (runningSessions.has(sessionId)) {
    return false;
  }
  runningSessions.set(sessionId, { since: Date.now() });
  log.debug(`Session lock acquired: ${sessionId.slice(0, 8)}`);
  return true;
}

/** Release the lock for a session. */
export function releaseSessionLock(sessionId: string): void {
  runningSessions.delete(sessionId);
  log.debug(`Session lock released: ${sessionId.slice(0, 8)}`);
}

/** Check if a session currently has an active run. */
export function isSessionRunning(sessionId: string): boolean {
  return runningSessions.has(sessionId);
}

/** Get all currently running session IDs (for debugging/monitoring). */
export function getRunningSessionIds(): string[] {
  return Array.from(runningSessions.keys());
}
