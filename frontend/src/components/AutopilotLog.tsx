"use client";

import { useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { type AutopilotLogEntry, type BlueprintStatus, type ExecutionMode, fetchAutopilotLog } from "@/lib/api";
import { usePollingInterval } from "@/lib/polling-utils";

interface AutopilotLogProps {
  blueprintId: string;
  executionMode: ExecutionMode | undefined;
  blueprintStatus: BlueprintStatus;
}

function statusIcon(result: string | undefined): { icon: string; color: string } {
  if (!result) return { icon: "✓", color: "text-accent-green" };
  const r = result.toLowerCase();
  if (r.includes("error") || r.includes("fail")) return { icon: "✕", color: "text-accent-red" };
  if (r.includes("retry") || r.includes("resume") || r.includes("continuation")) return { icon: "↻", color: "text-accent-blue" };
  if (r.includes("warn") || r.includes("pause") || r.includes("skip")) return { icon: "⚠", color: "text-accent-amber" };
  return { icon: "✓", color: "text-accent-green" };
}

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const PAGE_SIZE = 20;

export function AutopilotLog({ blueprintId, executionMode, blueprintStatus }: AutopilotLogProps) {
  const [open, setOpen] = useState(true);
  const [offset, setOffset] = useState(0);
  const [olderEntries, setOlderEntries] = useState<AutopilotLogEntry[]>([]);

  const isAutopilotRunning = executionMode === "autopilot" && blueprintStatus === "running";

  const refetchInterval = usePollingInterval(
    useCallback(() => (isAutopilotRunning ? 5000 : false), [isAutopilotRunning]),
  );

  const { data: latestEntries = [] } = useQuery({
    queryKey: ["autopilot-log", blueprintId, 0],
    queryFn: () => fetchAutopilotLog(blueprintId, PAGE_SIZE, 0),
    refetchInterval,
  });

  // Combine older pages with latest page (deduplicated)
  const allEntries = [...latestEntries];
  const latestIds = new Set(latestEntries.map((e) => e.id));
  for (const entry of olderEntries) {
    if (!latestIds.has(entry.id)) allEntries.push(entry);
  }

  const totalCount = allEntries.length;
  if (totalCount === 0) return null;

  const hasMore = latestEntries.length === PAGE_SIZE || olderEntries.length > 0;

  const handleLoadMore = async () => {
    const nextOffset = offset + PAGE_SIZE;
    try {
      const more = await fetchAutopilotLog(blueprintId, PAGE_SIZE, nextOffset);
      setOlderEntries((prev) => {
        const ids = new Set(prev.map((e) => e.id));
        return [...prev, ...more.filter((e) => !ids.has(e.id))];
      });
      setOffset(nextOffset);
    } catch {
      // non-critical
    }
  };

  return (
    <div className="mb-4 rounded-xl border border-border-primary bg-bg-secondary overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-bg-tertiary/50 transition-colors"
      >
        <svg
          className={`w-3 h-3 text-text-muted transition-transform ${open ? "rotate-90" : ""}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M9 18l6-6-6-6" />
        </svg>
        <span className="text-xs font-medium text-text-primary">Autopilot Log</span>
        <span className="text-xs text-text-muted">({totalCount} iteration{totalCount !== 1 ? "s" : ""})</span>
        {isAutopilotRunning && (
          <span className="w-1.5 h-1.5 rounded-full bg-accent-green animate-pulse ml-1" />
        )}
      </button>

      {open && (
        <div className="px-4 pb-3 space-y-2">
          {allEntries.map((entry) => {
            const { icon, color } = statusIcon(entry.result);
            return (
              <div key={entry.id} className="flex items-start gap-2">
                <span className="text-text-muted text-xs font-mono w-8 flex-shrink-0 text-right pt-0.5">
                  #{entry.iteration}
                </span>
                <span className={`${color} text-sm flex-shrink-0 pt-0.5`}>{icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className="font-medium text-sm text-text-primary truncate">
                      {entry.action}
                    </span>
                    <span className="text-text-muted text-xs flex-shrink-0">
                      {relativeTime(entry.createdAt)}
                    </span>
                  </div>
                  {entry.decision && (
                    <p className="text-text-secondary text-xs mt-0.5 line-clamp-2">
                      {entry.decision}
                    </p>
                  )}
                </div>
              </div>
            );
          })}

          {hasMore && latestEntries.length >= PAGE_SIZE && (
            <button
              onClick={handleLoadMore}
              className="text-xs text-accent-blue hover:text-accent-blue/80 transition-colors mt-1"
            >
              Show earlier...
            </button>
          )}
        </div>
      )}
    </div>
  );
}
