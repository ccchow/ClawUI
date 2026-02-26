import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CLAWUI_DB_DIR } from "./config.js";

const PROJECT_ROOT = join(import.meta.dirname, "..", "..");
const CLAWUI_DIR = join(PROJECT_ROOT, CLAWUI_DB_DIR);
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

export function trackSessionView(sessionId: string): void {
  const state = getAppState();
  const now = new Date().toISOString();

  // Remove existing entry for this session
  state.recentSessions = state.recentSessions.filter((r) => r.id !== sessionId);

  // Add to front
  state.recentSessions.unshift({ id: sessionId, viewedAt: now });

  // Trim to max
  if (state.recentSessions.length > MAX_RECENT) {
    state.recentSessions = state.recentSessions.slice(0, MAX_RECENT);
  }

  state.ui.lastViewedSession = sessionId;
  saveAppState(state);
}
