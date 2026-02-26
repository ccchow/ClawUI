import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CLAWUI_DB_DIR } from "./config.js";

const CLAWUI_DIR = CLAWUI_DB_DIR;
const STATE_PATH = join(CLAWUI_DIR, "app-state.json");

export interface RecentSession {
  id: string;
  viewedAt: string;
}

export interface AppState {
  version: 1;
  ui: {
    theme?: string;
    lastViewedSession?: string;
    lastViewedProject?: string;
  };
  recentSessions: RecentSession[];
  filters: {
    hideArchivedSessions?: boolean;
    defaultSort?: string;
  };
}

function defaultAppState(): AppState {
  return {
    version: 1,
    ui: { theme: "dark" },
    recentSessions: [],
    filters: { hideArchivedSessions: true, defaultSort: "updated_at" },
  };
}

export function getAppState(): AppState {
  if (!existsSync(STATE_PATH)) return defaultAppState();
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf-8")) as AppState;
  } catch {
    return defaultAppState();
  }
}

function saveAppState(state: AppState): void {
  if (!existsSync(CLAWUI_DIR)) mkdirSync(CLAWUI_DIR, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

export function updateAppState(patch: Partial<Omit<AppState, "version">>): AppState {
  const state = getAppState();

  if (patch.ui) {
    state.ui = { ...state.ui, ...patch.ui };
  }
  if (patch.filters) {
    state.filters = { ...state.filters, ...patch.filters };
  }
  if (patch.recentSessions !== undefined) {
    state.recentSessions = patch.recentSessions;
  }

  saveAppState(state);
  return state;
}

const MAX_RECENT = 50;

/** In-memory dedup: skip disk write if we just tracked this session. */
let lastTrackedSessionId: string | null = null;
let lastTrackedAt = 0;
const TRACK_DEBOUNCE_MS = 10_000; // Only write once per 10s per session

export function trackSessionView(sessionId: string): void {
  const now = Date.now();
  if (sessionId === lastTrackedSessionId && now - lastTrackedAt < TRACK_DEBOUNCE_MS) {
    return; // Skip redundant disk write
  }

  const state = getAppState();
  const isoNow = new Date().toISOString();

  // Remove existing entry for this session
  state.recentSessions = state.recentSessions.filter((r) => r.id !== sessionId);

  // Add to front
  state.recentSessions.unshift({ id: sessionId, viewedAt: isoNow });

  // Trim to max
  if (state.recentSessions.length > MAX_RECENT) {
    state.recentSessions = state.recentSessions.slice(0, MAX_RECENT);
  }

  state.ui.lastViewedSession = sessionId;
  saveAppState(state);

  lastTrackedSessionId = sessionId;
  lastTrackedAt = now;
}
