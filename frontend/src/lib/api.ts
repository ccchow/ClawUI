const API_BASE = "/api";

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
}

export interface Suggestion {
  title: string;
  description: string;
  prompt: string;
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

export function getSessions(projectId: string): Promise<SessionMeta[]> {
  return fetchJSON(`${API_BASE}/projects/${encodeURIComponent(projectId)}/sessions`);
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
