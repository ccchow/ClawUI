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
  // Optimistic archive overrides: sessionId -> archived value
  const [archiveOverrides, setArchiveOverrides] = useState<Record<string, boolean>>({});

  // Derive effective sessions from props + optimistic overrides
  const effectiveSessions = useMemo(() => {
    const hasStarOverrides = Object.keys(starOverrides).length > 0;
    const hasArchiveOverrides = Object.keys(archiveOverrides).length > 0;
    if (!hasStarOverrides && !hasArchiveOverrides) return sessions;
    return sessions.map((s) => {
      let updated = s;
      if (s.sessionId in starOverrides) updated = { ...updated, starred: starOverrides[s.sessionId] };
      if (s.sessionId in archiveOverrides) updated = { ...updated, archived: archiveOverrides[s.sessionId] };
      return updated;
    });
  }, [sessions, starOverrides, archiveOverrides]);

  // Clear overrides when sessions prop updates (server caught up)
  useEffect(() => {
    setStarOverrides({});
    setArchiveOverrides({});
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

  const handleToggleArchive = async (e: React.MouseEvent, session: SessionMeta) => {
    e.preventDefault();
    e.stopPropagation();
    const newArchived = !session.archived;
    setArchiveOverrides((prev) => ({ ...prev, [session.sessionId]: newArchived }));
    try {
      await updateSessionMeta(session.sessionId, { archived: newArchived });
    } catch {
      setArchiveOverrides((prev) => ({ ...prev, [session.sessionId]: !newArchived }));
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
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-bg-secondary border border-border-primary text-text-secondary text-sm hover:bg-bg-tertiary transition-all active:scale-[0.98] whitespace-nowrap"
          title={`Sort by ${sort === "newest" ? "most messages" : "newest first"}`}
        >
          {sort === "newest" ? (
            <>
              <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="8" cy="8" r="6.5" /><path d="M8 4.5V8l2.5 1.5" />
              </svg>
              Newest
            </>
          ) : (
            <>
              <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 3h8M2 7h5M2 11h3M12 4v8M10 10l2 2 2-2" />
              </svg>
              Most msgs
            </>
          )}
        </button>
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <button
          onClick={() => setStarredFilter(!starredFilter)}
          className={`flex items-center gap-1.5 px-2.5 py-2 sm:py-1 rounded-lg border text-xs transition-all active:scale-[0.97] ${
            starredFilter
              ? "text-accent-amber border-accent-amber/40 bg-accent-amber/10"
              : "text-text-muted border-border-primary hover:bg-bg-tertiary"
          }`}
        >
          <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25z" />
          </svg>
          Starred
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
          className={`flex items-center gap-1.5 px-2.5 py-2 sm:py-1 rounded-lg border text-xs transition-all active:scale-[0.97] ${
            showArchived
              ? "text-text-secondary border-border-hover bg-bg-tertiary"
              : "text-text-muted border-border-primary hover:bg-bg-tertiary"
          }`}
        >
          <svg className="w-3 h-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="2" width="12" height="4" rx="1" /><path d="M3 6v7a1 1 0 001 1h8a1 1 0 001-1V6" /><path d="M6.5 9h3" />
          </svg>
          {showArchived ? "Showing archived" : "Archived"}
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
          {query || starredFilter || tagFilter ? (
            "No sessions matching current filters"
          ) : (
            <div className="flex flex-col items-center gap-3">
              <svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-text-muted/40">
                <rect x="6" y="8" width="36" height="28" rx="3" />
                <line x1="6" y1="14" x2="42" y2="14" />
                <line x1="14" y1="22" x2="22" y2="22" />
                <line x1="14" y1="28" x2="30" y2="28" />
                <circle cx="10" cy="11" r="1" fill="currentColor" />
                <circle cx="14" cy="11" r="1" fill="currentColor" />
                <circle cx="18" cy="11" r="1" fill="currentColor" />
              </svg>
              <p className="text-sm">No sessions found for this project</p>
              <p className="text-xs text-text-muted/70">
                Sessions appear here when you use Claude Code.
              </p>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((s) => (
            <Link
              key={s.sessionId}
              href={`/session/${s.sessionId}`}
              className={`block rounded-xl border border-border-primary bg-bg-secondary p-4 hover:bg-bg-tertiary hover:border-border-hover transition-all active:scale-[0.995] ${
                s.archived ? "opacity-60" : ""
              }`}
            >
              <div className="flex items-start justify-between gap-2 sm:gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    {/* Star button */}
                    <button
                      onClick={(e) => handleToggleStar(e, s)}
                      className={`flex-shrink-0 p-2 -m-1 rounded-lg transition-all active:scale-[0.9] ${
                        s.starred
                          ? "text-accent-amber"
                          : "text-text-muted/30 hover:text-accent-amber/60"
                      }`}
                      title={s.starred ? "Unstar" : "Star"}
                      aria-label={s.starred ? "Unstar session" : "Star session"}
                    >
                      <svg className="w-4 h-4" viewBox="0 0 16 16" fill={s.starred ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.2">
                        <path d="M8 1.5l2 4 4.5.65-3.25 3.17.77 4.48L8 11.77 3.98 13.8l.77-4.48L1.5 6.15 6 5.5z" />
                      </svg>
                    </button>

                    {/* Archive button */}
                    <button
                      onClick={(e) => handleToggleArchive(e, s)}
                      className={`flex-shrink-0 p-2 -m-1 rounded-lg transition-all active:scale-[0.9] ${
                        s.archived
                          ? "text-text-muted hover:text-text-secondary"
                          : "text-text-muted/30 hover:text-text-muted/60"
                      }`}
                      title={s.archived ? "Unarchive" : "Archive"}
                      aria-label={s.archived ? "Unarchive session" : "Archive session"}
                    >
                      <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        {s.archived ? (
                          <><rect x="2" y="2" width="12" height="4" rx="1" /><path d="M3 6v7a1 1 0 001 1h8a1 1 0 001-1V6" /><path d="M8 9v3M6 11l2 -2 2 2" /></>
                        ) : (
                          <><rect x="2" y="2" width="12" height="4" rx="1" /><path d="M3 6v7a1 1 0 001 1h8a1 1 0 001-1V6" /><path d="M8 9v3M6 10l2 2 2-2" /></>
                        )}
                      </svg>
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

                    {/* Tags — show first tag on mobile, all on desktop */}
                    {s.tags && s.tags.length > 0 && (
                      <>
                        <div className="flex gap-1 flex-wrap sm:hidden">
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-accent-blue/20 text-accent-blue">
                            {s.tags[0]}
                          </span>
                          {s.tags.length > 1 && (
                            <span className="text-[10px] text-text-muted">+{s.tags.length - 1}</span>
                          )}
                        </div>
                        <div className="gap-1 flex-wrap hidden sm:flex">
                          {s.tags.map((tag) => (
                            <span
                              key={tag}
                              className="text-[10px] px-1.5 py-0.5 rounded-full bg-accent-blue/20 text-accent-blue"
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                      </>
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
