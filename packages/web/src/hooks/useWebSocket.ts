"use client";

import { useEffect, useRef, useCallback } from "react";
import { useStore } from "@/lib/store";
import type { AGUIMessage, HumanAction } from "@/lib/types";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:4800";
const RECONNECT_INTERVAL = 3000;
const MAX_RECONNECT_ATTEMPTS = 20;

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptCount = useRef(0);
  const { setConnected, handleMessage } = useStore();

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    try {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        attemptCount.current = 0;
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as AGUIMessage;
          if (msg.type && msg.session_id) {
            handleMessage(msg);
          }
        } catch {
          // ignore malformed messages
        }
      };

      ws.onclose = () => {
        setConnected(false);
        wsRef.current = null;
        scheduleReconnect();
      };

      ws.onerror = () => {
        ws.close();
      };
    } catch {
      scheduleReconnect();
    }
  }, [setConnected, handleMessage]);

  const scheduleReconnect = useCallback(() => {
    if (attemptCount.current >= MAX_RECONNECT_ATTEMPTS) return;
    if (reconnectTimer.current) return;

    attemptCount.current++;
    reconnectTimer.current = setTimeout(() => {
      reconnectTimer.current = null;
      connect();
    }, RECONNECT_INTERVAL);
  }, [connect]);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const sendAction = useCallback((action: HumanAction) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(action));
    }
  }, []);

  return { sendAction };
}
