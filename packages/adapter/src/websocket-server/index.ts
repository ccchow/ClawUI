import { WebSocketServer, WebSocket } from "ws";
import { EventEmitter } from "events";
import type { AGUIMessage, HumanAction } from "../types.js";

export interface WSServerOptions {
  port?: number;
  host?: string;
}

/**
 * WebSocket server that broadcasts AG-UI events to all connected clients
 * and receives HumanAction messages from the frontend.
 *
 * Events:
 *  - "human_action" (action: HumanAction)
 *  - "connection"   (clientCount: number)
 *  - "disconnect"   (clientCount: number)
 */
export class AdapterWSServer extends EventEmitter {
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();

  /** Start the WebSocket server. */
  start(opts?: WSServerOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      const port = opts?.port ?? 4800;
      const host = opts?.host ?? "0.0.0.0";

      this.wss = new WebSocketServer({ port, host }, () => {
        console.log(`[WS] Adapter WebSocket server listening on ${host}:${port}`);
        resolve();
      });

      this.wss.on("error", (err) => {
        reject(err);
      });

      this.wss.on("connection", (ws) => {
        this.clients.add(ws);
        this.emit("connection", this.clients.size);
        console.log(`[WS] Client connected (total: ${this.clients.size})`);

        ws.on("message", (raw) => {
          try {
            const msg = JSON.parse(raw.toString()) as HumanAction;
            if (msg.session_id && msg.action_type) {
              this.emit("human_action", msg);
            }
          } catch {
            console.warn("[WS] Received invalid message:", raw.toString().slice(0, 200));
          }
        });

        ws.on("close", () => {
          this.clients.delete(ws);
          this.emit("disconnect", this.clients.size);
          console.log(`[WS] Client disconnected (total: ${this.clients.size})`);
        });

        ws.on("error", (err) => {
          console.error("[WS] Client error:", err.message);
          this.clients.delete(ws);
        });
      });
    });
  }

  /** Broadcast an AG-UI event to all connected clients. */
  broadcast(message: AGUIMessage): void {
    const payload = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  /** Send a message to a specific client (by index — useful for testing). */
  getClientCount(): number {
    return this.clients.size;
  }

  /** Shut down the server. */
  close(): Promise<void> {
    return new Promise((resolve) => {
      for (const client of this.clients) {
        client.close();
      }
      this.clients.clear();
      if (this.wss) {
        this.wss.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}
