/**
 * Shared polling interval utilities for TanStack Query refetchInterval callbacks.
 *
 * Extracts the dynamic interval + safety cap pattern used across
 * useBlueprintDetailQueries, useSessionDetailQueries, and useNodeDetailQueries.
 */

import type { MutableRefObject } from "react";
import { useCallback, useRef } from "react";
import type { QueryClient } from "@tanstack/react-query";

/** Maximum polling duration before auto-stop (35 minutes) */
export const POLL_SAFETY_CAP_MS = 35 * 60 * 1000;

/**
 * Computes a dynamic polling interval with safety cap.
 *
 * - When `activeInterval` is `false`, resets the timer and returns `false` (no polling).
 * - When `activeInterval` is a number, starts/continues the timer and returns
 *   the interval — unless the safety cap has been exceeded, in which case it
 *   resets the timer and returns `false`.
 *
 * @param pollStartRef  Mutable ref tracking when continuous polling began
 * @param activeInterval  The desired interval (ms) or `false` if polling should stop
 * @param maxDuration  Safety cap in ms (default: 35 min)
 */
export function createDynamicInterval(
  pollStartRef: MutableRefObject<number | null>,
  activeInterval: number | false,
  maxDuration = POLL_SAFETY_CAP_MS,
): number | false {
  if (activeInterval === false) {
    pollStartRef.current = null;
    return false;
  }

  if (!pollStartRef.current) pollStartRef.current = Date.now();
  if (Date.now() - pollStartRef.current > maxDuration) {
    pollStartRef.current = null;
    return false;
  }

  return activeInterval;
}

/**
 * Hook that creates a refetchInterval callback with built-in poll-start
 * tracking and safety cap via `createDynamicInterval`.
 *
 * Encapsulates the repeated `useRef<number | null>(null)` + `useCallback`
 * + `createDynamicInterval(pollStartRef, ...)` pattern from the query hooks.
 *
 * @param computeInterval  Called on each tick to determine the desired interval
 *   (number in ms) or `false` to stop polling. Stored in a ref so the returned
 *   callback identity is stable and doesn't cause unnecessary re-renders.
 */
export function usePollingInterval(
  computeInterval: () => number | false,
): () => number | false {
  const pollStartRef = useRef<number | null>(null);
  const computeRef = useRef(computeInterval);
  computeRef.current = computeInterval;

  return useCallback(
    () => createDynamicInterval(pollStartRef, computeRef.current()),
    [],
  );
}

/**
 * Invalidate multiple query keys on a QueryClient in one call.
 * Reduces the repetitive `queryClient.invalidateQueries({ queryKey })` pattern
 * found in every query hook's `invalidateAll` helper.
 */
export function invalidateKeys(
  queryClient: QueryClient,
  keys: readonly (readonly unknown[])[],
): void {
  for (const queryKey of keys) {
    queryClient.invalidateQueries({ queryKey });
  }
}
