import { WebSocketServer, WebSocket } from "ws";
import { MockGenerator } from "./mock-generator/index.js";

const PORT = parseInt(process.env["WS_PORT"] ?? "4800", 10);

const wss = new WebSocketServer({ port: PORT, host: "0.0.0.0" }, () => {
  console.log(`[MockServer] WebSocket server listening on 0.0.0.0:${PORT}`);
  console.log("[MockServer] Waiting for client connections...");
});

function broadcast(data: string) {
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

// Start a new mock lifecycle every time a client connects
wss.on("connection", (ws) => {
  console.log("[MockServer] Client connected, starting mock lifecycle...");

  const mock = new MockGenerator("claude", "claude");
  const { cancel } = mock.streamLifecycle(
    (event) => {
      const payload = JSON.stringify(event);
      broadcast(payload);
      console.log(`[MockServer] Sent: ${event.type} (session: ${event.session_id.slice(0, 8)})`);
    },
    { baseDelay: 1200 }
  );

  // After first lifecycle, start a second agent with delay
  setTimeout(() => {
    const mock2 = new MockGenerator("openclaw", "openclaw");
    mock2.streamLifecycle(
      (event) => {
        broadcast(JSON.stringify(event));
        console.log(`[MockServer] Sent: ${event.type} (session: ${event.session_id.slice(0, 8)})`);
      },
      { baseDelay: 1500 }
    );
  }, 3000);

  ws.on("message", (raw) => {
    console.log(`[MockServer] Received action: ${raw.toString().slice(0, 200)}`);
  });

  ws.on("close", () => {
    cancel();
    console.log("[MockServer] Client disconnected");
  });
});

process.on("SIGINT", () => {
  console.log("\n[MockServer] Shutting down...");
  wss.close();
  process.exit(0);
});
