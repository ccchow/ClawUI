"use client";

import { useState, useEffect, useCallback, useRef, useMemo, Fragment } from "react";
import { useParams, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  type MacroNodeStatus,
  type ConveneSession,
  type ConveneMessage,
  type BatchCreateNode,
  type RoleInfo,
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
  starBlueprint as starBlueprintApi,
  unstarBlueprint as unstarBlueprintApi,
  markInsightRead as markInsightReadApi,
  markAllInsightsRead as markAllInsightsReadApi,
  dismissInsight as dismissInsightApi,
  coordinateBlueprint,
  getConveneSessionDetail,
  startConveneSession,
  approveConveneSession,
  cancelConveneSession,
  fetchRoles,
} from "@/lib/api";
import { useBlueprintDetailQueries, blueprintKeys } from "@/lib/useBlueprintDetailQueries";
import { AgentBadge } from "@/components/AgentSelector";
import { RoleSelector } from "@/components/RoleSelector";
import { ROLE_COLORS, ROLE_FALLBACK_COLORS } from "@/components/role-colors";
import { StatusIndicator } from "@/components/StatusIndicator";
import { MacroNodeCard } from "@/components/MacroNodeCard";
import { MarkdownContent } from "@/components/MarkdownContent";
import { MarkdownEditor } from "@/components/MarkdownEditor";
import { AISparkle } from "@/components/AISparkle";
import { computeDepLayout } from "@/components/DependencyGraph";
import { SkeletonLoader } from "@/components/SkeletonLoader";
import { useToast } from "@/components/Toast";
import { ConfirmationStrip } from "@/components/ConfirmationStrip";
import { AutopilotToggle } from "@/components/AutopilotToggle";
import { BlueprintChat } from "@/components/BlueprintChat";
import { useBlueprintBroadcast } from "@/lib/useBlueprintBroadcast";

