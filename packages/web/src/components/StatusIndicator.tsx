"use client";

import type { SessionStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

const statusConfig: Record<SessionStatus, { emoji: string; label: string; className: string }> = {
  running: {
    emoji: "\uD83D\uDFE2",
    label: "Running",
    className: "bg-green-500/20 text-green-400",
  },
  waiting: {
    emoji: "\uD83D\uDFE1",
    label: "Awaiting Input",
    className: "bg-yellow-500/20 text-yellow-400 animate-pulse",
  },
  finished: {
    emoji: "\u26AA",
    label: "Finished",
    className: "bg-zinc-500/20 text-zinc-400",
  },
  idle: {
    emoji: "\u26AA",
    label: "Idle",
    className: "bg-zinc-500/20 text-zinc-400",
  },
};

export function StatusIndicator({ status }: { status: SessionStatus }) {
  const config = statusConfig[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium",
        config.className
      )}
    >
      <span>{config.emoji}</span>
      {config.label}
    </span>
  );
}
