"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  getTimeline,
  updateSessionMeta,
  getSessionMeta,
  runPrompt,
  getSessionExecution,
  getBlueprint,
  type TimelineNode,
  type Suggestion,
  type SessionMeta,
  type Blueprint,
  type MacroNode,
} from "@/lib/api";
import { formatTimeAgo } from "@/lib/format-time";
import { Timeline } from "@/components/Timeline";
import { MarkdownContent } from "@/components/MarkdownContent";
import { SuggestionButtons } from "@/components/SuggestionButtons";
import { PromptInput } from "@/components/PromptInput";
import { saveSuggestions, loadSuggestions } from "@/lib/suggestions-store";

const POLL_INTERVAL = 5_000;
const POLL_INTERVAL_RUNNING = 2_000;

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
          className="text-xs px-2 py-0.5 rounded-lg bg-bg-primary border border-border-primary text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-blue w-20 sm:w-24"
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
          <div
            className="cursor-pointer hover:text-text-primary transition-colors"
            onClick={() => {
              setEditingNotes(true);
              setTimeout(() => notesRef.current?.focus(), 0);
            }}
          >
            <MarkdownContent content={meta.notes} maxHeight="200px" />
          </div>
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
  // Fingerprint for poll dedup: detects both count changes and content replacement (synthetic → real nodes)
  const pollFingerprintRef = useRef("");

  // Refs for live-polling during a run (allows fetchNodes to read without re-creation)
  const runningRef = useRef(false);
  const thinkingNodeRef = useRef<TimelineNode | null>(null);
  const preRunNodeCountRef = useRef(0);

  // Session enrichment meta
  const [sessionMeta, setSessionMeta] = useState<{
    alias?: string;
    tags?: string[];
    notes?: string;
    starred?: boolean;
    archived?: boolean;
  }>({});

  // Blueprint context (if this session was created by a plan execution)
  const [blueprintContext, setBlueprintContext] = useState<{
    blueprint: Blueprint;
    node: MacroNode;
    nodeIndex: number;
  } | null>(null);

  // Used for polling and manual refresh only (not initial load)
  const fetchNodes = useCallback(
    async () => {
      try {
        const n = await getTimeline(id);
        const last = n[n.length - 1];

        if (runningRef.current && thinkingNodeRef.current) {
          // During a run: only update display once server has new content beyond pre-run state.
          // This ensures the optimistic user message stays visible until the real node appears.
          if (n.length > preRunNodeCountRef.current) {
            const fp = `${n.length}-${last?.id ?? ""}-running`;
            if (fp !== pollFingerprintRef.current) {
              setNodes([...n, thinkingNodeRef.current]);
              pollFingerprintRef.current = fp;
            }
          }
          // If no new content yet, keep optimistic state unchanged
        } else {
          // Normal polling: replace nodes if fingerprint changed
          const fp = `${n.length}-${last?.id ?? ""}`;
          if (fp !== pollFingerprintRef.current) {
            setNodes(n);
            pollFingerprintRef.current = fp;
          }
        }
        setLastRefresh(Date.now());
      } catch {
        // Silently ignore poll errors
      }
    },
    [id]
  );

  // Consolidated initial load: fetch nodes + meta + blueprint context together
  useEffect(() => {
    let cancelled = false;
    pollFingerprintRef.current = "";
    setLoading(true);

    async function loadAll() {
      // Fire all three fetches in parallel
      const [nodesResult, metaResult, bpResult] = await Promise.allSettled([
        getTimeline(id),
        getSessionMeta(id),
        getSessionExecution(id).then(async (execution) => {
          if (!execution) return null;
          const bp = await getBlueprint(execution.blueprintId);
          const node = bp.nodes.find((n) => n.id === execution.nodeId);
          if (!node) return null;
          const nodeIndex = bp.nodes.findIndex((n) => n.id === execution.nodeId);
          return { blueprint: bp, node, nodeIndex };
        }),
      ]);

      if (cancelled) return;

      // Batch all state updates together
      if (nodesResult.status === "fulfilled") {
        const initNodes = nodesResult.value;
        const last = initNodes[initNodes.length - 1];
        setNodes(initNodes);
        pollFingerprintRef.current = `${initNodes.length}-${last?.id ?? ""}`;
        setLastRefresh(Date.now());
      } else {
        setError(
          nodesResult.reason instanceof Error
            ? nodesResult.reason.message
            : String(nodesResult.reason)
        );
      }

      if (metaResult.status === "fulfilled" && metaResult.value) {
        setSessionMeta(metaResult.value);
      }

      if (bpResult.status === "fulfilled" && bpResult.value) {
        setBlueprintContext(bpResult.value);
      }

      // Restore suggestions from cookie
      const saved = loadSuggestions(id);
      if (saved.length > 0) setSuggestions(saved);

      setLoading(false);
    }

    loadAll();
    return () => { cancelled = true; };
  }, [id]);

  // Persist suggestions to cookie whenever they change
  useEffect(() => {
    if (suggestions.length > 0) {
      saveSuggestions(id, suggestions);
    }
  }, [id, suggestions]);

  // Auto-refresh poll (faster 2s interval during active runs for live streaming)
  useEffect(() => {
    if (!autoRefresh || loading) return;

    const interval = setInterval(() => {
      if (!document.hidden) {
        fetchNodes();
      }
    }, running ? POLL_INTERVAL_RUNNING : POLL_INTERVAL);

    return () => clearInterval(interval);
  }, [autoRefresh, loading, running, fetchNodes]);

  // Update the "Xm ago" label every second
  useEffect(() => {
    if (!lastRefresh) return;
    const tick = setInterval(() => {
      setRefreshLabel(formatTimeAgo(lastRefresh));
    }, 1_000);
    return () => clearInterval(tick);
  }, [lastRefresh]);

  const handleMetaChange = (patch: Partial<SessionMeta>) => {
    setSessionMeta((prev) => ({ ...prev, ...patch }));
  };

  const handleRun = async (prompt: string) => {
    setRunning(true);
    runningRef.current = true;
    setError(null);
    setSuggestions([]);

    const userNodeId = `run-${Date.now()}`;
    const thinkingNodeId = `thinking-${Date.now()}`;
    const now = new Date().toISOString();

    const thinkingNode: TimelineNode = {
      id: thinkingNodeId,
      type: "system" as const,
      timestamp: now,
      title: "⏳ Claude Code is working...",
      content: prompt,
    };

    // Store refs for live-polling during the run
    preRunNodeCountRef.current = nodes.length;
    thinkingNodeRef.current = thinkingNode;

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
        thinkingNode,
      ];
      pollFingerprintRef.current = `${updated.length}-${thinkingNodeId}`;
      return updated;
    });

    const startTime = Date.now();
    try {
      const data = await runPrompt(id, prompt);

      // Backend synced the JSONL after run — fetch real parsed timeline
      const realNodes = await getTimeline(id);
      const lastReal = realNodes[realNodes.length - 1];
      setNodes(realNodes);
      pollFingerprintRef.current = `${realNodes.length}-${lastReal?.id ?? ""}`;
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
      // Reset fingerprint so next poll replaces synthetic nodes with real data
      pollFingerprintRef.current = "";
    } finally {
      setRunning(false);
      runningRef.current = false;
      thinkingNodeRef.current = null;
    }
  };

  if (error && nodes.length === 0) {
    return (
      <div className="text-center py-20">
        <p className="text-accent-red text-lg mb-2">Failed to load session</p>
        <p className="text-text-muted text-sm">{error}</p>
        <Link href="/sessions" className="text-accent-blue text-sm mt-4 inline-block hover:underline">
          Back to sessions
        </Link>
      </div>
    );
  }

  return (
    <div className="pb-12 animate-fade-in">
      {/* Header */}
      <div className="mb-6">
        <Link
          href="/sessions"
          className="text-sm text-text-muted hover:text-text-secondary transition-colors mb-2 inline-block"
        >
          ← Back to sessions
        </Link>
        <div className="flex items-center gap-2 sm:gap-3 flex-wrap min-w-0">
          <h1 className="text-xl font-bold truncate max-w-[60vw] sm:max-w-none">
            {sessionMeta.alias || "Session"}
          </h1>
          <span className="text-sm text-text-muted font-mono">{id.slice(0, 8)}</span>
          <span className="text-xs text-text-muted">
            {nodes.length} nodes
          </span>

          {/* Star toggle */}
          <button
            onClick={() => {
              const newStarred = !sessionMeta.starred;
              handleMetaChange({ starred: newStarred });
              updateSessionMeta(id, { starred: newStarred }).catch(() => {
                handleMetaChange({ starred: !newStarred });
              });
            }}
            className={`flex-shrink-0 p-1 rounded transition-all active:scale-[0.9] ${
              sessionMeta.starred
                ? "text-accent-amber"
                : "text-text-muted/30 hover:text-accent-amber/60"
            }`}
            title={sessionMeta.starred ? "Unstar" : "Star"}
          >
            <svg className="w-4 h-4" viewBox="0 0 16 16" fill={sessionMeta.starred ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.2">
              <path d="M8 1.5l2 4 4.5.65-3.25 3.17.77 4.48L8 11.77 3.98 13.8l.77-4.48L1.5 6.15 6 5.5z" />
            </svg>
          </button>

          {/* Archive toggle */}
          <button
            onClick={() => {
              const newArchived = !sessionMeta.archived;
              handleMetaChange({ archived: newArchived });
              updateSessionMeta(id, { archived: newArchived }).catch(() => {
                handleMetaChange({ archived: !newArchived });
              });
            }}
            className={`flex-shrink-0 p-1 rounded transition-all active:scale-[0.9] ${
              sessionMeta.archived
                ? "text-text-muted hover:text-text-secondary"
                : "text-text-muted/30 hover:text-text-muted/60"
            }`}
            title={sessionMeta.archived ? "Unarchive" : "Archive"}
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              {sessionMeta.archived ? (
                <><rect x="2" y="2" width="12" height="4" rx="1" /><path d="M3 6v7a1 1 0 001 1h8a1 1 0 001-1V6" /><path d="M8 9v3M6 11l2 -2 2 2" /></>
              ) : (
                <><rect x="2" y="2" width="12" height="4" rx="1" /><path d="M3 6v7a1 1 0 001 1h8a1 1 0 001-1V6" /><path d="M8 9v3M6 10l2 2 2-2" /></>
              )}
            </svg>
          </button>

          {/* Tags in header */}
          {sessionMeta.tags && sessionMeta.tags.length > 0 && (
            <div className="flex gap-1 flex-wrap">
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
          <div className="ml-auto flex items-center gap-2 w-full sm:w-auto">
            <button
              onClick={() => setAutoRefresh((v) => !v)}
              title={autoRefresh ? "Auto-refresh on (click to disable)" : "Auto-refresh off (click to enable)"}
              className={`w-2 h-2 rounded-full transition-colors ${
                autoRefresh ? "bg-accent-green animate-pulse" : "bg-text-muted"
              }`}
            />
            <span className="text-xs text-text-muted">{refreshLabel}</span>
            <button
              onClick={() => fetchNodes()}
              title="Refresh now"
              className="text-xs text-text-muted hover:text-text-primary transition-all active:scale-[0.9] px-1.5 py-1 rounded hover:bg-bg-tertiary"
            >
              <svg className="w-3 h-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 8a6 6 0 1 1-6-6" /><polyline points="14 2 14 6 10 6" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {loading ? (
        /* Skeleton layout that reserves the same vertical space as loaded content */
        <div className="space-y-4 animate-pulse">
          {/* Blueprint banner placeholder */}
          <div className="h-12 rounded-xl bg-bg-secondary border border-border-primary" />
          {/* Session info header placeholder */}
          <div className="h-24 rounded-xl bg-bg-secondary border border-border-primary" />
          {/* Prompt input placeholder */}
          <div className="h-12 rounded-xl bg-bg-secondary border border-border-primary" />
          {/* Timeline node skeletons */}
          <div className="h-20 rounded-xl bg-bg-secondary border border-border-primary" />
          <div className="h-20 rounded-xl bg-bg-secondary border border-border-primary" />
          <div className="h-20 rounded-xl bg-bg-secondary border border-border-primary" />
          <div className="h-20 rounded-xl bg-bg-secondary border border-border-primary" />
        </div>
      ) : (
        <>
          {/* Blueprint context banner — always reserve space, transition opacity */}
          <div
            className={`rounded-xl border p-3 mb-4 flex items-center gap-2 text-sm transition-opacity duration-200 min-w-0 flex-wrap ${
              blueprintContext
                ? "border-accent-purple/30 bg-accent-purple/10 opacity-100"
                : "border-transparent opacity-0 pointer-events-none"
            }`}
            style={{ minHeight: blueprintContext ? undefined : 0, height: blueprintContext ? undefined : 0, marginBottom: blueprintContext ? undefined : 0, padding: blueprintContext ? undefined : 0, overflow: "hidden" }}
          >
            {blueprintContext && (
              <>
                <span className="text-accent-purple font-medium flex-shrink-0">Blueprint</span>
                <Link
                  href={`/blueprints/${blueprintContext.blueprint.id}`}
                  className="text-accent-blue hover:underline font-medium truncate min-w-0"
                >
                  {blueprintContext.blueprint.title}
                </Link>
                <span className="text-text-muted flex-shrink-0">&rarr;</span>
                <span className="text-text-secondary flex-shrink-0">
                  Node #{blueprintContext.nodeIndex + 1}:
                </span>
                <Link
                  href={`/blueprints/${blueprintContext.blueprint.id}/nodes/${blueprintContext.node.id}`}
                  className="text-accent-blue hover:underline font-medium truncate min-w-0"
                >
                  {blueprintContext.node.title}
                </Link>
              </>
            )}
          </div>

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
