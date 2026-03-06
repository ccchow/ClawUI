"use client";

import { useState, useCallback, useRef, useEffect } from "react";
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
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return "<1s";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  return `${seconds}s`;
}

function absoluteTime(dateStr: string): string {
  const d = new Date(dateStr);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function LogEntryRow({
  entry,
  isExpanded,
  onToggle,
}: {
  entry: AutopilotLogEntry;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const { icon, color } = statusIcon(entry.result);
  const decisionRef = useRef<HTMLParagraphElement>(null);
  const [overflows, setOverflows] = useState(false);

  useEffect(() => {
    if (isExpanded) return; // preserve last-known overflow when expanded
    const el = decisionRef.current;
    if (!el) { setOverflows(false); return; }
    setOverflows(el.scrollHeight > el.clientHeight);
  }, [entry.decision, isExpanded]);

  return (
    <div className="flex items-start gap-2">
      <span
        className="text-text-muted text-xs font-mono w-14 flex-shrink-0 text-right pt-0.5"
        title={absoluteTime(entry.createdAt)}
      >
        {relativeTime(entry.createdAt)}
      </span>
      <span className={`${color} text-sm flex-shrink-0 pt-0.5`}>{icon}</span>
      <div className="flex-1 min-w-0">
        <span className={`font-medium text-sm text-text-primary block ${isExpanded ? "" : "truncate"}`}>
          {entry.action}
        </span>
        {entry.decision && (
          <div className="relative">
            <p
              ref={decisionRef}
              className={`text-text-secondary text-xs mt-0.5 ${isExpanded ? "" : "line-clamp-2"}`}
            >
              {entry.decision}
            </p>
            {!isExpanded && overflows && (
              <button
                onClick={onToggle}
                aria-expanded={false}
                className="absolute bottom-0 right-0 text-xs text-text-secondary hover:text-text-primary transition-colors pl-6"
                style={{ background: 'linear-gradient(to right, transparent, rgb(var(--bg-secondary)) 40%)' }}
              >
                Show more
              </button>
            )}
          </div>
        )}
        {isExpanded && overflows && (
          <button
            onClick={onToggle}
            aria-expanded={true}
            className="text-xs text-text-secondary hover:text-text-primary transition-colors mt-0.5"
          >
            Show less
          </button>
        )}
      </div>
    </div>
  );
}

const PAGE_SIZE = 20;

export function AutopilotLog({ blueprintId, executionMode, blueprintStatus }: AutopilotLogProps) {
  const [open, setOpen] = useState(true);
  const [offset, setOffset] = useState(0);
  const [olderEntries, setOlderEntries] = useState<AutopilotLogEntry[]>([]);
  const [expandedEntries, setExpandedEntries] = useState<Set<string>>(new Set());
  const logTopRef = useRef<HTMLDivElement>(null);
  const isLogVisibleRef = useRef(true);
  const prevEntryCountRef = useRef(0);

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

  // Sort descending by time (newest first)
  allEntries.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const totalCount = allEntries.length;

  // Track whether the log header is visible in the viewport
  useEffect(() => {
    const el = logTopRef.current;
    if (!el || !open) return;
    const observer = new IntersectionObserver(
      ([entry]) => { isLogVisibleRef.current = entry.isIntersecting; },
      { threshold: 0 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [open]);

  // Auto-scroll to newest entry when new log entries arrive
  useEffect(() => {
    if (!isAutopilotRunning || !open) return;
    if (allEntries.length > prevEntryCountRef.current && prevEntryCountRef.current > 0) {
      if (isLogVisibleRef.current && logTopRef.current) {
        logTopRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    }
    prevEntryCountRef.current = allEntries.length;
  }, [allEntries.length, isAutopilotRunning, open]);

  if (totalCount === 0) return null;

  const hasMore = latestEntries.length === PAGE_SIZE || olderEntries.length > 0;

  const allExpanded = allEntries.length > 0 && allEntries.every((e) => expandedEntries.has(e.id));

  const toggleEntry = (id: string) => {
    setExpandedEntries((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllEntries = () => {
    if (allExpanded) {
      setExpandedEntries(new Set());
    } else {
      setExpandedEntries(new Set(allEntries.map((e) => e.id)));
    }
  };

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
        aria-expanded={open}
        aria-label={open ? "Collapse autopilot log" : "Expand autopilot log"}
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
        <div ref={logTopRef} className="px-4 pb-3 space-y-2">
          {totalCount > 1 && (
            <div className="flex justify-end">
              <button
                onClick={toggleAllEntries}
                className="text-xs text-text-secondary hover:text-text-primary transition-colors"
              >
                {allExpanded ? "Collapse all" : "Expand all"}
              </button>
            </div>
          )}

          {allEntries.map((entry, i) => {
            const nextEntry = allEntries[i + 1];
            const durationMs = nextEntry
              ? new Date(entry.createdAt).getTime() - new Date(nextEntry.createdAt).getTime()
              : 0;
            return (
              <div key={entry.id}>
                <LogEntryRow
                  entry={entry}
                  isExpanded={expandedEntries.has(entry.id)}
                  onToggle={() => toggleEntry(entry.id)}
                />
                {nextEntry && durationMs >= 1000 && (
                  <div className="flex items-center gap-2 py-0.5 pl-[4.5rem]">
                    <div className="flex-1 border-t border-border-primary/50" />
                    <span className="text-[10px] text-text-muted font-mono flex-shrink-0">
                      {formatDuration(durationMs)}
                    </span>
                    <div className="flex-1 border-t border-border-primary/50" />
                  </div>
                )}
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
