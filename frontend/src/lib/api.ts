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

// --- Blueprint / Plan types ---

export type BlueprintStatus = "draft" | "approved" | "running" | "paused" | "done" | "failed";
export type MacroNodeStatus = "pending" | "running" | "done" | "failed" | "blocked" | "skipped";

export interface Artifact {
  id: string;
  type: "handoff_summary" | "file_diff" | "test_report" | "custom";
  content: string;
  sourceNodeId: string;
  targetNodeId?: string;
  blueprintId: string;
  createdAt: string;
}

export interface NodeExecution {
  id: string;
  nodeId: string;
  blueprintId: string;
  sessionId?: string;
  type: "primary" | "retry" | "continuation" | "subtask";
  status: "running" | "done" | "failed" | "cancelled";
  inputContext?: string;
  outputSummary?: string;
  contextTokensUsed?: number;
  parentExecutionId?: string;
  startedAt: string;
  completedAt?: string;
}

export interface MacroNode {
  id: string;
  blueprintId: string;
  order: number;
  title: string;
  description: string;
  status: MacroNodeStatus;
  dependencies: string[];
  parallelGroup?: string;
  prompt?: string;
  estimatedMinutes?: number;
  actualMinutes?: number;
  inputArtifacts: Artifact[];
  outputArtifacts: Artifact[];
  executions: NodeExecution[];
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Blueprint {
  id: string;
  title: string;
  description: string;
  projectCwd?: string;
  status: BlueprintStatus;
  nodes: MacroNode[];
  createdAt: string;
  updatedAt: string;
}

// --- Blueprint APIs ---

export function listBlueprints(filters?: { status?: string; projectCwd?: string }): Promise<Blueprint[]> {
  const params = new URLSearchParams();
  if (filters?.status) params.set("status", filters.status);
  if (filters?.projectCwd) params.set("projectCwd", filters.projectCwd);
  const qs = params.toString();
  return fetchJSON(`${API_BASE}/blueprints${qs ? `?${qs}` : ""}`);
}

export function getBlueprint(id: string): Promise<Blueprint> {
  return fetchJSON(`${API_BASE}/blueprints/${encodeURIComponent(id)}`);
}

export function createBlueprint(data: {
  title: string;
  description?: string;
  projectCwd?: string;
}): Promise<Blueprint> {
  return fetchJSON(`${API_BASE}/blueprints`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export function updateBlueprint(
  id: string,
  patch: Partial<Pick<Blueprint, "title" | "description" | "status" | "projectCwd">>
): Promise<Blueprint> {
  return fetchJSON(`${API_BASE}/blueprints/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export function deleteBlueprint(id: string): Promise<{ ok: boolean }> {
  return fetchJSON(`${API_BASE}/blueprints/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function approveBlueprint(id: string): Promise<Blueprint> {
  return fetchJSON(`${API_BASE}/blueprints/${encodeURIComponent(id)}/approve`, {
    method: "POST",
  });
}

export function createMacroNode(
  blueprintId: string,
  data: {
    title: string;
    description?: string;
    order?: number;
    dependencies?: string[];
    parallelGroup?: string;
    prompt?: string;
    estimatedMinutes?: number;
  }
): Promise<MacroNode> {
  return fetchJSON(`${API_BASE}/blueprints/${encodeURIComponent(blueprintId)}/nodes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export function updateMacroNode(
  blueprintId: string,
  nodeId: string,
  patch: Partial<Pick<MacroNode, "title" | "description" | "status" | "dependencies" | "order" | "prompt">>
): Promise<MacroNode> {
  return fetchJSON(
    `${API_BASE}/blueprints/${encodeURIComponent(blueprintId)}/nodes/${encodeURIComponent(nodeId)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }
  );
}

export function deleteMacroNode(
  blueprintId: string,
  nodeId: string
): Promise<{ ok: boolean }> {
  return fetchJSON(
    `${API_BASE}/blueprints/${encodeURIComponent(blueprintId)}/nodes/${encodeURIComponent(nodeId)}`,
    { method: "DELETE" }
  );
}

// --- AI Generation APIs ---

export function generatePlan(blueprintId: string, description?: string): Promise<MacroNode[]> {
  return fetchJSON(`${API_BASE}/blueprints/${encodeURIComponent(blueprintId)}/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ description }),
  });
}

// --- Execution APIs ---

export function runNode(
  blueprintId: string,
  nodeId: string
): Promise<NodeExecution> {
  return fetchJSON(
    `${API_BASE}/blueprints/${encodeURIComponent(blueprintId)}/nodes/${encodeURIComponent(nodeId)}/run`,
    { method: "POST" }
  );
}

export function runNextNode(
  blueprintId: string
): Promise<NodeExecution | { message: string }> {
  return fetchJSON(
    `${API_BASE}/blueprints/${encodeURIComponent(blueprintId)}/run`,
    { method: "POST" }
  );
}

export function runAllNodes(
  blueprintId: string
): Promise<{ message: string; blueprintId: string }> {
  return fetchJSON(
    `${API_BASE}/blueprints/${encodeURIComponent(blueprintId)}/run-all`,
    { method: "POST" }
  );
}
