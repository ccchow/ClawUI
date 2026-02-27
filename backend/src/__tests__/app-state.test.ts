import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";

describe("app-state module", () => {
  const PROJECT_ROOT = join(import.meta.dirname, "..", "..", "..");
  const CLAWUI_DIR = join(PROJECT_ROOT, ".clawui");
  const STATE_PATH = join(CLAWUI_DIR, "app-state.json");

  let originalContent: string | null;

  beforeEach(() => {
    if (existsSync(STATE_PATH)) {
      originalContent = readFileSync(STATE_PATH, "utf-8");
    } else {
      originalContent = null;
    }
  });

  afterEach(() => {
    if (originalContent !== null) {
      writeFileSync(STATE_PATH, originalContent, "utf-8");
    } else if (existsSync(STATE_PATH)) {
      rmSync(STATE_PATH);
    }
  });

  it("getAppState returns default when file does not exist", async () => {
    if (existsSync(STATE_PATH)) rmSync(STATE_PATH);
    const { getAppState } = await import("../app-state.js");
    const state = getAppState();
    expect(state.version).toBe(1);
    expect(state.ui.theme).toBe("dark");
    expect(state.recentSessions).toEqual([]);
    expect(state.filters.hideArchivedSessions).toBe(true);
    expect(state.filters.defaultSort).toBe("updated_at");
  });

  it("getAppState returns default for malformed JSON", async () => {
    mkdirSync(CLAWUI_DIR, { recursive: true });
    writeFileSync(STATE_PATH, "broken json!", "utf-8");
    const { getAppState } = await import("../app-state.js");
    const state = getAppState();
    expect(state.version).toBe(1);
  });

  it("updateAppState merges UI fields", async () => {
    if (existsSync(STATE_PATH)) rmSync(STATE_PATH);
    const { updateAppState, getAppState } = await import("../app-state.js");

    updateAppState({ ui: { lastViewedProject: "proj1" } });
    const state = getAppState();
    expect(state.ui.theme).toBe("dark");
    expect(state.ui.lastViewedProject).toBe("proj1");
  });

  it("updateAppState merges filter fields", async () => {
    if (existsSync(STATE_PATH)) rmSync(STATE_PATH);
    const { updateAppState, getAppState } = await import("../app-state.js");

    updateAppState({ filters: { defaultSort: "created_at" } });
    const state = getAppState();
    expect(state.filters.defaultSort).toBe("created_at");
    expect(state.filters.hideArchivedSessions).toBe(true);
  });

  it("updateAppState replaces recentSessions array", async () => {
    if (existsSync(STATE_PATH)) rmSync(STATE_PATH);
    const { updateAppState, getAppState } = await import("../app-state.js");

    updateAppState({
      recentSessions: [{ id: "s1", viewedAt: "2024-01-01T00:00:00Z" }],
    });
    const state = getAppState();
    expect(state.recentSessions).toHaveLength(1);
    expect(state.recentSessions[0].id).toBe("s1");
  });

  it("trackSessionView adds session to front and deduplicates", async () => {
    if (existsSync(STATE_PATH)) rmSync(STATE_PATH);
    const { trackSessionView, getAppState } = await import("../app-state.js");

    trackSessionView("s1");
    trackSessionView("s2");
    trackSessionView("s1"); // should move to front

    const state = getAppState();
    expect(state.recentSessions[0].id).toBe("s1");
    expect(state.recentSessions[1].id).toBe("s2");
    expect(state.recentSessions).toHaveLength(2);
    expect(state.ui.lastViewedSession).toBe("s1");
  });

  it("trackSessionView trims to max 50 entries", async () => {
    if (existsSync(STATE_PATH)) rmSync(STATE_PATH);
    const { trackSessionView, getAppState } = await import("../app-state.js");

    // Add 55 sessions
    for (let i = 0; i < 55; i++) {
      trackSessionView(`session-${i}`);
    }
    const state = getAppState();
    expect(state.recentSessions.length).toBeLessThanOrEqual(50);
    // Most recent should be at front
    expect(state.recentSessions[0].id).toBe("session-54");
  });

  it("trackSessionView sets lastViewedSession in ui state", async () => {
    if (existsSync(STATE_PATH)) rmSync(STATE_PATH);
    const { trackSessionView, getAppState } = await import("../app-state.js");

    trackSessionView("session-abc");
    const state = getAppState();
    expect(state.ui.lastViewedSession).toBe("session-abc");
  });

  it("trackSessionView preserves viewedAt timestamps for other sessions", async () => {
    if (existsSync(STATE_PATH)) rmSync(STATE_PATH);
    const { trackSessionView, getAppState } = await import("../app-state.js");

    trackSessionView("s1");
    const state1 = getAppState();
    const s1ViewedAt = state1.recentSessions[0].viewedAt;

    trackSessionView("s2");
    const state2 = getAppState();
    // s2 is at front, s1 is second
    expect(state2.recentSessions[0].id).toBe("s2");
    expect(state2.recentSessions[1].id).toBe("s1");
    // s1's viewedAt should be preserved
    expect(state2.recentSessions[1].viewedAt).toBe(s1ViewedAt);
  });

  it("updateAppState with empty patch does not lose existing data", async () => {
    if (existsSync(STATE_PATH)) rmSync(STATE_PATH);
    const { updateAppState, getAppState } = await import("../app-state.js");

    // Set up initial state
    updateAppState({ ui: { theme: "light" }, filters: { defaultSort: "created_at" } });

    // Update with empty-ish patch (no ui, no filters, no recentSessions)
    const result = updateAppState({});
    expect(result.ui.theme).toBe("light");
    expect(result.filters.defaultSort).toBe("created_at");
  });

  it("updateAppState merges ui without overwriting other ui fields", async () => {
    if (existsSync(STATE_PATH)) rmSync(STATE_PATH);
    const { updateAppState, getAppState } = await import("../app-state.js");

    updateAppState({ ui: { theme: "light", lastViewedSession: "s1" } });
    updateAppState({ ui: { lastViewedProject: "p1" } });

    const state = getAppState();
    expect(state.ui.theme).toBe("light");
    expect(state.ui.lastViewedSession).toBe("s1");
    expect(state.ui.lastViewedProject).toBe("p1");
  });

  it("getAppState returns consistent defaults for new state", async () => {
    if (existsSync(STATE_PATH)) rmSync(STATE_PATH);
    const { getAppState } = await import("../app-state.js");

    const state = getAppState();
    expect(state).toEqual({
      version: 1,
      ui: { theme: "dark" },
      recentSessions: [],
      filters: { hideArchivedSessions: true, defaultSort: "updated_at" },
    });
  });

  it("updateAppState persists data to disk", async () => {
    if (existsSync(STATE_PATH)) rmSync(STATE_PATH);
    const { updateAppState } = await import("../app-state.js");

    updateAppState({ ui: { theme: "light" } });

    expect(existsSync(STATE_PATH)).toBe(true);
    const raw = JSON.parse(readFileSync(STATE_PATH, "utf-8"));
    expect(raw.ui.theme).toBe("light");
    expect(raw.version).toBe(1);
  });
});