/** Strip markdown formatting for plain-text preview (best-effort, line-clamp handles overflow) */
function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")       // fenced code blocks
    .replace(/`([^`]+)`/g, "$1")            // inline code
    .replace(/^#{1,6}\s+/gm, "")            // headings
    .replace(/(\*\*|__)(.*?)\1/g, "$2")     // bold
    .replace(/(\*|_)(.*?)\1/g, "$2")        // italic
    .replace(/^>\s?/gm, "")                 // blockquotes
    .replace(/^[-*+]\s+/gm, "")            // list markers
    .replace(/^\d+\.\s+/gm, "")            // ordered list markers
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links (keep text)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // images (keep alt)
    .replace(/\s+/g, " ")                   // collapse whitespace
    .trim();
}

export default function BlueprintDetailPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const id = params.id as string;

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

  // Fetch all registered roles for convene form
  useEffect(() => {
    fetchRoles().then(setAllRoles).catch(() => {});
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

  const handleNodeSearchInput = useCallback((value: string) => {
    setNodeSearchInput(value);
    if (nodeSearchTimerRef.current) clearTimeout(nodeSearchTimerRef.current);
    nodeSearchTimerRef.current = setTimeout(() => {
      setNodeSearchQuery(value.trim().toLowerCase());
    }, 300);
  }, []);

  // Cleanup node search debounce timer
  useEffect(() => {
    return () => { if (nodeSearchTimerRef.current) clearTimeout(nodeSearchTimerRef.current); };
  }, []);
  const [nodeSearchInput, setNodeSearchInput] = useState("");
  const [nodeSearchQuery, setNodeSearchQuery] = useState("");
  const nodeSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showOlderNodes, setShowOlderNodes] = useState(false);
  const [approving, setApproving] = useState(false);
  const [runningAll, setRunningAll] = useState(false);
  const [reevaluating, setReevaluating] = useState(false);
  const [insightsOpen, setInsightsOpen] = useState(false);
  const insightsAutoOpenedRef = useRef(false);
  const [showDismissed, setShowDismissed] = useState(false);

  // Convene state
  const [discussionsOpen, setDiscussionsOpen] = useState(true);
  const [showConveneForm, setShowConveneForm] = useState(false);
  const [conveneTopic, setConveneTopic] = useState("");
  const [conveneRoles, setConveneRoles] = useState<string[]>([]);
  const [allRoles, setAllRoles] = useState<RoleInfo[]>([]);
  const [conveneContextNodes, setConveneContextNodes] = useState<string[]>([]);
  const [conveneMaxRounds, setConveneMaxRounds] = useState(3);
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null);
  const [sessionDetail, setSessionDetail] = useState<(ConveneSession & { messages: ConveneMessage[] }) | null>(null);
  const [confirmingDiscard, setConfirmingDiscard] = useState<string | null>(null);
  const [expandedMsgIds, setExpandedMsgIds] = useState<Set<string>>(new Set());
  const [confirmingRunAll, setConfirmingRunAll] = useState(false);
  const [confirmingStatusReset, setConfirmingStatusReset] = useState(false);
  const [confirmingStatusTransition, setConfirmingStatusTransition] = useState<string | null>(null);

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

  const { showToast } = useToast();

  // TanStack Query: blueprint, queue, insights, convene — with coordinated polling
  const {
    blueprint, pendingTasks, insights, conveneSessions,
    loading, error: queryError,
    invalidateAll, setBlueprint, setInsights, setConveneSessions, queryClient,
  } = useBlueprintDetailQueries(id, autoRefresh);

  // Local error state for mutation errors (separate from query error)
  const [mutationError, setMutationError] = useState<string | null>(null);
  const error = queryError || mutationError;

  // Cross-tab sync: when another tab fires an operation on this blueprint,
  // immediately invalidate all queries so polling picks up changes.
  const broadcastOperation = useBlueprintBroadcast(id, () => {
    invalidateAll();
  });

  // Dynamic browser tab title
  useEffect(() => {
    if (blueprint?.title) {
      document.title = `${blueprint.title} — ClawUI`;
    }
    return () => { document.title = "ClawUI — Agent Session Viewer"; };
  }, [blueprint?.title]);

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
      if (results.some((r) => r.recovered)) invalidateAll();
    });
  }, [blueprint, id, invalidateAll]);

  // Auto-generate nodes if ?generate=true (fire-and-forget on new blueprint)
  useEffect(() => {
    if (
      searchParams.get("generate") === "true" &&
      !autoGenerateTriggered.current &&
      blueprint &&
      blueprint.nodes.length === 0 &&
      !generating
    ) {
      autoGenerateTriggered.current = true;
      setGenerating(true);
      setMutationError(null);
      preGenerateNodeIdsRef.current = new Set();
      setNewNodeIds(new Set());
      generatePlan(id)
        .then(() => { broadcastOperation("generate"); invalidateAll(); })
        .catch((err) => setMutationError(err instanceof Error ? err.message : String(err)))
        .finally(() => setGenerating(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally only triggered by blueprint/searchParams changes; autoGenerateTriggered ref guards against double execution
  }, [blueprint, searchParams]);

  // Derived state (used by JSX and below effects)
  const anyNodeRunning = blueprint?.nodes.some(n => n.status === "running") ?? false;
  const anyNodeQueued = blueprint?.nodes.some(n => n.status === "queued") ?? false;
  const hasPendingTasks = pendingTasks.length > 0;
  const activeConvene = conveneSessions.some(s => s.status === "active" || s.status === "synthesizing");
  const isPolling = autoRefresh && (blueprint?.status === "running" || anyNodeRunning || anyNodeQueued || hasPendingTasks);

  // Track newly created nodes during generation (reads TanStack Query data reactively)
  useEffect(() => {
    if (!preGenerateNodeIdsRef.current || !blueprint) return;
    const freshIds = blueprint.nodes
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
    const isGenerating = pendingTasks.some(t => t.type === "generate");
    if (!isGenerating) {
      preGenerateNodeIdsRef.current = null;
      setTimeout(() => setNewNodeIds(new Set()), 3000);
    }
  }, [blueprint, pendingTasks]);

  // Clear runningAll when no more activity
  useEffect(() => {
    if (!runningAll) return;
    const stillActive = blueprint?.status === "running"
      || anyNodeRunning || anyNodeQueued || hasPendingTasks;
    if (!stillActive) setRunningAll(false);
  }, [blueprint?.status, anyNodeRunning, anyNodeQueued, hasPendingTasks, runningAll]);

  // Fast-poll expanded convene session detail during active discussions (2s)
  // to stream new round messages as they arrive.
  const expandedSession = conveneSessions.find(s => s.id === expandedSessionId);
  const expandedSessionActive = expandedSession?.status === "active" || expandedSession?.status === "synthesizing";
  useEffect(() => {
    if (!expandedSessionId || !expandedSessionActive) return;
    const interval = setInterval(async () => {
      if (document.hidden) return;
      try {
        const detail = await getConveneSessionDetail(id, expandedSessionId);
        setSessionDetail(detail);
        // Also update the session in the list so status badge refreshes
        setConveneSessions(prev => prev.map(s => s.id === detail.id ? { ...s, status: detail.status, messageCount: detail.messages.length, synthesisResult: detail.synthesisResult } : s));
      } catch {
        // non-critical
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [expandedSessionId, expandedSessionActive, id, setConveneSessions]);

  // Auto-expand latest round messages for active convene sessions
  const sessionDetailMsgCount = sessionDetail?.messages.length ?? 0;
  const sessionDetailStatus = sessionDetail?.status;
  useEffect(() => {
    if (!sessionDetail || sessionDetailStatus !== "active" || sessionDetailMsgCount === 0) return;
    const msgs = sessionDetail.messages.filter(m => m.messageType !== "synthesis");
    if (msgs.length === 0) return;
    const maxRound = Math.max(...msgs.map(m => m.round));
    const latestRoundMsgIds = msgs.filter(m => m.round === maxRound).map(m => m.id);
    setExpandedMsgIds(prev => {
      const next = new Set(prev);
      let changed = false;
      for (const mid of latestRoundMsgIds) {
        if (!next.has(mid)) { next.add(mid); changed = true; }
      }
      return changed ? next : prev;
    });
  }, [sessionDetail, sessionDetailMsgCount, sessionDetailStatus]);

  const handleApprove = async () => {
    setApproving(true);
    try {
      const updated = await approveBlueprint(id);
      setBlueprint(updated);
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : String(err));
    } finally {
      setApproving(false);
    }
  };

  const handleReevaluateAll = async () => {
    setReevaluating(true);
    setMutationError(null);
    try {
      await reevaluateAllNodes(id);
      broadcastOperation("reevaluate_all");
      invalidateAll();
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : String(err));
    } finally {
      setReevaluating(false);
    }
  };

  const handleRunAll = async () => {
    if (!confirmingRunAll) {
      setConfirmingRunAll(true);
      return;
    }
    setConfirmingRunAll(false);
    setRunningAll(true);
    setMutationError(null);
    try {
      await runAllNodes(id);
      broadcastOperation("run_all");
      invalidateAll();
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : String(err));
      setRunningAll(false);
    }
  };

  const handleRefresh = () => {
    invalidateAll();
  };

  const handleCoordinate = async () => {
    setMutationError(null);
    try {
      await coordinateBlueprint(id);
      broadcastOperation("coordinate");
      invalidateAll();
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : "Coordinator failed");
    }
  };

  // Convene handlers
  const handleStartConvene = async () => {
    if (!conveneTopic.trim() || conveneRoles.length < 2) return;
    setMutationError(null);
    try {
      await startConveneSession(id, {
        topic: conveneTopic.trim(),
        roleIds: conveneRoles,
        contextNodeIds: conveneContextNodes.length > 0 ? conveneContextNodes : undefined,
        maxRounds: conveneMaxRounds,
      });
      broadcastOperation("convene");
      setShowConveneForm(false);
      setConveneTopic("");
      setConveneRoles([]);
      setConveneContextNodes([]);
      setConveneMaxRounds(3);
      invalidateAll();
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : "Failed to start discussion");
    }
  };

  const handleExpandSession = async (sessionId: string) => {
    if (expandedSessionId === sessionId) {
      setExpandedSessionId(null);
      setSessionDetail(null);
      return;
    }
    setExpandedSessionId(sessionId);
    setExpandedMsgIds(new Set());
    try {
      const detail = await getConveneSessionDetail(id, sessionId);
      setSessionDetail(detail);
    } catch {
      setSessionDetail(null);
    }
  };

  const handleApproveConvene = async (sessionId: string) => {
    try {
      const result = await approveConveneSession(id, sessionId);
      showToast(`${result.createdNodeIds.length} nodes created from discussion`);
      invalidateAll();
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : "Failed to approve session");
    }
  };

  const handleCancelConvene = async (sessionId: string) => {
    try {
      await cancelConveneSession(id, sessionId);
      setConfirmingDiscard(null);
      queryClient.invalidateQueries({ queryKey: blueprintKeys.conveneSessions(id) });
      if (expandedSessionId === sessionId) {
        setExpandedSessionId(null);
        setSessionDetail(null);
      }
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : "Failed to cancel session");
    }
  };

  // Insight handlers — optimistic updates
  const handleMarkInsightRead = async (insightId: string) => {
    setInsights((prev) => prev.map((i) => i.id === insightId ? { ...i, read: true } : i));
    try {
      await markInsightReadApi(id, insightId);
    } catch {
      // Revert on error
      setInsights((prev) => prev.map((i) => i.id === insightId ? { ...i, read: false } : i));
    }
  };

  const handleMarkAllInsightsRead = async () => {
    const prevInsights = insights;
    setInsights((prev) => prev.map((i) => ({ ...i, read: true })));
    try {
      await markAllInsightsReadApi(id);
    } catch {
      setInsights(prevInsights);
    }
  };

  const handleDismissInsight = async (insightId: string) => {
    setInsights((prev) => prev.map((i) => i.id === insightId ? { ...i, dismissed: true } : i));
    try {
      await dismissInsightApi(id, insightId);
    } catch {
      // Revert on error
      setInsights((prev) => prev.map((i) => i.id === insightId ? { ...i, dismissed: false } : i));
    }
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
      setMutationError(err instanceof Error ? err.message : String(err));
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
      showToast("Node created and enriched");
      setNodeTitle("");
      setNodeDescription("");
      setNodeDeps([]);
      setShowAddNode(false);
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : String(err));
    } finally {
      setEnriching(false);
    }
  };

  // Toast when coordinator task completes
  const prevCoordinatingRef = useRef(false);
  useEffect(() => {
    const wasCoordinating = prevCoordinatingRef.current;
    const nowCoordinating = pendingTasks.some(t => t.type === "coordinate");
    prevCoordinatingRef.current = nowCoordinating;
    if (wasCoordinating && !nowCoordinating) {
      showToast("Coordinator finished analyzing insights");
    }
  }, [pendingTasks, showToast]);

  // Toast when convene task completes
  const prevConveneRef = useRef(false);
  useEffect(() => {
    const wasConvening = prevConveneRef.current;
    const nowConvening = pendingTasks.some(t => t.type === "convene");
    prevConveneRef.current = nowConvening;
    if (wasConvening && !nowConvening) {
      showToast("Discussion complete — review synthesis");
    }
  }, [pendingTasks, showToast]);

  // Toast when generate task completes
  const nowGeneratingTask = pendingTasks.some(t => t.type === "generate");
  const prevGeneratingTaskRef = useRef(false);
  useEffect(() => {
    const wasGenerating = prevGeneratingTaskRef.current;
    prevGeneratingTaskRef.current = nowGeneratingTask;
    if (wasGenerating && !nowGeneratingTask) {
      showToast("Generation complete");
    }
  }, [nowGeneratingTask, showToast]);

  // Toast when reevaluate-all task completes
  const nowReevalAllTask = pendingTasks.some(t => t.type === "reevaluate");
  const prevReevalAllRef = useRef(false);
  useEffect(() => {
    const wasReevaluating = prevReevalAllRef.current;
    prevReevalAllRef.current = nowReevalAllTask;
    if (wasReevaluating && !nowReevalAllTask) {
      showToast("Reevaluation complete for all nodes");
    }
  }, [nowReevalAllTask, showToast]);

  // Toast when run-all completes (runningAll tracks user-initiated Run All)
  const prevRunningAllRef = useRef(false);
  useEffect(() => {
    const wasRunningAll = prevRunningAllRef.current;
    prevRunningAllRef.current = runningAll;
    if (wasRunningAll && !runningAll) {
      showToast("All executions complete");
    }
  }, [runningAll, showToast]);

  // Keyboard shortcut: Cmd/Ctrl+Shift+R → Reevaluate All
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (e.target as HTMLElement).isContentEditable) return;
      if (e.key === "R" && e.shiftKey && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleReevaluateAll();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

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

  // Auto-open insights panel on first load only if there are unread insights
  useEffect(() => {
    if (!insightsAutoOpenedRef.current && insights.length > 0) {
      insightsAutoOpenedRef.current = true;
      if (insights.some((i) => !i.read && !i.dismissed)) {
        setInsightsOpen(true);
      }
    }
  }, [insights]);

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
  const isReevaluatingTask = pendingTasks.some(t => t.type === "reevaluate");
  const isRunningTask = pendingTasks.some(t => t.type === "run");
  const isCoordinatingTask = pendingTasks.some(t => t.type === "coordinate");
  const isConveneTask = pendingTasks.some(t => t.type === "convene");
  const unreadInsightCount = insights.filter((i) => !i.read && !i.dismissed).length;
  const newNodeCount = newNodeIds.size;
  const isRunning = blueprint.status === "running" || runningAll;
  // Name of the active blueprint-level operation (for tooltip), or undefined if idle.
  // "Run All" and individual node runs are NOT included — individual Run buttons remain
  // clickable so users can queue additional nodes while others execute.
  const blueprintBusy = isGeneratingTask ? "Generate" : isConveneTask ? "Convene" : isCoordinatingTask ? "Coordinate" : undefined;
  const isAutopilot = blueprint.executionMode === "autopilot" || blueprint.executionMode === "fsd";
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

  // Apply status filter + search filter then sort
  let filteredNodes = statusFilter === "all"
    ? blueprint.nodes
    : blueprint.nodes.filter((n) => n.status === statusFilter);
  if (nodeSearchQuery) {
    filteredNodes = filteredNodes.filter((n) => n.title.toLowerCase().includes(nodeSearchQuery));
  }

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
    displayNodes = [...filteredNodes].sort((a, b) =>
      reverseOrder ? b.seq - a.seq : a.seq - b.seq
    );
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
          {/* Star toggle */}
          <button
            onClick={async () => {
              const newStarred = !blueprint.starred;
              // Optimistic update
              setBlueprint((prev) => prev ? { ...prev, starred: newStarred } : prev);
              try {
                if (newStarred) {
                  await starBlueprintApi(id);
                } else {
                  await unstarBlueprintApi(id);
                }
              } catch {
                // Revert on error
                setBlueprint((prev) => prev ? { ...prev, starred: !newStarred } : prev);
              }
            }}
            className={`flex-shrink-0 p-1 rounded-lg transition-all active:scale-[0.9] ${
              blueprint.starred
                ? "text-accent-amber"
                : "text-text-muted/30 hover:text-accent-amber/60"
            }`}
            title={blueprint.starred ? "Unstar" : "Star"}
            aria-label={blueprint.starred ? "Unstar blueprint" : "Star blueprint"}
          >
            <svg className="w-5 h-5" viewBox="0 0 16 16" fill={blueprint.starred ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.2">
              <path d="M8 1.5l2 4 4.5.65-3.25 3.17.77 4.48L8 11.77 3.98 13.8l.77-4.48L1.5 6.15 6 5.5z" />
            </svg>
          </button>
          <StatusIndicator status={blueprint.status} context="blueprint" />
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
              readOnly={generating || enriching || reevaluating || isGeneratingTask || isReevaluatingTask}
              className={`text-xl font-semibold min-w-0 flex-1 px-2 py-0.5 rounded-lg bg-bg-tertiary border border-accent-blue text-text-primary focus:outline-none ${generating || enriching || reevaluating || isGeneratingTask || isReevaluatingTask ? "opacity-60 cursor-not-allowed" : ""}`}
            />
          ) : (
            <h1
              className={`text-xl font-semibold truncate min-w-0 flex-1 transition-colors ${generating || enriching || reevaluating || isGeneratingTask || isReevaluatingTask ? "opacity-60 cursor-not-allowed" : "cursor-pointer hover:text-text-primary"}`}
              onClick={() => {
                if (generating || enriching || reevaluating || isGeneratingTask || isReevaluatingTask) return;
                setTitleValue(blueprint.title);
                setEditingTitle(true);
                setTimeout(() => titleRef.current?.focus(), 0);
              }}
              title={generating || enriching || reevaluating || isGeneratingTask || isReevaluatingTask ? "Editing disabled during AI operation" : "Click to edit"}
            >
              {blueprint.title}
            </h1>
          )}
          <span className="text-xs px-2 py-0.5 rounded-full bg-bg-tertiary text-text-muted capitalize flex-shrink-0">
            {blueprint.status === "running" ? "In Progress" : blueprint.status}
          </span>
          {blueprint.status === "running" && !anyNodeRunning && !anyNodeQueued && !hasPendingTasks && (
            confirmingStatusReset ? (
              <ConfirmationStrip
                confirmLabel="Reset to Approved?"
                variant="amber"
                inline
                onConfirm={async () => {
                  setConfirmingStatusReset(false);
                  try {
                    const updated = await updateBlueprint(id, { status: "approved" });
                    setBlueprint(updated);
                    showToast("Blueprint status reset to Approved");
                  } catch (err) {
                    setMutationError(err instanceof Error ? err.message : String(err));
                  }
                }}
                onCancel={() => setConfirmingStatusReset(false)}
              />
            ) : (
              <button
                onClick={() => setConfirmingStatusReset(true)}
                title="Blueprint appears stuck — no nodes are running or queued. Click to reset status to Approved."
                className="text-xs text-accent-amber hover:text-accent-amber/80 transition-colors flex-shrink-0"
              >
                Reset
              </button>
            )
          )}
          {/* Status transitions: done/failed → approved, approved → draft, paused → approved */}
          {(blueprint.status === "done" || blueprint.status === "failed") && (
            confirmingStatusTransition === "reopen" ? (
              <ConfirmationStrip
                confirmLabel="Reopen to Approved?"
                variant="blue"
                inline
                onConfirm={async () => {
                  setConfirmingStatusTransition(null);
                  try {
                    const updated = await updateBlueprint(id, { status: "approved" });
                    setBlueprint(updated);
                    showToast("Blueprint reopened — status set to Approved");
                  } catch (err) {
                    setMutationError(err instanceof Error ? err.message : String(err));
                  }
                }}
                onCancel={() => setConfirmingStatusTransition(null)}
              />
            ) : (
              <button
                onClick={() => setConfirmingStatusTransition("reopen")}
                title={`Reopen this ${blueprint.status} blueprint — sets status back to Approved for re-execution`}
                className="text-xs text-accent-blue hover:text-accent-blue/80 transition-colors flex-shrink-0"
              >
                Reopen
              </button>
            )
          )}
          {blueprint.status === "approved" && (
            confirmingStatusTransition === "draft" ? (
              <ConfirmationStrip
                confirmLabel="Revert to Draft?"
                variant="blue"
                inline
                onConfirm={async () => {
                  setConfirmingStatusTransition(null);
                  try {
                    const updated = await updateBlueprint(id, { status: "draft" });
                    setBlueprint(updated);
                    showToast("Blueprint reverted to Draft");
                  } catch (err) {
                    setMutationError(err instanceof Error ? err.message : String(err));
                  }
                }}
                onCancel={() => setConfirmingStatusTransition(null)}
              />
            ) : (
              <button
                onClick={() => setConfirmingStatusTransition("draft")}
                title="Revert blueprint to Draft for further planning"
                className="text-xs text-accent-blue hover:text-accent-blue/80 transition-colors flex-shrink-0"
              >
                Back to Draft
              </button>
            )
          )}
          {blueprint.status === "paused" && (
            confirmingStatusTransition === "resume" ? (
              <ConfirmationStrip
                confirmLabel="Resume to Approved?"
                variant="blue"
                inline
                onConfirm={async () => {
                  setConfirmingStatusTransition(null);
                  try {
                    const updated = await updateBlueprint(id, { status: "approved" });
                    setBlueprint(updated);
                    showToast("Blueprint resumed — status set to Approved");
                  } catch (err) {
                    setMutationError(err instanceof Error ? err.message : String(err));
                  }
                }}
                onCancel={() => setConfirmingStatusTransition(null)}
              />
            ) : (
              <button
                onClick={() => setConfirmingStatusTransition("resume")}
                title="Resume this paused blueprint — sets status to Approved for execution"
                className="text-xs text-accent-blue hover:text-accent-blue/80 transition-colors flex-shrink-0"
              >
                Resume
              </button>
            )
          )}
          {blueprint.archivedAt && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-text-muted/10 text-text-muted flex-shrink-0">
              archived
            </span>
          )}
          {blueprint.agentType && blueprint.agentType !== "claude" && (
            <AgentBadge agentType={blueprint.agentType} size="xs" />
          )}
          {blueprint.agentParams && (
            <span className="text-xs text-text-muted font-mono bg-bg-tertiary px-1.5 py-0.5 rounded" title={blueprint.agentParams}>
              {blueprint.agentParams.length > 30 ? blueprint.agentParams.slice(0, 30) + "…" : blueprint.agentParams}
            </span>
          )}
          <AutopilotToggle
            blueprintId={id}
            executionMode={blueprint.executionMode}
            blueprintStatus={blueprint.status}
            onUpdate={(patch) => setBlueprint((prev) => prev ? { ...prev, ...patch } : prev)}
          />
          {/* State-control actions + archive */}
          <div className="flex items-center gap-1 flex-shrink-0">
            {blueprint.status === "draft" && (
              <button
                onClick={handleApprove}
                disabled={approving}
                title={approving ? "Approving blueprint..." : "Mark this blueprint as approved and ready for execution"}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-accent-blue/15 text-accent-blue text-xs font-medium hover:bg-accent-blue/25 transition-all active:scale-[0.97] disabled:opacity-disabled disabled:cursor-not-allowed whitespace-nowrap"
              >
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
                {approving ? "Approving..." : "Approve"}
              </button>
            )}
            {canRunAll && (
              confirmingRunAll ? (
                <ConfirmationStrip
                  confirmLabel={isAutopilot ? "Run all (autopilot)?" : "Run all pending nodes?"}
                  variant="amber"
                  onConfirm={handleRunAll}
                  onCancel={() => setConfirmingRunAll(false)}
                  disabled={isRunning || isRunningTask}
                />
              ) : (
                <button
                  onClick={handleRunAll}
                  disabled={isRunning || isRunningTask}
                  title={isRunning || isRunningTask ? "AI is executing nodes — check progress in the node cards below" : isAutopilot ? "Execute all pending nodes via autopilot agent loop" : "Execute all pending nodes in dependency order using the selected agent"}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-all active:scale-[0.97] disabled:opacity-disabled disabled:cursor-not-allowed whitespace-nowrap ${
                    isAutopilot
                      ? "bg-accent-green/15 text-accent-green hover:bg-accent-green/25"
                      : "bg-accent-blue/15 text-accent-blue hover:bg-accent-blue/25"
                  }`}
                >
                  {isRunning || isRunningTask ? (
                    <><AISparkle size="xs" /> In Progress...</>
                  ) : (
                    <>
                      <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2l10 6-10 6V2z" /></svg>
                      {isAutopilot ? "Run All (Autopilot)" : "Run All"}
                    </>
                  )}
                </button>
              )
            )}
            {/* Convene button */}
            <button
              onClick={() => {
                setConveneRoles(blueprint.enabledRoles?.length ? [...blueprint.enabledRoles] : allRoles.map((r) => r.id));
                setShowConveneForm(true);
              }}
              disabled={
                blueprint.status === "running" ||
                !!blueprintBusy
              }
              title={
                blueprint.status === "running"
                  ? "Cannot convene while blueprint is executing"
                  : !!blueprintBusy
                    ? "Wait for current operation to complete"
                    : "Start a multi-role discussion to plan new nodes"
              }
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-medium bg-accent-purple/15 text-accent-purple border-accent-purple/30 hover:bg-accent-purple/25 active:scale-[0.97] transition-all disabled:opacity-disabled disabled:cursor-not-allowed whitespace-nowrap"
            >
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              Convene
            </button>
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
            readOnly={generating || enriching || reevaluating || isGeneratingTask || isReevaluatingTask}
            className={`w-full text-sm px-3 py-2 rounded-lg bg-bg-tertiary border border-accent-blue text-text-primary placeholder:text-text-muted focus:outline-none resize-y min-h-[60px] mb-3 ${generating || enriching || reevaluating || isGeneratingTask || isReevaluatingTask ? "opacity-60 cursor-not-allowed" : ""}`}
            rows={2}
          />
        ) : (
          <div
            className={`text-sm mb-3 transition-colors ${generating || enriching || reevaluating || isGeneratingTask || isReevaluatingTask ? "opacity-60 cursor-not-allowed" : "cursor-pointer hover:text-text-primary"}`}
            onClick={() => {
              if (generating || enriching || reevaluating || isGeneratingTask || isReevaluatingTask) return;
              setDescValue(blueprint.description || "");
              setEditingDesc(true);
              setTimeout(() => descRef.current?.focus(), 0);
            }}
            title={generating || enriching || reevaluating || isGeneratingTask || isReevaluatingTask ? "Editing disabled during AI operation" : "Click to edit"}
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

        <div className="mb-3">
          <RoleSelector
            value={blueprint.enabledRoles ?? ["sde"]}
            onChange={async (newRoles) => {
              try {
                const updated = await updateBlueprint(id, { enabledRoles: newRoles, defaultRole: newRoles[0] });
                setBlueprint(updated);
              } catch {
                // revert silently
              }
            }}
            disabled={blueprint.status !== "draft" && blueprint.status !== "approved" && blueprint.status !== "paused"}
          />
        </div>

        {/* Blueprint Chat — replaces generator textarea */}
        <BlueprintChat
          blueprintId={id}
          executionMode={blueprint.executionMode}
          blueprintStatus={blueprint.status}
          pauseReason={blueprint.pauseReason}
          isReevaluating={reevaluating || isReevaluatingTask}
          isRunning={isRunning}
          hasNodes={blueprint.nodes.some((n) => n.status !== "done" && n.status !== "running" && n.status !== "queued")}
          onReevaluateAll={handleReevaluateAll}
          onUpdate={(patch) => setBlueprint((prev) => prev ? { ...prev, ...patch } as typeof prev : prev)}
          onInvalidate={invalidateAll}
          onBroadcast={(type) => broadcastOperation(type as Parameters<typeof broadcastOperation>[0])}
          onScrollToNode={(nodeId) => {
            const el = document.getElementById(`node-${nodeId}`);
            if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
          }}
        />
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
        {/* Convene active banner */}
        {isConveneTask && (
          <div className="mt-3 flex items-center gap-2 px-4 py-2 rounded-lg bg-accent-purple/10 border border-accent-purple/20">
            <span className="w-2 h-2 rounded-full bg-accent-purple animate-pulse flex-shrink-0" />
            <span className="text-sm text-accent-purple">Role discussion in progress</span>
          </div>
        )}
        {/* Convene configuration form */}
        {showConveneForm && (
          <div className="mt-3 rounded-xl border border-accent-purple/30 bg-bg-secondary p-4 animate-fade-in">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-medium text-text-primary">Start Discussion</h3>
              <button
                onClick={() => setShowConveneForm(false)}
                className="p-1 rounded text-text-muted hover:text-text-secondary hover:bg-bg-tertiary transition-colors"
                aria-label="Close convene form"
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18" /><path d="M6 6l12 12" /></svg>
              </button>
            </div>
            {/* Topic */}
            <input
              type="text"
              value={conveneTopic}
              onChange={(e) => setConveneTopic(e.target.value)}
              placeholder="Discussion topic (e.g. 'Design the auth system')"
              className="w-full px-3 py-2 rounded-lg bg-bg-tertiary text-text-primary text-sm placeholder:text-text-muted border border-border-primary focus:border-accent-purple/40 focus:outline-none mb-3"
              autoFocus
            />
            {/* Role selection — show all registered roles, pre-check enabledRoles */}
            <div className="mb-3">
              <label className="text-xs text-text-muted mb-1.5 block">Participating roles (min 2)</label>
              <div className="flex flex-wrap gap-1.5">
                {allRoles.map((role) => (
                  <button
                    key={role.id}
                    type="button"
                    onClick={() =>
                      setConveneRoles((prev) =>
                        prev.includes(role.id) ? prev.filter((x) => x !== role.id) : [...prev, role.id]
                      )
                    }
                    className={`px-2 py-1 rounded-md text-xs border transition-colors ${
                      conveneRoles.includes(role.id)
                        ? `${ROLE_COLORS[role.id]?.border ?? ROLE_FALLBACK_COLORS.border} ${ROLE_COLORS[role.id]?.bg ?? ROLE_FALLBACK_COLORS.bg} ${ROLE_COLORS[role.id]?.text ?? ROLE_FALLBACK_COLORS.text}`
                        : "border-border-primary text-text-muted hover:border-border-hover"
                    }`}
                  >
                    {role.id.toUpperCase()}
                  </button>
                ))}
              </div>
              {conveneRoles.length < 2 && (
                <p className="text-xs text-accent-red mt-1">Select at least 2 roles for a meaningful discussion</p>
              )}
            </div>
            {/* Context nodes (optional) */}
            {blueprint.nodes.length > 0 && (
              <div className="mb-3">
                <label className="text-xs text-text-muted mb-1.5 block">Context nodes (optional)</label>
                <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
                  {blueprint.nodes.map((n) => (
                    <button
                      key={n.id}
                      type="button"
                      onClick={() =>
                        setConveneContextNodes((prev) =>
                          prev.includes(n.id) ? prev.filter((x) => x !== n.id) : [...prev, n.id]
                        )
                      }
                      className={`flex-shrink-0 px-2 py-1 rounded-md text-xs border transition-colors ${
                        conveneContextNodes.includes(n.id)
                          ? "border-accent-blue bg-accent-blue/20 text-accent-blue"
                          : "border-border-primary text-text-muted hover:border-border-hover"
                      }`}
                    >
                      #{n.seq} {n.title.length > 25 ? n.title.slice(0, 25) + "…" : n.title}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {/* Max rounds */}
            <div className="mb-4">
              <label className="text-xs text-text-muted mb-1.5 block">Max rounds</label>
              <div className="flex items-center gap-1.5">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setConveneMaxRounds(n)}
                    className={`w-8 h-8 rounded-lg text-xs font-medium transition-colors ${
                      conveneMaxRounds === n
                        ? "bg-accent-purple/20 text-accent-purple border border-accent-purple/40"
                        : "bg-bg-tertiary text-text-muted border border-border-primary hover:border-border-hover"
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
            {/* Actions */}
            <div className="flex items-center gap-2">
              <button
                onClick={handleStartConvene}
                disabled={!conveneTopic.trim() || conveneRoles.length < 2}
                title={!conveneTopic.trim() ? "Enter a topic" : conveneRoles.length < 2 ? "Select at least 2 roles" : "Start discussion"}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent-purple/15 text-accent-purple border border-accent-purple/30 text-xs font-medium hover:bg-accent-purple/25 active:scale-[0.97] transition-all disabled:opacity-disabled disabled:cursor-not-allowed"
              >
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
                Start Discussion
              </button>
              <button
                onClick={() => setShowConveneForm(false)}
                className="px-3 py-1.5 rounded-lg text-text-muted text-xs hover:text-text-secondary hover:bg-bg-tertiary transition-all"
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


      {/* Insights Panel */}
      {insights.length > 0 && (() => {
        const visibleInsights = showDismissed ? insights : insights.filter((i) => !i.dismissed);
        const unreadCount = insights.filter((i) => !i.read && !i.dismissed).length;
        const dismissedCount = insights.filter((i) => i.dismissed).length;
        if (visibleInsights.length === 0 && dismissedCount === 0) return null;

        const severityConfig = {
          critical: { bg: "bg-accent-red/10", border: "border-accent-red/30", text: "text-accent-red", dot: "bg-accent-red" },
          warning: { bg: "bg-accent-amber/10", border: "border-accent-amber/30", text: "text-accent-amber", dot: "bg-accent-amber" },
          info: { bg: "bg-accent-blue/10", border: "border-accent-blue/30", text: "text-accent-blue", dot: "bg-accent-blue" },
        };

        return (
          <div className="mb-4 rounded-xl border border-border-primary bg-bg-secondary overflow-hidden">
            {/* Header */}
            <button
              onClick={() => setInsightsOpen((v) => !v)}
              className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-bg-tertiary/50 transition-colors"
            >
              <svg className={`w-3 h-3 text-text-muted transition-transform ${insightsOpen ? "rotate-90" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
              <span className="text-sm font-medium text-text-primary">Insights</span>
              {unreadCount > 0 && (
                <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-accent-red/20 text-accent-red">
                  {unreadCount}
                </span>
              )}
              <span className="text-xs text-text-muted ml-auto">
                {visibleInsights.length} insight{visibleInsights.length !== 1 ? "s" : ""}
              </span>
              {unreadCount > 0 && (
                <button
                  onClick={(e) => { e.stopPropagation(); handleMarkAllInsightsRead(); }}
                  className="text-[11px] text-accent-blue hover:text-accent-blue/80 transition-colors px-1.5 py-0.5 rounded hover:bg-accent-blue/10"
                >
                  Mark all read
                </button>
              )}
              <button
                onClick={(e) => { e.stopPropagation(); handleCoordinate(); }}
                disabled={isRunning || isCoordinatingTask || unreadInsightCount === 0}
                title={isCoordinatingTask ? "Coordinator is analyzing insights..." : unreadInsightCount === 0 ? "No unread insights to analyze" : "Agent analyzes unread insights and creates/updates nodes"}
                className="text-[11px] text-accent-purple hover:text-accent-purple/80 transition-colors px-1.5 py-0.5 rounded hover:bg-accent-purple/10 disabled:opacity-disabled disabled:cursor-not-allowed flex items-center gap-1"
              >
                {isCoordinatingTask ? (<><AISparkle size="xs" /> Analyzing...</>) : "Analyze"}
              </button>
            </button>

            {/* Insight list */}
            {insightsOpen && (
              <div className="border-t border-border-primary">
                {visibleInsights.length === 0 ? (
                  <div className="px-4 py-3 text-xs text-text-muted">All insights dismissed.</div>
                ) : (
                  <div className="divide-y divide-border-primary">
                    {visibleInsights.map((insight) => {
                      const cfg = severityConfig[insight.severity] || severityConfig.info;
                      const sourceNode = insight.sourceNodeId
                        ? blueprint.nodes.find((n) => n.id === insight.sourceNodeId)
                        : null;
                      return (
                        <div
                          key={insight.id}
                          className={`px-4 py-2.5 flex items-start gap-2.5 transition-colors ${insight.dismissed ? "opacity-50" : ""} ${!insight.read && !insight.dismissed ? "bg-bg-tertiary/30" : ""}`}
                        >
                          {/* Severity dot */}
                          <span className={`flex-shrink-0 mt-1.5 w-2 h-2 rounded-full ${cfg.dot}`} title={insight.severity} />
                          {/* Content */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
                              <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${(ROLE_COLORS[insight.role] ?? ROLE_FALLBACK_COLORS).bg} ${(ROLE_COLORS[insight.role] ?? ROLE_FALLBACK_COLORS).text}`}>
                                {insight.role}
                              </span>
                              <span className={`text-[10px] px-1 py-0.5 rounded capitalize ${cfg.bg} ${cfg.text}`}>
                                {insight.severity}
                              </span>
                              {sourceNode && (
                                <Link
                                  href={`/blueprints/${id}/nodes/${insight.sourceNodeId}`}
                                  className="text-[10px] text-accent-blue hover:text-accent-blue/80 transition-colors truncate max-w-[120px]"
                                >
                                  #{sourceNode.seq} {sourceNode.title}
                                </Link>
                              )}
                              <span className="text-[10px] text-text-muted ml-auto flex-shrink-0">
                                {new Date(insight.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                              </span>
                            </div>
                            <p className="text-sm text-text-secondary">{insight.message}</p>
                          </div>
                          {/* Actions */}
                          <div className="flex items-center gap-1 flex-shrink-0 mt-0.5">
                            {!insight.read && !insight.dismissed && (
                              <button
                                onClick={() => handleMarkInsightRead(insight.id)}
                                className="p-1 rounded text-text-muted hover:text-accent-blue hover:bg-accent-blue/10 transition-colors"
                                title="Mark as read"
                                aria-label="Mark insight as read"
                              >
                                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
                              </button>
                            )}
                            {!insight.dismissed && (
                              <button
                                onClick={() => handleDismissInsight(insight.id)}
                                className="p-1 rounded text-text-muted hover:text-accent-red hover:bg-accent-red/10 transition-colors"
                                title="Dismiss"
                                aria-label="Dismiss insight"
                              >
                                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18" /><path d="M6 6l12 12" /></svg>
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                {dismissedCount > 0 && (
                  <div className="px-4 py-2 border-t border-border-primary">
                    <button
                      onClick={() => setShowDismissed((v) => !v)}
                      className="text-[11px] text-text-muted hover:text-text-secondary transition-colors"
                    >
                      {showDismissed ? "Hide" : "Show"} {dismissedCount} dismissed
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })()}

      {/* Discussions Panel */}
      {conveneSessions.length > 0 && (
        <div className="mb-4 rounded-xl border border-border-primary bg-bg-secondary overflow-hidden">
          {/* Header */}
          <button
            onClick={() => setDiscussionsOpen((v) => !v)}
            className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-bg-tertiary/50 transition-colors"
          >
            <svg className={`w-3 h-3 text-text-muted transition-transform ${discussionsOpen ? "rotate-90" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
            <span className="text-sm font-medium text-text-primary">Discussions</span>
            <span className="bg-accent-purple/15 text-accent-purple text-xs rounded-full px-2 py-0.5">
              {conveneSessions.length}
            </span>
            <span className="text-xs text-text-muted ml-auto">
              {conveneSessions.filter((s) => s.status === "completed").length} completed
              {conveneSessions.filter((s) => s.status === "failed").length > 0 && (
                <span className="text-accent-red ml-1">
                  {" \u00b7 "}{conveneSessions.filter((s) => s.status === "failed").length} failed
                </span>
              )}
            </span>
          </button>

          {/* Session list */}
          {discussionsOpen && (
            <div className="border-t border-border-primary divide-y divide-border-primary">
              {conveneSessions.map((session) => {
                const isExpanded = expandedSessionId === session.id;
                const statusColors: Record<string, string> = {
                  active: "bg-accent-purple/15 text-accent-purple",
                  synthesizing: "bg-accent-amber/15 text-accent-amber",
                  completed: "bg-accent-green/15 text-accent-green",
                  cancelled: "bg-text-muted/10 text-text-muted",
                  failed: "bg-accent-red/15 text-accent-red",
                };
                return (
                  <div key={session.id}>
                    {/* Session card */}
                    <button
                      onClick={() => handleExpandSession(session.id)}
                      className="w-full text-left hover:bg-bg-hover active:scale-[0.995] transition-all rounded-lg p-3"
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-sm font-medium text-text-primary truncate flex-1">{session.topic}</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium capitalize ${statusColors[session.status] ?? statusColors.cancelled}`}>
                          {session.status}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="flex items-center gap-1">
                          {session.participatingRoles.map((r) => (
                            <span
                              key={r}
                              className={`w-2 h-2 rounded-full ${ROLE_COLORS[r]?.dot ?? ROLE_FALLBACK_COLORS.dot}`}
                              title={r.toUpperCase()}
                            />
                          ))}
                        </div>
                        <span className="text-[10px] text-text-muted">
                          {session.messageCount} message{session.messageCount !== 1 ? "s" : ""}
                        </span>
                        <span className="text-[10px] text-text-muted ml-auto">
                          {new Date(session.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                        </span>
                      </div>
                    </button>

                    {/* Expanded session detail */}
                    {isExpanded && (
                      <div className="px-3 pb-3 max-h-[500px] overflow-y-auto animate-fade-in">
                        {sessionDetail && sessionDetail.id === session.id ? (
                          <>
                            {/* Message list */}
                            {(() => {
                              const nonSynthMsgs = sessionDetail.messages.filter(m => m.messageType !== "synthesis");
                              if (nonSynthMsgs.length >= 4) {
                                const allExpanded = nonSynthMsgs.every(m => expandedMsgIds.has(m.id));
                                return (
                                  <div className="flex justify-end mb-1">
                                    <button
                                      onClick={() => {
                                        setExpandedMsgIds(prev => {
                                          const next = new Set(prev);
                                          if (allExpanded) {
                                            nonSynthMsgs.forEach(m => next.delete(m.id));
                                          } else {
                                            nonSynthMsgs.forEach(m => next.add(m.id));
                                          }
                                          return next;
                                        });
                                      }}
                                      className="text-[10px] text-accent-blue hover:underline"
                                    >
                                      {allExpanded ? "Collapse all" : "Expand all"}
                                    </button>
                                  </div>
                                );
                              }
                              return null;
                            })()}
                            <div className="space-y-2 mb-3">
                              {sessionDetail.messages.map((msg) => {
                                const isSynthesis = msg.messageType === "synthesis";
                                const roleColor = ROLE_COLORS[msg.roleId] ?? ROLE_FALLBACK_COLORS;
                                const isMsgExpanded = isSynthesis || expandedMsgIds.has(msg.id);
                                return (
                                  <div
                                    key={msg.id}
                                    className={`border-l-2 rounded-r-lg ${
                                      isSynthesis
                                        ? "bg-accent-purple/10 border-accent-purple"
                                        : `bg-bg-tertiary/50 ${roleColor.border}`
                                    }`}
                                  >
                                    <button
                                      onClick={() => {
                                        if (isSynthesis) return;
                                        setExpandedMsgIds(prev => {
                                          const next = new Set(prev);
                                          if (next.has(msg.id)) next.delete(msg.id);
                                          else next.add(msg.id);
                                          return next;
                                        });
                                      }}
                                      className={`w-full text-left flex items-center gap-2 p-3 ${isSynthesis ? "" : "cursor-pointer"} ${!isMsgExpanded ? "pb-0" : ""}`}
                                      aria-expanded={isMsgExpanded}
                                      aria-label={`${isSynthesis ? "Synthesis" : msg.roleId.toUpperCase()}${!isSynthesis ? ` Round ${msg.round}` : ""} — ${isMsgExpanded ? "collapse" : "expand"}`}
                                    >
                                      {!isSynthesis && (
                                        <svg className={`w-3 h-3 text-text-muted transition-transform flex-shrink-0 ${isMsgExpanded ? "rotate-90" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
                                      )}
                                      <span className={`text-xs font-medium ${isSynthesis ? "text-accent-purple" : roleColor.text}`}>
                                        {isSynthesis ? "Synthesis" : msg.roleId.toUpperCase()}
                                      </span>
                                      {!isSynthesis && (
                                        <span className="text-[10px] text-text-muted">Round {msg.round}</span>
                                      )}
                                    </button>
                                    <div className="px-3 pb-3">
                                      {isMsgExpanded ? (
                                        <MarkdownContent content={msg.content} maxHeight="200px" />
                                      ) : (
                                        <div>
                                          <p className="text-xs text-text-secondary line-clamp-2 leading-snug">{stripMarkdown(msg.content)}</p>
                                          <button
                                            onClick={() => setExpandedMsgIds(prev => new Set(prev).add(msg.id))}
                                            className="text-[10px] text-accent-blue hover:underline mt-0.5"
                                          >
                                            Show more
                                          </button>
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>

                            {/* Synthesis review — approve/discard */}
                            {session.status === "synthesizing" && sessionDetail.synthesisResult && sessionDetail.synthesisResult.length > 0 && (
                              <div className="border border-accent-purple/20 rounded-lg p-3 bg-accent-purple/5">
                                <h4 className="text-xs font-medium text-accent-purple mb-2">Proposed nodes ({sessionDetail.synthesisResult.length})</h4>
                                <ul className="space-y-1 mb-3">
                                  {sessionDetail.synthesisResult.map((node: BatchCreateNode, i: number) => (
                                    <li key={i} className="text-xs text-text-secondary flex items-start gap-1.5">
                                      <span className="text-text-muted flex-shrink-0">{i + 1}.</span>
                                      <span>{node.title}</span>
                                      {node.roles && node.roles.length > 0 && (
                                        <span className="flex items-center gap-0.5 ml-auto flex-shrink-0">
                                          {node.roles.map((r) => (
                                            <span key={r} className={`w-1.5 h-1.5 rounded-full ${ROLE_COLORS[r]?.dot ?? ROLE_FALLBACK_COLORS.dot}`} />
                                          ))}
                                        </span>
                                      )}
                                    </li>
                                  ))}
                                </ul>
                                <div className="flex items-center gap-2">
                                  <button
                                    onClick={() => handleApproveConvene(session.id)}
                                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-accent-green/15 text-accent-green border border-accent-green/30 text-xs font-medium hover:bg-accent-green/25 active:scale-[0.97] transition-all"
                                  >
                                    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
                                    Approve
                                  </button>
                                  {confirmingDiscard === session.id ? (
                                    <ConfirmationStrip
                                      confirmLabel="Discard?"
                                      variant="red"
                                      onConfirm={() => handleCancelConvene(session.id)}
                                      onCancel={() => setConfirmingDiscard(null)}
                                    />
                                  ) : (
                                    <button
                                      onClick={() => setConfirmingDiscard(session.id)}
                                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-accent-red/15 text-accent-red border border-accent-red/30 text-xs font-medium hover:bg-accent-red/25 active:scale-[0.97] transition-all"
                                    >
                                      <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18" /><path d="M6 6l12 12" /></svg>
                                      Discard
                                    </button>
                                  )}
                                </div>
                              </div>
                            )}
                          </>
                        ) : (
                          <div className="py-4 text-center">
                            <div className="w-4 h-4 border-2 border-accent-purple/30 border-t-accent-purple rounded-full animate-spin mx-auto" />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Add Node */}
      <div className="mb-4">
        {showAddNode ? (
          <form
            onSubmit={handleAddNode}
            className="rounded-xl border border-border-primary bg-bg-secondary focus-within:border-accent-blue/40 transition-colors"
          >
            <input
              type="text"
              value={nodeTitle}
              onChange={(e) => setNodeTitle(e.target.value)}
              placeholder="Node title"
              readOnly={enriching}
              className={`w-full px-4 pt-3 pb-1 bg-transparent text-text-primary placeholder:text-text-muted text-sm focus:outline-none${enriching ? " opacity-60 cursor-not-allowed" : ""}`}
              autoFocus
              required
            />
            <div className="px-4 pb-2">
              <MarkdownEditor
                value={nodeDescription}
                onChange={setNodeDescription}
                placeholder="Description (supports Markdown and image paste)"
                disabled={enriching}
              />
            </div>
            {/* Dependency picker */}
            {blueprint.nodes.length > 0 && (
              <div className="px-4 pb-2">
                <button
                  type="button"
                  onClick={() => setDepsExpanded((v) => !v)}
                  className="flex items-center gap-1 text-xs text-text-muted mb-1 hover:text-text-secondary transition-colors"
                  aria-expanded={depsExpanded}
                >
                  <svg className={`w-3 h-3 transition-transform ${depsExpanded ? "rotate-90" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
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
                      #{n.seq} {n.title.length > 30 ? n.title.slice(0, 30) + "…" : n.title}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {/* Bottom action bar */}
            <div className="flex items-center gap-1.5 px-3 pb-2.5">
              <button
                type="submit"
                disabled={!nodeTitle.trim() || addingNode}
                title={addingNode ? "Adding node..." : !nodeTitle.trim() ? "Enter a node title first" : "Add node to blueprint"}
                aria-label="Add node"
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-text-muted text-xs font-medium hover:bg-bg-tertiary hover:text-text-secondary transition-all active:scale-[0.97] disabled:opacity-disabled disabled:cursor-not-allowed whitespace-nowrap"
              >
                {addingNode ? (
                  <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" strokeOpacity="0.25" /><path d="M12 2a10 10 0 0 1 10 10" /></svg>
                ) : (
                  <svg className="w-3.5 h-3.5 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14" /><path d="M5 12h14" /></svg>
                )}
                {addingNode ? "Adding..." : "Add"}
              </button>
              <button
                type="button"
                disabled={!nodeTitle.trim() || enriching}
                onClick={handleSmartCreate}
                title={enriching ? "AI is enriching the node..." : !nodeTitle.trim() ? "Enter a node title first" : "AI enriches the title and description, then creates the node"}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-accent-purple text-xs font-medium hover:bg-accent-purple/10 transition-all active:scale-[0.97] disabled:opacity-disabled disabled:cursor-not-allowed whitespace-nowrap"
              >
                {enriching ? (<><AISparkle size="xs" /> Enriching...</>) : (<><AISparkle size="xs" className="opacity-70" /> Smart Create</>)}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowAddNode(false);
                  setNodeTitle("");
                  setNodeDescription("");
                  setNodeDeps([]);
                }}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-text-muted text-xs font-medium hover:bg-bg-tertiary hover:text-text-secondary transition-all active:scale-[0.97] whitespace-nowrap"
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <button
            onClick={() => setShowAddNode(true)}
            className="w-full py-2.5 rounded-xl border border-dashed border-border-primary text-text-muted text-xs font-medium hover:border-border-hover hover:text-text-secondary hover:bg-bg-secondary transition-all active:scale-[0.99] inline-flex items-center justify-center gap-1.5"
          >
            <svg className="w-3.5 h-3.5 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14" /><path d="M5 12h14" /></svg>
            Add Node
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
            <div className="flex items-center gap-2 flex-shrink-0">
              <span className="text-xs text-text-muted">
                {statusFilter === "all" && !nodeSearchQuery
                  ? `${blueprint.nodes.length} node${blueprint.nodes.length !== 1 ? "s" : ""}`
                  : `${filteredNodes.length}/${blueprint.nodes.length} nodes`}
              </span>
              <div className="relative">
                <svg className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-text-muted pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
                </svg>
                <input
                  type="text"
                  value={nodeSearchInput}
                  onChange={(e) => handleNodeSearchInput(e.target.value)}
                  placeholder="Filter nodes..."
                  className="w-28 sm:w-36 pl-7 pr-2 py-0.5 rounded-full text-[11px] bg-bg-tertiary text-text-primary placeholder:text-text-muted border border-transparent focus:border-border-hover focus:outline-none transition-colors"
                />
                {nodeSearchInput && (
                  <button
                    onClick={() => { setNodeSearchInput(""); setNodeSearchQuery(""); }}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-secondary transition-colors"
                    aria-label="Clear node search"
                  >
                    <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M18 6L6 18" /><path d="M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
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
                  className={`w-3.5 h-3.5 ${isPolling ? "animate-spin" : ""}`}
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
          {filteredNodes.length === 0 && (statusFilter !== "all" || nodeSearchQuery) && (
            <div className="text-center py-8 text-text-muted text-sm border border-dashed border-border-primary rounded-xl">
              {nodeSearchQuery ? (
                <>
                  No nodes matching &ldquo;{nodeSearchQuery}&rdquo;.{" "}
                  <button
                    onClick={() => { setNodeSearchInput(""); setNodeSearchQuery(""); }}
                    className="text-accent-blue hover:underline"
                  >
                    Clear search
                  </button>
                </>
              ) : (
                <>
                  No <span className="capitalize">{statusFilter}</span> nodes.{" "}
                  <button
                    onClick={() => setStatusFilter("all")}
                    className="text-accent-blue hover:underline"
                  >
                    Show all
                  </button>
                </>
              )}
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
                      <div id={`node-${node.id}`} className={newNodeIds.has(node.id) ? "animate-node-appear" : ""}>
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
                          broadcastOperation={broadcastOperation}
                          hasSuggestions={(node.suggestionCount ?? 0) > 0}
                          blueprintBusy={blueprintBusy}
                          hasRunningNodes={anyNodeRunning || anyNodeQueued}
                          blueprintStatus={blueprint.status}
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
                  <div key={node.id} id={`node-${node.id}`} className={newNodeIds.has(node.id) ? "animate-node-appear" : ""}>
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
                      broadcastOperation={broadcastOperation}
                      hasSuggestions={(node.suggestionCount ?? 0) > 0}
                      blueprintBusy={blueprintBusy}
                      hasRunningNodes={anyNodeRunning || anyNodeQueued}
                      blueprintDefaultRole={blueprint.defaultRole}
                      blueprintEnabledRoles={blueprint.enabledRoles}
                      blueprintStatus={blueprint.status}
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
