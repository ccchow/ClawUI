"use client";

import { useState, useMemo, useEffect } from "react";
import Link from "next/link";
import { type SessionMeta, type SessionFilters, updateSessionMeta, getTags } from "@/lib/api";

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

export function SessionList({
  sessions,
  onFiltersChange,
}: {
  sessions: SessionMeta[];
  onFiltersChange?: (filters: SessionFilters) => void;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortMode>("newest");
  const [starredFilter, setStarredFilter] = useState(false);
  const [tagFilter, setTagFilter] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [localSessions, setLocalSessions] = useState<SessionMeta[]>(sessions);

  // Sync prop changes
  useEffect(() => {
    setLocalSessions(sessions);
  }, [sessions]);

  // Load available tags
  useEffect(() => {
    getTags().then(setAllTags).catch(() => {});
  }, []);

  // Notify parent of filter changes (for server-side filtering)
  useEffect(() => {
    onFiltersChange?.({
      starred: starredFilter || undefined,
      tag: tagFilter || undefined,
      archived: showArchived || undefined,
    });
  }, [starredFilter, tagFilter, showArchived, onFiltersChange]);

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();

    let result = localSessions;

    // Client-side text search
    if (q) {
      result = result.filter(
        (s) =>
          (s.slug && s.slug.toLowerCase().includes(q)) ||
          (s.alias && s.alias.toLowerCase().includes(q)) ||
          s.sessionId.toLowerCase().includes(q) ||
          (s.cwd && s.cwd.toLowerCase().includes(q))
      );
    }

    // Client-side star filter (supplement server-side)
    if (starredFilter) {
      result = result.filter((s) => s.starred);
    }

    // Client-side tag filter
    if (tagFilter) {
      result = result.filter((s) => s.tags?.includes(tagFilter));
    }

    // Hide archived unless toggled
    if (!showArchived) {
      result = result.filter((s) => !s.archived);
    }

    if (sort === "most-messages") {
      return [...result].sort((a, b) => b.nodeCount - a.nodeCount);
    }
    return [...result].sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
  }, [localSessions, query, sort, starredFilter, tagFilter, showArchived]);

  const handleToggleStar = async (e: React.MouseEvent, session: SessionMeta) => {
    e.preventDefault();
    e.stopPropagation();
    const newStarred = !session.starred;
    // Optimistic update
    setLocalSessions((prev) =>
      prev.map((s) =>
        s.sessionId === session.sessionId ? { ...s, starred: newStarred } : s
      )
    );
    try {
      await updateSessionMeta(session.sessionId, { starred: newStarred });
    } catch {
      // Revert on error
      setLocalSessions((prev) =>
        prev.map((s) =>
          s.sessionId === session.sessionId ? { ...s, starred: !newStarred } : s
        )
      );
    }
  };

  // Collect tags visible in current sessions for the dropdown
  const visibleTags = useMemo(() => {
    const tagSet = new Set<string>();
    for (const s of localSessions) {
      s.tags?.forEach((t) => tagSet.add(t));
    }
    // Merge with all tags from API
    for (const t of allTags) tagSet.add(t);
    return [...tagSet].sort();
  }, [localSessions, allTags]);

  return (
    <div>
      {/* Search + sort controls */}
      <div className="flex gap-2 mb-3">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by slug, alias, ID, or path..."
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

      {/* Filter bar */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <button
          onClick={() => setStarredFilter(!starredFilter)}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs transition-all ${
            starredFilter
              ? "text-yellow-400 border-yellow-400/40 bg-yellow-400/10"
              : "text-text-muted border-border-primary hover:bg-bg-tertiary"
          }`}
        >
          ⭐ Starred
        </button>

        {visibleTags.length > 0 && (
          <select
            value={tagFilter}
            onChange={(e) => setTagFilter(e.target.value)}
            className="px-2.5 py-1 rounded-lg border border-border-primary bg-bg-secondary text-text-secondary text-xs focus:outline-none focus:border-accent-blue"
          >
            <option value="">All tags</option>
            {visibleTags.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        )}

        <button
          onClick={() => setShowArchived(!showArchived)}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs transition-all ${
            showArchived
              ? "text-text-secondary border-border-hover bg-bg-tertiary"
              : "text-text-muted border-border-primary hover:bg-bg-tertiary"
          }`}
        >
          {showArchived ? "📦 Showing archived" : "📦 Archived"}
        </button>

        {(starredFilter || tagFilter || showArchived) && (
          <button
            onClick={() => {
              setStarredFilter(false);
              setTagFilter("");
              setShowArchived(false);
            }}
            className="text-xs text-text-muted hover:text-text-secondary transition-colors"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Results count when filtering */}
      {(query || starredFilter || tagFilter) && (
        <p className="text-xs text-text-muted mb-2">
          {filtered.length} of {localSessions.length} sessions
        </p>
      )}

      {filtered.length === 0 ? (
        <div className="text-center py-16 text-text-muted">
          {query || starredFilter || tagFilter
            ? "No sessions matching current filters"
            : "No sessions found for this project"}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((s) => (
            <Link
              key={s.sessionId}
              href={`/session/${s.sessionId}`}
              className={`block rounded-xl border border-border-primary bg-bg-secondary p-4 hover:bg-bg-tertiary hover:border-border-hover transition-all ${
                s.archived ? "opacity-60" : ""
              }`}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    {/* Star button */}
                    <button
                      onClick={(e) => handleToggleStar(e, s)}
                      className={`flex-shrink-0 text-sm transition-colors ${
                        s.starred
                          ? "text-yellow-400"
                          : "text-text-muted/30 hover:text-yellow-400/60"
                      }`}
                      title={s.starred ? "Unstar" : "Star"}
                    >
                      {s.starred ? "★" : "☆"}
                    </button>

                    {/* Alias or slug */}
                    {(s.alias || s.slug) && (
                      <span className="font-medium text-text-primary truncate">
                        {s.alias || s.slug}
                      </span>
                    )}
                    <span className="text-xs text-text-muted font-mono truncate">
                      {s.sessionId.slice(0, 8)}
                    </span>

                    {/* Tags */}
                    {s.tags && s.tags.length > 0 && (
                      <div className="flex gap-1 flex-shrink-0">
                        {s.tags.map((tag) => (
                          <span
                            key={tag}
                            className="text-[10px] px-1.5 py-0.5 rounded-full bg-accent-blue/20 text-accent-blue"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
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
