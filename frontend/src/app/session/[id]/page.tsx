"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  getTimeline,
  runPrompt,
  type TimelineNode,
  type Suggestion,
} from "@/lib/api";
import { Timeline } from "@/components/Timeline";
import { SuggestionButtons } from "@/components/SuggestionButtons";
import { PromptInput } from "@/components/PromptInput";
import { saveSuggestions, loadSuggestions } from "@/lib/suggestions-store";

const POLL_INTERVAL = 5_000;

function timeAgo(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 5) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

export default function SessionPage() {
  const { id } = useParams<{ id: string }>();

  const [nodes, setNodes] = useState<TimelineNode[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<number>(0);
  const [refreshLabel, setRefreshLabel] = useState("just now");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const nodeCountRef = useRef(0);

  const fetchNodes = useCallback(
    async (showLoader = false) => {
      if (showLoader) setLoading(true);
      try {
        const n = await getTimeline(id);
        // Only update state if node count changed (avoids re-render churn)
        if (n.length !== nodeCountRef.current) {
          setNodes(n);
          nodeCountRef.current = n.length;
        }
        setLastRefresh(Date.now());
        if (showLoader) setLoading(false);
      } catch (e) {
        if (showLoader) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      }
    },
    [id]
  );

  // Initial load
  useEffect(() => {
    nodeCountRef.current = 0;
    fetchNodes(true);
    // Restore suggestions from cookie for this session
    const saved = loadSuggestions(id);
    if (saved.length > 0) setSuggestions(saved);
  }, [fetchNodes, id]);

  // Persist suggestions to cookie whenever they change
  useEffect(() => {
    if (suggestions.length > 0) {
      saveSuggestions(id, suggestions);
    }
  }, [id, suggestions]);

  // Auto-refresh poll
  useEffect(() => {
    if (!autoRefresh || loading) return;

    const interval = setInterval(() => {
      // Only poll when tab is visible and not running a prompt
      if (!document.hidden && !running) {
        fetchNodes(false);
      }
    }, POLL_INTERVAL);

    return () => clearInterval(interval);
  }, [autoRefresh, loading, running, fetchNodes]);

  // Update the "Xm ago" label every second
  useEffect(() => {
    if (!lastRefresh) return;
    const tick = setInterval(() => {
      setRefreshLabel(timeAgo(lastRefresh));
    }, 1_000);
    return () => clearInterval(tick);
  }, [lastRefresh]);

  const handleRun = async (prompt: string) => {
    setRunning(true);
    setError(null);
    setSuggestions([]);

    const userNodeId = `run-${Date.now()}`;
    const thinkingNodeId = `thinking-${Date.now()}`;
    const now = new Date().toISOString();

    // Optimistic UI: immediately show user message + thinking indicator
    setNodes((prev) => {
      const updated = [
        ...prev,
        {
          id: userNodeId,
          type: "user" as const,
          timestamp: now,
          title: prompt.slice(0, 120),
          content: prompt,
        },
        {
          id: thinkingNodeId,
          type: "system" as const,
          timestamp: now,
          title: "⏳ Claude Code is working...",
          content: prompt,
        },
      ];
      nodeCountRef.current = updated.length;
      return updated;
    });

    console.log("[ClawUI] Starting run:", { sessionId: id, promptLen: prompt.length });
    const startTime = Date.now();
    try {
      const url = `http://localhost:3001/api/sessions/${id}/run`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const elapsed = Date.now() - startTime;
      console.log("[ClawUI] Response received:", { status: res.status, elapsed: `${elapsed}ms` });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`API error ${res.status}: ${body}`);
      }

      const data = await res.json();
      console.log("[ClawUI] Parsed:", { outputLen: data.output?.length, suggestions: data.suggestions?.length });

      // Replace thinking node with actual response
      setNodes((prev) => {
        const updated = prev.map((n) =>
          n.id === thinkingNodeId
            ? {
                id: `result-${Date.now()}`,
                type: "assistant" as const,
                timestamp: new Date().toISOString(),
                title: (data.output || "").slice(0, 120),
                content: data.output || "(empty response)",
              }
            : n
        );
        nodeCountRef.current = updated.length;
        return updated;
      });
      setLastRefresh(Date.now());
      setSuggestions(data.suggestions || []);
    } catch (e) {
      const elapsed = Date.now() - startTime;
      console.error("[ClawUI] Run failed:", { elapsed: `${elapsed}ms`, error: e });
      // Replace thinking node with error
      setNodes((prev) =>
        prev.map((n) =>
          n.id === thinkingNodeId
            ? {
                id: `error-${Date.now()}`,
                type: "error" as const,
                timestamp: new Date().toISOString(),
                title: "❌ Failed",
                content: e instanceof Error ? e.message : String(e),
              }
            : n
        )
      );
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  if (error && nodes.length === 0) {
    return (
      <div className="text-center py-20">
        <p className="text-accent-red text-lg mb-2">Failed to load session</p>
        <p className="text-text-muted text-sm">{error}</p>
        <Link href="/" className="text-accent-blue text-sm mt-4 inline-block hover:underline">
          Back to sessions
        </Link>
      </div>
    );
  }

  return (
    <div className="pb-12">
      {/* Header */}
      <div className="mb-6">
        <Link
          href="/"
          className="text-sm text-text-muted hover:text-text-secondary transition-colors mb-2 inline-block"
        >
          ← Back to sessions
        </Link>
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold">Session</h1>
          <span className="text-sm text-text-muted font-mono">{id.slice(0, 8)}</span>
          <span className="text-xs text-text-muted">
            {nodes.length} nodes
          </span>

          {/* Refresh indicator */}
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => setAutoRefresh((v) => !v)}
              title={autoRefresh ? "Auto-refresh on (click to disable)" : "Auto-refresh off (click to enable)"}
              className={`w-2 h-2 rounded-full transition-colors ${
                autoRefresh ? "bg-accent-green animate-pulse" : "bg-text-muted"
              }`}
            />
            <span className="text-xs text-text-muted">{refreshLabel}</span>
            <button
              onClick={() => fetchNodes(false)}
              title="Refresh now"
              className="text-xs text-text-muted hover:text-text-primary transition-colors px-1.5 py-0.5 rounded hover:bg-bg-tertiary"
            >
              ↻
            </button>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-accent-blue border-t-transparent" />
        </div>
      ) : (
        <>
          {/* Action area — at top since timeline is newest-first */}
          <div className="mb-6 space-y-4">
            <PromptInput
              disabled={running}
              loading={running}
              onSubmit={handleRun}
            />

            <SuggestionButtons
              suggestions={suggestions}
              disabled={running}
              onSelect={handleRun}
            />

            {error && (
              <div className="p-3 rounded-lg bg-accent-red/10 border border-accent-red/20 text-accent-red text-sm">
                {error}
              </div>
            )}
          </div>

          <Timeline nodes={nodes} />
        </>
      )}
    </div>
  );
}
