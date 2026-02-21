"use client";

import Link from "next/link";
import type { SessionMeta } from "@/lib/api";

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
  if (sessions.length === 0) {
    return (
      <div className="text-center py-16 text-text-muted">
        No sessions found for this project
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {sessions.map((s) => (
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
  );
}
