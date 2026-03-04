"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type {
  TimelineNode,
  SessionMeta,
  SessionStatus,
  Blueprint,
  MacroNode,
} from "@/lib/api";
import {
  getTimeline,
  getSessionMeta,
  getSessionStatus,
  getSessionExecution,
  getBlueprint,
} from "@/lib/api";
import { usePollingInterval, invalidateKeys } from "@/lib/polling-utils";

// Query key factories — centralized for invalidation
export const sessionKeys = {
  timeline: (id: string) => ["session", id, "timeline"] as const,
  meta: (id: string) => ["session", id, "meta"] as const,
  status: (id: string) => ["session", id, "status"] as const,
  blueprintContext: (id: string) => ["session", id, "blueprintContext"] as const,
};

export interface BlueprintContext {
  blueprint: Blueprint;
  node: MacroNode;
  nodeIndex: number;
}

/**
 * Custom hook that bundles all session detail page queries with
 * coordinated dynamic polling (2s during runs / 5s normal / off when idle).
 *
 * Returns query results plus helpers for invalidation and optimistic updates.
 */
export function useSessionDetailQueries(
  sessionId: string,
  autoRefresh: boolean,
  localRunning: boolean,
) {
  const queryClient = useQueryClient();

  // Dynamic timeline interval: 2s when running, 5s normal, off when idle
  const getTimelineInterval = usePollingInterval(() => {
    if (!autoRefresh) return false;

    if (localRunning) return 2000;
    const status = queryClient.getQueryData<SessionStatus>(sessionKeys.status(sessionId));
    if (status?.running) return 2000;
    return 5000;
  });

  // Status polling: 2s when remote running, 5s normal, off when locally running
  const getStatusInterval = usePollingInterval(() => {
    if (!autoRefresh || localRunning) return false;
    const status = queryClient.getQueryData<SessionStatus>(sessionKeys.status(sessionId));
    if (status?.running) return 2000;
    return 5000;
  });

  // ── Timeline query ────────────────────────────────────────────
  const timelineQuery = useQuery({
    queryKey: sessionKeys.timeline(sessionId),
    queryFn: () => getTimeline(sessionId),
    refetchInterval: getTimelineInterval,
  });

  // ── Meta query (loaded once, updated optimistically) ──────────
  const metaQuery = useQuery({
    queryKey: sessionKeys.meta(sessionId),
    queryFn: () => getSessionMeta(sessionId),
  });

  // ── Session status (detect remote runs) ───────────────────────
  const statusQuery = useQuery({
    queryKey: sessionKeys.status(sessionId),
    queryFn: () => getSessionStatus(sessionId),
    refetchInterval: getStatusInterval,
  });

  // ── Blueprint context (loaded once) ───────────────────────────
  const blueprintContextQuery = useQuery({
    queryKey: sessionKeys.blueprintContext(sessionId),
    queryFn: async (): Promise<BlueprintContext | null> => {
      const execution = await getSessionExecution(sessionId);
      if (!execution) return null;
      const bp = await getBlueprint(execution.blueprintId);
      const node = bp.nodes.find((n) => n.id === execution.nodeId);
      if (!node) return null;
      const nodeIndex = bp.nodes.findIndex((n) => n.id === execution.nodeId);
      return { blueprint: bp, node, nodeIndex };
    },
    staleTime: Infinity,
  });

  // Derived: remote running = status says running but not locally running
  const remoteRunning = !localRunning && (statusQuery.data?.running ?? false);

  // ── Helpers ──────────────────────────────────────────────────

  /** Optimistically set timeline data in cache */
  const setTimeline = useCallback(
    (updater: TimelineNode[] | ((prev: TimelineNode[] | undefined) => TimelineNode[] | undefined)) => {
      queryClient.setQueryData<TimelineNode[]>(sessionKeys.timeline(sessionId), updater);
    },
    [sessionId, queryClient],
  );

  /** Optimistically set meta data in cache */
  const setMeta = useCallback(
    (updater: Partial<SessionMeta> | null | ((prev: Partial<SessionMeta> | null | undefined) => Partial<SessionMeta> | null | undefined)) => {
      queryClient.setQueryData(sessionKeys.meta(sessionId), updater);
    },
    [sessionId, queryClient],
  );

  /** Directly set status data in cache (e.g. from broadcast channel) */
  const setStatus = useCallback(
    (status: SessionStatus) => {
      queryClient.setQueryData(sessionKeys.status(sessionId), status);
    },
    [sessionId, queryClient],
  );

  /** Invalidate timeline query to force refetch */
  const invalidateTimeline = useCallback(
    () => queryClient.invalidateQueries({ queryKey: sessionKeys.timeline(sessionId) }),
    [sessionId, queryClient],
  );

  /** Invalidate all session queries */
  const invalidateAll = useCallback(() => {
    invalidateKeys(queryClient, [
      sessionKeys.timeline(sessionId),
      sessionKeys.meta(sessionId),
      sessionKeys.status(sessionId),
    ]);
  }, [sessionId, queryClient]);

  return {
    // Query data
    nodes: timelineQuery.data ?? [],
    sessionMeta: metaQuery.data ?? null,
    blueprintContext: blueprintContextQuery.data ?? null,
    remoteRunning,

    // Loading / error states
    loading: timelineQuery.isPending || metaQuery.isPending,
    error: timelineQuery.error?.message ?? null,

    // Last update timestamp (for "Xm ago" label)
    dataUpdatedAt: timelineQuery.dataUpdatedAt,

    // Helpers
    setTimeline,
    setMeta,
    setStatus,
    invalidateTimeline,
    invalidateAll,
    queryClient,
  };
}
