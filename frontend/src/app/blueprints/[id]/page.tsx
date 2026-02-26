"use client";

import { useState, useEffect, useCallback, useRef, useMemo, Fragment } from "react";
import { useParams, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  type Blueprint,
  type MacroNodeStatus,
  type PendingTask,
  getBlueprint,
  getQueueStatus,
  approveBlueprint,
  updateBlueprint,
  createMacroNode,
  enrichNode,
  generatePlan,
  runAllNodes,
  reevaluateAllNodes,
  recoverNodeSession,
  archiveBlueprint as archiveBlueprintApi,
  unarchiveBlueprint as unarchiveBlueprintApi,
} from "@/lib/api";
import { StatusIndicator } from "@/components/StatusIndicator";
import { MacroNodeCard } from "@/components/MacroNodeCard";
import { MarkdownContent } from "@/components/MarkdownContent";
import { MarkdownEditor } from "@/components/MarkdownEditor";
import { AISparkle } from "@/components/AISparkle";
import { computeDepLayout } from "@/components/DependencyGraph";
import { SkeletonLoader } from "@/components/SkeletonLoader";

export default function BlueprintDetailPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const id = params.id as string;

  const [blueprint, setBlueprint] = useState<Blueprint | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const autoGenerateTriggered = useRef(false);

  // Add node form
  const [showAddNode, setShowAddNode] = useState(false);
  const [nodeTitle, setNodeTitle] = useState("");
  const [nodeDescription, setNodeDescription] = useState("");
  const [addingNode, setAddingNode] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [nodeDeps, setNodeDeps] = useState<string[]>([]);
  const [depsExpanded, setDepsExpanded] = useState(false);

  // Initialize filter state from URL search params
  const VALID_NODE_STATUSES = useMemo(() => new Set<string>(["pending", "queued", "running", "done", "failed", "blocked", "skipped", "all"]), []);
  const initNodeStatus = searchParams.get("filter");
  const [reverseOrder, setReverseOrderRaw] = useState(searchParams.get("order") === "oldest" ? false : true);
  const [smartSort, setSmartSortRaw] = useState(searchParams.get("sort") === "manual" ? false : true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [statusFilter, setStatusFilterRaw] = useState<MacroNodeStatus | "all">(
    initNodeStatus && VALID_NODE_STATUSES.has(initNodeStatus) ? initNodeStatus as MacroNodeStatus | "all" : "all"
  );

  // Helper to sync filter state to URL + sessionStorage
  const updateUrlParam = useCallback((key: string, value: string, defaultValue: string) => {
    const url = new URL(window.location.href);
    if (value === defaultValue) url.searchParams.delete(key);
    else url.searchParams.set(key, value);
    // Preserve ?generate param if present
    window.history.replaceState({}, "", url.toString());
    try { sessionStorage.setItem(`clawui:blueprint-${id}-filters`, url.search); } catch { /* ignore */ }
  }, [id]);

  // Save initial filter state to sessionStorage on mount
  useEffect(() => {
    const url = new URL(window.location.href);
    try { sessionStorage.setItem(`clawui:blueprint-${id}-filters`, url.search); } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on mount
  }, []);

  const setStatusFilter = useCallback((value: MacroNodeStatus | "all") => {
    setStatusFilterRaw(value);
    updateUrlParam("filter", value, "all");
  }, [updateUrlParam]);

  const setSmartSort = useCallback((updater: boolean | ((prev: boolean) => boolean)) => {
    setSmartSortRaw(prev => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      updateUrlParam("sort", next ? "smart" : "manual", "smart");
      return next;
    });
  }, [updateUrlParam]);

  const setReverseOrder = useCallback((updater: boolean | ((prev: boolean) => boolean)) => {
    setReverseOrderRaw(prev => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      updateUrlParam("order", next ? "newest" : "oldest", "newest");
      return next;
    });
  }, [updateUrlParam]);
  const [showOlderNodes, setShowOlderNodes] = useState(false);
  const [generateInstruction, setGenerateInstruction] = useState("");
  const [approving, setApproving] = useState(false);
  const [runningAll, setRunningAll] = useState(false);
  const [reevaluating, setReevaluating] = useState(false);
  const [pendingTasks, setPendingTasks] = useState<PendingTask[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollStartRef = useRef<number | null>(null);
  const MAX_POLL_DURATION = 35 * 60 * 1000; // 35 min safety cap
  const [generateCooldown, setGenerateCooldown] = useState(false);
  const [confirmingRegenerate, setConfirmingRegenerate] = useState(false);
  const [confirmingReevaluate, setConfirmingReevaluate] = useState(false);

  // Generation progress tracking
  const preGenerateNodeIdsRef = useRef<Set<string> | null>(null);
  const [newNodeIds, setNewNodeIds] = useState<Set<string>>(new Set());

  // Editable title
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleValue, setTitleValue] = useState("");
  const titleRef = useRef<HTMLInputElement>(null);

  // Editable description
  const [editingDesc, setEditingDesc] = useState(false);
  const [descValue, setDescValue] = useState("");
  const descRef = useRef<HTMLTextAreaElement>(null);
  const recoveryAttempted = useRef(false);

  const loadBlueprint = useCallback(() => {
    return getBlueprint(id)
      .then((bp) => {
        setBlueprint(bp);
        return bp;
      })
      .catch((err) => {
        setError(err.message);
        return null;
      })
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    loadBlueprint();
    // Also fetch queue status on initial load so pendingTasks is populated
    // immediately (prevents losing visibility of queued reevaluate/enrich ops)
    getQueueStatus(id).then((qi) => setPendingTasks(qi.pendingTasks)).catch(() => { /* non-critical: UI still functional */ });
  }, [loadBlueprint, id]);

  // Auto-recover lost sessions for nodes failed by server restart
  useEffect(() => {
    if (recoveryAttempted.current || !blueprint) return;
    const restartedNodes = blueprint.nodes.filter(
      (n) => n.error?.includes("Execution interrupted by server restart"),
    );
    if (restartedNodes.length === 0) return;
    recoveryAttempted.current = true;
    Promise.all(
      restartedNodes.map((n) =>
        recoverNodeSession(id, n.id).catch(() => ({ recovered: false })),
      ),
    ).then((results) => {
      if (results.some((r) => r.recovered)) loadBlueprint();
    });
  }, [blueprint, id, loadBlueprint]);

  // Auto-generate nodes if ?generate=true
  useEffect(() => {
    if (
      searchParams.get("generate") === "true" &&
      !autoGenerateTriggered.current &&
      blueprint &&
      blueprint.nodes.length === 0 &&
      !generating
    ) {
      autoGenerateTriggered.current = true;
      handleGenerate(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handleGenerate is intentionally excluded to prevent re-trigger loops; autoGenerateTriggered ref guards against double execution
  }, [blueprint, searchParams]);

  const handleGenerate = async (skipConfirm = false) => {
    if (!skipConfirm && blueprint && blueprint.nodes.length > 0 && !confirmingRegenerate) {
      setConfirmingRegenerate(true);
      return;
    }
    setConfirmingRegenerate(false);
    setGenerating(true);
    setError(null);
    // Snapshot current node IDs to track new ones during generation
    preGenerateNodeIdsRef.current = new Set(blueprint?.nodes.map(n => n.id) ?? []);
    setNewNodeIds(new Set());
    try {
      await generatePlan(id, generateInstruction.trim() || undefined);
      // Generate is now fire-and-forget — reload to pick up pending task,
      // then polling will detect new nodes as Claude creates them via API
      await loadBlueprint();
      getQueueStatus(id).then((qi) => setPendingTasks(qi.pendingTasks)).catch(() => {});
      // Prevent accidental reevaluate clicks right after generation
      setGenerateCooldown(true);
      setTimeout(() => setGenerateCooldown(false), 5000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerateInstruction("");
      setGenerating(false);
    }
  };

  // Auto-poll when blueprint or any node is running/queued, or has pending tasks
  const anyNodeRunning = blueprint?.nodes.some(n => n.status === "running") ?? false;
  const anyNodeQueued = blueprint?.nodes.some(n => n.status === "queued") ?? false;
  const hasPendingTasks = pendingTasks.length > 0;
  const shouldPoll = autoRefresh && (blueprint?.status === "running" || anyNodeRunning || anyNodeQueued || hasPendingTasks);
  useEffect(() => {
    if (shouldPoll) {
      if (!pollStartRef.current) pollStartRef.current = Date.now();
      // Clear any existing interval before creating a new one to prevent leaks
      // when the effect re-runs due to dependency changes while still polling.
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(() => {
        // Safety cap: stop polling after MAX_POLL_DURATION to prevent infinite polling
        if (pollStartRef.current && Date.now() - pollStartRef.current > MAX_POLL_DURATION) {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          pollStartRef.current = null;
          setPendingTasks([]);
          setRunningAll(false);
          return;
        }
        Promise.all([
          getBlueprint(id),
          getQueueStatus(id),
        ])
          .then(([bp, queueInfo]) => {
            setBlueprint(bp);
            setPendingTasks(queueInfo.pendingTasks);
            // Track newly created nodes during generation
            if (preGenerateNodeIdsRef.current) {
              const freshIds = bp.nodes
                .map(n => n.id)
                .filter(nid => !preGenerateNodeIdsRef.current!.has(nid));
              if (freshIds.length > 0) {
                setNewNodeIds(prev => {
                  const next = new Set(prev);
                  freshIds.forEach(nid => next.add(nid));
                  return next;
                });
              }
              // Clear tracking when generation completes
              const isGenerating = queueInfo.pendingTasks.some(t => t.type === "generate");
              if (!isGenerating) {
                preGenerateNodeIdsRef.current = null;
                // Keep newNodeIds visible briefly, then clear for animation
                setTimeout(() => setNewNodeIds(new Set()), 3000);
              }
            }
            const stillActive = bp.status === "running"
              || bp.nodes.some(n => n.status === "running" || n.status === "queued")
              || queueInfo.pendingTasks.length > 0;
            if (!stillActive) {
              if (pollRef.current) clearInterval(pollRef.current);
              pollRef.current = null;
              pollStartRef.current = null;
              setRunningAll(false);
            }
          })
          .catch(() => { /* non-critical: UI still functional */ });
      }, 5000);
    } else {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      pollStartRef.current = null;
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [shouldPoll, id]);

  const handleApprove = async () => {
    setApproving(true);
    try {
      const updated = await approveBlueprint(id);
      setBlueprint(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setApproving(false);
    }
  };

  const handleReevaluateAll = async () => {
    if (!confirmingReevaluate) {
      setConfirmingReevaluate(true);
      return;
    }
    setConfirmingReevaluate(false);
    setReevaluating(true);
    setError(null);
    try {
      await reevaluateAllNodes(id);
      // Refresh to pick up pending tasks
      const bp = await getBlueprint(id);
      setBlueprint(bp);
      getQueueStatus(id).then((qi) => setPendingTasks(qi.pendingTasks)).catch(() => { /* non-critical: UI still functional */ });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReevaluating(false);
    }
  };

  const handleRunAll = async () => {
    setRunningAll(true);
    setError(null);
    try {
      await runAllNodes(id);
      // Start polling — the useEffect above will handle it once status becomes "running"
      const bp = await getBlueprint(id);
      setBlueprint(bp);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRunningAll(false);
    }
  };

  const handleRefresh = () => {
    loadBlueprint();
    getQueueStatus(id).then((qi) => setPendingTasks(qi.pendingTasks)).catch(() => { /* non-critical: UI still functional */ });
  };

  const handleAddNode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nodeTitle.trim() || !blueprint) return;

    setAddingNode(true);
    try {
      const node = await createMacroNode(id, {
        title: nodeTitle.trim(),
        description: nodeDescription.trim() || undefined,
        order: blueprint.nodes.length,
        dependencies: nodeDeps.length > 0 ? nodeDeps : undefined,
      });
      setBlueprint((prev) =>
        prev ? { ...prev, nodes: [...prev.nodes, node] } : prev
      );
      setNodeTitle("");
      setNodeDescription("");
      setNodeDeps([]);
      setShowAddNode(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAddingNode(false);
    }
  };

  const handleSmartCreate = async () => {
    if (!nodeTitle.trim() || !blueprint) return;
    setEnriching(true);
    try {
      const result = await enrichNode(id, {
        title: nodeTitle.trim(),
        description: nodeDescription.trim() || undefined,
      });
      // Smart Create (no nodeId) returns {title, description} from callback path
      if ("status" in result) throw new Error("Unexpected queued response for Smart Create");
      // Create the node with enriched data directly in DB
      const node = await createMacroNode(id, {
        title: result.title,
        description: result.description,
        order: blueprint.nodes.length,
        dependencies: nodeDeps.length > 0 ? nodeDeps : undefined,
      });
      setBlueprint((prev) =>
        prev ? { ...prev, nodes: [...prev.nodes, node] } : prev
      );
      setNodeTitle("");
      setNodeDescription("");
      setNodeDeps([]);
      setShowAddNode(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setEnriching(false);
    }
  };

  // Compute dependency depth for each node (topological level in the DAG)
  // Root nodes (no deps) = depth 0; depth = max(depth of deps) + 1
  const depthMap = useMemo(() => {
    const nodes = blueprint?.nodes ?? [];
    const map = new Map<string, number>();
    const visiting = new Set<string>();
    const nodeById = new Map(nodes.map(n => [n.id, n]));

    function getDepth(id: string): number {
      if (map.has(id)) return map.get(id)!;
      if (visiting.has(id)) return 0; // cycle guard
      visiting.add(id);
      const node = nodeById.get(id);
      let depth = 0;
      if (node && node.dependencies.length > 0) {
        depth = Math.max(...node.dependencies.map(depId => getDepth(depId))) + 1;
      }
      visiting.delete(id);
      map.set(id, depth);
      return depth;
    }

    for (const node of nodes) {
      getDepth(node.id);
    }
    return map;
  }, [blueprint?.nodes]);

  // Build back link preserving blueprints list filter state
  const blueprintsBackHref = useMemo(() => {
    try {
      const saved = sessionStorage.getItem("clawui:blueprints-filters");
      if (saved) return `/blueprints${saved}`;
    } catch { /* ignore */ }
    return "/blueprints";
  }, []);

  if (loading) {
    return (
      <div className="py-4">
        <div className="w-32 h-4 rounded bg-bg-tertiary animate-pulse mb-4" />
        <div className="flex items-center gap-3 mb-3">
          <div className="w-3 h-3 rounded-full bg-bg-tertiary animate-pulse" />
          <div className="h-6 w-2/3 rounded bg-bg-tertiary animate-pulse" />
        </div>
        <div className="h-4 w-1/2 rounded bg-bg-tertiary animate-pulse mb-6" />
        <SkeletonLoader variant="nodeCard" count={4} />
      </div>
    );
  }

  if (error && !blueprint) {
    return (
      <div className="text-center py-16 text-accent-red">
        Failed to load blueprint: {error}
      </div>
    );
  }

  if (!blueprint) {
    return (
      <div className="text-center py-16 text-text-muted">
        Blueprint not found
      </div>
    );
  }

  const isGeneratingTask = pendingTasks.some(t => t.type === "generate");
  const newNodeCount = newNodeIds.size;
  const isRunning = blueprint.status === "running" || runningAll;
  const canRunAll = (blueprint.status === "approved" || blueprint.status === "failed" || blueprint.status === "paused")
    && blueprint.nodes.some((n) => n.status === "pending" || n.status === "failed");

  // Status priority for smart sort: active/actionable first, completed last
  const statusPriority: Record<MacroNodeStatus, number> = {
    running: 0,
    queued: 1,
    failed: 2,
    blocked: 3,
    pending: 4,
    done: 5,
    skipped: 6,
  };

  // Apply status filter then sort
  const filteredNodes = statusFilter === "all"
    ? blueprint.nodes
    : blueprint.nodes.filter((n) => n.status === statusFilter);

  // Active vs completed tier: active statuses always above completed ones
  const completedStatuses = new Set<MacroNodeStatus>(["done", "skipped"]);

  let displayNodes: typeof filteredNodes;
  if (smartSort && statusFilter === "all") {
    // Smart sort: active tier on top; depth descending only for active nodes; then status priority, then createdAt descending
    displayNodes = [...filteredNodes].sort((a, b) => {
      const aCompleted = completedStatuses.has(a.status);
      const bCompleted = completedStatuses.has(b.status);
      const tierDiff = (aCompleted ? 1 : 0) - (bCompleted ? 1 : 0);
      if (tierDiff !== 0) return tierDiff;
      // Depth only matters for active nodes — completed nodes skip depth sorting
      if (!aCompleted) {
        const depthDiff = (depthMap.get(b.id) ?? 0) - (depthMap.get(a.id) ?? 0);
        if (depthDiff !== 0) return depthDiff;
      }
      const priorityDiff = statusPriority[a.status] - statusPriority[b.status];
      if (priorityDiff !== 0) return priorityDiff;
      return b.createdAt.localeCompare(a.createdAt);
    });
  } else {
    displayNodes = reverseOrder ? [...filteredNodes].reverse() : filteredNodes;
  }

  // Smart grouping: only collapse done/skipped nodes, never hide active ones
  const OLDER_GROUP_THRESHOLD = 6;
  const RECENT_COMPLETED_VISIBLE = 2;
  let topDisplayNodes: typeof displayNodes = displayNodes;
  let olderDisplayNodes: typeof displayNodes = [];

  if (statusFilter === "all" && displayNodes.length > OLDER_GROUP_THRESHOLD) {
    const collapsibleIds = new Set<string>();
    let completedSeen = 0;
    for (const node of displayNodes) {
      if (node.status === "done" || node.status === "skipped") {
        completedSeen++;
        if (completedSeen > RECENT_COMPLETED_VISIBLE) {
          collapsibleIds.add(node.id);
        }
      }
      // Active states (pending, running, failed, blocked, queued) are never collapsed
    }
    if (collapsibleIds.size > 0) {
      topDisplayNodes = displayNodes.filter(n => !collapsibleIds.has(n.id));
      olderDisplayNodes = displayNodes.filter(n => collapsibleIds.has(n.id));
    }
  }

  // Compute dependency lane layouts for visible nodes
  // When expanded (or no collapsed nodes), use all displayNodes; when collapsed, use topDisplayNodes only
  const visibleNodes = showOlderNodes || olderDisplayNodes.length === 0 ? displayNodes : topDisplayNodes;
  const depLayouts = computeDepLayout(blueprint.nodes, visibleNodes);

  return (
    <div className="animate-fade-in">
      <Link
        href={blueprintsBackHref}
        className="text-sm text-text-muted hover:text-text-secondary transition-colors mb-4 inline-block"
      >
        &#8592; Back to Blueprints
      </Link>

      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2 min-w-0 overflow-hidden">
          <StatusIndicator status={blueprint.status} />
          {editingTitle ? (
            <input
              ref={titleRef}
              type="text"
              value={titleValue}
              onChange={(e) => setTitleValue(e.target.value)}
              onBlur={async () => {
                setEditingTitle(false);
                const trimmed = titleValue.trim();
                if (!trimmed || trimmed === blueprint.title) return;
                try {
                  const updated = await updateBlueprint(id, { title: trimmed });
                  setBlueprint(updated);
                } catch {
                  // revert on failure
                }
              }}
              onKeyDown={async (e) => {
                if (e.key === "Escape") {
                  setEditingTitle(false);
                  setTitleValue(blueprint.title);
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  (e.target as HTMLInputElement).blur();
                }
              }}
              readOnly={generating || enriching || reevaluating}
              className={`text-xl font-semibold min-w-0 flex-1 px-2 py-0.5 rounded-lg bg-bg-tertiary border border-accent-blue text-text-primary focus:outline-none ${generating || enriching || reevaluating ? "opacity-60 cursor-not-allowed" : ""}`}
            />
          ) : (
            <h1
              className={`text-xl font-semibold truncate min-w-0 flex-1 transition-colors ${generating || enriching || reevaluating ? "opacity-60 cursor-not-allowed" : "cursor-pointer hover:text-text-primary"}`}
              onClick={() => {
                if (generating || enriching || reevaluating) return;
                setTitleValue(blueprint.title);
                setEditingTitle(true);
                setTimeout(() => titleRef.current?.focus(), 0);
              }}
              title={generating || enriching || reevaluating ? "Editing disabled during AI operation" : "Click to edit"}
            >
              {blueprint.title}
            </h1>
          )}
          <span className="text-xs px-2 py-0.5 rounded-full bg-bg-tertiary text-text-muted capitalize flex-shrink-0">
            {blueprint.status === "running" ? "In Progress" : blueprint.status}
          </span>
          {blueprint.archivedAt && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-text-muted/10 text-text-muted flex-shrink-0">
              archived
            </span>
          )}
          {/* Archive/Unarchive button */}
          {blueprint.archivedAt ? (
            <button
              onClick={async () => {
                try {
                  const updated = await unarchiveBlueprintApi(id);
                  setBlueprint(updated);
                } catch { /* silently fail */ }
              }}
              className="p-1.5 rounded-lg text-text-muted hover:text-text-secondary hover:bg-bg-tertiary transition-all active:scale-[0.97] flex-shrink-0"
              aria-label="Unarchive blueprint"
              title="Unarchive"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="3" width="20" height="5" rx="1" />
                <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
                <path d="M12 12v6" />
                <path d="M9 15l3-3 3 3" />
              </svg>
            </button>
          ) : (
            <button
              onClick={async () => {
                try {
                  const updated = await archiveBlueprintApi(id);
                  setBlueprint(updated);
                } catch { /* silently fail */ }
              }}
              className="p-1.5 rounded-lg text-text-muted hover:text-text-secondary hover:bg-bg-tertiary transition-all active:scale-[0.97] flex-shrink-0"
              aria-label="Archive blueprint"
              title="Archive"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="3" width="20" height="5" rx="1" />
                <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
                <path d="M10 12h4" />
              </svg>
            </button>
          )}
        </div>
        {editingDesc ? (
          <textarea
            ref={descRef}
            value={descValue}
            onChange={(e) => setDescValue(e.target.value)}
            onBlur={async () => {
              setEditingDesc(false);
              if (descValue !== (blueprint.description || "")) {
                try {
                  const updated = await updateBlueprint(id, { description: descValue });
                  setBlueprint(updated);
                } catch {
                  // revert
                }
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setEditingDesc(false);
                setDescValue(blueprint.description || "");
              }
            }}
            readOnly={generating || enriching || reevaluating}
            className={`w-full text-sm px-3 py-2 rounded-lg bg-bg-tertiary border border-accent-blue text-text-primary placeholder:text-text-muted focus:outline-none resize-y min-h-[60px] mb-3 ${generating || enriching || reevaluating ? "opacity-60 cursor-not-allowed" : ""}`}
            rows={2}
          />
        ) : (
          <div
            className={`text-sm mb-3 transition-colors ${generating || enriching || reevaluating ? "opacity-60 cursor-not-allowed" : "cursor-pointer hover:text-text-primary"}`}
            onClick={() => {
              if (generating || enriching || reevaluating) return;
              setDescValue(blueprint.description || "");
              setEditingDesc(true);
              setTimeout(() => descRef.current?.focus(), 0);
            }}
            title={generating || enriching || reevaluating ? "Editing disabled during AI operation" : "Click to edit"}
          >
            {blueprint.description ? (
              <MarkdownContent content={blueprint.description} maxHeight="200px" />
            ) : (
              <p className="text-text-muted italic">Click to add description...</p>
            )}
          </div>
        )}
        {blueprint.projectCwd && (
          <p className="text-xs text-text-muted font-mono mb-3 truncate">
            {blueprint.projectCwd}
          </p>
        )}

        {/* Generate instruction + action buttons */}
        <div className="flex flex-col sm:flex-row gap-2 sm:items-start">
          <div className="flex-1 min-w-0">
            <textarea
              rows={2}
              value={generateInstruction}
              onChange={(e) => setGenerateInstruction(e.target.value)}
              readOnly={generating}
              placeholder="Optional: describe what to generate or change (e.g. 'add auth support', 'focus on testing')... Press Cmd+Enter to generate"
              className={`w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-primary text-text-primary text-sm placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent-purple resize-y max-h-32 overflow-y-auto ${generating ? "opacity-60 cursor-not-allowed" : ""}`}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  if (!generating) handleGenerate();
                }
              }}
            />
          </div>
          <div className="flex gap-2 flex-wrap">
            {blueprint.status === "draft" && (
              <button
                onClick={handleApprove}
                disabled={approving}
                title="Mark this blueprint as approved and ready for execution"
                className="px-4 py-2 rounded-lg bg-accent-blue text-white text-sm font-medium hover:bg-accent-blue/90 transition-all active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
              >
                {approving ? "Approving..." : "Approve Plan"}
              </button>
            )}
            {confirmingRegenerate ? (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-accent-purple/40 bg-accent-purple/10 animate-fade-in">
                <span className="text-xs text-accent-purple whitespace-nowrap">Regenerate nodes?</span>
                <button
                  onClick={() => handleGenerate(true)}
                  className="px-2.5 py-1 rounded-md bg-accent-purple text-white text-xs font-medium hover:bg-accent-purple/90 active:scale-[0.98] transition-all"
                >
                  Yes
                </button>
                <button
                  onClick={() => setConfirmingRegenerate(false)}
                  className="px-2.5 py-1 rounded-md border border-border-primary text-text-secondary text-xs hover:bg-bg-tertiary active:scale-[0.98] transition-all"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => handleGenerate()}
                disabled={generating}
                title={generating ? "AI is generating task nodes..." : "Use AI to decompose the blueprint into executable task nodes"}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-all active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2 whitespace-nowrap ${
                  blueprint.nodes.length === 0
                    ? "bg-accent-purple text-white hover:bg-accent-purple/90"
                    : "border border-accent-purple text-accent-purple hover:bg-accent-purple/10"
                }`}
              >
                {generating ? (
                  <>
                    <AISparkle size="sm" />
                    Generating...
                  </>
                ) : (
                  "Generate Nodes"
                )}
              </button>
            )}
            {blueprint.nodes.some((n) => n.status !== "done" && n.status !== "running" && n.status !== "queued") && (
              confirmingReevaluate ? (
                <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-accent-blue/40 bg-accent-blue/10 animate-fade-in">
                  <span className="text-xs text-accent-blue whitespace-nowrap">Reevaluate all nodes?</span>
                  <button
                    onClick={handleReevaluateAll}
                    className="px-2.5 py-1 rounded-md bg-accent-blue text-white text-xs font-medium hover:bg-accent-blue/90 active:scale-[0.98] transition-all"
                  >
                    Yes
                  </button>
                  <button
                    onClick={() => setConfirmingReevaluate(false)}
                    className="px-2.5 py-1 rounded-md border border-border-primary text-text-secondary text-xs hover:bg-bg-tertiary active:scale-[0.98] transition-all"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={handleReevaluateAll}
                  disabled={isRunning || reevaluating || generateCooldown}
                  title={generateCooldown ? "Please wait a moment after generating nodes" : reevaluating || pendingTasks.some((t) => t.type === "reevaluate") ? "AI is re-evaluating all nodes..." : isRunning ? "Cannot reevaluate while nodes are running" : "AI reads your codebase and updates all node titles, descriptions, and statuses"}
                  className="px-4 py-2 rounded-lg border border-accent-blue text-accent-blue text-sm font-medium hover:bg-accent-blue/10 transition-all active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2 whitespace-nowrap"
                >
                  {reevaluating || pendingTasks.some((t) => t.type === "reevaluate") ? (
                    <>
                      <AISparkle size="sm" />
                      Reevaluating...
                    </>
                  ) : (
                    <>
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 2v6h-6" /><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M3 22v-6h6" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
                      </svg>
                      Reevaluate
                    </>
                  )}
                </button>
              )
            )}
            {canRunAll && (
              <button
                onClick={handleRunAll}
                disabled={isRunning}
                title={isRunning ? "AI is executing nodes — check progress in the node cards below" : "Execute all pending nodes in dependency order using Claude Code"}
                className="px-4 py-2 rounded-lg bg-accent-green text-white text-sm font-medium hover:bg-accent-green/90 transition-all active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2 whitespace-nowrap"
              >
                {isRunning ? (
                  <>
                    <AISparkle size="sm" />
                    Running...
                  </>
                ) : (
                  <>
                    <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M4 2l10 6-10 6V2z" />
                    </svg>
                    Run All
                  </>
                )}
              </button>
            )}
          </div>
        </div>
        {/* Generation progress banner */}
        {isGeneratingTask && (
          <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-accent-purple/10 border border-accent-purple/30">
            <AISparkle size="sm" className="text-accent-purple flex-shrink-0" />
            <span className="text-sm text-accent-purple">
              Generating nodes...
              {newNodeCount > 0
                ? ` ${newNodeCount} new node${newNodeCount !== 1 ? "s" : ""} created so far.`
                : " New nodes will appear as they\u2019re created."}
            </span>
          </div>
        )}
      </div>

      {error && (
        <div className="text-sm text-accent-red bg-accent-red/10 rounded-lg p-3 mb-4">
          {error}
        </div>
      )}

      {/* Add Node */}
      <div className="mb-4">
        {showAddNode ? (
          <form
            onSubmit={handleAddNode}
            className="rounded-xl border border-border-primary bg-bg-secondary p-4 space-y-3"
          >
            <input
              type="text"
              value={nodeTitle}
              onChange={(e) => setNodeTitle(e.target.value)}
              placeholder="Node title"
              readOnly={enriching}
              className={`w-full px-3 py-2 rounded-lg bg-bg-tertiary border border-border-primary text-text-primary placeholder:text-text-muted text-sm focus:outline-none focus:border-accent-blue focus:ring-1 focus:ring-accent-blue/30${enriching ? " opacity-60 cursor-not-allowed" : ""}`}
              autoFocus
              required
            />
            <MarkdownEditor
              value={nodeDescription}
              onChange={setNodeDescription}
              placeholder="Description (supports Markdown and image paste)"
              disabled={enriching}
            />
            {/* Dependency picker */}
            {blueprint.nodes.length > 0 && (
              <div>
                <button
                  type="button"
                  onClick={() => setDepsExpanded((v) => !v)}
                  className="flex items-center gap-1 text-xs text-text-muted mb-1 hover:text-text-secondary transition-colors"
                >
                  <span className={`transition-transform ${depsExpanded ? "rotate-90" : ""}`}>▶</span>
                  Dependencies{nodeDeps.length > 0 && <span className="text-accent-blue ml-1">({nodeDeps.length} selected)</span>}
                </button>
                <div className={`flex gap-1.5 ${depsExpanded ? "flex-wrap" : "overflow-hidden max-h-[28px]"}`}>
                  {[...blueprint.nodes].sort((a, b) => {
                    const aSelected = nodeDeps.includes(a.id) ? 0 : 1;
                    const bSelected = nodeDeps.includes(b.id) ? 0 : 1;
                    if (aSelected !== bSelected) return aSelected - bSelected;
                    return b.order - a.order;
                  }).map((n) => (
                    <button
                      key={n.id}
                      type="button"
                      onClick={() =>
                        setNodeDeps((prev) =>
                          prev.includes(n.id) ? prev.filter((d) => d !== n.id) : [...prev, n.id]
                        )
                      }
                      className={`flex-shrink-0 px-2 py-1 rounded-md text-xs border transition-colors ${
                        nodeDeps.includes(n.id)
                          ? "border-accent-blue bg-accent-blue/20 text-accent-blue"
                          : "border-border-primary text-text-muted hover:border-border-hover"
                      }`}
                    >
                      #{n.order + 1} {n.title.length > 30 ? n.title.slice(0, 30) + "…" : n.title}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="flex gap-2 flex-wrap">
              <button
                type="submit"
                disabled={!nodeTitle.trim() || addingNode}
                className="px-3 py-1.5 rounded-lg bg-accent-blue text-white text-sm hover:bg-accent-blue/90 transition-all active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {addingNode ? "Adding..." : "Add Node"}
              </button>
              <button
                type="button"
                disabled={!nodeTitle.trim() || enriching}
                onClick={handleSmartCreate}
                className="inline-flex items-center gap-1 whitespace-nowrap px-3 py-1.5 rounded-lg bg-accent-purple text-white text-sm hover:bg-accent-purple/90 transition-all active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {enriching ? (<><AISparkle size="xs" /> Enrich</>) : (<><AISparkle size="xs" className="opacity-70" /> Smart Create</>)}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowAddNode(false);
                  setNodeTitle("");
                  setNodeDescription("");
                  setNodeDeps([]);
                }}
                className="px-3 py-1.5 rounded-lg border border-border-primary text-text-secondary text-sm hover:bg-bg-tertiary transition-colors"
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <button
            onClick={() => setShowAddNode(true)}
            className="w-full py-3 rounded-xl border border-dashed border-border-primary text-text-muted text-sm hover:border-border-hover hover:text-text-secondary hover:bg-bg-secondary transition-all active:scale-[0.99]"
          >
            + Add Node
          </button>
        )}
      </div>

      {/* Node chain */}
      {blueprint.nodes.length === 0 ? (
        <div className="text-center py-12 text-text-muted border border-dashed border-border-primary rounded-xl">
          <p className="mb-1">No nodes yet.</p>
          <p className="text-sm">Add your first task node to this blueprint.</p>
        </div>
      ) : (
        <div>
          <div className="flex items-center justify-between mb-3 gap-2">
            <span className="text-xs text-text-muted flex-shrink-0">
              {statusFilter === "all"
                ? `${blueprint.nodes.length} node${blueprint.nodes.length !== 1 ? "s" : ""}`
                : `${filteredNodes.length}/${blueprint.nodes.length} nodes`}
            </span>
            <div className="flex items-center gap-1.5 flex-wrap justify-end">
              {(["all", "pending", "queued", "running", "done", "failed", "blocked", "skipped"] as const).map((s) => {
                const count = s === "all" ? blueprint.nodes.length : blueprint.nodes.filter((n) => n.status === s).length;
                if (s !== "all" && count === 0) return null;
                const isActive = statusFilter === s;
                const colorMap: Record<string, string> = {
                  all: isActive ? "bg-bg-tertiary text-text-primary border-border-hover" : "",
                  pending: isActive ? "bg-text-muted/20 text-text-secondary border-text-muted/40" : "",
                  queued: isActive ? "bg-accent-amber/20 text-accent-amber border-accent-amber/40" : "",
                  running: isActive ? "bg-accent-blue/20 text-accent-blue border-accent-blue/40" : "",
                  done: isActive ? "bg-accent-green/20 text-accent-green border-accent-green/40" : "",
                  failed: isActive ? "bg-accent-red/20 text-accent-red border-accent-red/40" : "",
                  blocked: isActive ? "bg-accent-amber/20 text-accent-amber border-accent-amber/40" : "",
                  skipped: isActive ? "bg-text-muted/10 text-text-muted border-text-muted/30" : "",
                };
                return (
                  <button
                    key={s}
                    onClick={() => setStatusFilter(s)}
                    className={`px-2 py-1.5 sm:py-0.5 rounded-full text-[11px] border transition-all active:scale-[0.96] capitalize ${
                      isActive
                        ? colorMap[s]
                        : "border-transparent text-text-muted hover:text-text-secondary hover:bg-bg-tertiary/50"
                    }`}
                  >
                    {s === "all" ? "All" : s}{s !== "all" && ` ${count}`}
                  </button>
                );
              })}
              <span className="w-px h-4 bg-border-primary mx-0.5" />
              <button
                onClick={() => setSmartSort((v) => !v)}
                className={`flex items-center gap-1.5 px-2.5 py-2 sm:py-1 rounded-lg text-xs transition-all active:scale-[0.97] ${
                  smartSort
                    ? "bg-accent-purple/15 border border-accent-purple/40 text-accent-purple"
                    : "bg-bg-secondary border border-border-primary text-text-muted hover:text-text-secondary hover:border-border-hover"
                }`}
                title="Group by status: active nodes first, completed last"
                aria-label="Toggle smart sort"
              >
                Smart Sort
              </button>
              {!smartSort && (
                <button
                  onClick={() => setReverseOrder((v) => !v)}
                  aria-label="Toggle sort order"
                  className="flex items-center gap-1.5 px-2.5 py-2 sm:py-1 rounded-lg bg-bg-secondary border border-border-primary text-text-muted text-xs hover:text-text-secondary hover:border-border-hover transition-all active:scale-[0.97]"
                >
                  <svg className={`w-3 h-3 transition-transform ${reverseOrder ? "" : "rotate-180"}`} viewBox="0 0 16 16" fill="currentColor">
                    <path d="M8 4a.5.5 0 0 1 .5.5v5.793l2.146-2.147a.5.5 0 0 1 .708.708l-3 3a.5.5 0 0 1-.708 0l-3-3a.5.5 0 1 1 .708-.708L7.5 10.293V4.5A.5.5 0 0 1 8 4z" />
                  </svg>
                  {reverseOrder ? "Newest first" : "Oldest first"}
                </button>
              )}
              <span className="w-px h-4 bg-border-primary mx-0.5" />
              <button
                onClick={() => setAutoRefresh((v) => !v)}
                className={`relative flex items-center gap-1 p-2.5 sm:p-1.5 rounded-lg text-xs transition-colors ${
                  autoRefresh
                    ? "text-accent-blue hover:text-accent-blue/80"
                    : "text-text-muted/40 hover:text-text-muted/60"
                }`}
                title={autoRefresh ? "Auto-refresh on (click to disable)" : "Auto-refresh off (click to enable)"}
                aria-label="Toggle auto-refresh"
              >
                <svg
                  className={`w-3.5 h-3.5 ${shouldPoll ? "animate-spin" : ""}`}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 12a9 9 0 1 1-9-9" />
                  <polyline points="21 3 21 9 15 9" />
                </svg>
                {!autoRefresh && (
                  <span className="absolute inset-0 flex items-center justify-center">
                    <span className="block w-[18px] h-[2px] bg-text-muted/60 rotate-45 rounded" />
                  </span>
                )}
              </button>
            </div>
          </div>
          {filteredNodes.length === 0 && statusFilter !== "all" && (
            <div className="text-center py-8 text-text-muted text-sm border border-dashed border-border-primary rounded-xl">
              No <span className="capitalize">{statusFilter}</span> nodes.{" "}
              <button
                onClick={() => setStatusFilter("all")}
                className="text-accent-blue hover:underline"
              >
                Show all
              </button>
            </div>
          )}
          {showOlderNodes || olderDisplayNodes.length === 0 ? (
            <>
              {(() => {
                const olderIds = new Set(olderDisplayNodes.map(n => n.id));
                let collapseButtonRendered = false;
                return displayNodes.map((node, displayIdx) => {
                  const originalIndex = blueprint.nodes.indexOf(node);
                  const isOlder = olderIds.has(node.id);
                  const showCollapseButton = !collapseButtonRendered && isOlder && olderDisplayNodes.length > 0;
                  if (showCollapseButton) collapseButtonRendered = true;
                  return (
                    <Fragment key={node.id}>
                      {showCollapseButton && (
                        <button
                          onClick={() => setShowOlderNodes(false)}
                          aria-expanded={true}
                          className="flex items-center gap-2 w-full text-left py-2 px-3 my-1 rounded-lg hover:bg-bg-secondary/50 transition-colors"
                        >
                          <svg className="w-3 h-3 text-text-muted" viewBox="0 0 16 16" fill="currentColor">
                          <path d="M4.427 7.427l3.396 3.396a.25.25 0 00.354 0l3.396-3.396A.25.25 0 0011.396 7H4.604a.25.25 0 00-.177.427z" />
                        </svg>
                          <span className="text-xs font-medium text-text-secondary">
                            Collapse {olderDisplayNodes.length} completed nodes
                          </span>
                        </button>
                      )}
                      <div className={newNodeIds.has(node.id) ? "animate-node-appear" : ""}>
                        <MacroNodeCard
                          node={node}
                          pendingTasks={pendingTasks}
                          index={originalIndex}
                          total={blueprint.nodes.length}
                          blueprintId={blueprint.id}
                          onRefresh={handleRefresh}
                          onNodeUpdated={handleRefresh}
                          onNodeDeleted={handleRefresh}
                          defaultExpanded={false}
                          isLastDisplayed={displayIdx === displayNodes.length - 1}
                          depLanes={depLayouts[displayIdx]}
                        />
                      </div>
                    </Fragment>
                  );
                });
              })()}
            </>
          ) : (
            <>
              {topDisplayNodes.map((node, displayIdx) => {
                const originalIndex = blueprint.nodes.indexOf(node);
                return (
                  <div key={node.id} className={newNodeIds.has(node.id) ? "animate-node-appear" : ""}>
                    <MacroNodeCard
                      node={node}
                      pendingTasks={pendingTasks}
                      index={originalIndex}
                      total={blueprint.nodes.length}
                      blueprintId={blueprint.id}
                      onRefresh={handleRefresh}
                      onNodeUpdated={handleRefresh}
                      onNodeDeleted={handleRefresh}
                      defaultExpanded={false}
                      isLastDisplayed={displayIdx === topDisplayNodes.length - 1}
                      depLanes={depLayouts[displayIdx]}
                    />
                  </div>
                );
              })}
              <button
                onClick={() => setShowOlderNodes(true)}
                aria-expanded={false}
                className="flex items-center gap-2 w-full text-left py-2 px-3 my-1 rounded-lg hover:bg-bg-secondary/50 transition-colors"
              >
                <svg className="w-3 h-3 text-text-muted" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M6.427 4.427l3.396 3.396a.25.25 0 010 .354l-3.396 3.396A.25.25 0 016 11.396V4.604a.25.25 0 01.427-.177z" />
                </svg>
                <span className="text-xs font-medium text-text-secondary">
                  {olderDisplayNodes.length} completed nodes
                </span>
                <span className="text-xs text-text-muted bg-bg-tertiary px-2 py-0.5 rounded">
                  {olderDisplayNodes.filter((n) => n.status === "done").length} done
                  {olderDisplayNodes.some((n) => n.status === "skipped") &&
                    `, ${olderDisplayNodes.filter((n) => n.status === "skipped").length} skipped`}
                </span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
