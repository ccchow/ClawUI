import { create } from "zustand";
import type {
  AGUIMessage,
  SessionStatus,
  A2UIPayload,
} from "./types";

export interface SessionState {
  sessionId: string;
  agentName: string;
  status: SessionStatus;
  currentStep: string | null;
  textBuffer: string;
  lastText: string;
  pendingA2UI: A2UIPayload | null;
  waitingReason: string | null;
  startedAt: string;
  finishedStatus: "success" | "failed" | null;
}

interface StoreState {
  sessions: Record<string, SessionState>;
  connected: boolean;
  setConnected: (connected: boolean) => void;
  handleMessage: (msg: AGUIMessage) => void;
  clearSession: (sessionId: string) => void;
  resolveA2UI: (sessionId: string) => void;
}

export const useStore = create<StoreState>((set) => ({
  sessions: {},
  connected: false,

  setConnected: (connected) => set({ connected }),

  handleMessage: (msg) =>
    set((state) => {
      const existing = state.sessions[msg.session_id];

      switch (msg.type) {
        case "RUN_STARTED": {
          const data = msg.data as { agent_name: string };
          return {
            sessions: {
              ...state.sessions,
              [msg.session_id]: {
                sessionId: msg.session_id,
                agentName: data.agent_name,
                status: "running",
                currentStep: null,
                textBuffer: "",
                lastText: "",
                pendingA2UI: null,
                waitingReason: null,
                startedAt: msg.timestamp,
                finishedStatus: null,
              },
            },
          };
        }

        case "TEXT_MESSAGE_CONTENT": {
          if (!existing) return state;
          const data = msg.data as { delta: string };
          return {
            sessions: {
              ...state.sessions,
              [msg.session_id]: {
                ...existing,
                textBuffer: existing.textBuffer + data.delta + "\n",
                lastText: data.delta,
              },
            },
          };
        }

        case "STEP_STARTED": {
          if (!existing) return state;
          const data = msg.data as { step_type: string; tool_name: string };
          return {
            sessions: {
              ...state.sessions,
              [msg.session_id]: {
                ...existing,
                status: "running",
                currentStep: data.tool_name,
              },
            },
          };
        }

        case "WAITING_FOR_HUMAN": {
          if (!existing) return state;
          const data = msg.data as {
            reason: string;
            a2ui_payload?: A2UIPayload;
          };
          return {
            sessions: {
              ...state.sessions,
              [msg.session_id]: {
                ...existing,
                status: "waiting",
                waitingReason: data.reason,
                pendingA2UI: data.a2ui_payload ?? null,
              },
            },
          };
        }

        case "RUN_FINISHED": {
          if (!existing) return state;
          const data = msg.data as { status: "success" | "failed" };
          return {
            sessions: {
              ...state.sessions,
              [msg.session_id]: {
                ...existing,
                status: "finished",
                currentStep: null,
                pendingA2UI: null,
                waitingReason: null,
                finishedStatus: data.status,
              },
            },
          };
        }

        default:
          return state;
      }
    }),

  clearSession: (sessionId) =>
    set((state) => {
      const { [sessionId]: _, ...rest } = state.sessions;
      return { sessions: rest };
    }),

  resolveA2UI: (sessionId) =>
    set((state) => {
      const existing = state.sessions[sessionId];
      if (!existing) return state;
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...existing,
            status: "running",
            pendingA2UI: null,
            waitingReason: null,
          },
        },
      };
    }),
}));
