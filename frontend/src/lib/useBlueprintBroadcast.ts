"use client";

import { useEffect, useCallback, useRef } from "react";

const CHANNEL_NAME = "clawui-blueprint-ops";

export type BroadcastOpType =
  | "run"
  | "enrich"
  | "reevaluate"
  | "split"
  | "smart_deps"
  | "generate"
  | "run_all"
  | "reevaluate_all"
  | "resume"
  | "coordinate"
  | "convene";

interface BlueprintBroadcastMessage {
  blueprintId: string;
  nodeId?: string;
  type: BroadcastOpType;
  timestamp: number;
}

/**
 * Cross-tab broadcast for blueprint operations.
 *
 * When an operation starts in one tab, broadcasts a message so other tabs
 * can immediately fetch fresh data and activate polling. This bridges the
 * gap where dormant tabs wouldn't know to start polling.
 *
 * Returns a `broadcast` function to call after firing operations.
 * The `onOperationDetected` callback is called when *another* tab
 * broadcasts an operation for the same blueprint.
 *
 * Gracefully degrades: if BroadcastChannel is unavailable, the broadcast
 * function is a no-op and no listener is set up.
 */
export function useBlueprintBroadcast(
  blueprintId: string | undefined,
  onOperationDetected: () => void,
): (type: BroadcastOpType, nodeId?: string) => void {
  const channelRef = useRef<BroadcastChannel | null>(null);
  const callbackRef = useRef(onOperationDetected);
  callbackRef.current = onOperationDetected;

  useEffect(() => {
    if (!blueprintId) return;
    try {
      const channel = new BroadcastChannel(CHANNEL_NAME);
      channelRef.current = channel;
      channel.onmessage = (event: MessageEvent<BlueprintBroadcastMessage>) => {
        if (event.data?.blueprintId === blueprintId) {
          callbackRef.current();
        }
      };
      return () => {
        channel.close();
        channelRef.current = null;
      };
    } catch {
      // BroadcastChannel not available — graceful degradation
      return;
    }
  }, [blueprintId]);

  return useCallback(
    (type: BroadcastOpType, nodeId?: string) => {
      if (!blueprintId) return;
      try {
        channelRef.current?.postMessage({
          blueprintId,
          nodeId,
          type,
          timestamp: Date.now(),
        } satisfies BlueprintBroadcastMessage);
      } catch {
        // Graceful degradation
      }
    },
    [blueprintId],
  );
}
