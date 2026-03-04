"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type {
  Blueprint,
  MacroNode,
  NodeExecution,
  PendingTask,
  TimelineNode,
  RelatedSession,
  NodeSuggestion,
  QueueInfo,
} from "@/lib/api";
import {
  getBlueprint,
  getNodeExecutions,
  getQueueStatus,
  getRelatedSessions,
  getActiveRelatedSession,
  getSuggestionsForNode,
  getLastSessionMessage,
} from "@/lib/api";
import { blueprintKeys } from "@/lib/useBlueprintDetailQueries";
import { usePollingInterval, invalidateKeys } from "@/lib/polling-utils";

// Query key factories — node-specific keys
export const nodeDetailKeys = {
  executions: (blueprintId: string, nodeId: string) =>
    ["node", blueprintId, nodeId, "executions"] as const,
  relatedSessions: (blueprintId: string, nodeId: string) =>
    ["node", blueprintId, nodeId, "relatedSessions"] as const,
  suggestions: (blueprintId: string, nodeId: string) =>
    ["node", blueprintId, nodeId, "suggestions"] as const,
  lastMessage: (sessionId: string) =>
    ["node", "lastMessage", sessionId] as const,
  activeRelatedSession: (blueprintId: string, nodeId: string) =>
    ["node", blueprintId, nodeId, "activeRelatedSession"] as const,
  relatedLastMessage: (sessionId: string) =>
    ["node", "relatedLastMessage", sessionId] as const,
};

/**
 * Custom hook that bundles all node detail page queries with
 * coordinated dynamic polling (5s active / 10s recovery-only / off when idle).
 *
 * Accepts `postCompletionPolling` and `recoveryPolling` booleans from the page
 * to extend polling after status transitions.
 */
