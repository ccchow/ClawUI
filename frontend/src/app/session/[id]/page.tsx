"use client";

import { useEffect, useState, useRef, useMemo } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  updateSessionMeta,
  runPrompt,
  type AgentType,
  type TimelineNode,
  type Suggestion,
  type SessionMeta,
} from "@/lib/api";
import { formatTimeAgo } from "@/lib/format-time";
import { Timeline } from "@/components/Timeline";
import { MarkdownContent } from "@/components/MarkdownContent";
import { SuggestionButtons } from "@/components/SuggestionButtons";
import { PromptInput } from "@/components/PromptInput";
import { saveSuggestions, loadSuggestions } from "@/lib/suggestions-store";
import { useSessionBroadcast } from "@/lib/useSessionBroadcast";
import { useSessionDetailQueries } from "@/lib/useSessionDetailQueries";
import { AgentBadge } from "@/components/AgentSelector";

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

  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshLabel, setRefreshLabel] = useState("just now");

  // Run overlay: synthetic nodes shown during active local runs
  const [runOverlay, setRunOverlay] = useState<TimelineNode[] | null>(null);
  const thinkingNodeRef = useRef<TimelineNode | null>(null);
  const preRunNodeCountRef = useRef(0);

  // ── TanStack Query ────────────────────────────────────────────
  const {
    nodes: rawNodes,
    sessionMeta: metaData,
    blueprintContext,
    remoteRunning,
    loading,
    error: queryError,
    dataUpdatedAt,
    setMeta,
    setStatus,
    invalidateTimeline,
  } = useSessionDetailQueries(id, autoRefresh, running);

  // Cross-tab broadcast: notify other tabs when this tab starts/stops a run
  const broadcastRunState = useSessionBroadcast(id, (isRunning) => {
    setStatus({ running: isRunning });
  });

  const isDisabled = running || remoteRunning;

  // Non-null meta for display
  const sessionMeta = metaData ?? {} as { alias?: string; tags?: string[]; notes?: string; starred?: boolean; archived?: boolean; agentType?: AgentType };

  // During a run, update overlay when server returns new content
  useEffect(() => {
    if (!running || !thinkingNodeRef.current) return;
    if (rawNodes.length > preRunNodeCountRef.current) {
      setRunOverlay([...rawNodes, thinkingNodeRef.current]);
    }
  }, [rawNodes, running]);

  // Display nodes: overlay during runs, raw query data otherwise
  const nodes = useMemo(
    () => runOverlay ?? rawNodes,
    [runOverlay, rawNodes],
  );

  // Restore suggestions from cookie on mount
  useEffect(() => {
    const saved = loadSuggestions(id);
    if (saved.length > 0) setSuggestions(saved);
  }, [id]);

  // Persist suggestions to cookie whenever they change
  useEffect(() => {
    if (suggestions.length > 0) {
      saveSuggestions(id, suggestions);
    }
  }, [id, suggestions]);

  // Update the "Xm ago" label from query's dataUpdatedAt
  useEffect(() => {
    if (!dataUpdatedAt) return;
    setRefreshLabel(formatTimeAgo(dataUpdatedAt));
    const tick = setInterval(() => {
      setRefreshLabel(formatTimeAgo(dataUpdatedAt));
    }, 1_000);
    return () => clearInterval(tick);
  }, [dataUpdatedAt]);

  const handleMetaChange = (patch: Partial<SessionMeta>) => {
    setMeta((prev) => ({ ...(prev ?? {}), ...patch }));
  };

  const handleRun = async (prompt: string) => {
    setRunning(true);
    setError(null);
    setSuggestions([]);
    broadcastRunState("start");

    const userNodeId = `run-${Date.now()}`;
    const thinkingNodeId = `thinking-${Date.now()}`;
    const now = new Date().toISOString();

    const thinkingNode: TimelineNode = {
      id: thinkingNodeId,
      type: "system" as const,
      timestamp: now,
      title: "⏳ Agent is working...",
      content: prompt,
    };

    // Store refs for live-polling during the run
    preRunNodeCountRef.current = rawNodes.length;
    thinkingNodeRef.current = thinkingNode;

    // Optimistic overlay: immediately show user message + thinking indicator
    setRunOverlay([
      ...rawNodes,
      {
        id: userNodeId,
        type: "user" as const,
        timestamp: now,
        title: prompt.slice(0, 120),
        content: prompt,
      },
      thinkingNode,
    ]);

    try {
      const data = await runPrompt(id, prompt);

      // Wait for fresh data before clearing overlay to avoid flash
      await invalidateTimeline();
      setSuggestions(data.suggestions || []);
    } catch (e) {
      console.error("[ClawUI] Run failed:", e);

      // Handle 409 Conflict — session is already running in another tab
      const is409 = e instanceof Error && e.message.includes("409");
      if (is409) {
        setStatus({ running: true });
        setError("Session is running in another tab");
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setRunning(false);
      thinkingNodeRef.current = null;
      setRunOverlay(null);
      broadcastRunState("stop");
    }
  };

  const displayError = error || queryError;

  if (displayError && nodes.length === 0 && !loading) {
    return (
      <div className="text-center py-20">
        <p className="text-accent-red text-lg mb-2">Failed to load session</p>
        <p className="text-text-muted text-sm">{displayError}</p>
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
              onClick={() => invalidateTimeline()}
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
            <div className="flex items-center gap-2">
              {sessionMeta.agentType && (
                <AgentBadge agentType={sessionMeta.agentType} size="sm" />
              )}
              <div className="flex-1 min-w-0">
                <PromptInput
                  disabled={isDisabled}
                  loading={running}
                  onSubmit={handleRun}
                />
              </div>
            </div>

            {remoteRunning && !running && (
              <div className="p-3 rounded-lg bg-accent-amber/10 border border-accent-amber/20 text-accent-amber text-sm">
                Session is running in another tab
              </div>
            )}

            <SuggestionButtons
              suggestions={suggestions}
              disabled={isDisabled}
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
