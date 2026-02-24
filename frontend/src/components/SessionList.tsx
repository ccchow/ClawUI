"use client";

import { useState, useMemo, useEffect } from "react";
import Link from "next/link";
import { type SessionMeta, type SessionFilters, updateSessionMeta, getTags } from "@/lib/api";
import { formatTimeAgo } from "@/lib/format-time";

type SortMode = "newest" | "most-messages";

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
  // Optimistic star overrides: sessionId -> starred value
  const [starOverrides, setStarOverrides] = useState<Record<string, boolean>>({});

  // Derive effective sessions from props + optimistic star overrides
  const effectiveSessions = useMemo(() => {
    if (Object.keys(starOverrides).length === 0) return sessions;
    return sessions.map((s) =>
      s.sessionId in starOverrides ? { ...s, starred: starOverrides[s.sessionId] } : s
    );
  }, [sessions, starOverrides]);

  // Clear overrides when sessions prop updates (server caught up)
  useEffect(() => {
    setStarOverrides({});
  }, [sessions]);

  // Load available tags
  useEffect(() => {
    getTags().then(setAllTags).catch(() => { /* non-critical: stale data cleared on next poll */ });
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

    let result = effectiveSessions;

    // Client-side text search
    if (q) {
      result = result.filter(
        (s) =>
          (s.slug && s.slug.toLowerCase().includes(q)) ||
          (s.alias && s.alias.toLowerCase().includes(q)) ||
          s.sessionId.toLowerCase().includes(q) ||
          (s.cwd && s.cwd.toLowerCase().includes(q)) ||
          (s.macroNodeTitle && s.macroNodeTitle.toLowerCase().includes(q)) ||
          (s.macroNodeDescription && s.macroNodeDescription.toLowerCase().includes(q))
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
  }, [effectiveSessions, query, sort, starredFilter, tagFilter, showArchived]);

  const handleToggleStar = async (e: React.MouseEvent, session: SessionMeta) => {
    e.preventDefault();
    e.stopPropagation();
    const newStarred = !session.starred;
    // Optimistic update via overrides
    setStarOverrides((prev) => ({ ...prev, [session.sessionId]: newStarred }));
    try {
      await updateSessionMeta(session.sessionId, { starred: newStarred });
    } catch {
      // Revert on error
      setStarOverrides((prev) => ({ ...prev, [session.sessionId]: !newStarred }));
    }
  };

  // Collect tags visible in current sessions for the dropdown
  const visibleTags = useMemo(() => {
    const tagSet = new Set<string>();
    for (const s of effectiveSessions) {
      s.tags?.forEach((t) => tagSet.add(t));
    }
    // Merge with all tags from API
    for (const t of allTags) tagSet.add(t);
    return [...tagSet].sort();
  }, [effectiveSessions, allTags]);

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
          {filtered.length} of {effectiveSessions.length} sessions
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
              <div className="flex items-start justify-between gap-2 sm:gap-4">
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
                      <div className="flex gap-1 flex-wrap hidden sm:flex">
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
                  {s.macroNodeTitle && (
                    <p className="text-xs text-accent-purple truncate" title={s.macroNodeDescription || s.macroNodeTitle}>
                      {s.macroNodeTitle}{s.macroNodeDescription ? ` — ${s.macroNodeDescription}` : ""}
                    </p>
                  )}
                  {s.cwd && (
                    <p className="text-xs text-text-muted truncate">{s.cwd}</p>
                  )}
                </div>
                <div className="text-right flex-shrink-0">
                  <div className="text-sm text-text-secondary">
                    {formatTimeAgo(s.timestamp)}
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
