"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type {
  Blueprint,
  BlueprintInsight,
  PendingTask,
  ConveneSession,
  QueueInfo,
} from "@/lib/api";
import {
  getBlueprint,
  getQueueStatus,
  fetchBlueprintInsights,
  getConveneSessions,
} from "@/lib/api";
import { usePollingInterval, invalidateKeys } from "@/lib/polling-utils";

// Query key factories — centralized for invalidation
export const blueprintKeys = {
  all: ["blueprints"] as const,
  list: (filters?: { includeArchived?: boolean; search?: string }) =>
    ["blueprints", "list", filters ?? {}] as const,
  detail: (id: string) => ["blueprint", id] as const,
  queue: (id: string) => ["blueprint", id, "queue"] as const,
  insights: (id: string) => ["blueprint", id, "insights"] as const,
  conveneSessions: (id: string) => ["blueprint", id, "conveneSessions"] as const,
};

/**
 * Determines if polling should be active based on query data.
 * Mirrors the original `shouldPoll` logic.
 */
function shouldPollBlueprint(bp: Blueprint | undefined, pendingTasks: PendingTask[]): boolean {
  if (!bp) return false;
  return (
    bp.status === "running" ||
    bp.nodes.some((n) => n.status === "running" || n.status === "queued") ||
    pendingTasks.length > 0
  );
}

/**
 * Custom hook that bundles all blueprint detail page queries with
 * coordinated dynamic polling (2s active convene / 5s normal / off when idle).
 *
 * Returns query results plus helpers for invalidation and optimistic updates.
 */
export function useBlueprintDetailQueries(
  blueprintId: string,
  autoRefresh: boolean,
) {
  const queryClient = useQueryClient();

  // Compute refetch interval from cached state.
  // This reads from the query cache so all four queries share the same
  // polling decision without circular deps.
  const refetchInterval = usePollingInterval(() => {
    if (!autoRefresh) return false;

    const bp = queryClient.getQueryData<Blueprint>(blueprintKeys.detail(blueprintId));
    const qi = queryClient.getQueryData<QueueInfo>(blueprintKeys.queue(blueprintId));
    const sessions = queryClient.getQueryData<ConveneSession[]>(blueprintKeys.conveneSessions(blueprintId));
    const pendingTasks = qi?.pendingTasks ?? [];

    const active = shouldPollBlueprint(bp, pendingTasks);
    if (!active) return false;

    const hasActiveConvene = sessions?.some(
      (s) => s.status === "active" || s.status === "synthesizing",
    ) ?? false;
    return hasActiveConvene ? 2000 : 5000;
  });

  // ── Blueprint query ──────────────────────────────────────────
  const blueprintQuery = useQuery({
    queryKey: blueprintKeys.detail(blueprintId),
    queryFn: () => getBlueprint(blueprintId),
    refetchInterval,
  });

  // ── Queue status query ───────────────────────────────────────
  const queueQuery = useQuery({
    queryKey: blueprintKeys.queue(blueprintId),
    queryFn: () => getQueueStatus(blueprintId),
    refetchInterval,
  });

  // ── Insights query ───────────────────────────────────────────
  const insightsQuery = useQuery({
    queryKey: blueprintKeys.insights(blueprintId),
    queryFn: () => fetchBlueprintInsights(blueprintId),
    refetchInterval,
  });

  // ── Convene sessions query ───────────────────────────────────
  const conveneQuery = useQuery({
    queryKey: blueprintKeys.conveneSessions(blueprintId),
    queryFn: () => getConveneSessions(blueprintId),
    refetchInterval,
  });

  // ── Helpers ──────────────────────────────────────────────────

  /** Invalidate all four queries (e.g. after a mutation or cross-tab broadcast) */
  const invalidateAll = useCallback(() => {
    invalidateKeys(queryClient, [
      blueprintKeys.detail(blueprintId),
      blueprintKeys.queue(blueprintId),
      blueprintKeys.insights(blueprintId),
      blueprintKeys.conveneSessions(blueprintId),
    ]);
  }, [blueprintId, queryClient]);

  /** Optimistically patch blueprint data in cache */
  const setBlueprint = useCallback(
    (updater: Blueprint | ((prev: Blueprint | undefined) => Blueprint | undefined)) => {
      queryClient.setQueryData<Blueprint>(blueprintKeys.detail(blueprintId), updater);
    },
    [blueprintId, queryClient],
  );

  /** Optimistically patch insights data in cache */
  const setInsights = useCallback(
    (updater: BlueprintInsight[] | ((prev: BlueprintInsight[]) => BlueprintInsight[])) => {
      if (typeof updater === "function") {
        queryClient.setQueryData<BlueprintInsight[]>(
          blueprintKeys.insights(blueprintId),
          (prev) => updater(prev ?? []),
        );
      } else {
        queryClient.setQueryData<BlueprintInsight[]>(blueprintKeys.insights(blueprintId), updater);
      }
    },
    [blueprintId, queryClient],
  );

  /** Optimistically patch convene sessions in cache */
  const setConveneSessions = useCallback(
    (updater: ConveneSession[] | ((prev: ConveneSession[]) => ConveneSession[])) => {
      if (typeof updater === "function") {
        queryClient.setQueryData<ConveneSession[]>(
          blueprintKeys.conveneSessions(blueprintId),
          (prev) => updater(prev ?? []),
        );
      } else {
        queryClient.setQueryData<ConveneSession[]>(blueprintKeys.conveneSessions(blueprintId), updater);
      }
    },
    [blueprintId, queryClient],
  );

  return {
    // Query data (with defaults for convenience)
    blueprint: blueprintQuery.data ?? null,
    pendingTasks: queueQuery.data?.pendingTasks ?? [],
    insights: insightsQuery.data ?? [],
    conveneSessions: conveneQuery.data ?? [],

    // Loading / error states (only blueprint is critical for initial render)
    loading: blueprintQuery.isPending,
    error: blueprintQuery.error?.message ?? null,

    // Helpers
    invalidateAll,
    setBlueprint,
    setInsights,
    setConveneSessions,
    queryClient,
  };
}
