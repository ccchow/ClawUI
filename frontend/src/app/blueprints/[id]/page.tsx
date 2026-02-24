"use client";

import { useState, useEffect, useCallback, useRef, Fragment } from "react";
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
} from "@/lib/api";
import { StatusIndicator } from "@/components/StatusIndicator";
import { MacroNodeCard } from "@/components/MacroNodeCard";
import { MarkdownEditor } from "@/components/MarkdownEditor";
import { AISparkle } from "@/components/AISparkle";
import { computeDepLayout } from "@/components/DependencyGraph";

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

  const [reverseOrder, setReverseOrder] = useState(true);
  const [smartSort, setSmartSort] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [statusFilter, setStatusFilter] = useState<MacroNodeStatus | "all">("all");
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
    if (!skipConfirm) {
      const hasNodes = blueprint && blueprint.nodes.length > 0;
      const msg = hasNodes
        ? "This will regenerate nodes using Claude Code (may take 1-3 minutes). Existing pending nodes may be updated or removed. Continue?"
        : "This will generate task nodes using Claude Code (may take 1-3 minutes). Continue?";
      if (!window.confirm(msg)) return;
    }

    setGenerating(true);
    setError(null);
    try {
      await generatePlan(id, generateInstruction.trim() || undefined);
      setGenerateInstruction("");
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
    const nodeCount = blueprint?.nodes.filter(n => n.status !== "done" && n.status !== "running" && n.status !== "queued").length ?? 0;
    if (!window.confirm(
      `This will launch a Claude Code session to reevaluate ${nodeCount} node${nodeCount !== 1 ? "s" : ""} (may take several minutes). Continue?`
    )) return;

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

  if (loading) {
    return (
      <div className="text-center py-16 text-text-muted">
        Loading blueprint...
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

  let displayNodes: typeof filteredNodes;
  if (smartSort && statusFilter === "all") {
    // Smart sort: group by status priority, maintain order within each group
    displayNodes = [...filteredNodes].sort((a, b) => {
      const priorityDiff = statusPriority[a.status] - statusPriority[b.status];
      if (priorityDiff !== 0) return priorityDiff;
      return b.order - a.order;
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
    <div>
      <Link
        href="/blueprints"
        className="text-sm text-text-muted hover:text-text-secondary transition-colors mb-4 inline-block"
      >
        &#8592; Back to Blueprints
      </Link>

      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2 min-w-0 overflow-hidden">
          <StatusIndicator status={blueprint.status} />
          <h1 className="text-xl font-semibold truncate min-w-0 flex-1">{blueprint.title}</h1>
          <span className="text-xs px-2 py-0.5 rounded-full bg-bg-tertiary text-text-muted capitalize flex-shrink-0">
            {blueprint.status === "running" ? "In Progress" : blueprint.status}
          </span>
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
            className="w-full text-sm px-3 py-2 rounded-lg bg-bg-tertiary border border-accent-blue text-text-primary placeholder:text-text-muted focus:outline-none resize-y min-h-[60px] mb-3"
            rows={2}
          />
        ) : (
          <p
            className="text-sm text-text-secondary mb-3 cursor-pointer hover:text-text-primary transition-colors"
            onClick={() => {
              setDescValue(blueprint.description || "");
              setEditingDesc(true);
              setTimeout(() => descRef.current?.focus(), 0);
            }}
            title="Click to edit"
          >
            {blueprint.description || <span className="text-text-muted italic">Click to add description...</span>}
          </p>
        )}
        {blueprint.projectCwd && (
          <p className="text-xs text-text-muted font-mono mb-3 truncate">
            {blueprint.projectCwd}
          </p>
        )}

        {/* Generate instruction + action buttons */}
        <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
          <div className="flex-1 min-w-0">
            <input
              type="text"
              value={generateInstruction}
              onChange={(e) => setGenerateInstruction(e.target.value)}
              placeholder="Optional: describe what to generate or change (e.g. 'add auth support', 'focus on testing')..."
              className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-primary text-text-primary text-sm placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent-purple"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
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
                className="px-4 py-2 rounded-lg bg-accent-blue text-white text-sm font-medium hover:bg-accent-blue/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
              >
                {approving ? "Approving..." : "Approve Plan"}
              </button>
            )}
            <button
              onClick={() => handleGenerate()}
              disabled={generating}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 whitespace-nowrap ${
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
            {blueprint.nodes.some((n) => n.status !== "done" && n.status !== "running" && n.status !== "queued") && (
              <button
                onClick={handleReevaluateAll}
                disabled={isRunning || reevaluating || generateCooldown}
                title={generateCooldown ? "Please wait a moment after generating nodes" : undefined}
                className="px-4 py-2 rounded-lg border border-accent-blue text-accent-blue text-sm font-medium hover:bg-accent-blue/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 whitespace-nowrap"
              >
                {reevaluating || pendingTasks.some((t) => t.type === "reevaluate") ? (
                  <>
                    <AISparkle size="sm" />
                    Reevaluating...
                  </>
                ) : (
                  <>&#x1F504; Reevaluate</>
                )}
              </button>
            )}
            {canRunAll && (
              <button
                onClick={handleRunAll}
                disabled={isRunning}
                className="px-4 py-2 rounded-lg bg-accent-green text-white text-sm font-medium hover:bg-accent-green/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 whitespace-nowrap"
              >
                {isRunning ? (
                  <>
                    <AISparkle size="sm" />
                    Running...
                  </>
                ) : (
                  <>&#9654; Run All</>
                )}
              </button>
            )}
          </div>
        </div>
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
              className="w-full px-3 py-2 rounded-lg bg-bg-tertiary border border-border-primary text-text-primary placeholder:text-text-muted text-sm focus:outline-none focus:border-accent-blue focus:ring-1 focus:ring-accent-blue/30"
              autoFocus
              required
            />
            <MarkdownEditor
              value={nodeDescription}
              onChange={setNodeDescription}
              placeholder="Description (supports Markdown and image paste)"
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
                className="px-3 py-1.5 rounded-lg bg-accent-blue text-white text-sm hover:bg-accent-blue/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {addingNode ? "Adding..." : "Add Node"}
              </button>
              <button
                type="button"
                disabled={!nodeTitle.trim() || enriching}
                onClick={handleSmartCreate}
                className="px-3 py-1.5 rounded-lg bg-accent-purple text-white text-sm hover:bg-accent-purple/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {enriching ? (<><AISparkle size="xs" /> Enriching...</>) : "✨ Smart Create"}
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
            className="w-full py-3 rounded-xl border border-dashed border-border-primary text-text-muted text-sm hover:border-border-hover hover:text-text-secondary hover:bg-bg-secondary transition-all"
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
                    className={`px-2 py-0.5 rounded-full text-[11px] border transition-colors capitalize ${
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
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs transition-colors ${
                  smartSort
                    ? "bg-accent-purple/15 border border-accent-purple/40 text-accent-purple"
                    : "bg-bg-secondary border border-border-primary text-text-muted hover:text-text-secondary hover:border-border-hover"
                }`}
                title="Group by status: active nodes first, completed last"
              >
                Smart Sort
              </button>
              {!smartSort && (
                <button
                  onClick={() => setReverseOrder((v) => !v)}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-bg-secondary border border-border-primary text-text-muted text-xs hover:text-text-secondary hover:border-border-hover transition-colors"
                >
                  <span className="text-sm">{reverseOrder ? "\u2193" : "\u2191"}</span>
                  {reverseOrder ? "Newest first" : "Oldest first"}
                </button>
              )}
              <span className="w-px h-4 bg-border-primary mx-0.5" />
              <button
                onClick={() => setAutoRefresh((v) => !v)}
                className={`relative flex items-center gap-1 p-1.5 rounded-lg text-xs transition-colors ${
                  autoRefresh
                    ? "text-accent-blue hover:text-accent-blue/80"
                    : "text-text-muted/40 hover:text-text-muted/60"
                }`}
                title={autoRefresh ? "Auto-refresh on (click to disable)" : "Auto-refresh off (click to enable)"}
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
                          className="flex items-center gap-2 w-full text-left py-2 px-3 my-1 rounded-lg hover:bg-bg-secondary/50 transition-colors"
                        >
                          <span className="text-xs text-text-muted font-mono">▼</span>
                          <span className="text-xs font-medium text-text-secondary">
                            Collapse {olderDisplayNodes.length} completed nodes
                          </span>
                        </button>
                      )}
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
                  <MacroNodeCard
                    key={node.id}
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
                );
              })}
              <button
                onClick={() => setShowOlderNodes(true)}
                className="flex items-center gap-2 w-full text-left py-2 px-3 my-1 rounded-lg hover:bg-bg-secondary/50 transition-colors"
              >
                <span className="text-xs text-text-muted font-mono">▶</span>
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
