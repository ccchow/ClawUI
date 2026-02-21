"use client";

import { useStore } from "@/lib/store";

export function ConnectionStatus() {
  const connected = useStore((s) => s.connected);

  return (
    <div className="flex items-center gap-2 text-xs">
      <span
        className={
          connected
            ? "h-2 w-2 rounded-full bg-green-500"
            : "h-2 w-2 rounded-full bg-red-500 animate-pulse"
        }
      />
      <span className="text-muted-foreground">
        {connected ? "Connected" : "Disconnected"}
      </span>
    </div>
  );
}
