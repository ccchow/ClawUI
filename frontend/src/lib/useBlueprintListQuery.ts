"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { Blueprint } from "@/lib/api";
import { listBlueprints, getBlueprint, getQueueStatus, fetchBlueprintInsights, getConveneSessions } from "@/lib/api";
import { blueprintKeys } from "@/lib/useBlueprintDetailQueries";

interface ListFilters {
  includeArchived?: boolean;
  search?: string;
}

/**
 * Custom hook for the blueprints list page.
 * Uses TanStack Query for data fetching with cache management.
 * Provides a prefetch helper to pre-cache blueprint detail data on hover.
 */
export function useBlueprintListQuery(filters: ListFilters) {
  const queryClient = useQueryClient();

  const listQuery = useQuery({
    queryKey: blueprintKeys.list(filters),
    queryFn: () => listBlueprints({ includeArchived: filters.includeArchived, search: filters.search || undefined }),
  });

  /** Optimistically patch the list data in cache (e.g. for star/archive) */
  const setBlueprints = useCallback(
    (updater: Blueprint[] | ((prev: Blueprint[] | undefined) => Blueprint[] | undefined)) => {
      queryClient.setQueryData<Blueprint[]>(blueprintKeys.list(filters), updater);
    },
    [filters, queryClient],
  );

  /** Invalidate the list query to force refetch */
  const invalidateList = useCallback(
    () => queryClient.invalidateQueries({ queryKey: blueprintKeys.all }),
    [queryClient],
  );

  /**
   * Prefetch blueprint detail data (blueprint + queue + insights + convene sessions)
   * so it's cached before the user navigates to the detail page.
   * Call this on link hover/focus for instant navigation.
   */
  const prefetchBlueprintDetail = useCallback(
    (blueprintId: string) => {
      queryClient.prefetchQuery({
        queryKey: blueprintKeys.detail(blueprintId),
        queryFn: () => getBlueprint(blueprintId),
        staleTime: 10_000, // prefetched data is fresh for 10s
      });
      queryClient.prefetchQuery({
        queryKey: blueprintKeys.queue(blueprintId),
        queryFn: () => getQueueStatus(blueprintId),
        staleTime: 10_000,
      });
      queryClient.prefetchQuery({
        queryKey: blueprintKeys.insights(blueprintId),
        queryFn: () => fetchBlueprintInsights(blueprintId),
        staleTime: 10_000,
      });
      queryClient.prefetchQuery({
        queryKey: blueprintKeys.conveneSessions(blueprintId),
        queryFn: () => getConveneSessions(blueprintId),
        staleTime: 10_000,
      });
    },
    [queryClient],
  );

  return {
    blueprints: listQuery.data ?? [],
    loading: listQuery.isPending,
    error: listQuery.error?.message ?? null,

    setBlueprints,
    invalidateList,
    prefetchBlueprintDetail,
    queryClient,
  };
}
