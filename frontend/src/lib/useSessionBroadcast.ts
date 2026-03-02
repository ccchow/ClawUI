"use client";

import { useEffect, useCallback, useRef } from "react";

const CHANNEL_NAME = "clawui-session-runs";

interface SessionRunMessage {
  sessionId: string;
  action: "start" | "stop";
  timestamp: number;
}

/**
 * Cross-tab broadcast for session run state.
 *
 * When a session run starts/stops in one tab, broadcasts a message so other tabs
 * can immediately update their UI (disable/enable PromptInput).
 *
 * Returns a `broadcast` function to call when local run state changes.
 * The `onRunStateChange` callback is called when *another* tab broadcasts
 * a run state change for the same session.
 */
export function useSessionBroadcast(
  sessionId: string | undefined,
  onRunStateChange: (running: boolean) => void,
): (action: "start" | "stop") => void {
  const channelRef = useRef<BroadcastChannel | null>(null);
  const callbackRef = useRef(onRunStateChange);
  callbackRef.current = onRunStateChange;

  useEffect(() => {
    if (!sessionId) return;
    try {
      const channel = new BroadcastChannel(CHANNEL_NAME);
      channelRef.current = channel;
      channel.onmessage = (event: MessageEvent<SessionRunMessage>) => {
        if (event.data?.sessionId === sessionId) {
          callbackRef.current(event.data.action === "start");
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
  }, [sessionId]);

  return useCallback(
    (action: "start" | "stop") => {
      if (!sessionId) return;
      try {
        channelRef.current?.postMessage({
          sessionId,
          action,
          timestamp: Date.now(),
        } satisfies SessionRunMessage);
      } catch {
        // Graceful degradation
      }
    },
    [sessionId],
  );
}
