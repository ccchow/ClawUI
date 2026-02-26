"use client";

import { useEffect, useState, useCallback } from "react";
import { getProjects, getSessions, type ProjectInfo, type SessionMeta, type SessionFilters } from "@/lib/api";
import { SessionList } from "@/components/SessionList";

export default function SessionsPage() {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<SessionFilters>({});

  useEffect(() => {
    getProjects()
      .then((p) => {
        setProjects(p);
        if (p.length > 0) {
          setSelectedProject(p[0].id);
        }
        setInitialLoading(false);
      })
      .catch((e) => {
        setError(e.message);
        setInitialLoading(false);
      });
  }, []);

  useEffect(() => {
    if (!selectedProject) return;
    // Only show full loading on initial mount when no sessions exist yet
    const isInitial = sessions.length === 0;
    if (isInitial) setInitialLoading(true);
    else setRefreshing(true);

    getSessions(selectedProject, filters)
      .then((s) => {
        setSessions(s);
        setInitialLoading(false);
        setRefreshing(false);
      })
      .catch((e) => {
        setError(e.message);
        setInitialLoading(false);
        setRefreshing(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sessions is intentionally excluded to avoid refetch loops when sessions state updates
  }, [selectedProject, filters]);

  const handleFiltersChange = useCallback((newFilters: SessionFilters) => {
    setFilters(newFilters);
  }, []);

  if (error) {
    return (
      <div className="text-center py-20">
        <p className="text-accent-red text-lg mb-2">Failed to load</p>
        <p className="text-text-muted text-sm">{error}</p>
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-1">Sessions</h1>
        <p className="text-text-secondary text-sm">
          Browse Claude Code sessions across your projects
        </p>
      </div>

      {/* Project selector */}
      {projects.length > 1 && (
        <div className="flex gap-2 mb-6 overflow-x-auto pb-2">
          {projects.map((p) => (
            <button
              key={p.id}
              onClick={() => setSelectedProject(p.id)}
              className={`px-3 py-1.5 rounded-lg text-sm whitespace-nowrap transition-colors ${
                selectedProject === p.id
                  ? "bg-accent-blue text-white"
                  : "bg-bg-tertiary text-text-secondary hover:bg-bg-hover"
              }`}
            >
              {p.name}
              <span className="ml-1.5 opacity-60">({p.sessionCount})</span>
            </button>
          ))}
        </div>
      )}

      {initialLoading && sessions.length === 0 ? (
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-accent-blue border-t-transparent" />
        </div>
      ) : (
        <div className="relative">
          {/* Subtle overlay when refreshing with filter/project changes */}
          {refreshing && (
            <div className="absolute inset-0 z-10 flex items-start justify-end p-2 pointer-events-none">
              <div className="animate-spin rounded-full h-4 w-4 border-2 border-accent-blue border-t-transparent" />
            </div>
          )}
          <div className={refreshing ? "opacity-70 transition-opacity duration-150" : "transition-opacity duration-150"}>
            <SessionList sessions={sessions} onFiltersChange={handleFiltersChange} />
          </div>
        </div>
      )}
    </div>
  );
}
