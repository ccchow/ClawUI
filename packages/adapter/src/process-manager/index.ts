import * as pty from "node-pty";
import { EventEmitter } from "events";
import { v4 as uuidv4 } from "uuid";
import type { SessionInfo, SessionStatus } from "../types.js";

export interface SpawnOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
}

interface ManagedSession {
  info: SessionInfo;
  process: pty.IPty;
}

/**
 * Manages CLI agent processes via node-pty.
 *
 * Events:
 *  - "data"    (sessionId: string, data: string)
 *  - "exit"    (sessionId: string, exitCode: number)
 */
export class ProcessManager extends EventEmitter {
  private sessions = new Map<string, ManagedSession>();

  /** Spawn a new agent process, returns the session_id. */
  spawn(opts: SpawnOptions): string {
    const sessionId = uuidv4();
    const args = opts.args ?? [];
    const proc = pty.spawn(opts.command, args, {
      name: "xterm-256color",
      cols: opts.cols ?? 120,
      rows: opts.rows ?? 30,
      cwd: opts.cwd ?? process.cwd(),
      env: { ...process.env, ...(opts.env ?? {}) } as Record<string, string>,
    });

    const session: ManagedSession = {
      info: {
        session_id: sessionId,
        agent_name: opts.command,
        command: [opts.command, ...args].join(" "),
        status: "running",
        created_at: new Date().toISOString(),
      },
      process: proc,
    };

    proc.onData((data: string) => {
      this.emit("data", sessionId, data);
    });

    proc.onExit(({ exitCode }) => {
      session.info.status = "finished";
      this.emit("exit", sessionId, exitCode);
    });

    this.sessions.set(sessionId, session);
    return sessionId;
  }

  /** Write data to the process stdin (e.g. user input). */
  write(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    session.process.write(data);
  }

  /** Send SIGTSTP to pause the process. */
  pause(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    session.process.pause();
  }

  /** Resume a paused process. */
  resume(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    session.process.resume();
  }

  /** Kill the process. */
  kill(sessionId: string, signal?: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    session.process.kill(signal);
    session.info.status = "finished";
  }

  /** Update the session status (used by protocol translator). */
  setStatus(sessionId: string, status: SessionStatus): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.info.status = status;
    }
  }

  /** Get info for a single session. */
  getSession(sessionId: string): SessionInfo | undefined {
    return this.sessions.get(sessionId)?.info;
  }

  /** List all sessions. */
  listSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => s.info);
  }

  /** Clean up a finished session from the map. */
  remove(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Kill all sessions and clean up. */
  dispose(): void {
    for (const [id] of this.sessions) {
      try {
        this.kill(id);
      } catch {
        // already exited
      }
    }
    this.sessions.clear();
  }
}
