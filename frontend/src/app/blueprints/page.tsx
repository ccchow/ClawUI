"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { type Blueprint, type BlueprintStatus, listBlueprints, archiveBlueprint as archiveBlueprintApi, unarchiveBlueprint as unarchiveBlueprintApi } from "@/lib/api";
import { StatusIndicator } from "@/components/StatusIndicator";
import { SkeletonLoader } from "@/components/SkeletonLoader";

const STATUS_FILTERS: { label: string; value: BlueprintStatus | "all" }[] = [
  { label: "Approved", value: "approved" },
  { label: "Running", value: "running" },
  { label: "Done", value: "done" },
  { label: "Draft", value: "draft" },
  { label: "Failed", value: "failed" },
  { label: "Paused", value: "paused" },
  { label: "All", value: "all" },
];

function formatDate(ts: string): string {
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

const VALID_BP_STATUSES = new Set<string>(["approved", "running", "done", "draft", "failed", "paused", "all"]);

export default function BlueprintsPage() {
  const searchParams = useSearchParams();
  const [blueprints, setBlueprints] = useState<Blueprint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Initialize filter state from URL search params
  const initialStatus = searchParams.get("status");
  const [statusFilter, setStatusFilterRaw] = useState<BlueprintStatus | "all">(
    initialStatus && VALID_BP_STATUSES.has(initialStatus) ? initialStatus as BlueprintStatus | "all" : "approved"
  );
  const [showArchived, setShowArchivedRaw] = useState(searchParams.get("archived") === "1");
  const statusFilterRef = useRef(statusFilter);
  const showArchivedRef = useRef(showArchived);

  // Sync filter changes to URL + sessionStorage
  const syncFiltersToUrl = useCallback((status: BlueprintStatus | "all", archived: boolean) => {
    const url = new URL(window.location.href);
    if (status === "approved") url.searchParams.delete("status");
    else url.searchParams.set("status", status);
    if (!archived) url.searchParams.delete("archived");
    else url.searchParams.set("archived", "1");
    window.history.replaceState({}, "", url.toString());
    try { sessionStorage.setItem("clawui:blueprints-filters", url.search); } catch { /* ignore */ }
  }, []);

  const setStatusFilter = useCallback((value: BlueprintStatus | "all") => {
    setStatusFilterRaw(value);
    statusFilterRef.current = value;
    syncFiltersToUrl(value, showArchivedRef.current);
  }, [syncFiltersToUrl]);

  const setShowArchived = useCallback((value: boolean) => {
    setShowArchivedRaw(value);
    showArchivedRef.current = value;
    syncFiltersToUrl(statusFilterRef.current, value);
  }, [syncFiltersToUrl]);

  // Save initial filter state to sessionStorage on mount
  useEffect(() => {
    syncFiltersToUrl(statusFilterRef.current, showArchivedRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on mount
  }, []);

  const loadBlueprints = useCallback(() => {
    return listBlueprints({ includeArchived: showArchived })
      .then(setBlueprints)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [showArchived]);

  useEffect(() => {
    setLoading(true);
    loadBlueprints();
  }, [loadBlueprints]);

  const filtered = useMemo(() => {
    let list = blueprints;
    // When showing archived, filter to only archived if toggle is on
    // When not showing archived, the API already excludes them
    if (showArchived) {
      list = list.filter((bp) => bp.archivedAt);
    }
    if (statusFilter !== "all") {
      list = list.filter((bp) => bp.status === statusFilter);
    }
    return list;
  }, [blueprints, statusFilter, showArchived]);

  // Count per status for badge display
  const statusCounts = useMemo(() => {
    const relevantBps = showArchived
      ? blueprints.filter((bp) => bp.archivedAt)
      : blueprints;
    const counts: Record<string, number> = { all: relevantBps.length };
    for (const bp of relevantBps) {
      counts[bp.status] = (counts[bp.status] || 0) + 1;
    }
    return counts;
  }, [blueprints, showArchived]);

  const archivedCount = useMemo(() => {
    return blueprints.filter((bp) => bp.archivedAt).length;
  }, [blueprints]);

  const handleArchive = useCallback(async (e: React.MouseEvent, bpId: string) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await archiveBlueprintApi(bpId);
      setBlueprints((prev) => prev.filter((bp) => bp.id !== bpId));
    } catch {
      // silently fail — user can retry
    }
  }, []);

  const handleUnarchive = useCallback(async (e: React.MouseEvent, bpId: string) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      const updated = await unarchiveBlueprintApi(bpId);
      setBlueprints((prev) => prev.map((bp) => bp.id === updated.id ? updated : bp));
    } catch {
      // silently fail
    }
  }, []);

  if (loading) {
    return (
      <div className="py-4">
        <div className="flex items-center justify-between mb-4">
          <div className="h-6 w-32 rounded bg-bg-tertiary animate-pulse" />
          <div className="h-9 w-32 rounded-lg bg-bg-tertiary animate-pulse" />
        </div>
        <SkeletonLoader variant="list" count={4} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-16 text-accent-red">
        Failed to load blueprints: {error}
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold">Blueprints</h1>
        <Link
          href="/blueprints/new"
          className="px-4 py-2 rounded-lg bg-accent-blue text-white text-sm font-medium hover:bg-accent-blue/90 transition-all active:scale-[0.98]"
        >
          New Blueprint
        </Link>
      </div>

      {/* Status filter chips + Archive toggle */}
      <div className="flex flex-wrap items-center gap-1.5 mb-4">
        {STATUS_FILTERS.map((f) => {
          const count = statusCounts[f.value] || 0;
          if (f.value !== "all" && count === 0) return null;
          const isActive = statusFilter === f.value;
          return (
            <button
              key={f.value}
              onClick={() => setStatusFilter(f.value)}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-all active:scale-[0.96] ${
                isActive
                  ? "bg-accent-blue text-white"
                  : "bg-bg-tertiary text-text-muted hover:text-text-secondary hover:bg-bg-tertiary/80"
              }`}
            >
              {f.label}
              <span className={`ml-1.5 ${isActive ? "text-white/70" : "text-text-muted/60"}`}>
                {count}
              </span>
            </button>
          );
        })}

        {/* Separator + Archive toggle */}
        <span className="w-px h-4 bg-border-primary mx-1" />
        <button
          onClick={() => setShowArchived(!showArchived)}
          className={`px-3 py-1 rounded-full text-xs font-medium transition-all active:scale-[0.96] flex items-center gap-1.5 ${
            showArchived
              ? "bg-text-muted/20 text-text-secondary"
              : "bg-bg-tertiary text-text-muted hover:text-text-secondary hover:bg-bg-tertiary/80"
          }`}
          aria-label={showArchived ? "Hide archived blueprints" : "Show archived blueprints"}
        >
          {/* Archive box icon */}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="3" width="20" height="5" rx="1" />
            <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
            <path d="M10 12h4" />
          </svg>
          Archived
          {archivedCount > 0 && (
            <span className={`${showArchived ? "text-text-muted" : "text-text-muted/60"}`}>
              {archivedCount}
            </span>
          )}
        </button>
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-16 text-text-muted">
          {blueprints.length === 0 && !showArchived ? (
            <div className="flex flex-col items-center gap-3">
              <svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-text-muted/40">
                <rect x="8" y="6" width="32" height="36" rx="3" />
                <line x1="16" y1="16" x2="32" y2="16" />
                <line x1="16" y1="22" x2="28" y2="22" />
                <line x1="16" y1="28" x2="24" y2="28" />
                <rect x="14" y="34" width="8" height="4" rx="1" className="text-text-muted/20" fill="currentColor" />
              </svg>
              <p className="text-sm">No blueprints yet.</p>
              <p className="text-xs text-text-muted/70">
                Blueprints orchestrate multi-step tasks with Claude Code.
              </p>
              <Link
                href="/blueprints/new"
                className="mt-1 px-5 py-2.5 rounded-lg bg-accent-blue text-white text-sm font-medium hover:bg-accent-blue/90 transition-colors"
              >
                New Blueprint
              </Link>
            </div>
          ) : showArchived && archivedCount === 0 ? (
            <p className="text-sm">No archived blueprints.</p>
          ) : (
            <p className="text-sm">
              No {showArchived ? "archived " : ""}{statusFilter !== "all" ? statusFilter + " " : ""}blueprints.{" "}
              {statusFilter !== "all" && (
                <button
                  onClick={() => setStatusFilter("all")}
                  className="text-accent-blue hover:underline"
                >
                  Show all
                </button>
              )}
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((bp) => (
            <div key={bp.id} className="relative group">
              <Link
                href={`/blueprints/${bp.id}`}
                className={`block rounded-xl border border-border-primary bg-bg-secondary p-4 hover:bg-bg-tertiary hover:border-border-hover transition-all active:scale-[0.995] ${
                  bp.archivedAt ? "opacity-60" : ""
                }`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1 min-w-0">
                      <StatusIndicator status={bp.status} />
                      <span className="font-medium text-text-primary truncate min-w-0">
                        {bp.title}
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-bg-tertiary text-text-muted capitalize flex-shrink-0">
                        {bp.status}
                      </span>
                      {bp.archivedAt && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-text-muted/10 text-text-muted flex-shrink-0">
                          archived
                        </span>
                      )}
                    </div>
                    {bp.description && (
                      <p className="text-sm text-text-muted truncate">
                        {bp.description}
                      </p>
                    )}
                    {bp.projectCwd && (
                      <p className="text-xs text-text-muted mt-1 truncate font-mono">
                        {bp.projectCwd}
                      </p>
                    )}
                  </div>
                  <div className="flex items-start gap-2 flex-shrink-0">
                    <div className="text-right">
                      <div className="text-sm text-text-secondary">
                        {formatDate(bp.updatedAt)}
                      </div>
                      <div className="text-xs text-text-muted mt-0.5">
                        {bp.nodes.length} node{bp.nodes.length !== 1 ? "s" : ""}
                      </div>
                    </div>
                    {/* Archive/Unarchive button */}
                    {bp.archivedAt ? (
                      <button
                        onClick={(e) => handleUnarchive(e, bp.id)}
                        className="p-2 -m-1 rounded-lg opacity-40 sm:opacity-0 sm:group-hover:opacity-100 hover:bg-bg-tertiary transition-all"
                        aria-label="Unarchive blueprint"
                        title="Unarchive"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="2" y="3" width="20" height="5" rx="1" />
                          <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
                          <path d="M12 12v6" />
                          <path d="M9 15l3-3 3 3" />
                        </svg>
                      </button>
                    ) : (
                      <button
                        onClick={(e) => handleArchive(e, bp.id)}
                        className="p-2 -m-1 rounded-lg opacity-40 sm:opacity-0 sm:group-hover:opacity-100 hover:bg-bg-tertiary transition-all"
                        aria-label="Archive blueprint"
                        title="Archive"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="2" y="3" width="20" height="5" rx="1" />
                          <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
                          <path d="M10 12h4" />
                        </svg>
                      </button>
                    )}
                  </div>
                </div>
              </Link>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
