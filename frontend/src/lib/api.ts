const API_BASE = typeof window !== "undefined" ? "http://localhost:3001/api" : "/api";

export interface ProjectInfo {
  id: string;
  name: string;
  path: string;
  sessionCount: number;
}

export interface SessionMeta {
  sessionId: string;
  projectId: string;
  projectName: string;
  timestamp: string;
  nodeCount: number;
  slug?: string;
  cwd?: string;
  // Enrichment fields
  starred?: boolean;
  tags?: string[];
  alias?: string;
  notes?: string;
  archived?: boolean;
}

export interface TimelineNode {
  id: string;
  type: "user" | "assistant" | "tool_use" | "tool_result" | "error" | "system";
  timestamp: string;
  title: string;
  content: string;
  toolName?: string;
  toolInput?: string;
  toolResult?: string;
  toolUseId?: string;
  // Enrichment fields
  bookmarked?: boolean;
  annotation?: string;
}

export interface Suggestion {
  title: string;
  description: string;
  prompt: string;
}

export interface SessionFilters {
  starred?: boolean;
  tag?: string;
  archived?: boolean;
}

async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API error ${res.status}: ${body}`);
  }
  return res.json();
}

export function getProjects(): Promise<ProjectInfo[]> {
  return fetchJSON(`${API_BASE}/projects`);
}

export function getSessions(projectId: string, filters?: SessionFilters): Promise<SessionMeta[]> {
  const params = new URLSearchParams();
  if (filters?.starred) params.set("starred", "true");
  if (filters?.tag) params.set("tag", filters.tag);
  if (filters?.archived) params.set("archived", "true");
  const qs = params.toString();
  return fetchJSON(`${API_BASE}/projects/${encodeURIComponent(projectId)}/sessions${qs ? `?${qs}` : ""}`);
}

export function getTimeline(sessionId: string): Promise<TimelineNode[]> {
  return fetchJSON(`${API_BASE}/sessions/${sessionId}/timeline`);
}

export interface RunResult {
  output: string;
  suggestions: Suggestion[];
}

export function runPrompt(
  sessionId: string,
  prompt: string
): Promise<RunResult> {
  return fetchJSON(`${API_BASE}/sessions/${sessionId}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
}

// --- Enrichment APIs ---

export function updateSessionMeta(
  sessionId: string,
  patch: Partial<Pick<SessionMeta, "starred" | "tags" | "alias" | "notes" | "archived">>
): Promise<void> {
  return fetchJSON(`${API_BASE}/sessions/${sessionId}/meta`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export function updateNodeMeta(
  nodeId: string,
  patch: Partial<Pick<TimelineNode, "bookmarked" | "annotation">>
): Promise<void> {
  return fetchJSON(`${API_BASE}/nodes/${nodeId}/meta`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export function getTags(): Promise<string[]> {
  return fetchJSON(`${API_BASE}/tags`);
}

export function getAppState(): Promise<Record<string, unknown>> {
  return fetchJSON(`${API_BASE}/state`);
}

export function updateAppState(patch: Record<string, unknown>): Promise<void> {
  return fetchJSON(`${API_BASE}/state`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}
