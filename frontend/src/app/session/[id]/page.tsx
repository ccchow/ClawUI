"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  getTimeline,
  updateSessionMeta,
  getSessionExecution,
  getBlueprint,
  type TimelineNode,
  type Suggestion,
  type SessionMeta,
  type Blueprint,
  type MacroNode,
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

function SessionInfoHeader({
  sessionId,
  meta,
  onMetaChange,
}: {
  sessionId: string;
  meta: { alias?: string; tags?: string[]; notes?: string; starred?: boolean };
  onMetaChange: (patch: Partial<SessionMeta>) => void;
}) {
  const [tagInput, setTagInput] = useState("");
  const [editingNotes, setEditingNotes] = useState(false);
  const [notesValue, setNotesValue] = useState(meta.notes || "");
  const notesRef = useRef<HTMLTextAreaElement>(null);

  // Sync notes from parent
  useEffect(() => {
    if (!editingNotes) setNotesValue(meta.notes || "");
  }, [meta.notes, editingNotes]);

  const handleAddTag = () => {
    const tag = tagInput.trim().toLowerCase();
    if (!tag) return;
    const currentTags = meta.tags || [];
    if (currentTags.includes(tag)) {
      setTagInput("");
      return;
    }
    const newTags = [...currentTags, tag];
    onMetaChange({ tags: newTags });
    updateSessionMeta(sessionId, { tags: newTags }).catch(() => {
      onMetaChange({ tags: currentTags });
    });
    setTagInput("");
  };

  const handleRemoveTag = (tag: string) => {
    const currentTags = meta.tags || [];
    const newTags = currentTags.filter((t) => t !== tag);
    onMetaChange({ tags: newTags });
    updateSessionMeta(sessionId, { tags: newTags }).catch(() => {
      onMetaChange({ tags: currentTags });
    });
  };

  const handleNotesSave = () => {
    setEditingNotes(false);
    if (notesValue !== (meta.notes || "")) {
      onMetaChange({ notes: notesValue });
      updateSessionMeta(sessionId, { notes: notesValue }).catch(() => {
        onMetaChange({ notes: meta.notes });
      });
    }
  };

  return (
    <div className="rounded-xl border border-border-primary bg-bg-secondary p-4 mb-4 space-y-3">
      {/* Alias */}
      {meta.alias && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-muted uppercase tracking-wider">Alias</span>
          <span className="text-sm font-medium text-text-primary">{meta.alias}</span>
        </div>
      )}

      {/* Tags */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-text-muted uppercase tracking-wider">Tags</span>
        {(meta.tags || []).map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-accent-blue/20 text-accent-blue"
          >
            {tag}
            <button
              onClick={() => handleRemoveTag(tag)}
              className="text-accent-blue/60 hover:text-accent-blue transition-colors"
            >
              ×
            </button>
          </span>
        ))}
        <input
          type="text"
          value={tagInput}
          onChange={(e) => setTagInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleAddTag();
            }
          }}
          placeholder="Add tag..."
          className="text-xs px-2 py-0.5 rounded-lg bg-bg-primary border border-border-primary text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-blue w-24"
        />
      </div>

      {/* Notes */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs text-text-muted uppercase tracking-wider">Notes</span>
          {!editingNotes && (
            <button
              onClick={() => {
                setEditingNotes(true);
                setTimeout(() => notesRef.current?.focus(), 0);
              }}
              className="text-xs text-text-muted hover:text-text-secondary transition-colors"
            >
              {meta.notes ? "edit" : "add"}
            </button>
          )}
        </div>
        {editingNotes ? (
          <textarea
            ref={notesRef}
            value={notesValue}
            onChange={(e) => setNotesValue(e.target.value)}
            onBlur={handleNotesSave}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setNotesValue(meta.notes || "");
                setEditingNotes(false);
              }
            }}
            placeholder="Add session notes..."
            className="w-full text-sm px-3 py-2 rounded-lg bg-bg-primary border border-accent-blue text-text-primary placeholder:text-text-muted focus:outline-none resize-y min-h-[60px]"
            rows={3}
          />
        ) : meta.notes ? (
          <p
            className="text-sm text-text-secondary whitespace-pre-wrap cursor-pointer hover:text-text-primary transition-colors"
            onClick={() => {
              setEditingNotes(true);
              setTimeout(() => notesRef.current?.focus(), 0);
            }}
          >
            {meta.notes}
          </p>
        ) : null}
      </div>
    </div>
  );
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

  // Session enrichment meta
  const [sessionMeta, setSessionMeta] = useState<{
    alias?: string;
    tags?: string[];
    notes?: string;
    starred?: boolean;
  }>({});

  // Blueprint context (if this session was created by a plan execution)
  const [blueprintContext, setBlueprintContext] = useState<{
    blueprint: Blueprint;
    node: MacroNode;
    nodeIndex: number;
  } | null>(null);

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

  // Fetch blueprint context (reverse lookup: session → execution → blueprint)
  useEffect(() => {
    async function loadBlueprintContext() {
      try {
        const execution = await getSessionExecution(id);
        if (!execution) return;
        const bp = await getBlueprint(execution.blueprintId);
        const node = bp.nodes.find((n) => n.id === execution.nodeId);
        if (!node) return;
        const nodeIndex = bp.nodes.findIndex((n) => n.id === execution.nodeId);
        setBlueprintContext({ blueprint: bp, node, nodeIndex });
      } catch {
        // No blueprint linked — that's fine
      }
    }
    loadBlueprintContext();
  }, [id]);

  // Fetch session enrichment meta
  useEffect(() => {
    async function loadSessionMeta() {
      try {
        const res = await fetch(`http://localhost:3001/api/sessions/${id}/meta`);
        if (res.ok) {
          const meta = await res.json();
          setSessionMeta(meta);
        }
      } catch {
        // Meta endpoint may not exist yet, ignore
      }
    }
    loadSessionMeta();
  }, [id]);

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

  const handleMetaChange = (patch: Partial<SessionMeta>) => {
    setSessionMeta((prev) => ({ ...prev, ...patch }));
  };

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
          <h1 className="text-xl font-bold">
            {sessionMeta.alias || "Session"}
          </h1>
          <span className="text-sm text-text-muted font-mono">{id.slice(0, 8)}</span>
          <span className="text-xs text-text-muted">
            {nodes.length} nodes
          </span>

          {/* Tags in header */}
          {sessionMeta.tags && sessionMeta.tags.length > 0 && (
            <div className="flex gap-1">
              {sessionMeta.tags.map((tag) => (
                <span
                  key={tag}
                  className="text-[10px] px-1.5 py-0.5 rounded-full bg-accent-blue/20 text-accent-blue"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}

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
          {/* Blueprint context banner */}
          {blueprintContext && (
            <div className="rounded-xl border border-accent-purple/30 bg-accent-purple/10 p-3 mb-4 flex items-center gap-2 text-sm">
              <span className="text-accent-purple font-medium">Blueprint</span>
              <Link
                href={`/blueprints/${blueprintContext.blueprint.id}`}
                className="text-accent-blue hover:underline font-medium truncate"
              >
                {blueprintContext.blueprint.title}
              </Link>
              <span className="text-text-muted">&rarr;</span>
              <span className="text-text-secondary">
                Node #{blueprintContext.nodeIndex + 1}:
              </span>
              <span className="text-text-primary font-medium truncate">
                {blueprintContext.node.title}
              </span>
            </div>
          )}

          {/* Session info header with notes and tag editor */}
          <SessionInfoHeader
            sessionId={id}
            meta={sessionMeta}
            onMetaChange={handleMetaChange}
          />

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
