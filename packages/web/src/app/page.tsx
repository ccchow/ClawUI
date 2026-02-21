"use client";

import { useStore } from "@/lib/store";
import { useWebSocket } from "@/hooks/useWebSocket";
import { SessionCard } from "@/components/SessionCard";
import { ConnectionStatus } from "@/components/ConnectionStatus";

export default function Dashboard() {
  useWebSocket();
  const sessions = useStore((s) => s.sessions);
  const sessionList = Object.values(sessions);

  // Sort: waiting first, then running, then finished
  const sorted = sessionList.sort((a, b) => {
    const priority: Record<string, number> = { waiting: 0, running: 1, idle: 2, finished: 3 };
    return (priority[a.status] ?? 9) - (priority[b.status] ?? 9);
  });

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Agent Cockpit</h1>
          <p className="text-sm text-muted-foreground">
            Real-time session monitoring dashboard
          </p>
        </div>
        <ConnectionStatus />
      </header>

      {sorted.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <p className="text-muted-foreground text-sm">
            No active sessions. Waiting for agent connections...
          </p>
          <p className="text-muted-foreground/60 text-xs mt-2">
            Start an agent through the adapter to see sessions here.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {sorted.map((session) => (
            <SessionCard key={session.sessionId} session={session} />
          ))}
        </div>
      )}
    </main>
  );
}
