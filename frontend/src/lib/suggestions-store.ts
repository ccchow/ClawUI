import type { Suggestion } from "./api";

const COOKIE_PREFIX = "clawui_sug_";
const MAX_AGE = 7 * 24 * 60 * 60; // 7 days

function cookieKey(sessionId: string): string {
  // Use first 8 chars of session ID to keep cookie name short
  return `${COOKIE_PREFIX}${sessionId.slice(0, 8)}`;
}

export function saveSuggestions(sessionId: string, suggestions: Suggestion[]): void {
  if (typeof document === "undefined" || suggestions.length === 0) return;
  try {
    const value = encodeURIComponent(JSON.stringify(suggestions));
    document.cookie = `${cookieKey(sessionId)}=${value}; path=/; max-age=${MAX_AGE}; SameSite=Lax`;
  } catch {
    // Silently fail if cookie write fails (e.g. size limit)
  }
}

export function loadSuggestions(sessionId: string): Suggestion[] {
  if (typeof document === "undefined") return [];
  try {
    const key = cookieKey(sessionId) + "=";
    const cookie = document.cookie
      .split("; ")
      .find((c) => c.startsWith(key));
    if (!cookie) return [];
    const value = decodeURIComponent(cookie.slice(key.length));
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
    return [];
  } catch {
    return [];
  }
}

export function clearSuggestions(sessionId: string): void {
  if (typeof document === "undefined") return;
  document.cookie = `${cookieKey(sessionId)}=; path=/; max-age=0`;
}
