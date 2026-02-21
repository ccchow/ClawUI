export { ProcessManager } from "./process-manager/index.js";
export type { SpawnOptions } from "./process-manager/index.js";

export { StreamInterceptor } from "./stream-interceptor/index.js";
export type { InterceptorOptions } from "./stream-interceptor/index.js";

export { ProtocolTranslator } from "./protocol-translator/index.js";

export { AdapterWSServer } from "./websocket-server/index.js";
export type { WSServerOptions } from "./websocket-server/index.js";

export { MockGenerator } from "./mock-generator/index.js";

export type {
  AGUIMessage,
  AGUIEventType,
  HumanAction,
  SessionInfo,
  SessionStatus,
  RunStartedData,
  TextMessageData,
  StepStartedData,
  WaitingForHumanData,
  RunFinishedData,
  A2UIPayload,
} from "./types.js";

import { ProcessManager } from "./process-manager/index.js";
import { StreamInterceptor } from "./stream-interceptor/index.js";
import { ProtocolTranslator } from "./protocol-translator/index.js";
import { AdapterWSServer } from "./websocket-server/index.js";
import type { HumanAction } from "./types.js";

export interface AdapterConfig {
  wsPort?: number;
  wsHost?: string;
  flushTimeout?: number;
}

/**
 * Main Adapter that wires all modules together:
 *   ProcessManager → StreamInterceptor → ProtocolTranslator → WebSocket broadcast
 */
export class Adapter {
  readonly processManager: ProcessManager;
  readonly interceptor: StreamInterceptor;
  readonly translator: ProtocolTranslator;
  readonly wsServer: AdapterWSServer;

  constructor(config?: AdapterConfig) {
    this.processManager = new ProcessManager();
    this.interceptor = new StreamInterceptor({ flushTimeout: config?.flushTimeout });
    this.translator = new ProtocolTranslator();
    this.wsServer = new AdapterWSServer();

    this.wire();
  }

  /** Start the WebSocket server. */
  async start(config?: AdapterConfig): Promise<void> {
    await this.wsServer.start({
      port: config?.wsPort ?? 4800,
      host: config?.wsHost ?? "0.0.0.0",
    });
  }

  /** Shut down everything. */
  async stop(): Promise<void> {
    this.processManager.dispose();
    this.interceptor.dispose();
    await this.wsServer.close();
  }

  /** Wire the pipeline: PTY data → interceptor → translator → WS broadcast. */
  private wire(): void {
    // PTY raw data → StreamInterceptor for line buffering
    this.processManager.on("data", (sessionId: string, data: string) => {
      this.interceptor.feed(sessionId, data);
    });

    // PTY exit → translator + interceptor cleanup
    this.processManager.on("exit", (sessionId: string, exitCode: number) => {
      this.interceptor.flush(sessionId);
      this.translator.processExit(sessionId, exitCode);
      this.interceptor.remove(sessionId);
    });

    // Complete lines → ProtocolTranslator
    this.interceptor.on("line", (sessionId: string, line: string) => {
      this.translator.processLine(sessionId, line);
    });

    // Partial flush → ProtocolTranslator
    this.interceptor.on("flush", (sessionId: string, partial: string) => {
      this.translator.processFlush(sessionId, partial);
    });

    // AG-UI events → WebSocket broadcast
    this.translator.on("event", (msg) => {
      this.wsServer.broadcast(msg);

      // Update session status based on event type
      if (msg.type === "WAITING_FOR_HUMAN") {
        this.processManager.setStatus(msg.session_id, "waiting");
      } else if (msg.type === "RUN_FINISHED") {
        this.processManager.setStatus(msg.session_id, "finished");
      }
    });

    // HumanAction from frontend → inject into PTY stdin
    this.wsServer.on("human_action", (action: HumanAction) => {
      const input = this.resolveHumanInput(action);
      this.processManager.write(action.session_id, input);
      this.processManager.setStatus(action.session_id, "running");
    });
  }

  /** Convert a HumanAction into the text to write to stdin. */
  private resolveHumanInput(action: HumanAction): string {
    switch (action.action_type) {
      case "APPROVE":
        return "y\n";
      case "REJECT":
        return "n\n";
      case "PROVIDE_INPUT":
        return typeof action.payload === "string" ? action.payload + "\n" : "\n";
    }
  }
}

/** CLI entry point: start the adapter server. */
async function main() {
  const port = parseInt(process.env["WS_PORT"] ?? "4800", 10);
  const adapter = new Adapter();

  process.on("SIGINT", async () => {
    console.log("\n[Adapter] Shutting down...");
    await adapter.stop();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await adapter.stop();
    process.exit(0);
  });

  await adapter.start({ wsPort: port });
  console.log("[Adapter] Ready. Use WebSocket API to spawn agent sessions.");
}

// Run if executed directly
const isDirectRun = process.argv[1]?.includes("adapter") &&
  !process.argv[1]?.includes("mock-generator");
if (isDirectRun) {
  main().catch((err) => {
    console.error("[Adapter] Fatal error:", err);
    process.exit(1);
  });
}