export function useNodeDetailQueries(
  blueprintId: string,
  nodeId: string,
  options?: {
    postCompletionPolling?: boolean;
    recoveryPolling?: boolean;
  },
) {
  const queryClient = useQueryClient();
  const postCompletionPolling = options?.postCompletionPolling ?? false;
  const recoveryPolling = options?.recoveryPolling ?? false;

  // Compute refetch interval from cached state (avoids circular deps)
  const refetchInterval = usePollingInterval(() => {
    const bp = queryClient.getQueryData<Blueprint>(blueprintKeys.detail(blueprintId));
    const node = bp?.nodes.find((n) => n.id === nodeId);
    const qi = queryClient.getQueryData<QueueInfo>(blueprintKeys.queue(blueprintId));
    const pendingTasks = qi?.pendingTasks ?? [];
    const hasPendingTasks = pendingTasks.some((t) => t.nodeId === nodeId);
    const nodeActive = node?.status === "running" || node?.status === "queued";

    const shouldPoll = nodeActive || hasPendingTasks || postCompletionPolling || recoveryPolling;
    if (!shouldPoll) return false;

    // Recovery-only → slower interval
    if (recoveryPolling && !nodeActive && !hasPendingTasks && !postCompletionPolling) {
      return 10000;
    }

    return 5000;
  });

  // ── Primary queries ──────────────────────────────────────────

  const blueprintQuery = useQuery({
    queryKey: blueprintKeys.detail(blueprintId),
    queryFn: () => getBlueprint(blueprintId),
    refetchInterval,
  });

  const executionsQuery = useQuery({
    queryKey: nodeDetailKeys.executions(blueprintId, nodeId),
    queryFn: () => getNodeExecutions(blueprintId, nodeId),
    refetchInterval,
  });

  const queueQuery = useQuery({
    queryKey: blueprintKeys.queue(blueprintId),
    queryFn: () => getQueueStatus(blueprintId),
    refetchInterval,
  });

  const relatedSessionsQuery = useQuery({
    queryKey: nodeDetailKeys.relatedSessions(blueprintId, nodeId),
    queryFn: () => getRelatedSessions(blueprintId, nodeId),
    refetchInterval,
  });

  const suggestionsQuery = useQuery({
    queryKey: nodeDetailKeys.suggestions(blueprintId, nodeId),
    queryFn: () => getSuggestionsForNode(blueprintId, nodeId),
    refetchInterval,
  });

  // ── Dependent queries ────────────────────────────────────────

  // Derive running session ID from executions cache
  const executions = executionsQuery.data ?? [];
  const runningExec = executions.find(
    (e) => e.status === "running" && e.sessionId,
  );
  const runningSessionId = runningExec?.sessionId ?? null;

  // Dependent query intervals — use usePollingInterval for safety cap consistency
  const lastMessageInterval = usePollingInterval(() =>
    runningSessionId ? 5000 : false,
  );

  const lastMessageQuery = useQuery({
    queryKey: nodeDetailKeys.lastMessage(runningSessionId ?? "__none__"),
    queryFn: () => getLastSessionMessage(runningSessionId!),
    enabled: !!runningSessionId,
    refetchInterval: lastMessageInterval,
  });

  // Derive whether there are related ops for this node
  const pendingTasks = queueQuery.data?.pendingTasks ?? [];
  const hasRelatedOps = pendingTasks.some(
    (t) =>
      t.nodeId === nodeId &&
      (t.type === "enrich" ||
        t.type === "reevaluate" ||
        t.type === "split" ||
        t.type === "smart_deps" ||
        t.type === "evaluate"),
  );

  const activeRelatedInterval = usePollingInterval(() =>
    hasRelatedOps ? 5000 : false,
  );

  const activeRelatedSessionQuery = useQuery({
    queryKey: nodeDetailKeys.activeRelatedSession(blueprintId, nodeId),
    queryFn: () => getActiveRelatedSession(blueprintId, nodeId),
    enabled: hasRelatedOps,
    refetchInterval: activeRelatedInterval,
  });

  const relatedSessionId = activeRelatedSessionQuery.data?.sessionId ?? null;

  const relatedLastMsgInterval = usePollingInterval(() =>
    relatedSessionId ? 5000 : false,
  );

  const relatedLastMessageQuery = useQuery({
    queryKey: nodeDetailKeys.relatedLastMessage(relatedSessionId ?? "__none__"),
    queryFn: () => getLastSessionMessage(relatedSessionId!),
    enabled: !!relatedSessionId,
    refetchInterval: relatedLastMsgInterval,
  });

  // ── Derived data ─────────────────────────────────────────────

  const blueprint = blueprintQuery.data ?? null;
  const node = blueprint?.nodes.find((n) => n.id === nodeId) ?? null;

  // ── Helpers ──────────────────────────────────────────────────

  /** Invalidate all queries to force refetch */
  const invalidateAll = useCallback(() => {
    const keys: (readonly unknown[])[] = [
      blueprintKeys.detail(blueprintId),
      nodeDetailKeys.executions(blueprintId, nodeId),
      blueprintKeys.queue(blueprintId),
      nodeDetailKeys.relatedSessions(blueprintId, nodeId),
      nodeDetailKeys.suggestions(blueprintId, nodeId),
    ];
    // Dependent queries auto-refetch based on enabled state
    if (runningSessionId) {
      keys.push(nodeDetailKeys.lastMessage(runningSessionId));
    }
    if (hasRelatedOps) {
      keys.push(nodeDetailKeys.activeRelatedSession(blueprintId, nodeId));
    }
    invalidateKeys(queryClient, keys);
  }, [blueprintId, nodeId, runningSessionId, hasRelatedOps, queryClient]);

  /** Optimistically patch the node within the blueprint cache */
  const setNode = useCallback(
    (updater: MacroNode | ((prev: MacroNode | null) => MacroNode | null)) => {
      queryClient.setQueryData<Blueprint>(
        blueprintKeys.detail(blueprintId),
        (prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            nodes: prev.nodes.map((n) => {
              if (n.id !== nodeId) return n;
              const updated = typeof updater === "function" ? updater(n) : updater;
              return updated ?? n;
            }),
          };
        },
      );
    },
    [blueprintId, nodeId, queryClient],
  );

  /** Optimistically patch blueprint data in cache */
  const setBlueprint = useCallback(
    (updater: Blueprint | ((prev: Blueprint | undefined) => Blueprint | undefined)) => {
      queryClient.setQueryData<Blueprint>(blueprintKeys.detail(blueprintId), updater);
    },
    [blueprintId, queryClient],
  );

  return {
    // Query data
    blueprint,
    node,
    executions,
    pendingTasks,
    relatedSessions: relatedSessionsQuery.data ?? [],
    suggestions: suggestionsQuery.data ?? [],
    lastMessage: lastMessageQuery.data ?? null,
    activeRelatedSession: activeRelatedSessionQuery.data ?? null,
    relatedLastMessage: relatedLastMessageQuery.data ?? null,

    // Loading / error states (blueprint is critical for initial render)
    loading: blueprintQuery.isPending,
    error: blueprintQuery.error?.message ?? null,

    // Helpers
    invalidateAll,
    setNode,
    setBlueprint,
    queryClient,
  };
}
