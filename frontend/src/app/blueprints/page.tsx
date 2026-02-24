"use client";

import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import { type Blueprint, type BlueprintStatus, listBlueprints } from "@/lib/api";
import { StatusIndicator } from "@/components/StatusIndicator";

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

export default function BlueprintsPage() {
  const [blueprints, setBlueprints] = useState<Blueprint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<BlueprintStatus | "all">("approved");

  useEffect(() => {
    listBlueprints()
      .then(setBlueprints)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    if (statusFilter === "all") return blueprints;
    return blueprints.filter((bp) => bp.status === statusFilter);
  }, [blueprints, statusFilter]);

  // Count per status for badge display
  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { all: blueprints.length };
    for (const bp of blueprints) {
      counts[bp.status] = (counts[bp.status] || 0) + 1;
    }
    return counts;
  }, [blueprints]);

  if (loading) {
    return (
      <div className="text-center py-16 text-text-muted">
        Loading blueprints...
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
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold">Blueprints</h1>
        <Link
          href="/blueprints/new"
          className="px-4 py-2 rounded-lg bg-accent-blue text-white text-sm font-medium hover:bg-accent-blue/90 transition-colors"
        >
          New Blueprint
        </Link>
      </div>

      {/* Status filter chips */}
      <div className="flex flex-wrap gap-1.5 mb-4">
        {STATUS_FILTERS.map((f) => {
          const count = statusCounts[f.value] || 0;
          if (f.value !== "all" && count === 0) return null;
          const isActive = statusFilter === f.value;
          return (
            <button
              key={f.value}
              onClick={() => setStatusFilter(f.value)}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
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
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-16 text-text-muted">
          {blueprints.length === 0 ? (
            <>
              <p className="mb-2">No blueprints yet.</p>
              <p className="text-sm">
                Create your first blueprint to start orchestrating multi-step tasks.
              </p>
            </>
          ) : (
            <p className="text-sm">
              No {statusFilter} blueprints.{" "}
              <button
                onClick={() => setStatusFilter("all")}
                className="text-accent-blue hover:underline"
              >
                Show all
              </button>
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((bp) => (
            <Link
              key={bp.id}
              href={`/blueprints/${bp.id}`}
              className="block rounded-xl border border-border-primary bg-bg-secondary p-4 hover:bg-bg-tertiary hover:border-border-hover transition-all"
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
                <div className="text-right flex-shrink-0">
                  <div className="text-sm text-text-secondary">
                    {formatDate(bp.updatedAt)}
                  </div>
                  <div className="text-xs text-text-muted mt-0.5">
                    {bp.nodes.length} node{bp.nodes.length !== 1 ? "s" : ""}
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
