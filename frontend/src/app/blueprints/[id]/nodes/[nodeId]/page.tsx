"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  type Blueprint,
  type MacroNode,
  type NodeExecution,
  type PendingTask,
  type TimelineNode,
  type RelatedSession,
  getBlueprint,
  getNodeExecutions,
  getQueueStatus,
  getLastSessionMessage,
  getRelatedSessions,
  runNode,
  updateMacroNode,
  deleteMacroNode,
  enrichNode,
  reevaluateNode,
  recoverNodeSession,
  resumeNodeSession,
  unqueueNode,
  splitNode,
  smartPickDependencies,
} from "@/lib/api";
import { StatusIndicator } from "@/components/StatusIndicator";
import { MarkdownContent } from "@/components/MarkdownContent";
import { MarkdownEditor } from "@/components/MarkdownEditor";
import { AISparkle } from "@/components/AISparkle";
import { SkeletonLoader } from "@/components/SkeletonLoader";
import { AgentBadge } from "@/components/AgentSelector";

function formatDuration(startedAt: string, completedAt?: string): string {
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}m ${secs}s`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

export default function NodeDetailPage() {
  const params = useParams();
  const router = useRouter();
  const blueprintId = params.id as string;
  const nodeId = params.nodeId as string;

  const [blueprint, setBlueprint] = useState<Blueprint | null>(null);
  const [node, setNode] = useState<MacroNode | null>(null);
  const [executions, setExecutions] = useState<NodeExecution[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const [depsExpanded, setDepsExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [saving, setSaving] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [reevaluating, setReevaluating] = useState(false);
  const [pendingTasks, setPendingTasks] = useState<PendingTask[]>([]);
  const [recovered, setRecovered] = useState(false);
  const [resumingExecId, setResumingExecId] = useState<string | null>(null);
  const [skipping, setSkipping] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showUnqueueConfirm, setShowUnqueueConfirm] = useState(false);
  const [unqueuing, setUnqueuing] = useState(false);
  const [splitting, setSplitting] = useState(false);
  const [smartDepsOptimistic, setSmartDepsOptimistic] = useState(false);
  const [showSplitConfirm, setShowSplitConfirm] = useState(false);
  const [showNodeSwitcher, setShowNodeSwitcher] = useState(false);
  const nodeSwitcherRef = useRef<HTMLDivElement>(null);
  const nodeSwitcherTriggerRef = useRef<HTMLButtonElement>(null);
  const [expandedInputs, setExpandedInputs] = useState<Set<string>>(new Set());
  const [collapsedOutputs, setCollapsedOutputs] = useState<Set<string>>(new Set());
  const [inputArtifactsCollapsed, setInputArtifactsCollapsed] = useState(false);
  const [outputArtifactsCollapsed, setOutputArtifactsCollapsed] = useState(false);
  const [lastMessage, setLastMessage] = useState<TimelineNode | null>(null);
  const [relatedSessions, setRelatedSessions] = useState<RelatedSession[]>([]);
  const [relatedExpanded, setRelatedExpanded] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recoveryAttempted = useRef(false);
  const prevStatusRef = useRef<string | null>(null);
  const [postCompletionPolls, setPostCompletionPolls] = useState(0);

  // Build back link preserving blueprint detail filter state
  const blueprintBackHref = useMemo(() => {
    try {
      const saved = sessionStorage.getItem(`clawui:blueprint-${blueprintId}-filters`);
      if (saved) return `/blueprints/${blueprintId}${saved}`;
    } catch { /* ignore */ }
    return `/blueprints/${blueprintId}`;
  }, [blueprintId]);

  const loadData = useCallback(async () => {
    try {
      const [bp, execs, queueInfo, related] = await Promise.all([
        getBlueprint(blueprintId),
        getNodeExecutions(blueprintId, nodeId),
        getQueueStatus(blueprintId),
        getRelatedSessions(blueprintId, nodeId),
      ]);
      setBlueprint(bp);
      const found = bp.nodes.find((n) => n.id === nodeId) ?? null;
      setNode(found);
      setExecutions(execs);
      setPendingTasks(queueInfo.pendingTasks);
      setRelatedSessions(related);

      // Fetch last session message for running executions
      const runningExec = execs.find(
        (e) => e.status === "running" && e.sessionId
      );
      if (runningExec?.sessionId) {
        getLastSessionMessage(runningExec.sessionId)
          .then(setLastMessage)
          .catch(() => { /* silent — session may not have messages yet */ });
      } else {
        setLastMessage(null);
      }

      return found;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setLoading(false);
    }
  }, [blueprintId, nodeId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Auto-recover lost sessions for nodes failed by server restart
  useEffect(() => {
    if (recoveryAttempted.current || !node || !executions.length) return;
    const isServerRestartError = node.error?.includes("Execution interrupted by server restart");
    const hasOrphanedExec = executions.some(
      (e) => e.status === "failed" && !e.sessionId &&
        e.outputSummary?.includes("Server restarted"),
    );
    if (isServerRestartError && hasOrphanedExec) {
      recoveryAttempted.current = true;
      recoverNodeSession(blueprintId, nodeId)
        .then((result) => {
          if (result.recovered) {
            setRecovered(true);
            loadData(); // Reload to show the recovered session links
          }
        })
        .catch(() => { /* silent — recovery is best-effort */ });
    }
  }, [node, executions, blueprintId, nodeId, loadData]);

  // Check for pending tasks on this node
  const reevaluateQueued = pendingTasks.some(
    (t) => t.nodeId === nodeId && t.type === "reevaluate"
  );
  const enrichQueued = pendingTasks.some(
    (t) => t.nodeId === nodeId && t.type === "enrich"
  );
  const hasPendingTasks = pendingTasks.some((t) => t.nodeId === nodeId);
  const smartDepsQueued = pendingTasks.some(
    (t) => t.nodeId === nodeId && t.type === "smart_deps"
  );
  const smartDepsLoading = smartDepsOptimistic || smartDepsQueued;

  // Reset optimistic flag once polling confirms the task (or it completes)
  useEffect(() => {
    if (smartDepsQueued) setSmartDepsOptimistic(false);
  }, [smartDepsQueued]);

  // Sync edit fields when reevaluate completes (node data updated via polling)
  const prevReevalQueuedRef = useRef(false);
  useEffect(() => {
    const wasQueued = prevReevalQueuedRef.current;
    prevReevalQueuedRef.current = reevaluateQueued;
    // Reevaluate just completed: force-close edit mode so fresh content is visible
    if (wasQueued && !reevaluateQueued && editing && node) {
      setEditing(false);
    }
  }, [reevaluateQueued, editing, node]);

  // Track enrichQueued transitions: clear optimistic state and sync fields on completion
  const prevEnrichQueuedRef = useRef(false);
  useEffect(() => {
    if (enrichQueued) setEnriching(false); // polling picked up pending task — clear optimistic flag
    const wasQueued = prevEnrichQueuedRef.current;
    prevEnrichQueuedRef.current = enrichQueued;
    if (wasQueued && !enrichQueued && editing && node) {
      // Enrich completed: update edit fields with fresh node data
      setEditTitle(node.title);
      setEditDesc(node.description || "");
    }
  }, [enrichQueued, editing, node]);

  // Detect status transition from running/queued → done/failed/blocked and start post-completion polling
  useEffect(() => {
    const prev = prevStatusRef.current;
    const curr = node?.status ?? null;
    if (prev && (prev === "running" || prev === "queued") && curr && curr !== "running" && curr !== "queued") {
      setPostCompletionPolls(4); // 4 more cycles × 5s = 20s buffer for artifacts/evaluation
    }
    prevStatusRef.current = curr;
  }, [node?.status]);

  // Navigate to blueprint page when split completes (node becomes skipped)
  useEffect(() => {
    if (splitting && node?.status === "skipped") {
      router.push(blueprintBackHref);
    }
  }, [splitting, node?.status, router, blueprintBackHref]);

  // Auto-poll when node is running, queued, has pending tasks, or post-completion countdown active
  useEffect(() => {
    const shouldPoll = node?.status === "running" || node?.status === "queued" || hasPendingTasks || postCompletionPolls > 0;
    if (shouldPoll) {
      pollRef.current = setInterval(() => {
        if (postCompletionPolls > 0) {
          setPostCompletionPolls((c) => c - 1);
        }
        loadData();
      }, 5000);
    } else {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [node?.status, hasPendingTasks, postCompletionPolls, loadData]);

  // Focus trap for node switcher overlay
  useEffect(() => {
    if (!showNodeSwitcher) return;
    // Auto-focus the first node button in the list
    const container = nodeSwitcherRef.current;
    if (container) {
      const firstButton = container.querySelector<HTMLElement>('[data-node-picker-item]');
      firstButton?.focus();
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setShowNodeSwitcher(false);
        nodeSwitcherTriggerRef.current?.focus();
        return;
      }
      if (e.key === "Tab" && container) {
        const focusable = container.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [showNodeSwitcher]);

  // Node navigation: prev/next by order
  const sortedNodes = blueprint ? [...blueprint.nodes].sort((a, b) => a.order - b.order) : [];
  const currentNodeIdx = sortedNodes.findIndex((n) => n.id === nodeId);
  // Node picker: most recently modified first, excluding skipped nodes
  const pickerNodes = blueprint ? [...blueprint.nodes].filter((n) => n.status !== "skipped").sort((a, b) => {
    const timeA = new Date(a.updatedAt || a.createdAt).getTime();
    const timeB = new Date(b.updatedAt || b.createdAt).getTime();
    return timeB - timeA;
  }) : [];
  const prevNode = currentNodeIdx > 0 ? sortedNodes[currentNodeIdx - 1] : null;
  const nextNode = currentNodeIdx < sortedNodes.length - 1 ? sortedNodes[currentNodeIdx + 1] : null;

  // Keyboard shortcuts: left/right arrow for prev/next node, Escape to close switcher
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setShowNodeSwitcher(false);
        return;
      }
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (e.target as HTMLElement).isContentEditable) return;
      if (e.key === "ArrowLeft" && prevNode) {
        e.preventDefault();
        setShowNodeSwitcher(false);
        router.push(`/blueprints/${blueprintId}/nodes/${prevNode.id}`);
      } else if (e.key === "ArrowRight" && nextNode) {
        e.preventDefault();
        setShowNodeSwitcher(false);
        router.push(`/blueprints/${blueprintId}/nodes/${nextNode.id}`);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [blueprintId, prevNode, nextNode, router]);

  const handleRun = async () => {
    if (running) return;
    setRunning(true);
    setWarning(null);
    runNode(blueprintId, nodeId)
      .catch((err) => {
        setWarning(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setRunning(false);
        loadData();
      });
  };

  const handleEnrich = async () => {
    if (!editTitle.trim()) return;
    setEnriching(true);
    try {
      const result = await enrichNode(blueprintId, {
        title: editTitle.trim(),
        description: editDesc.trim() || undefined,
        nodeId: node?.id,
      });
      // Fire-and-forget: keep enriching=true as optimistic flag until polling
      // picks up the pending "enrich" task (enrichQueued), then enrichQueued
      // takes over the loading state. enriching is cleared in the useEffect above.
      if ("status" in result) {
        loadData();
        // Don't setEnriching(false) — enrichQueued will take over
      } else {
        setEditTitle(result.title);
        setEditDesc(result.description);
        setEnriching(false);
        if (node) {
          setNode((prev) => prev ? { ...prev, title: result.title, description: result.description } : prev);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setEnriching(false);
    }
  };

  const handleReevaluate = async () => {
    if (reevaluating || reevaluateQueued) return;
    setReevaluating(true);
    try {
      await reevaluateNode(blueprintId, nodeId);
      // Fire-and-forget: result applied in background, polling will detect changes
      loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReevaluating(false);
    }
  };

  if (loading) {
    return <SkeletonLoader variant="nodeDetail" />;
  }

  if (error && !node) {
    return (
      <div className="text-center py-16 text-accent-red">
        Failed to load node: {error}
      </div>
    );
  }

  if (!node || !blueprint) {
    return (
      <div className="text-center py-16 text-text-muted">Node not found</div>
    );
  }

  const canRun = node.status === "pending" || node.status === "failed";
  const isQueued = node.status === "queued";
  const isRunning = running || node.status === "running";
  const queuePosition = isQueued
    ? (pendingTasks.filter(t => t.type === "run").findIndex(t => t.nodeId === nodeId) + 1)
    : 0;

  // Find dependency nodes from the blueprint
  const depNodes = node.dependencies
    .map((depId) => blueprint.nodes.find((n) => n.id === depId))
    .filter(Boolean) as MacroNode[];

  return (
    <div className="pb-16 sm:pb-0 animate-fade-in">
      {/* Top nav bar */}
      <div className="flex items-center gap-2 mb-4">
        <Link
          href={blueprintBackHref}
          aria-label="Back to blueprint"
          className="flex items-center gap-1.5 p-2 -m-2 text-sm text-text-muted hover:text-text-secondary transition-colors flex-shrink-0"
        >
          <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor">
            <path fillRule="evenodd" d="M11.354 1.646a.5.5 0 0 1 0 .708L5.707 8l5.647 5.646a.5.5 0 0 1-.708.708l-6-6a.5.5 0 0 1 0-.708l6-6a.5.5 0 0 1 .708 0z"/>
          </svg>
          <span className="hidden sm:inline truncate max-w-[180px]">{blueprint.title}</span>
        </Link>
        <div className="flex-1 min-w-0 flex items-center justify-center">
          <button
            ref={nodeSwitcherTriggerRef}
            onClick={() => setShowNodeSwitcher(true)}
            className="flex items-center gap-2 px-3 py-2.5 sm:py-1.5 rounded-lg bg-bg-secondary border border-border-primary hover:border-border-hover transition-colors max-w-[260px] sm:max-w-[520px] min-w-0"
          >
            <StatusIndicator status={node.status} size="sm" />
            <span className="text-xs text-text-muted font-mono flex-shrink-0">#{(node.order ?? 0) + 1}</span>
            <span className="text-sm text-text-primary truncate min-w-0">{node.title}</span>
            <svg className="w-3 h-3 text-text-muted flex-shrink-0" viewBox="0 0 16 16" fill="currentColor">
              <path d="M4.427 7.427l3.396 3.396a.25.25 0 00.354 0l3.396-3.396A.25.25 0 0011.396 7H4.604a.25.25 0 00-.177.427z" />
            </svg>
          </button>
        </div>
        <div className="flex items-center gap-0.5 flex-shrink-0">
          <button
            onClick={() => prevNode && router.push(`/blueprints/${blueprintId}/nodes/${prevNode.id}`)}
            disabled={!prevNode}
            aria-label="Previous node"
            title={!prevNode ? "No previous node" : `Go to #${prevNode.order + 1} ${prevNode.title}`}
            className="p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-tertiary active:bg-bg-hover transition-colors disabled:opacity-20 disabled:cursor-not-allowed"
          >
            <svg className="w-5 h-5" viewBox="0 0 16 16" fill="currentColor">
              <path fillRule="evenodd" d="M11.354 1.646a.5.5 0 0 1 0 .708L5.707 8l5.647 5.646a.5.5 0 0 1-.708.708l-6-6a.5.5 0 0 1 0-.708l6-6a.5.5 0 0 1 .708 0z"/>
            </svg>
          </button>
          <button
            onClick={() => nextNode && router.push(`/blueprints/${blueprintId}/nodes/${nextNode.id}`)}
            disabled={!nextNode}
            aria-label="Next node"
            title={!nextNode ? "No next node" : `Go to #${nextNode.order + 1} ${nextNode.title}`}
            className="p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-tertiary active:bg-bg-hover transition-colors disabled:opacity-20 disabled:cursor-not-allowed"
          >
            <svg className="w-5 h-5" viewBox="0 0 16 16" fill="currentColor">
              <path fillRule="evenodd" d="M4.646 1.646a.5.5 0 0 1 .708 0l6 6a.5.5 0 0 1 0 .708l-6 6a.5.5 0 0 1-.708-.708L10.293 8 4.646 2.354a.5.5 0 0 1 0-.708z"/>
            </svg>
          </button>
        </div>
      </div>

      {/* Node switcher overlay */}
      {showNodeSwitcher && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
          onClick={() => { setShowNodeSwitcher(false); nodeSwitcherTriggerRef.current?.focus(); }}
        >
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-fade-in" />
          <div
            ref={nodeSwitcherRef}
            role="dialog"
            aria-modal="true"
            aria-label="Node navigator"
            className="relative w-full sm:w-[560px] max-h-[70vh] sm:max-h-[60vh] bg-bg-secondary border border-border-primary rounded-t-2xl sm:rounded-2xl overflow-hidden flex flex-col animate-slide-up sm:animate-fade-in"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-border-primary">
              <span className="text-sm font-medium text-text-primary">
                {pickerNodes.length} Nodes
              </span>
              <button
                onClick={() => { setShowNodeSwitcher(false); nodeSwitcherTriggerRef.current?.focus(); }}
                aria-label="Close node navigator"
                className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-tertiary transition-colors"
              >
                <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06z" />
                </svg>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto overscroll-contain p-2">
              {pickerNodes.map((n) => {
                const isCurrent = n.id === nodeId;
                return (
                  <button
                    key={n.id}
                    data-node-picker-item
                    onClick={() => {
                      setShowNodeSwitcher(false);
                      if (!isCurrent) router.push(`/blueprints/${blueprintId}/nodes/${n.id}`);
                    }}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-colors ${
                      isCurrent
                        ? "bg-accent-blue/10 border border-accent-blue/30"
                        : "hover:bg-bg-tertiary border border-transparent"
                    }`}
                  >
                    <StatusIndicator status={n.status} />
                    <span className="text-xs text-text-muted font-mono w-6 text-right flex-shrink-0">
                      #{n.order + 1}
                    </span>
                    <span className={`text-sm truncate min-w-0 flex-1 ${isCurrent ? "text-accent-blue font-medium" : "text-text-primary"}`}>
                      {n.title}
                    </span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full capitalize flex-shrink-0 ${
                      n.status === "running" ? "bg-accent-blue/20 text-accent-blue"
                        : n.status === "queued" ? "bg-accent-amber/20 text-accent-amber"
                        : n.status === "failed" ? "bg-accent-red/20 text-accent-red"
                        : n.status === "done" ? "bg-accent-green/20 text-accent-green"
                        : n.status === "blocked" ? "bg-accent-amber/20 text-accent-amber"
                        : "bg-bg-tertiary text-text-muted"
                    }`}>
                      {n.status}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Mobile bottom navigation bar */}
      <div className="fixed bottom-0 left-0 right-0 z-40 sm:hidden">
        <div className="bg-bg-secondary/95 backdrop-blur-md border-t border-border-primary px-3 py-2 flex items-center gap-2">
          <button
            onClick={() => prevNode && router.push(`/blueprints/${blueprintId}/nodes/${prevNode.id}`)}
            disabled={!prevNode}
            aria-label="Previous node"
            title={!prevNode ? "No previous node" : `Go to #${prevNode.order + 1} ${prevNode.title}`}
            className="flex items-center gap-1.5 px-3 py-3 rounded-xl bg-bg-tertiary text-text-secondary active:bg-bg-hover transition-colors disabled:opacity-20 disabled:cursor-not-allowed flex-1 justify-center"
          >
            <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor">
              <path fillRule="evenodd" d="M11.354 1.646a.5.5 0 0 1 0 .708L5.707 8l5.647 5.646a.5.5 0 0 1-.708.708l-6-6a.5.5 0 0 1 0-.708l6-6a.5.5 0 0 1 .708 0z"/>
            </svg>
            <span className="text-xs truncate max-w-[80px]">{prevNode ? `#${prevNode.order + 1}` : "Prev"}</span>
          </button>
          <button
            onClick={() => setShowNodeSwitcher(true)}
            aria-label="Open node navigator"
            className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-bg-tertiary border border-border-hover text-text-primary active:bg-bg-hover transition-colors flex-shrink-0"
          >
            <span className="text-xs font-mono">{currentNodeIdx + 1}/{sortedNodes.length}</span>
            <svg className="w-3 h-3 text-text-muted" viewBox="0 0 16 16" fill="currentColor">
              <path d="M4.427 7.427l3.396 3.396a.25.25 0 00.354 0l3.396-3.396A.25.25 0 0011.396 7H4.604a.25.25 0 00-.177.427z" />
            </svg>
          </button>
          <button
            onClick={() => nextNode && router.push(`/blueprints/${blueprintId}/nodes/${nextNode.id}`)}
            disabled={!nextNode}
            aria-label="Next node"
            title={!nextNode ? "No next node" : `Go to #${nextNode.order + 1} ${nextNode.title}`}
            className="flex items-center gap-1.5 px-3 py-3 rounded-xl bg-bg-tertiary text-text-secondary active:bg-bg-hover transition-colors disabled:opacity-20 disabled:cursor-not-allowed flex-1 justify-center"
          >
            <span className="text-xs truncate max-w-[80px]">{nextNode ? `#${nextNode.order + 1}` : "Next"}</span>
            <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor">
              <path fillRule="evenodd" d="M4.646 1.646a.5.5 0 0 1 .708 0l6 6a.5.5 0 0 1 0 .708l-6 6a.5.5 0 0 1-.708-.708L10.293 8 4.646 2.354a.5.5 0 0 1 0-.708z"/>
            </svg>
          </button>
        </div>
      </div>

      {/* Node Header */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2 min-w-0 overflow-hidden">
          <StatusIndicator status={isRunning ? "running" : reevaluateQueued ? "queued" : node.status} />
          {editing ? (
            <input
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              readOnly={enriching || enrichQueued || reevaluating || reevaluateQueued}
              className={`text-xl font-semibold flex-1 min-w-0 bg-bg-tertiary border border-accent-blue rounded-lg px-2 py-1 text-text-primary focus:outline-none${enriching || enrichQueued || reevaluating || reevaluateQueued ? " opacity-60 cursor-not-allowed" : ""}`}
              placeholder="Node title"
            />
          ) : (
            <>
              <h1
                className="text-xl font-semibold cursor-pointer hover:text-accent-blue transition-colors truncate min-w-0 flex-1"
                onClick={() => { setEditTitle(node.title); setEditDesc(node.description || ""); setEditing(true); }}
                title="Click to edit"
              >
                {node.title}
              </h1>
              <button
                onClick={() => { setEditTitle(node.title); setEditDesc(node.description || ""); setEditing(true); }}
                className="text-xs text-accent-blue hover:text-accent-blue/80 font-medium transition-colors flex-shrink-0 active:scale-[0.97]"
                aria-label="Edit node"
              >
                edit
              </button>
            </>
          )}
          <span className={`text-xs px-2 py-0.5 rounded-full capitalize flex-shrink-0 ${
            isQueued || reevaluateQueued ? "bg-accent-amber/20 text-accent-amber" : "bg-bg-tertiary text-text-muted"
          }`}>
            {isRunning ? "running" : reevaluateQueued ? "re-evaluating (queued)" : isQueued ? (queuePosition > 0 ? `queued #${queuePosition}` : "queued") : node.status}
          </span>
          {node.agentType && node.agentType !== (blueprint?.agentType ?? "claude") && (
            <AgentBadge agentType={node.agentType} size="xs" />
          )}
          {isRunning && (
            <AISparkle size="sm" className="text-accent-blue" />
          )}
          {(isQueued || reevaluateQueued) && (
            <svg className="w-4 h-4 text-accent-amber animate-pulse flex-shrink-0" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 3.5a.5.5 0 0 0-1 0V8a.5.5 0 0 0 .252.434l3.5 2a.5.5 0 1 0 .496-.868L8 7.71V3.5z"/>
              <path d="M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16zm7-8A7 7 0 1 1 1 8a7 7 0 0 1 14 0z"/>
            </svg>
          )}
        </div>

        {editing ? (
          <div className="mb-3">
            <MarkdownEditor
              value={editDesc}
              onChange={setEditDesc}
              placeholder="Description (supports Markdown and image paste)"
              minHeight="120px"
              disabled={enriching || enrichQueued || reevaluating || reevaluateQueued}
              actions={
                <>
                  <button
                    onClick={async () => {
                      const trimmedTitle = editTitle.trim();
                      if (!trimmedTitle) return;
                      setSaving(true);
                      try {
                        const updates: Record<string, string> = {};
                        if (trimmedTitle !== node.title) updates.title = trimmedTitle;
                        if (editDesc !== (node.description || "")) updates.description = editDesc;
                        if (Object.keys(updates).length > 0) {
                          await updateMacroNode(blueprintId, node.id, updates);
                          setNode((prev) => prev ? { ...prev, ...updates } : prev);
                        }
                        setEditing(false);
                      } catch { /* ignore */ }
                      setSaving(false);
                    }}
                    disabled={!editTitle.trim() || saving || enriching || enrichQueued || reevaluating || reevaluateQueued}
                    title={saving ? "Saving changes..." : !editTitle.trim() ? "Enter a title first" : enriching || enrichQueued || reevaluating || reevaluateQueued ? "Cannot save while AI operation is in progress" : "Save changes"}
                    className="px-3 py-1.5 sm:px-2 sm:py-0.5 rounded-md bg-accent-blue text-white text-[11px] font-medium hover:bg-accent-blue/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {saving ? "Saving..." : "Save"}
                  </button>
                  <button
                    onClick={handleEnrich}
                    disabled={!editTitle.trim() || enriching || enrichQueued || reevaluating || reevaluateQueued}
                    title={enriching || enrichQueued ? "AI is enriching the title and description..." : !editTitle.trim() ? "Enter a title first" : reevaluating || reevaluateQueued ? "Cannot enrich while AI re-evaluation is in progress" : "AI enhances the title and description with implementation details from your codebase"}
                    className="inline-flex items-center gap-1 whitespace-nowrap px-3 py-1.5 sm:px-2 sm:py-0.5 rounded-md bg-accent-purple text-white text-[11px] font-medium hover:bg-accent-purple/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {enriching || enrichQueued ? (<><AISparkle size="xs" /> Enriching...</>) : "✨ Smart Enrich"}
                  </button>
                  <button
                    onClick={() => setEditing(false)}
                    disabled={enriching || enrichQueued || reevaluating || reevaluateQueued}
                    title={enriching || enrichQueued || reevaluating || reevaluateQueued ? "Cannot cancel while AI operation is in progress" : "Cancel editing"}
                    className="px-3 py-1.5 sm:px-2 sm:py-0.5 rounded-md border border-border-primary text-text-secondary text-[11px] hover:bg-bg-tertiary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Cancel
                  </button>
                </>
              }
            />
          </div>
        ) : (
          <div className="mb-3 rounded-xl border border-border-primary bg-bg-secondary transition-colors hover:border-border-hover">
            <div
              className="text-sm px-4 pt-3 pb-1 cursor-pointer hover:text-text-primary transition-colors min-h-[3rem]"
              onClick={() => { setEditTitle(node.title); setEditDesc(node.description || ""); setEditing(true); }}
              title="Click to edit"
            >
              {node.description ? (
                <MarkdownContent content={node.description} />
              ) : (
                <span className="text-text-muted italic">Click to add description...</span>
              )}
            </div>
            {!isRunning && !isQueued && (
              <div className="flex items-center justify-end px-3 pb-2.5">
                <button
                  onClick={handleReevaluate}
                  disabled={reevaluating || reevaluateQueued}
                  title={reevaluateQueued ? "AI re-evaluation queued, waiting..." : reevaluating ? "AI is re-evaluating this node..." : "AI reads your codebase and updates this node's title, description, and status"}
                  className={`inline-flex items-center gap-1.5 rounded-lg text-xs font-medium transition-all active:scale-[0.97] disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap ${
                    reevaluating || reevaluateQueued
                      ? "px-2.5 py-1 bg-accent-amber/15 text-accent-amber"
                      : "px-2.5 py-1 text-text-muted hover:bg-bg-tertiary hover:text-text-secondary"
                  }`}
                >
                  {reevaluating || reevaluateQueued ? (
                    <><AISparkle size="xs" /> {reevaluateQueued ? "Queued..." : "Re-evaluating..."}</>
                  ) : (
                    <>
                      <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 2v6h-6" /><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M3 22v-6h6" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
                      </svg>
                      Re-evaluate
                    </>
                  )}
                </button>
              </div>
            )}
          </div>
        )}

        {node.prompt && (
          <div className="mb-3">
            <h3 className="text-xs text-text-muted mb-1 font-medium uppercase tracking-wide">
              Prompt
            </h3>
            <pre className="text-sm text-text-secondary bg-bg-tertiary rounded-lg p-3 whitespace-pre-wrap font-mono text-xs overflow-x-auto">
              {node.prompt}
            </pre>
          </div>
        )}

        {/* Setup guidance banner for under-configured pending nodes */}
        {node.status === "pending" && node.dependencies.length === 0 && (!node.description || node.description.trim().length < 80) && (
          <div className="mb-3 px-3 py-2.5 rounded-lg bg-accent-blue/10 border border-accent-blue/20 flex items-start gap-2.5 animate-fade-in">
            <svg className="w-4 h-4 text-accent-blue flex-shrink-0 mt-0.5" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16zm.93-9.412-1 4.705c-.07.34.029.533.304.533.194 0 .487-.07.686-.246l-.088.416c-.287.346-.92.598-1.465.598-.703 0-1.002-.422-.808-1.319l.738-3.468c.064-.293.006-.399-.287-.399l-.254.002-.036-.174 2.21-.422zm-.338-3.168a.88.88 0 1 1 0 1.76.88.88 0 0 1 0-1.76z"/>
            </svg>
            <p className="text-xs text-accent-blue/90 leading-relaxed">
              This node has no dependencies and a minimal description. Consider adding dependencies to provide context from prior work, or click <strong>Edit</strong> then <strong>Smart Enrich</strong> to let AI expand the task details.
            </p>
          </div>
        )}

        {/* Action buttons */}
        <div className="grid grid-cols-2 sm:flex sm:flex-wrap gap-1.5">
          {isQueued && !showUnqueueConfirm && (
            <span className="col-span-2 px-2.5 py-1 rounded-lg bg-accent-amber/15 border border-accent-amber/20 text-accent-amber text-xs font-medium flex items-center justify-center gap-2">
              <svg className="w-3 h-3 animate-pulse" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 3.5a.5.5 0 0 0-1 0V8a.5.5 0 0 0 .252.434l3.5 2a.5.5 0 1 0 .496-.868L8 7.71V3.5z"/>
                <path d="M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16zm7-8A7 7 0 1 1 1 8a7 7 0 0 1 14 0z"/>
              </svg>
              Waiting in queue{queuePosition > 0 ? ` (#${queuePosition})` : ""}...
            </span>
          )}
          {isQueued && (
            showUnqueueConfirm ? (
              <span className="col-span-2 flex items-center justify-center gap-2 animate-fade-in">
                <span className="text-xs text-text-muted">Unqueue this node?</span>
                <button
                  onClick={async () => {
                    setUnqueuing(true);
                    try {
                      await unqueueNode(blueprintId, nodeId);
                      loadData();
                    } catch (err) {
                      setWarning(err instanceof Error ? err.message : String(err));
                    } finally {
                      setUnqueuing(false);
                      setShowUnqueueConfirm(false);
                    }
                  }}
                  disabled={unqueuing}
                  title={unqueuing ? "Removing from queue..." : undefined}
                  className="px-2.5 py-1 rounded-lg bg-accent-amber/20 text-accent-amber text-xs font-medium hover:bg-accent-amber/30 transition-colors disabled:opacity-50 active:scale-[0.97]"
                >
                  {unqueuing ? "..." : "Yes"}
                </button>
                <button
                  onClick={() => setShowUnqueueConfirm(false)}
                  className="px-2.5 py-1 rounded-lg bg-bg-tertiary text-text-muted text-xs font-medium hover:bg-bg-tertiary/80 transition-colors active:scale-[0.97]"
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                onClick={() => setShowUnqueueConfirm(true)}
                className="px-2.5 py-1 rounded-lg border border-accent-amber/30 text-accent-amber text-xs font-medium hover:bg-accent-amber/10 active:scale-[0.98] transition-all flex items-center justify-center gap-1.5"
              >
                <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/>
                </svg>
                Unqueue
              </button>
            )
          )}
          {(canRun || isRunning || isQueued) && (
            <button
              onClick={handleRun}
              disabled={isRunning || isQueued}
              title={isRunning ? "AI is executing this node in a Claude Code session..." : isQueued ? "Node is queued for execution" : "Execute this node using Claude Code"}
              className="px-2.5 py-1 rounded-lg bg-accent-green text-white text-xs font-medium hover:bg-accent-green/90 active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
            >
              {isRunning ? (
                <>
                  <AISparkle size="xs" />
                  Running...
                </>
              ) : (
                <>&#9654; Run</>
              )}
            </button>
          )}
          {(node.status === "pending" || isRunning || isQueued) && (
            <button
              onClick={async () => {
                try {
                  await updateMacroNode(blueprintId, nodeId, { status: "done" });
                  loadData();
                } catch (err) {
                  setWarning(err instanceof Error ? err.message : String(err));
                }
              }}
              disabled={isRunning || isQueued}
              title={isRunning || isQueued ? "Cannot mark done while node is running" : "Manually mark this node as completed without running it"}
              className="px-2.5 py-1 rounded-lg bg-accent-green text-white text-xs font-medium hover:bg-accent-green/90 active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
            >
              <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
                <path d="M13.485 1.929a.75.75 0 0 1 .086 1.056l-7.5 9a.75.75 0 0 1-1.107.048l-3.5-3.5a.75.75 0 1 1 1.061-1.061l2.905 2.905 6.999-8.399a.75.75 0 0 1 1.056-.086z" />
              </svg>
              Done
            </button>
          )}
          {(node.status === "pending" || node.status === "skipped" || isRunning || isQueued) && (
            <button
              onClick={async () => {
                setSkipping(true);
                const newStatus = node.status === "skipped" ? "pending" : "skipped";
                try {
                  await updateMacroNode(blueprintId, nodeId, { status: newStatus });
                  loadData();
                } catch (err) {
                  setWarning(err instanceof Error ? err.message : String(err));
                } finally {
                  setSkipping(false);
                }
              }}
              disabled={skipping || isRunning || isQueued}
              title={isRunning || isQueued ? "Cannot skip while node is running" : skipping ? "Updating node status..." : node.status === "skipped" ? "Restore this node to pending status" : "Mark this node as skipped"}
              className="px-2.5 py-1 rounded-lg border border-border-primary text-text-secondary text-xs font-medium hover:bg-bg-tertiary active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
            >
              <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
                <path d="M4.5 2a.5.5 0 0 1 .5.5v11a.5.5 0 0 1-1 0v-11a.5.5 0 0 1 .5-.5Zm7.5.5a.5.5 0 0 0-.83-.38l-5 4.5a.5.5 0 0 0 0 .74l5 4.5A.5.5 0 0 0 12 11.5v-9Z" transform="scale(-1,1) translate(-16,0)" />
              </svg>
              {skipping ? (node.status === "skipped" ? "Restoring..." : "Skipping...") : (node.status === "skipped" ? "Unskip" : "Skip")}
            </button>
          )}
          {(node.status === "pending" || isRunning || isQueued) && !showSplitConfirm && (
            <button
              onClick={() => setShowSplitConfirm(true)}
              disabled={splitting || isRunning || isQueued}
              title={isRunning || isQueued ? "Cannot split while node is running" : splitting ? "AI is decomposing this node into sub-tasks..." : "AI splits this node into 2–3 smaller sub-tasks with dependency wiring"}
              className="px-2.5 py-1 rounded-lg border border-accent-purple/30 text-accent-purple text-xs font-medium hover:bg-accent-purple/10 active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
            >
              {splitting ? (
                <>
                  <AISparkle size="xs" />
                  Splitting...
                </>
              ) : (
                <>
                  <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M8 1a.5.5 0 0 1 .5.5v5h5a.5.5 0 0 1 0 1h-5v5a.5.5 0 0 1-1 0v-5h-5a.5.5 0 0 1 0-1h5v-5A.5.5 0 0 1 8 1z" />
                    <path d="M2 8a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11A.5.5 0 0 1 2 8z" />
                  </svg>
                  Split
                </>
              )}
            </button>
          )}
          {node.status === "failed" && (
            <button
              onClick={handleRun}
              disabled={isRunning}
              title={isRunning ? "AI is retrying this node..." : "Start a fresh execution — for resuming the previous session, use the play button in Execution History below"}
              className="px-2.5 py-1 rounded-lg border border-accent-amber/50 text-accent-amber text-xs font-medium hover:bg-accent-amber/10 active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
            >
              <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 1 1 .908-.418A6 6 0 1 1 8 2v1z" />
                <path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466z" />
              </svg>
              Retry
            </button>
          )}
          {(node.status === "pending" || node.status === "failed" || isRunning || isQueued) && (
            <button
              onClick={() => setShowDeleteConfirm(true)}
              disabled={deleting || isRunning || isQueued}
              title={isRunning || isQueued ? "Cannot delete while node is running" : deleting ? "Deleting node..." : "Delete this node permanently"}
              className="px-2.5 py-1 rounded-lg border border-accent-red/30 text-accent-red text-xs font-medium hover:bg-accent-red/10 active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
            >
              <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
                <path d="M6.5 1.75a.25.25 0 0 1 .25-.25h2.5a.25.25 0 0 1 .25.25V3h-3V1.75ZM11 3V1.75A1.75 1.75 0 0 0 9.25 0h-2.5A1.75 1.75 0 0 0 5 1.75V3H2.75a.75.75 0 0 0 0 1.5h.3l.815 8.15A1.5 1.5 0 0 0 5.357 14h5.285a1.5 1.5 0 0 0 1.493-1.35l.815-8.15h.3a.75.75 0 0 0 0-1.5H11Zm-5.47 1.5.7 7h-1.46l-.7-7h1.46Zm2.97 7V4.5h-1v7h1Zm2.97 0-.7-7h1.46l.7 7h-1.46Z" />
              </svg>
              {deleting ? "Deleting..." : "Delete"}
            </button>
          )}
        </div>
        {warning && (
          <p className="text-xs text-accent-amber mt-2 flex items-center gap-1">
            <span>&#9888;</span> {warning}
          </p>
        )}
        {showSplitConfirm && (
          <div className="mt-3 p-3 rounded-lg bg-accent-purple/10 border border-accent-purple/30 animate-fade-in">
            <p className="text-sm text-accent-purple mb-2">Split into sub-tasks? The original node will be marked as skipped.</p>
            <div className="flex gap-2">
              <button
                onClick={async () => {
                  setSplitting(true);
                  setShowSplitConfirm(false);
                  try {
                    await splitNode(blueprintId, nodeId);
                    loadData(); // Refresh pending tasks to activate polling
                  } catch (err) {
                    setWarning(err instanceof Error ? err.message : String(err));
                    setSplitting(false);
                  }
                }}
                disabled={splitting}
                title={splitting ? "AI is decomposing this node..." : undefined}
                className="px-3 py-1 rounded-md bg-accent-purple text-white text-xs font-medium hover:bg-accent-purple/90 transition-colors disabled:opacity-50"
              >
                {splitting ? "Splitting..." : "Yes, Split"}
              </button>
              <button
                onClick={() => setShowSplitConfirm(false)}
                className="px-3 py-1 rounded-md border border-border-primary text-text-secondary text-xs hover:bg-bg-tertiary transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        {showDeleteConfirm && (
          <div className="mt-3 p-3 rounded-lg bg-accent-red/10 border border-accent-red/30 animate-fade-in">
            <p className="text-sm text-accent-red mb-2">Are you sure? This cannot be undone.</p>
            <div className="flex gap-2">
              <button
                onClick={async () => {
                  setDeleting(true);
                  try {
                    await deleteMacroNode(blueprintId, nodeId);
                    router.push(blueprintBackHref);
                  } catch (err) {
                    setWarning(err instanceof Error ? err.message : String(err));
                    setDeleting(false);
                    setShowDeleteConfirm(false);
                  }
                }}
                disabled={deleting}
                title={deleting ? "Deleting node..." : undefined}
                className="px-3 py-1 rounded-md bg-accent-red text-white text-xs font-medium hover:bg-accent-red/90 transition-colors disabled:opacity-50"
              >
                {deleting ? "Deleting..." : "Confirm Delete"}
              </button>
              <button
                onClick={() => setShowDeleteConfirm(false)}
                className="px-3 py-1 rounded-md border border-border-primary text-text-secondary text-xs hover:bg-bg-tertiary transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {error && (
        <div className="text-sm text-accent-red bg-accent-red/10 rounded-lg p-3 mb-4">
          {error}
        </div>
      )}

      {node.error && (
        node.error.includes("Execution interrupted by server restart") ? (
          <div className="text-sm text-accent-amber bg-accent-amber/10 rounded-lg p-3 mb-4 flex items-start gap-2">
            <span className="flex-shrink-0 mt-0.5">&#9888;</span>
            <span><span className="font-medium">Warning:</span> Node execution was interrupted — the server restarted while this node was running. Auto-recovery will attempt to resume. You can also retry manually.</span>
          </div>
        ) : (
          <div className="text-sm text-accent-red bg-accent-red/10 rounded-lg p-3 mb-4">
            <span className="font-medium">Error:</span> {node.error}
          </div>
        )
      )}

      {recovered && (
        <div className="text-sm text-accent-green bg-accent-green/10 rounded-lg p-3 mb-4">
          Session recovered — a Claude Code session was found and linked to this node&apos;s execution.
        </div>
      )}

      <div className="space-y-6">
        {/* Dependencies (editable) */}
        <section>
          {blueprint.nodes.filter((n) => n.id !== node.id).length > 0 ? (
            <div>
              <div className="flex items-center gap-2 mb-1">
                <button
                  onClick={() => setDepsExpanded((v) => !v)}
                  className="flex items-center gap-1 text-xs text-text-muted hover:text-text-secondary transition-colors"
                >
                  <span className={`transition-transform ${depsExpanded ? "rotate-90" : ""}`}>▶</span>
                  Dependencies{depNodes.length > 0 && <span className="text-accent-blue ml-1">({depNodes.length} selected)</span>}
                </button>
                {["pending", "failed", "blocked"].includes(node.status) && blueprint.nodes.filter((n) => n.id !== node.id && n.status !== "skipped").length > 0 && (
                  <button
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (smartDepsLoading) return;
                      setSmartDepsOptimistic(true);
                      try {
                        await smartPickDependencies(blueprintId, node.id);
                        loadData(); // Refresh pending tasks to activate polling
                      } catch {
                        setSmartDepsOptimistic(false);
                      }
                    }}
                    disabled={smartDepsLoading}
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-accent-purple/20 text-accent-purple text-[10px] font-medium hover:bg-accent-purple/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    title={smartDepsLoading ? "AI is analyzing nodes to pick dependencies..." : "AI analyzes node titles and descriptions to auto-select 0–3 logical dependencies"}
                    aria-label={smartDepsLoading ? "AI picking dependencies" : "AI-pick dependencies"}
                  >
                    {smartDepsLoading ? <><AISparkle size="xs" /> Picking…</> : "✨ Auto"}
                  </button>
                )}
              </div>
              <div className={`flex gap-1.5 ${depsExpanded ? "flex-wrap" : "overflow-hidden max-h-[28px]"}`}>
                {blueprint.nodes
                  .filter((n) => n.id !== node.id)
                  .filter((n) => n.status !== "skipped" || node.dependencies.includes(n.id))
                  .sort((a, b) => {
                    const aSelected = node.dependencies.includes(a.id) ? 0 : 1;
                    const bSelected = node.dependencies.includes(b.id) ? 0 : 1;
                    if (aSelected !== bSelected) return aSelected - bSelected;
                    return b.order - a.order;
                  })
                  .map((n) => {
                    const isDep = node.dependencies.includes(n.id);
                    const isSkipped = n.status === "skipped";
                    return (
                      <button
                        key={n.id}
                        disabled={smartDepsLoading}
                        onClick={async () => {
                          if (smartDepsLoading) return;
                          const newDeps = isDep
                            ? node.dependencies.filter((d) => d !== n.id)
                            : [...node.dependencies, n.id];
                          try {
                            const updated = await updateMacroNode(blueprintId, node.id, { dependencies: newDeps });
                            setBlueprint((prev) => {
                              if (!prev) return prev;
                              return {
                                ...prev,
                                nodes: prev.nodes.map((nd) =>
                                  nd.id === node.id ? updated : nd
                                ),
                              };
                            });
                            setNode(updated);
                          } catch { /* ignore */ }
                        }}
                        className={`flex-shrink-0 flex items-center gap-1.5 px-2 py-1 rounded-md text-xs border transition-colors ${
                          smartDepsLoading
                            ? "opacity-50 cursor-not-allowed"
                            : ""
                        } ${
                          isSkipped
                            ? "border-border-primary bg-bg-tertiary/50 text-text-muted opacity-60"
                            : isDep
                              ? "border-accent-blue bg-accent-blue/20 text-accent-blue"
                              : "border-border-primary text-text-muted hover:border-border-hover"
                        }`}
                        title={smartDepsLoading ? "AI is analyzing dependencies..." : isSkipped ? "This node was split — consider removing this dependency" : undefined}
                      >
                        <StatusIndicator status={n.status} size="sm" />
                        #{n.order + 1} {n.title.length > 30 ? n.title.slice(0, 30) + "…" : n.title}
                        {isSkipped && <span className="text-[10px] text-accent-amber">(split)</span>}
                        <span
                          onClick={(e) => { e.stopPropagation(); router.push(`/blueprints/${blueprintId}/nodes/${n.id}`); }}
                          className="opacity-40 hover:opacity-100 ml-0.5 cursor-pointer"
                          title={`Open #${n.order + 1} ${n.title}`}
                        >
                          ↗
                        </span>
                      </button>
                    );
                  })}
              </div>
            </div>
          ) : (
            <p className="text-xs text-text-muted">No other nodes to depend on.</p>
          )}
        </section>

        {/* Input Artifacts */}
        {node.inputArtifacts.length > 0 && (
          <section>
            <button
              onClick={() => setInputArtifactsCollapsed(!inputArtifactsCollapsed)}
              aria-expanded={!inputArtifactsCollapsed}
              className="flex items-center gap-1.5 text-sm font-medium text-text-primary mb-2 hover:text-text-secondary transition-colors"
            >
              <span className={`transition-transform text-xs ${!inputArtifactsCollapsed ? "rotate-90" : ""}`}>▶</span>
              Input Artifacts
              <span className="text-xs font-normal text-text-muted">({node.inputArtifacts.length})</span>
            </button>
            {!inputArtifactsCollapsed && <div className="space-y-2">
              {node.inputArtifacts.map((a) => {
                const sourceNode = blueprint.nodes.find(
                  (n) => n.id === a.sourceNodeId
                );
                return (
                  <div
                    key={a.id}
                    className="rounded-lg border border-border-primary bg-bg-secondary p-3"
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-accent-blue">&#8592;</span>
                      <span className="text-xs font-medium text-text-secondary capitalize">
                        {a.type.replace(/_/g, " ")}
                      </span>
                      {sourceNode && (
                        sourceNode.status === "skipped" ? (
                          <span className="text-xs text-text-muted opacity-60 italic">
                            from {sourceNode.title} <span className="text-accent-amber">(split)</span>
                          </span>
                        ) : (
                          <Link
                            href={`/blueprints/${blueprintId}/nodes/${sourceNode.id}`}
                            className="text-xs text-text-muted hover:text-accent-blue transition-colors"
                          >
                            from {sourceNode.title}
                          </Link>
                        )
                      )}
                    </div>
                    {a.content && (
                      <div className="text-xs bg-bg-tertiary rounded p-2 mt-1 max-h-96 overflow-y-auto [&_.space-y-3]:space-y-1.5 [&_.space-y-3]:text-xs">
                        <MarkdownContent content={a.content} maxHeight="none" />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>}
          </section>
        )}

        {/* Live Activity — last session message during execution */}
        {lastMessage && isRunning && (
          <section className="rounded-lg border border-accent-blue/30 bg-accent-blue/5 p-3">
            <h2 className="text-xs font-medium text-accent-blue mb-2 flex items-center gap-1.5">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent-blue opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-accent-blue" />
              </span>
              Live Activity
            </h2>
            <div className="flex items-start gap-2">
              <span className={`text-xs px-1.5 py-0.5 rounded font-medium shrink-0 mt-0.5 ${
                lastMessage.type === "assistant"
                  ? "bg-accent-purple/15 text-accent-purple"
                  : lastMessage.type === "user"
                  ? "bg-accent-blue/15 text-accent-blue"
                  : lastMessage.type === "tool_use" || lastMessage.type === "tool_result"
                  ? "bg-amber-500/15 text-amber-400"
                  : "bg-bg-tertiary text-text-muted"
              }`}>
                {lastMessage.type === "tool_use" ? `tool: ${lastMessage.toolName ?? "unknown"}` :
                 lastMessage.type === "tool_result" ? "tool result" :
                 lastMessage.type}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-xs text-text-secondary line-clamp-3 whitespace-pre-wrap break-words">
                  {lastMessage.content.length > 500
                    ? lastMessage.content.slice(0, 500) + "..."
                    : lastMessage.content}
                </p>
                <span className="text-[10px] text-text-muted mt-1 block">
                  {formatTime(lastMessage.timestamp)}
                </span>
              </div>
            </div>
          </section>
        )}

        {/* Execution History */}
        <section>
          <h2 className="text-sm font-medium text-text-primary mb-2 flex items-center gap-2">
            <span>
              Execution History
              {executions.length > 0 && (
                <span className="text-text-muted font-normal ml-1">
                  ({executions.length})
                </span>
              )}
            </span>
            {(isRunning || isQueued || hasPendingTasks || postCompletionPolls > 0) && (
              <span className="text-text-muted" title={postCompletionPolls > 0 ? "Waiting for artifacts..." : "Auto-refreshing every 5s"}>
                <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12a9 9 0 1 1-9-9" />
                  <polyline points="21 3 21 9 15 9" />
                </svg>
              </span>
            )}
          </h2>
          {executions.length === 0 ? (
            <p className="text-sm text-text-muted py-4 text-center border border-dashed border-border-primary rounded-lg">
              No executions yet
            </p>
          ) : (
            <div className="space-y-2">
              {executions.map((exec) => (
                <div
                  key={exec.id}
                  className="rounded-lg border border-border-primary bg-bg-secondary p-3"
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <StatusIndicator status={exec.status} size="sm" />
                    <span className="text-xs font-medium text-text-secondary capitalize">
                      {exec.type}
                    </span>
                    <span className="text-xs text-text-muted capitalize">
                      {exec.status}
                    </span>
                    <span className="text-xs text-text-muted">
                      {formatDuration(exec.startedAt, exec.completedAt)}
                    </span>
                    {exec.sessionId && (
                      <div className="w-full sm:w-auto sm:ml-auto flex items-center gap-1">
                        <Link
                          href={`/session/${exec.sessionId}`}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-accent-blue/15 text-accent-blue hover:bg-accent-blue/25 transition-colors text-xs font-medium"
                        >
                          <svg
                            className="w-3 h-3"
                            viewBox="0 0 16 16"
                            fill="currentColor"
                          >
                            <path d="M1.5 3A1.5 1.5 0 0 1 3 1.5h10A1.5 1.5 0 0 1 14.5 3v10a1.5 1.5 0 0 1-1.5 1.5H3A1.5 1.5 0 0 1 1.5 13V3zM3 2.5a.5.5 0 0 0-.5.5v10a.5.5 0 0 0 .5.5h10a.5.5 0 0 0 .5-.5V3a.5.5 0 0 0-.5-.5H3z" />
                            <path d="M4 5.5a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1-.5-.5zm0 2.5a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7A.5.5 0 0 1 4 8zm0 2.5a.5.5 0 0 1 .5-.5h4a.5.5 0 0 1 0 1h-4a.5.5 0 0 1-.5-.5z" />
                          </svg>
                          Session {exec.sessionId.slice(0, 8)}
                        </Link>
                        {exec.status === "failed" &&
                          // Hide resume button if a continuation with the same session exists and hasn't failed
                          !executions.some(
                            (other) =>
                              other.id !== exec.id &&
                              other.sessionId === exec.sessionId &&
                              other.status !== "failed"
                          ) && (
                          <button
                            onClick={() => {
                              setResumingExecId(exec.id);
                              resumeNodeSession(blueprintId, nodeId, exec.id)
                                .catch((err) => setWarning(err instanceof Error ? err.message : String(err)))
                                .finally(() => {
                                  setResumingExecId(null);
                                  loadData();
                                });
                            }}
                            disabled={resumingExecId === exec.id || isRunning}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-accent-green/15 text-accent-green hover:bg-accent-green/25 transition-all active:scale-[0.97] text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed"
                            title={resumingExecId === exec.id ? "AI is resuming the failed session..." : isRunning ? "Cannot resume while node is running" : "Resume this failed session — AI continues with full context from the previous attempt"}
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
                      </div>
                    )}
                  </div>
                  {exec.failureReason && exec.status === "failed" && (
                    <div className={`mt-1.5 rounded text-xs font-medium ${
                      exec.failureReason === "context_exhausted"
                        ? "bg-orange-500/10 text-orange-400"
                        : exec.failureReason === "output_token_limit"
                        ? "bg-amber-500/10 text-amber-400"
                        : exec.failureReason === "timeout"
                        ? "bg-yellow-500/10 text-yellow-400"
                        : exec.failureReason === "hung"
                        ? "bg-purple-500/10 text-purple-400"
                        : "bg-accent-red/10 text-accent-red"
                    }`}>
                      <div className="flex items-center gap-1.5 px-2 py-1">
                        {exec.failureReason === "context_exhausted" && (
                          <><span title="Context exhausted">&#x26A0;</span> Context exhausted — session ran out of context window space</>
                        )}
                        {exec.failureReason === "output_token_limit" && (
                          <><span title="Output token limit">&#x26A0;</span> Output token limit — response exceeded max output tokens</>
                        )}
                        {exec.failureReason === "timeout" && (
                          <><span title="Timeout">&#x23F1;</span> Timeout — execution exceeded the time limit</>
                        )}
                        {exec.failureReason === "hung" && (
                          <><span title="Hung">&#x1F6D1;</span> No output — Claude may have hung or stalled</>
                        )}
                        {exec.failureReason === "error" && (
                          <><span title="Error">&#x274C;</span> Error</>
                        )}
                      </div>
                      {/* Context health details */}
                      {(exec.compactCount != null && exec.compactCount > 0) && (
                        <div className="px-2 pb-1 text-[11px] opacity-80">
                          {exec.compactCount} compaction{exec.compactCount !== 1 ? "s" : ""}
                          {exec.peakTokens ? ` · peak ${Math.round(exec.peakTokens / 1000)}K tokens` : ""}
                        </div>
                      )}
                      {/* Actionable guidance for context-related failures */}
                      {(exec.failureReason === "context_exhausted" || exec.failureReason === "output_token_limit") && (
                        <div className="px-2 pb-1.5 text-[11px] font-normal opacity-70">
                          {exec.failureReason === "context_exhausted"
                            ? "Try breaking this task into smaller steps, or resume the session to continue where it left off."
                            : "The response was too long. Consider splitting this into multiple smaller tasks."
                          }
                        </div>
                      )}
                    </div>
                  )}
                  {/* Blocker info (from report-blocker callback) */}
                  {exec.blockerInfo && (
                    <div className="mt-1.5 rounded bg-accent-amber/10 text-accent-amber px-2 py-1.5 text-xs">
                      <div className="font-medium flex items-center gap-1">
                        <span>&#x1F6A7;</span> Blocker Reported
                      </div>
                      <div className="mt-0.5 text-[11px] opacity-90 whitespace-pre-wrap">{exec.blockerInfo}</div>
                    </div>
                  )}
                  {/* Task summary (from task-summary callback) */}
                  {exec.taskSummary && (
                    <div className="mt-1.5 rounded bg-accent-green/10 text-accent-green px-2 py-1.5 text-xs">
                      <div className="font-medium flex items-center gap-1">
                        <span>&#x1F4CB;</span> Task Summary
                      </div>
                      <div className="mt-0.5 text-[11px] opacity-90 whitespace-pre-wrap">{exec.taskSummary}</div>
                    </div>
                  )}
                  {/* Context pressure warning on successful executions */}
                  {exec.status === "done" && exec.contextPressure && exec.contextPressure !== "none" && (
                    <div className={`flex items-center gap-1.5 mt-1.5 px-2 py-1 rounded text-[11px] ${
                      exec.contextPressure === "critical"
                        ? "bg-orange-500/10 text-orange-400"
                        : exec.contextPressure === "high"
                        ? "bg-yellow-500/10 text-yellow-400"
                        : "bg-blue-500/10 text-blue-400"
                    }`}>
                      {exec.contextPressure === "critical" && "Context nearly full"}
                      {exec.contextPressure === "high" && "High context usage"}
                      {exec.contextPressure === "moderate" && "Moderate context usage"}
                      {exec.compactCount != null && exec.compactCount > 0 && (
                        <span className="opacity-70">
                          · {exec.compactCount} compaction{exec.compactCount !== 1 ? "s" : ""}
                          {exec.peakTokens ? ` · ${Math.round(exec.peakTokens / 1000)}K tokens` : ""}
                        </span>
                      )}
                    </div>
                  )}
                  <div className="text-[11px] text-text-muted mt-1">
                    Started {formatTime(exec.startedAt)}
                    {exec.completedAt && <> &middot; Completed {formatTime(exec.completedAt)}</>}
                  </div>
                  {exec.inputContext && (
                    <div className="mt-2">
                      <button
                        onClick={() => setExpandedInputs((prev) => {
                          const next = new Set(prev);
                          next.has(exec.id) ? next.delete(exec.id) : next.add(exec.id);
                          return next;
                        })}
                        aria-expanded={expandedInputs.has(exec.id)}
                        className="flex items-center gap-1 text-xs text-text-muted hover:text-text-secondary transition-colors"
                      >
                        <span className={`transition-transform ${expandedInputs.has(exec.id) ? "rotate-90" : ""}`}>▶</span>
                        Prompt Sent
                      </button>
                      {expandedInputs.has(exec.id) && (
                        <div className="text-xs bg-bg-tertiary rounded p-2 mt-1 max-h-64 overflow-y-auto [&_.space-y-3]:space-y-1.5 [&_.space-y-3]:text-xs">
                          <MarkdownContent content={exec.inputContext} maxHeight="none" />
                        </div>
                      )}
                    </div>
                  )}
                  {exec.outputSummary && (
                    <div className="mt-2">
                      <button
                        onClick={() => setCollapsedOutputs((prev) => {
                          const next = new Set(prev);
                          next.has(exec.id) ? next.delete(exec.id) : next.add(exec.id);
                          return next;
                        })}
                        aria-expanded={!collapsedOutputs.has(exec.id)}
                        className="flex items-center gap-1 text-xs text-text-muted hover:text-text-secondary transition-colors"
                      >
                        <span className={`transition-transform ${!collapsedOutputs.has(exec.id) ? "rotate-90" : ""}`}>▶</span>
                        Output Summary
                      </button>
                      {!collapsedOutputs.has(exec.id) && (
                        <div className="text-xs bg-bg-tertiary rounded p-2 mt-1 max-h-64 overflow-y-auto [&_.space-y-3]:space-y-1.5 [&_.space-y-3]:text-xs">
                          <MarkdownContent content={exec.outputSummary} maxHeight="none" />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Related Sessions (enrich, reevaluate, split, evaluate) */}
        {relatedSessions.length > 0 && (
          <section>
            <button
              onClick={() => setRelatedExpanded(!relatedExpanded)}
              aria-expanded={relatedExpanded}
              className="w-full text-left text-sm font-medium text-text-primary mb-2 flex items-center gap-2"
            >
              <svg className={`w-3 h-3 transition-transform ${relatedExpanded ? "rotate-90" : ""}`} viewBox="0 0 16 16" fill="currentColor">
                <path d="M6 3l5 5-5 5V3z" />
              </svg>
              Related Sessions
              <span className="text-text-muted font-normal">
                ({relatedSessions.length})
              </span>
            </button>
            {relatedExpanded && (
              <div className="space-y-1.5">
                {relatedSessions.map((rs) => (
                  <div
                    key={rs.id}
                    className="flex items-center gap-2 flex-wrap rounded-lg border border-border-primary bg-bg-secondary px-3 py-2"
                  >
                    <span className={`text-[11px] px-1.5 py-0.5 rounded font-medium shrink-0 ${
                      rs.type === "enrich"
                        ? "bg-accent-purple/15 text-accent-purple"
                        : rs.type === "reevaluate" || rs.type === "reevaluate_all"
                        ? "bg-accent-amber/15 text-accent-amber"
                        : rs.type === "split"
                        ? "bg-accent-blue/15 text-accent-blue"
                        : rs.type === "evaluate"
                        ? "bg-accent-green/15 text-accent-green"
                        : "bg-bg-tertiary text-text-muted"
                    }`}>
                      {rs.type === "reevaluate_all" ? "Reevaluate All" :
                       rs.type.charAt(0).toUpperCase() + rs.type.slice(1)}
                    </span>
                    <Link
                      href={`/session/${rs.sessionId}`}
                      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-lg bg-accent-blue/15 text-accent-blue hover:bg-accent-blue/25 transition-colors text-xs font-medium"
                    >
                      <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M1.5 3A1.5 1.5 0 0 1 3 1.5h10A1.5 1.5 0 0 1 14.5 3v10a1.5 1.5 0 0 1-1.5 1.5H3A1.5 1.5 0 0 1 1.5 13V3zM3 2.5a.5.5 0 0 0-.5.5v10a.5.5 0 0 0 .5.5h10a.5.5 0 0 0 .5-.5V3a.5.5 0 0 0-.5-.5H3z" />
                        <path d="M4 5.5a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1-.5-.5zm0 2.5a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7A.5.5 0 0 1 4 8zm0 2.5a.5.5 0 0 1 .5-.5h4a.5.5 0 0 1 0 1h-4a.5.5 0 0 1-.5-.5z" />
                      </svg>
                      Session {rs.sessionId.slice(0, 8)}
                    </Link>
                    <span className="text-[11px] text-text-muted">
                      {formatTime(rs.startedAt)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {/* Output Artifacts — merge duplicates with identical content */}
        {node.outputArtifacts.length > 0 && (() => {
          // Group by content+type to merge artifacts that differ only by targetNodeId
          const merged = node.outputArtifacts.reduce<
            { id: string; type: string; content: string; targetNodeIds: string[] }[]
          >((acc, a) => {
            const existing = acc.find(
              (g) => g.content === a.content && g.type === a.type
            );
            if (existing) {
              if (a.targetNodeId) existing.targetNodeIds.push(a.targetNodeId);
            } else {
              acc.push({
                id: a.id,
                type: a.type,
                content: a.content,
                targetNodeIds: a.targetNodeId ? [a.targetNodeId] : [],
              });
            }
            return acc;
          }, []);

          return (
            <section>
              <button
                onClick={() => setOutputArtifactsCollapsed(!outputArtifactsCollapsed)}
                aria-expanded={!outputArtifactsCollapsed}
                className="flex items-center gap-1.5 text-sm font-medium text-text-primary mb-2 hover:text-text-secondary transition-colors"
              >
                <span className={`transition-transform text-xs ${!outputArtifactsCollapsed ? "rotate-90" : ""}`}>▶</span>
                Output Artifacts
                <span className="text-xs font-normal text-text-muted">({merged.length})</span>
              </button>
              {!outputArtifactsCollapsed && <div className="space-y-2">
                {merged.map((g) => {
                  const targetNodes = g.targetNodeIds
                    .map((tid) => blueprint.nodes.find((n) => n.id === tid))
                    .filter(Boolean);
                  return (
                    <div
                      key={g.id}
                      className="rounded-lg border border-border-primary bg-bg-secondary p-3"
                    >
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className="text-accent-green">&#8594;</span>
                        <span className="text-xs font-medium text-text-secondary capitalize">
                          {g.type.replace(/_/g, " ")}
                        </span>
                        {targetNodes.map((tn) => (
                          <Link
                            key={tn!.id}
                            href={`/blueprints/${blueprintId}/nodes/${tn!.id}`}
                            className="text-xs text-text-muted hover:text-accent-blue transition-colors"
                          >
                            to {tn!.title}
                          </Link>
                        ))}
                      </div>
                      {g.content && (
                        <div className="text-xs bg-bg-tertiary rounded p-2 mt-1 max-h-96 overflow-y-auto [&_.space-y-3]:space-y-1.5 [&_.space-y-3]:text-xs">
                          <MarkdownContent content={g.content} maxHeight="none" />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>}
            </section>
          );
        })()}
      </div>
    </div>
  );
}
