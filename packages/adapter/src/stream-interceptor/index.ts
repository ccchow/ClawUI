import { EventEmitter } from "events";

export interface InterceptorOptions {
  /** Max time (ms) to buffer before flushing an incomplete line. Default: 100ms */
  flushTimeout?: number;
}

/**
 * Buffers raw PTY output into complete lines, with a timeout-based flush
 * to prevent indefinite buffering of partial output.
 *
 * Events:
 *  - "line"  (sessionId: string, line: string)
 *  - "flush" (sessionId: string, partial: string)  — timeout-triggered partial flush
 */
export class StreamInterceptor extends EventEmitter {
  private buffers = new Map<string, string>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private flushTimeout: number;

  constructor(opts?: InterceptorOptions) {
    super();
    this.flushTimeout = opts?.flushTimeout ?? 100;
  }

  /** Feed raw data from a session. Emits "line" for each complete line. */
  feed(sessionId: string, data: string): void {
    // Clear any pending flush timer
    this.clearTimer(sessionId);

    const existing = this.buffers.get(sessionId) ?? "";
    const combined = existing + data;

    // Split on newlines (handles \r\n and \n)
    const parts = combined.split(/\r?\n/);

    // All parts except the last are complete lines
    for (let i = 0; i < parts.length - 1; i++) {
      const line = this.stripAnsi(parts[i]);
      if (line.length > 0) {
        this.emit("line", sessionId, line);
      }
    }

    // Last part is an incomplete line — buffer it
    const remainder = parts[parts.length - 1];
    if (remainder.length > 0) {
      this.buffers.set(sessionId, remainder);
      this.startTimer(sessionId);
    } else {
      this.buffers.delete(sessionId);
    }
  }

  /** Force-flush any buffered data for a session. */
  flush(sessionId: string): void {
    this.clearTimer(sessionId);
    const buffered = this.buffers.get(sessionId);
    if (buffered && buffered.length > 0) {
      const clean = this.stripAnsi(buffered);
      if (clean.length > 0) {
        this.emit("flush", sessionId, clean);
      }
      this.buffers.delete(sessionId);
    }
  }

  /** Remove session tracking. */
  remove(sessionId: string): void {
    this.flush(sessionId);
    this.buffers.delete(sessionId);
    this.clearTimer(sessionId);
  }

  /** Clean up all sessions. */
  dispose(): void {
    for (const [id] of this.buffers) {
      this.clearTimer(id);
    }
    this.buffers.clear();
    this.timers.clear();
  }

  private startTimer(sessionId: string): void {
    const timer = setTimeout(() => {
      this.flush(sessionId);
    }, this.flushTimeout);
    this.timers.set(sessionId, timer);
  }

  private clearTimer(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(sessionId);
    }
  }

  /** Strip ANSI escape codes for clean text processing. */
  private stripAnsi(str: string): string {
    // eslint-disable-next-line no-control-regex
    return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\r/g, "");
  }
}
