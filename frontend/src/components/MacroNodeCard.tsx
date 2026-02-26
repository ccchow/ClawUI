"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { type MacroNode, type PendingTask, runNode, updateMacroNode, deleteMacroNode, enrichNode, reevaluateNode, resumeNodeSession, unqueueNode } from "@/lib/api";
import { StatusIndicator } from "./StatusIndicator";
import { MarkdownContent } from "./MarkdownContent";
import { MarkdownEditor } from "./MarkdownEditor";
import { AISparkle } from "./AISparkle";
import { type DepRowLayout, DepGutter } from "./DependencyGraph";

/** Strip markdown syntax for plain-text preview */
function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "[image]")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^>\s?/gm, "")
    .replace(/^[-*_]{3,}\s*$/gm, "")
    .replace(/\n+/g, " ")
    .trim();
}

export function MacroNodeCard({
  node,
  pendingTasks,
  index,
  total,
  blueprintId,
  onRefresh,
  onNodeUpdated,
  onNodeDeleted,
  defaultExpanded = false,
  isLastDisplayed,
  depLanes,
}: {
  node: MacroNode;
  pendingTasks?: PendingTask[];
  index: number;
  total: number;
  blueprintId?: string;
  onRefresh?: () => void;
  onNodeUpdated?: () => void;
  onNodeDeleted?: () => void;
  defaultExpanded?: boolean;
  isLastDisplayed?: boolean;
  depLanes?: DepRowLayout;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [running, setRunning] = useState(false);
  const isLast = isLastDisplayed ?? (index === total - 1);
  const canRun = blueprintId && (node.status === "pending" || node.status === "failed");
  const canManage = blueprintId && (node.status === "pending" || node.status === "failed" || node.status === "skipped");
  const isQueued = node.status === "queued";

  // Check if there's a pending reevaluate task for this node (from queue API)
  const reevaluateQueued = pendingTasks?.some(
    (t) => t.nodeId === node.id && t.type === "reevaluate"
  ) ?? false;

  // Queue position: only count "run" tasks, derive position from array order
  const queuePosition = isQueued
    ? (pendingTasks?.filter(t => t.type === "run").findIndex(t => t.nodeId === node.id) ?? -1) + 1
    : 0;

  // Unqueue confirmation state
  const [showUnqueueConfirm, setShowUnqueueConfirm] = useState(false);
  const [unqueuing, setUnqueuing] = useState(false);

  // Inline edit state
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(node.title);
  const [editDescription, setEditDescription] = useState(node.description || "");
  const [saving, setSaving] = useState(false);

  // Delete confirmation state
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Enrich state
  const [enriching, setEnriching] = useState(false);

  // Skip state
  const [skipping, setSkipping] = useState(false);

  // Reevaluate state
  const [reevaluating, setReevaluating] = useState(false);

  // Resume session state
  const [resumingExecId, setResumingExecId] = useState<string | null>(null);

  // Warning state (e.g. dependency not met)
  const [warning, setWarning] = useState<string | null>(null);

  // Mobile overflow menu state
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const mobileMenuRef = useRef<HTMLDivElement>(null);

  // Track reevaluateQueued transitions to sync edit fields when reevaluate completes
  const prevReevalQueuedRef = useRef(false);
  useEffect(() => {
    const wasQueued = prevReevalQueuedRef.current;
    prevReevalQueuedRef.current = reevaluateQueued;
    // Reevaluate just completed: force-close edit mode so fresh content is visible
    if (wasQueued && !reevaluateQueued && isEditing) {
      setIsEditing(false);
      setEditTitle(node.title);
      setEditDescription(node.description || "");
    }
  }, [reevaluateQueued, isEditing, node.title, node.description]);

  useEffect(() => {
    if (!mobileMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (mobileMenuRef.current && !mobileMenuRef.current.contains(e.target as Node)) {
        setMobileMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [mobileMenuOpen]);

  const handleRun = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!blueprintId || running) return;
    setRunning(true);
    setWarning(null);
    runNode(blueprintId, node.id)
      .catch((err) => {
        setWarning(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setRunning(false);
        onRefresh?.();
      });
  };

  const handleEditStart = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditTitle(node.title);
    setEditDescription(node.description || "");
    setIsEditing(true);
    setExpanded(true);
  };

  const handleEditSave = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!blueprintId || !editTitle.trim()) return;
    setSaving(true);
    try {
      await updateMacroNode(blueprintId, node.id, {
        title: editTitle.trim(),
        description: editDescription.trim(),
      });
      setIsEditing(false);
      onNodeUpdated?.();
    } catch {
      // keep editing on error
    } finally {
      setSaving(false);
    }
  };

  const handleEditCancel = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsEditing(false);
    setEditTitle(node.title);
    setEditDescription(node.description || "");
  };

  const handleDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowDeleteConfirm(true);
  };

  const handleDeleteConfirm = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!blueprintId) return;
    setDeleting(true);
    try {
      await deleteMacroNode(blueprintId, node.id);
      setShowDeleteConfirm(false);
      onNodeDeleted?.();
    } catch {
      setDeleting(false);
    }
  };

  const handleDeleteCancel = (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowDeleteConfirm(false);
  };

  const handleSkip = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!blueprintId) return;
    setSkipping(true);
    const newStatus = node.status === "skipped" ? "pending" : "skipped";
    try {
      await updateMacroNode(blueprintId, node.id, { status: newStatus });
      onNodeUpdated?.();
    } catch {
      // ignore
    } finally {
      setSkipping(false);
    }
  };

  const handleReevaluate = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!blueprintId || reevaluating || reevaluateQueued) return;
    setReevaluating(true);
    try {
      await reevaluateNode(blueprintId, node.id);
      // Fire-and-forget: result will be applied in background
      // Trigger parent refresh to start polling for changes
      onRefresh?.();
    } catch {
      // ignore
    } finally {
      setReevaluating(false);
    }
  };

  const handleEnrich = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!blueprintId || !editTitle.trim()) return;
    setEnriching(true);
    try {
      const result = await enrichNode(blueprintId, {
        title: editTitle.trim(),
        description: editDescription.trim() || undefined,
        nodeId: node.id,
      });
      // Existing node enrichment is now fire-and-forget (returns {status: "queued"}).
      // Trigger refresh so polling picks up the result when Claude finishes.
      if ("status" in result) {
        onRefresh?.();
      } else {
        setEditTitle(result.title);
        setEditDescription(result.description);
        onNodeUpdated?.();
      }
    } catch {
      // ignore enrichment errors silently
    } finally {
      setEnriching(false);
    }
  };

  return (
    <div className="flex gap-3">
      {/* Left: dependency lanes + status dot */}
      {depLanes && depLanes.totalLanes > 0 ? (
        <DepGutter
          layout={depLanes}
          status={node.status}
          running={running}
          reevaluateQueued={reevaluateQueued}
        />
      ) : (
        <div className="flex flex-col items-center pt-5">
          <StatusIndicator status={running ? "running" : reevaluateQueued ? "queued" : node.status} />
          {!isLast && (
            <div className="w-px flex-1 bg-border-primary mt-1" />
          )}
        </div>
      )}

      {/* Card */}
      <div
        className="flex-1 min-w-0 mb-2 rounded-xl border border-border-primary bg-bg-secondary hover:border-border-hover transition-colors cursor-pointer"
        onClick={() => !isEditing && setExpanded(!expanded)}
      >
        {/* Collapsed header */}
        <div className="p-3 sm:p-4 flex items-center gap-2 sm:gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-xs text-text-muted font-mono flex-shrink-0">
                #{node.order + 1}
              </span>
              {isEditing ? (
                <input
                  type="text"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  readOnly={enriching || reevaluating || reevaluateQueued}
                  className={`flex-1 min-w-0 px-2 py-1 rounded-md bg-bg-tertiary border border-accent-blue text-text-primary text-sm focus:outline-none focus:ring-1 focus:ring-accent-blue/30${enriching || reevaluating || reevaluateQueued ? " opacity-60 cursor-not-allowed" : ""}`}
                  autoFocus
                />
              ) : blueprintId ? (
                <Link
                  href={`/blueprints/${blueprintId}/nodes/${node.id}`}
                  className="font-medium text-text-primary truncate block hover:text-accent-blue transition-colors min-w-0 py-2 sm:py-0 -my-2 sm:my-0"
                  onClick={(e) => e.stopPropagation()}
                >
                  {node.title}
                </Link>
              ) : (
                <span className="font-medium text-text-primary truncate block min-w-0">
                  {node.title}
                </span>
              )}
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full capitalize flex-shrink-0 ${
                node.status === "queued" || reevaluateQueued
                  ? "bg-accent-amber/20 text-accent-amber"
                  : "bg-bg-tertiary text-text-muted"
              }`}>
                {running ? "running" : reevaluateQueued ? "re-eval" : node.status === "queued" ? (queuePosition > 0 ? `queued #${queuePosition}` : "queued") : node.status}
              </span>
            </div>
            {!expanded && !isEditing && node.description && (
              <p className="text-sm text-text-muted mt-1 line-clamp-1">
                {stripMarkdown(node.description)}
              </p>
            )}
          </div>
          <div className="flex items-center gap-1 sm:gap-2 flex-shrink-0">
            {/* Desktop management buttons — hidden on mobile */}
            {canManage && !isEditing && (
              <>
                <button
                  onClick={handleEditStart}
                  title="Edit node"
                  aria-label="Edit node"
                  className="p-1.5 rounded-md text-text-muted hover:text-accent-blue hover:bg-accent-blue/10 transition-colors hidden sm:block"
                >
                  <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm1.414 1.06a.25.25 0 0 0-.354 0L3.463 11.098a.25.25 0 0 0-.064.108l-.631 2.208 2.208-.63a.25.25 0 0 0 .108-.064l8.609-8.61a.25.25 0 0 0 0-.353l-1.086-1.086-.18.18Z" />
                  </svg>
                </button>
                {(node.status === "pending" || node.status === "skipped") && (
                  <button
                    onClick={handleSkip}
                    disabled={skipping}
                    title={node.status === "skipped" ? "Unskip node" : "Skip node"}
                    aria-label={node.status === "skipped" ? "Unskip node" : "Skip node"}
                    className="p-1.5 rounded-md text-text-muted hover:text-accent-yellow hover:bg-accent-yellow/10 transition-colors disabled:opacity-50 hidden sm:block"
                  >
                    <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M4.5 2a.5.5 0 0 1 .5.5v11a.5.5 0 0 1-1 0v-11a.5.5 0 0 1 .5-.5Zm7.5.5a.5.5 0 0 0-.83-.38l-5 4.5a.5.5 0 0 0 0 .74l5 4.5A.5.5 0 0 0 12 11.5v-9Z" transform="scale(-1,1) translate(-16,0)" />
                    </svg>
                  </button>
                )}
                <button
                  onClick={handleDeleteClick}
                  title="Delete node"
                  aria-label="Delete node"
                  className="p-1.5 rounded-md text-text-muted hover:text-accent-red hover:bg-accent-red/10 transition-colors hidden sm:block"
                >
                  <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M6.5 1.75a.25.25 0 0 1 .25-.25h2.5a.25.25 0 0 1 .25.25V3h-3V1.75ZM11 3V1.75A1.75 1.75 0 0 0 9.25 0h-2.5A1.75 1.75 0 0 0 5 1.75V3H2.75a.75.75 0 0 0 0 1.5h.3l.815 8.15A1.5 1.5 0 0 0 5.357 14h5.285a1.5 1.5 0 0 0 1.493-1.35l.815-8.15h.3a.75.75 0 0 0 0-1.5H11Zm-5.47 1.5.7 7h-1.46l-.7-7h1.46Zm2.97 7V4.5h-1v7h1Zm2.97 0-.7-7h1.46l.7 7h-1.46Z" />
                  </svg>
                </button>
              </>
            )}
            {/* Desktop re-evaluate button — hidden on mobile */}
            {blueprintId && node.status !== "running" && node.status !== "queued" && !isEditing && (
              <button
                onClick={handleReevaluate}
                disabled={reevaluating || reevaluateQueued}
                title={reevaluateQueued ? "AI re-evaluation queued, waiting..." : reevaluating ? "AI is re-evaluating this node..." : "AI reads your codebase and updates this node's title, description, and status"}
                aria-label={reevaluateQueued ? "Re-evaluation queued" : reevaluating ? "Re-evaluating node" : "Re-evaluate node with AI"}
                className="p-1.5 rounded-md text-text-muted hover:text-accent-amber hover:bg-accent-amber/10 transition-colors disabled:opacity-50 hidden sm:block"
              >
                {reevaluating || reevaluateQueued ? (
                  <AISparkle size="sm" />
                ) : (
                  <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 1 1 .908-.418A6 6 0 1 1 8 2v1z" />
                    <path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466z" />
                  </svg>
                )}
              </button>
            )}
            {/* Mobile overflow menu — visible only on mobile */}
            {blueprintId && !isEditing && (canManage || (node.status !== "running" && node.status !== "queued")) && (
              <div className="relative sm:hidden" ref={mobileMenuRef}>
                <button
                  onClick={(e) => { e.stopPropagation(); setMobileMenuOpen(!mobileMenuOpen); }}
                  className="p-2 -m-0.5 rounded-lg text-text-muted hover:text-text-secondary hover:bg-bg-tertiary transition-colors"
                  title="More actions"
                  aria-label="More actions"
                >
                  <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor">
                    <circle cx="8" cy="3" r="1.5" />
                    <circle cx="8" cy="8" r="1.5" />
                    <circle cx="8" cy="13" r="1.5" />
                  </svg>
                </button>
                {mobileMenuOpen && (
                  <div className="absolute right-0 top-full mt-1 z-50 min-w-[140px] rounded-lg border border-border-primary bg-bg-secondary shadow-lg py-1" onClick={(e) => e.stopPropagation()}>
                    {canManage && (
                      <>
                        <button onClick={(e) => { handleEditStart(e); setMobileMenuOpen(false); }} className="w-full text-left px-3 py-2 text-xs text-text-secondary hover:bg-bg-tertiary transition-colors">
                          Edit
                        </button>
                        {(node.status === "pending" || node.status === "skipped") && (
                          <button onClick={(e) => { handleSkip(e); setMobileMenuOpen(false); }} disabled={skipping} className="w-full text-left px-3 py-2 text-xs text-text-secondary hover:bg-bg-tertiary transition-colors disabled:opacity-50">
                            {node.status === "skipped" ? "Unskip" : "Skip"}
                          </button>
                        )}
                        <button onClick={(e) => { handleDeleteClick(e); setMobileMenuOpen(false); }} className="w-full text-left px-3 py-2 text-xs text-accent-red hover:bg-accent-red/10 transition-colors">
                          Delete
                        </button>
                      </>
                    )}
                    {node.status !== "running" && node.status !== "queued" && (
                      <button onClick={(e) => { handleReevaluate(e); setMobileMenuOpen(false); }} disabled={reevaluating || reevaluateQueued} className="w-full text-left px-3 py-2 text-xs text-accent-amber hover:bg-accent-amber/10 transition-colors disabled:opacity-50">
                        {reevaluating || reevaluateQueued ? "Re-evaluating..." : "Re-evaluate"}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
            {isQueued && !isEditing && !showUnqueueConfirm && (
              <button
                onClick={(e) => { e.stopPropagation(); setShowUnqueueConfirm(true); }}
                className="px-2 sm:px-2.5 py-1 rounded-lg bg-accent-amber/20 text-accent-amber text-xs font-medium flex items-center gap-1.5 cursor-pointer hover:bg-accent-amber/30 transition-colors active:scale-[0.97]"
                aria-label="Unqueue node"
                title="Click to unqueue"
              >
                <svg className="w-3 h-3 animate-pulse" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 3.5a.5.5 0 0 0-1 0V8a.5.5 0 0 0 .252.434l3.5 2a.5.5 0 1 0 .496-.868L8 7.71V3.5z"/>
                  <path d="M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16zm7-8A7 7 0 1 1 1 8a7 7 0 0 1 14 0z"/>
                </svg>
                <span className="hidden sm:inline">Queued{queuePosition > 0 ? ` (#${queuePosition})` : ""}</span>
                <svg className="w-2.5 h-2.5 opacity-60" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/>
                </svg>
              </button>
            )}
            {isQueued && !isEditing && showUnqueueConfirm && (
              <span className="flex items-center gap-1 animate-fade-in">
                <button
                  onClick={async (e) => {
                    e.stopPropagation();
                    if (!blueprintId) return;
                    setUnqueuing(true);
                    try {
                      await unqueueNode(blueprintId, node.id);
                      onRefresh?.();
                    } catch {
                      /* ignore — next poll will update */
                    } finally {
                      setUnqueuing(false);
                      setShowUnqueueConfirm(false);
                    }
                  }}
                  disabled={unqueuing}
                  className="px-2 py-1 rounded-lg bg-accent-amber/20 text-accent-amber text-xs font-medium hover:bg-accent-amber/30 transition-colors disabled:opacity-50 active:scale-[0.97]"
                >
                  {unqueuing ? "..." : "Yes"}
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); setShowUnqueueConfirm(false); }}
                  className="px-2 py-1 rounded-lg bg-bg-tertiary text-text-muted text-xs font-medium hover:bg-bg-tertiary/80 transition-colors active:scale-[0.97]"
                >
                  Cancel
                </button>
              </span>
            )}
            {canRun && !isEditing && (
              <>
                <button
                  onClick={handleRun}
                  disabled={running}
                  aria-label={running ? "AI is running this node" : "Run node"}
                  title={running ? "AI is executing this node in a Claude Code session..." : "Execute this node using Claude Code"}
                  className="px-2 sm:px-2.5 py-2 sm:py-1 rounded-lg bg-accent-green/20 text-accent-green text-xs font-medium hover:bg-accent-green/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                >
                  {running ? (
                    <>
                      <AISparkle size="xs" />
                      <span className="hidden sm:inline">Running...</span>
                    </>
                  ) : (
                    <>&#9654;<span className="hidden sm:inline"> Run</span></>
                  )}
                </button>
                {warning && (
                  <span
                    className="text-accent-amber cursor-help"
                    title={warning}
                    onClick={(e) => e.stopPropagation()}
                  >
                    &#9888;
                  </span>
                )}
              </>
            )}
            {node.executions.length > 0 && (
              <span className="text-xs text-text-muted hidden sm:inline">
                {node.executions.length} exec{node.executions.length !== 1 ? "s" : ""}
              </span>
            )}
            {!isEditing && (
              <button
                onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
                aria-expanded={expanded}
                aria-label={expanded ? "Collapse node" : "Expand node"}
                className={`p-1 -m-0.5 rounded text-text-muted text-xs transition-transform hover:bg-bg-tertiary ${expanded ? "rotate-180" : ""}`}
              >
                ▼
              </button>
            )}
          </div>
        </div>

        {/* Delete confirmation dialog */}
        {showDeleteConfirm && (
          <div className="mx-4 mb-3 p-3 rounded-lg bg-accent-red/10 border border-accent-red/30 animate-fade-in" onClick={(e) => e.stopPropagation()}>
            <p className="text-sm text-accent-red mb-2">Are you sure? This cannot be undone.</p>
            <div className="flex gap-2">
              <button
                onClick={handleDeleteConfirm}
                disabled={deleting}
                className="px-3 py-1 rounded-md bg-accent-red text-white text-xs font-medium hover:bg-accent-red/90 transition-colors disabled:opacity-50"
              >
                {deleting ? "Deleting..." : "Delete"}
              </button>
              <button
                onClick={handleDeleteCancel}
                className="px-3 py-1 rounded-md border border-border-primary text-text-secondary text-xs hover:bg-bg-tertiary transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Edit mode description */}
        {isEditing && (
          <div className="px-4 pb-4 space-y-3" onClick={(e) => e.stopPropagation()}>
            <MarkdownEditor
              value={editDescription}
              onChange={setEditDescription}
              placeholder="Description (supports Markdown and image paste)"
              disabled={enriching || reevaluating || reevaluateQueued}
            />
            <div className="flex gap-2">
              <button
                onClick={handleEditSave}
                disabled={!editTitle.trim() || saving || enriching || reevaluating || reevaluateQueued}
                className="px-3 py-1.5 rounded-lg bg-accent-blue text-white text-xs font-medium hover:bg-accent-blue/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving ? "Saving..." : "Save"}
              </button>
              <button
                onClick={handleEnrich}
                disabled={!editTitle.trim() || enriching || reevaluating || reevaluateQueued}
                title={enriching ? "AI is enriching the title and description..." : "AI enhances the title and description with implementation details from your codebase"}
                className="inline-flex items-center gap-1 whitespace-nowrap px-3 py-1.5 rounded-lg bg-accent-purple text-white text-xs font-medium hover:bg-accent-purple/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {enriching ? (<><AISparkle size="xs" /> Enrich</>) : "✨ Smart Enrich"}
              </button>
              <button
                onClick={handleEditCancel}
                disabled={enriching || reevaluating || reevaluateQueued}
                className="px-3 py-1.5 rounded-lg border border-border-primary text-text-secondary text-xs hover:bg-bg-tertiary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Expanded details */}
        {expanded && !isEditing && (
          <div className="px-4 pb-4 border-t border-border-primary pt-3 space-y-3">
            {node.description && (
              <MarkdownContent content={node.description} />
            )}

            {node.prompt && (
              <div>
                <h4 className="text-xs text-text-muted mb-1">Prompt</h4>
                <p className="text-sm text-text-secondary bg-bg-tertiary rounded-lg p-2 whitespace-pre-wrap font-mono text-xs">
                  {node.prompt}
                </p>
              </div>
            )}

            {/* Artifacts */}
            {(node.inputArtifacts.length > 0 || node.outputArtifacts.length > 0) && (
              <div>
                <h4 className="text-xs text-text-muted mb-1">Artifacts</h4>
                <div className="space-y-1">
                  {node.inputArtifacts.map((a) => (
                    <div key={a.id} className="text-xs text-text-secondary flex items-center gap-1.5">
                      <span className="text-accent-blue">&#8592;</span>
                      <span className="capitalize">{a.type.replace(/_/g, " ")}</span>
                    </div>
                  ))}
                  {node.outputArtifacts.map((a) => (
                    <div key={a.id} className="text-xs text-text-secondary flex items-center gap-1.5">
                      <span className="text-accent-green">&#8594;</span>
                      <span className="capitalize">{a.type.replace(/_/g, " ")}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Executions */}
            {node.executions.length > 0 && (
              <div>
                <h4 className="text-xs text-text-muted mb-1">Executions</h4>
                <div className="space-y-1.5">
                  {node.executions.map((exec) => (
                    <div key={exec.id} className="flex items-center gap-2 text-xs flex-wrap">
                      <StatusIndicator status={exec.status} size="sm" />
                      <span className="text-text-secondary capitalize">{exec.type}</span>
                      <span className="text-text-muted">·</span>
                      <span className="text-text-muted">{exec.status}</span>
                      {exec.sessionId && (
                        <>
                          <Link
                            href={`/session/${exec.sessionId}`}
                            className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-accent-blue/15 text-accent-blue hover:bg-accent-blue/25 transition-colors font-medium"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
                              <path d="M1.5 3A1.5 1.5 0 0 1 3 1.5h10A1.5 1.5 0 0 1 14.5 3v10a1.5 1.5 0 0 1-1.5 1.5H3A1.5 1.5 0 0 1 1.5 13V3zM3 2.5a.5.5 0 0 0-.5.5v10a.5.5 0 0 0 .5.5h10a.5.5 0 0 0 .5-.5V3a.5.5 0 0 0-.5-.5H3z"/>
                              <path d="M4 5.5a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1-.5-.5zm0 2.5a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7A.5.5 0 0 1 4 8zm0 2.5a.5.5 0 0 1 .5-.5h4a.5.5 0 0 1 0 1h-4a.5.5 0 0 1-.5-.5z"/>
                            </svg>
                            {exec.sessionId.slice(0, 8)}
                          </Link>
                          {exec.status === "failed" && blueprintId && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setResumingExecId(exec.id);
                                resumeNodeSession(blueprintId, node.id, exec.id)
                                  .catch(() => {})
                                  .finally(() => {
                                    setResumingExecId(null);
                                    onRefresh?.();
                                  });
                              }}
                              disabled={resumingExecId === exec.id || running}
                              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-green-600/15 text-green-500 hover:bg-green-600/25 transition-colors text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                              title={resumingExecId === exec.id ? "AI is resuming the failed session..." : "Resume this failed session — AI continues with full context from the previous attempt"}
                              aria-label={resumingExecId === exec.id ? "Resuming session" : "Resume failed session"}
                            >
                              {resumingExecId === exec.id ? (
                                <AISparkle size="xs" />
                              ) : (
                                <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
                                  <path d="M4 2l10 6-10 6V2z" />
                                </svg>
                              )}
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {node.error && (
              <div className="text-sm text-accent-red bg-accent-red/10 rounded-lg p-2">
                {node.error}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
