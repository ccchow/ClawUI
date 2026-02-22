"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import type { SessionMeta } from "@/lib/api";

type SortMode = "newest" | "most-messages";

function formatTime(ts: string): string {
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHrs = Math.floor(diffMins / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  const diffDays = Math.floor(diffHrs / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString();
}

export function SessionList({ sessions }: { sessions: SessionMeta[] }) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortMode>("newest");

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();

    let result = sessions;
    if (q) {
      result = sessions.filter(
        (s) =>
          (s.slug && s.slug.toLowerCase().includes(q)) ||
          s.sessionId.toLowerCase().includes(q) ||
          (s.cwd && s.cwd.toLowerCase().includes(q))
      );
    }

    if (sort === "most-messages") {
      return [...result].sort((a, b) => b.nodeCount - a.nodeCount);
    }
    // "newest" — already sorted by timestamp from API, but ensure it
    return [...result].sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
  }, [sessions, query, sort]);

  return (
    <div>
      {/* Search + sort controls */}
      <div className="flex gap-2 mb-4">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by slug, ID, or path..."
          className="flex-1 px-3 py-2 rounded-lg bg-bg-secondary border border-border-primary text-text-primary placeholder:text-text-muted text-sm focus:outline-none focus:border-accent-blue focus:ring-1 focus:ring-accent-blue/30"
        />
        <button
          onClick={() =>
            setSort((s) => (s === "newest" ? "most-messages" : "newest"))
          }
          className="px-3 py-2 rounded-lg bg-bg-secondary border border-border-primary text-text-secondary text-sm hover:bg-bg-tertiary transition-colors whitespace-nowrap"
          title={`Sort by ${sort === "newest" ? "most messages" : "newest first"}`}
        >
          {sort === "newest" ? "🕐 Newest" : "💬 Most msgs"}
        </button>
      </div>

      {/* Results count when filtering */}
      {query && (
        <p className="text-xs text-text-muted mb-2">
          {filtered.length} of {sessions.length} sessions
        </p>
      )}

      {filtered.length === 0 ? (
        <div className="text-center py-16 text-text-muted">
          {query
            ? `No sessions matching "${query}"`
            : "No sessions found for this project"}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((s) => (
            <Link
              key={s.sessionId}
              href={`/session/${s.sessionId}`}
              className="block rounded-xl border border-border-primary bg-bg-secondary p-4 hover:bg-bg-tertiary hover:border-border-hover transition-all"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    {s.slug && (
                      <span className="font-medium text-text-primary truncate">
                        {s.slug}
                      </span>
                    )}
                    <span className="text-xs text-text-muted font-mono truncate">
                      {s.sessionId.slice(0, 8)}
                    </span>
                  </div>
                  {s.cwd && (
                    <p className="text-xs text-text-muted truncate">{s.cwd}</p>
                  )}
                </div>
                <div className="text-right flex-shrink-0">
                  <div className="text-sm text-text-secondary">
                    {formatTime(s.timestamp)}
                  </div>
                  <div className="text-xs text-text-muted mt-0.5">
                    {s.nodeCount} messages
                  </div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
