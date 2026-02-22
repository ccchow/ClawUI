"use client";

import { useEffect, useState, useCallback } from "react";
import { getProjects, getSessions, type ProjectInfo, type SessionMeta, type SessionFilters } from "@/lib/api";
import { SessionList } from "@/components/SessionList";

export default function HomePage() {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<SessionFilters>({});

  useEffect(() => {
    getProjects()
      .then((p) => {
        setProjects(p);
        if (p.length > 0) {
          setSelectedProject(p[0].id);
        }
        setLoading(false);
      })
      .catch((e) => {
        setError(e.message);
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (!selectedProject) return;
    setLoading(true);
    getSessions(selectedProject, filters)
      .then((s) => {
        setSessions(s);
        setLoading(false);
      })
      .catch((e) => {
        setError(e.message);
        setLoading(false);
      });
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
    <div>
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

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-accent-blue border-t-transparent" />
        </div>
      ) : (
        <SessionList sessions={sessions} onFiltersChange={handleFiltersChange} />
      )}
    </div>
  );
}
