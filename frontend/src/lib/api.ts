const API_BASE = "/api";

function getAuthToken(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("clawui_token") || "";
}

function authHeaders(): Record<string, string> {
  const token = getAuthToken();
  return token ? { "x-clawui-token": token } : {};
}

export type AgentType = "claude" | "openclaw" | "pi" | "codex";

export interface AgentInfo {
  name: string;
  type: AgentType;
  available: boolean;
  sessionsPath: string;
  sessionCount: number;
}

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
  agentType?: AgentType;
  // Enrichment fields
  starred?: boolean;
  tags?: string[];
  alias?: string;
  notes?: string;
  archived?: boolean;
  // Macro node association (if session is linked to a blueprint node)
  macroNodeTitle?: string;
  macroNodeDescription?: string;
  macroNodeBlueprintId?: string;
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
  const headers: Record<string, string> = {
    ...authHeaders(),
    ...(init?.headers as Record<string, string> | undefined),
  };
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    // If the backend returns 403, the auth token is stale (rotated on restart).
    // Clear it so AuthProvider shows the unauthorized screen on next check.
    if (res.status === 403 && typeof window !== "undefined") {
      localStorage.removeItem("clawui_token");
      window.location.reload();
    }
    const body = await res.text();
    throw new Error(`API error ${res.status}: ${body}`);
  }
  return res.json();
}

export function getAgents(): Promise<AgentInfo[]> {
  return fetchJSON(`${API_BASE}/agents`);
}

// --- Role APIs ---

export interface RoleInfo {
  id: string;
  label: string;
  description: string;
  icon?: string;
  builtin: boolean;
  artifactTypes: string[];
  blockerTypes: string[];
}

export function fetchRoles(): Promise<RoleInfo[]> {
  return fetchJSON(`${API_BASE}/roles`);
}

export function fetchRole(id: string): Promise<RoleInfo> {
  return fetchJSON(`${API_BASE}/roles/${encodeURIComponent(id)}`);
}

export function getProjects(agentType?: AgentType): Promise<ProjectInfo[]> {
  const params = new URLSearchParams();
  if (agentType) params.set("agent", agentType);
  const qs = params.toString();
  return fetchJSON(`${API_BASE}/projects${qs ? `?${qs}` : ""}`);
}

export function getSessions(projectId: string, filters?: SessionFilters, agentType?: AgentType): Promise<SessionMeta[]> {
  const params = new URLSearchParams();
  if (filters?.starred) params.set("starred", "true");
  if (filters?.tag) params.set("tag", filters.tag);
  if (filters?.archived) params.set("archived", "true");
  if (agentType) params.set("agent", agentType);
  const qs = params.toString();
  return fetchJSON(`${API_BASE}/projects/${encodeURIComponent(projectId)}/sessions${qs ? `?${qs}` : ""}`);
}

export function getTimeline(sessionId: string): Promise<TimelineNode[]> {
  return fetchJSON(`${API_BASE}/sessions/${sessionId}/timeline`);
}

export function getLastSessionMessage(sessionId: string): Promise<TimelineNode> {
  return fetchJSON(`${API_BASE}/sessions/${sessionId}/last-message`);
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

export interface SessionStatus {
  running: boolean;
}

export function getSessionStatus(sessionId: string): Promise<SessionStatus> {
  return fetchJSON(`${API_BASE}/sessions/${sessionId}/status`);
}

export function getSessionMeta(
  sessionId: string
): Promise<Partial<SessionMeta> | null> {
  return fetch(`${API_BASE}/sessions/${sessionId}/meta`, {
    headers: authHeaders(),
  })
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null);
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
export type MacroNodeStatus = "pending" | "queued" | "running" | "done" | "failed" | "blocked" | "skipped";
export type ExecutionMode = "manual" | "autopilot" | "fsd";

export interface Artifact {
  id: string;
  type: string;
  content: string;
  sourceNodeId: string;
  targetNodeId?: string;
  blueprintId: string;
  createdAt: string;
}

export type FailureReason = "timeout" | "context_exhausted" | "output_token_limit" | "hung" | "error" | null;

export type ContextPressure = "none" | "moderate" | "high" | "critical";

export type ReportedStatus = "done" | "failed" | "blocked" | null;

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
  cliPid?: number;
  blockerInfo?: string;
  taskSummary?: string;
  failureReason?: FailureReason;
  reportedStatus?: ReportedStatus;
  reportedReason?: string;
  compactCount?: number;
  peakTokens?: number;
  contextPressure?: ContextPressure;
  startedAt: string;
  completedAt?: string;
}

export interface SessionHealth {
  failureReason: FailureReason;
  detail: string;
  compactCount: number;
  peakTokens: number;
  lastApiError: string | null;
  messageCount: number;
}

export interface MacroNode {
  id: string;
  blueprintId: string;
  order: number;
  seq: number;
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
  agentType?: AgentType;
  roles?: string[];
  suggestionCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface Blueprint {
  id: string;
  title: string;
  description: string;
  projectCwd?: string;
  status: BlueprintStatus;
  starred?: boolean;
  archivedAt?: string;
  agentType?: AgentType;
  agentParams?: string;
  enabledRoles?: string[];
  defaultRole?: string;
  executionMode?: ExecutionMode;
  maxIterations?: number;
  pauseReason?: string;
  conveneSessionCount?: number;
  nodes: MacroNode[];
  createdAt: string;
  updatedAt: string;
}

// --- Blueprint APIs ---

export function listBlueprints(filters?: { status?: string; projectCwd?: string; includeArchived?: boolean; search?: string }): Promise<Blueprint[]> {
  const params = new URLSearchParams();
  if (filters?.status) params.set("status", filters.status);
  if (filters?.projectCwd) params.set("projectCwd", filters.projectCwd);
  if (filters?.includeArchived) params.set("includeArchived", "true");
  if (filters?.search) params.set("search", filters.search);
  const qs = params.toString();
  return fetchJSON(`${API_BASE}/blueprints${qs ? `?${qs}` : ""}`);
}

export function getBlueprint(id: string, options?: { search?: string }): Promise<Blueprint> {
  const params = new URLSearchParams();
  if (options?.search) params.set("search", options.search);
  const qs = params.toString();
  return fetchJSON(`${API_BASE}/blueprints/${encodeURIComponent(id)}${qs ? `?${qs}` : ""}`);
}

export function createBlueprint(data: {
  title: string;
  description?: string;
  projectCwd?: string;
  agentType?: AgentType;
  agentParams?: string;
  enabledRoles?: string[];
  defaultRole?: string;
}): Promise<Blueprint> {
  return fetchJSON(`${API_BASE}/blueprints`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export function updateBlueprint(
  id: string,
  patch: Partial<Pick<Blueprint, "title" | "description" | "status" | "projectCwd" | "agentType" | "agentParams" | "enabledRoles" | "defaultRole" | "executionMode" | "maxIterations" | "pauseReason">>
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

export function archiveBlueprint(id: string): Promise<Blueprint> {
  return fetchJSON(`${API_BASE}/blueprints/${encodeURIComponent(id)}/archive`, {
    method: "POST",
  });
}

export function unarchiveBlueprint(id: string): Promise<Blueprint> {
  return fetchJSON(`${API_BASE}/blueprints/${encodeURIComponent(id)}/unarchive`, {
    method: "POST",
  });
}

export function starBlueprint(id: string): Promise<Blueprint> {
  return fetchJSON(`${API_BASE}/blueprints/${encodeURIComponent(id)}/star`, {
    method: "POST",
  });
}

export function unstarBlueprint(id: string): Promise<Blueprint> {
  return fetchJSON(`${API_BASE}/blueprints/${encodeURIComponent(id)}/unstar`, {
    method: "POST",
  });
}

export function approveBlueprint(id: string): Promise<Blueprint> {
  return fetchJSON(`${API_BASE}/blueprints/${encodeURIComponent(id)}/approve`, {
    method: "POST",
  });
}

export function enrichNode(
  blueprintId: string,
  data: { title: string; description?: string; nodeId?: string }
): Promise<{ title: string; description: string } | { status: string; nodeId: string }> {
  return fetchJSON(`${API_BASE}/blueprints/${encodeURIComponent(blueprintId)}/enrich-node`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export function smartPickDependencies(
  blueprintId: string,
  nodeId: string
): Promise<{ status: string; nodeId: string }> {
  return fetchJSON(
    `${API_BASE}/blueprints/${encodeURIComponent(blueprintId)}/nodes/${encodeURIComponent(nodeId)}/smart-dependencies`,
    { method: "POST" }
  );
}

export function reevaluateNode(
  blueprintId: string,
  nodeId: string
): Promise<{ status: string; nodeId: string }> {
  return fetchJSON(`${API_BASE}/blueprints/${encodeURIComponent(blueprintId)}/nodes/${encodeURIComponent(nodeId)}/reevaluate`, {
    method: "POST",
  });
}

export function reevaluateAllNodes(
  blueprintId: string
): Promise<{ message: string; blueprintId: string; nodeCount: number }> {
  return fetchJSON(
    `${API_BASE}/blueprints/${encodeURIComponent(blueprintId)}/reevaluate-all`,
    { method: "POST" }
  );
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
    agentType?: AgentType;
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
  patch: Partial<Pick<MacroNode, "title" | "description" | "status" | "dependencies" | "order" | "prompt" | "agentType" | "roles">>
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

export function generatePlan(blueprintId: string, description?: string): Promise<{ status: string; blueprintId: string }> {
  return fetchJSON(`${API_BASE}/blueprints/${encodeURIComponent(blueprintId)}/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ description }),
  });
}

// --- Execution APIs ---

export function getSessionExecution(
  sessionId: string
): Promise<NodeExecution | null> {
  return fetch(`${API_BASE}/sessions/${sessionId}/execution`, {
    headers: authHeaders(),
  })
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null);
}

export function runNode(
  blueprintId: string,
  nodeId: string
): Promise<{ status: string; nodeId: string }> {
  return fetchJSON(
    `${API_BASE}/blueprints/${encodeURIComponent(blueprintId)}/nodes/${encodeURIComponent(nodeId)}/run`,
    { method: "POST" }
  );
}

export function recoverNodeSession(
  blueprintId: string,
  nodeId: string
): Promise<{ recovered: boolean; recoveredCount?: number; reason?: string }> {
  return fetchJSON(
    `${API_BASE}/blueprints/${encodeURIComponent(blueprintId)}/nodes/${encodeURIComponent(nodeId)}/recover-session`,
    { method: "POST" }
  );
}

export function resumeNodeSession(
  blueprintId: string,
  nodeId: string,
  executionId: string
): Promise<{ status: string }> {
  return fetchJSON(
    `${API_BASE}/blueprints/${encodeURIComponent(blueprintId)}/nodes/${encodeURIComponent(nodeId)}/resume-session`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ executionId }),
    }
  );
}

export function getNodeExecutions(
  blueprintId: string,
  nodeId: string
): Promise<NodeExecution[]> {
  return fetchJSON(
    `${API_BASE}/blueprints/${encodeURIComponent(blueprintId)}/nodes/${encodeURIComponent(nodeId)}/executions`
  );
}

export type RelatedSessionType = "enrich" | "reevaluate" | "split" | "evaluate" | "reevaluate_all" | "generate" | "smart_deps" | "coordinate";

export interface RelatedSession {
  id: string;
  nodeId: string;
  blueprintId: string;
  sessionId: string;
  type: RelatedSessionType;
  startedAt: string;
  completedAt?: string;
}

export function getRelatedSessions(
  blueprintId: string,
  nodeId: string
): Promise<RelatedSession[]> {
  return fetchJSON(
    `${API_BASE}/blueprints/${encodeURIComponent(blueprintId)}/nodes/${encodeURIComponent(nodeId)}/related-sessions`
  );
}

export function getActiveRelatedSession(
  blueprintId: string,
  nodeId: string
): Promise<RelatedSession | null> {
  return fetchJSON(
    `${API_BASE}/blueprints/${encodeURIComponent(blueprintId)}/nodes/${encodeURIComponent(nodeId)}/active-related-session`
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
  blueprintId: string,
  options?: { safeguardGrace?: number }
): Promise<{ message: string; blueprintId: string }> {
  return fetchJSON(
    `${API_BASE}/blueprints/${encodeURIComponent(blueprintId)}/run-all`,
    {
      method: "POST",
      headers: options ? { "Content-Type": "application/json" } : undefined,
      body: options ? JSON.stringify(options) : undefined,
    }
  );
}

// --- Queue Status API ---

export interface PendingTask {
  type: "run" | "reevaluate" | "enrich" | "generate" | "split" | "smart_deps" | "evaluate" | "coordinate" | "convene" | "autopilot";
  nodeId?: string;
  blueprintId: string;
  queuedAt: string;
}

export interface QueueInfo {
  running: boolean;
  queueLength: number;
  pendingTasks: PendingTask[];
}

export function unqueueNode(blueprintId: string, nodeId: string): Promise<{ status: string }> {
  return fetchJSON(
    `${API_BASE}/blueprints/${encodeURIComponent(blueprintId)}/nodes/${encodeURIComponent(nodeId)}/unqueue`,
    { method: "POST" }
  );
}

export function splitNode(
  blueprintId: string,
  nodeId: string
): Promise<{ status: string; nodeId: string }> {
  return fetchJSON(
    `${API_BASE}/blueprints/${encodeURIComponent(blueprintId)}/nodes/${encodeURIComponent(nodeId)}/split`,
    { method: "POST" }
  );
}

export function getQueueStatus(blueprintId: string): Promise<QueueInfo> {
  return fetchJSON(`${API_BASE}/blueprints/${encodeURIComponent(blueprintId)}/queue`);
}

// ─── Global queue status ──────────────────────────────────────

export interface GlobalQueueTask {
  blueprintId: string;
  type: string;
  nodeId?: string;
  nodeTitle?: string;
  blueprintTitle?: string;
  sessionId?: string;
  queuePosition?: number;
}

export interface GlobalQueueInfo {
  active: boolean;
  totalPending: number;
  tasks: GlobalQueueTask[];
}

export function getGlobalStatus(): Promise<GlobalQueueInfo> {
  return fetchJSON(`${API_BASE}/global-status`);
}

// ─── Dev Tools ────────────────────────────────────────────────

export function getDevStatus(): Promise<{ devMode: boolean }> {
  return fetchJSON(`${API_BASE}/dev/status`);
}

export function redeployStable(): Promise<{ ok: boolean; message: string }> {
  return fetchJSON(`${API_BASE}/dev/redeploy`, { method: "POST" });
}

// ─── Session health ───────────────────────────────────────────

export function getSessionHealth(sessionId: string): Promise<SessionHealth> {
  return fetchJSON(`${API_BASE}/sessions/${sessionId}/health`);
}

// ─── Node Suggestions ─────────────────────────────────────────

export interface NodeSuggestion {
  id: string;
  nodeId: string;
  blueprintId: string;
  title: string;
  description: string;
  used: boolean;
  roles?: string[];
  createdAt: string;
}

export function getSuggestionsForNode(
  blueprintId: string,
  nodeId: string
): Promise<NodeSuggestion[]> {
  return fetchJSON(
    `${API_BASE}/blueprints/${encodeURIComponent(blueprintId)}/nodes/${encodeURIComponent(nodeId)}/suggestions`
  );
}

export function markSuggestionUsed(
  blueprintId: string,
  nodeId: string,
  suggestionId: string
): Promise<NodeSuggestion> {
  return fetchJSON(
    `${API_BASE}/blueprints/${encodeURIComponent(blueprintId)}/nodes/${encodeURIComponent(nodeId)}/suggestions/${encodeURIComponent(suggestionId)}/mark-used`,
    { method: "POST" }
  );
}

// ─── Image upload ─────────────────────────────────────────────

// ─── Blueprint Insights ───────────────────────────────────────

export type InsightSeverity = "info" | "warning" | "critical";

export interface BlueprintInsight {
  id: string;
  blueprintId: string;
  sourceNodeId?: string;
  role: string;
  severity: InsightSeverity;
  message: string;
  read: boolean;
  dismissed: boolean;
  createdAt: string;
}

export function fetchBlueprintInsights(
  blueprintId: string,
  opts?: { unreadOnly?: boolean },
): Promise<BlueprintInsight[]> {
  const params = new URLSearchParams();
  if (opts?.unreadOnly) params.set("unread", "true");
  const qs = params.toString();
  return fetchJSON(
    `${API_BASE}/blueprints/${encodeURIComponent(blueprintId)}/insights${qs ? `?${qs}` : ""}`,
  );
}

export function markInsightRead(
  blueprintId: string,
  insightId: string,
): Promise<BlueprintInsight> {
  return fetchJSON(
    `${API_BASE}/blueprints/${encodeURIComponent(blueprintId)}/insights/${encodeURIComponent(insightId)}/mark-read`,
    { method: "POST" },
  );
}

export function markAllInsightsRead(
  blueprintId: string,
): Promise<{ success: boolean }> {
  return fetchJSON(
    `${API_BASE}/blueprints/${encodeURIComponent(blueprintId)}/insights/mark-all-read`,
    { method: "POST" },
  );
}

export function dismissInsight(
  blueprintId: string,
  insightId: string,
): Promise<{ success: boolean }> {
  return fetchJSON(
    `${API_BASE}/blueprints/${encodeURIComponent(blueprintId)}/insights/${encodeURIComponent(insightId)}/dismiss`,
    { method: "POST" },
  );
}

export function getUnreadInsightCount(): Promise<{ count: number }> {
  return fetchJSON(`${API_BASE}/insights/unread-count`);
}

export function coordinateBlueprint(blueprintId: string): Promise<{ status: string; blueprintId: string }> {
  return fetchJSON(`${API_BASE}/blueprints/${encodeURIComponent(blueprintId)}/coordinate`, {
    method: "POST",
  });
}

// ─── Convene Sessions ─────────────────────────────────────────

export type ConveneSessionStatus = "active" | "synthesizing" | "completed" | "cancelled" | "failed";

export interface ConveneSession {
  id: string;
  blueprintId: string;
  topic: string;
  contextNodeIds: string[] | null;
  participatingRoles: string[];
  maxRounds: number;
  status: ConveneSessionStatus;
  synthesisResult: BatchCreateNode[] | null;
  messageCount: number;
  createdAt: string;
  completedAt: string | null;
}

export interface ConveneMessage {
  id: string;
  sessionId: string;
  roleId: string;
  round: number;
  content: string;
  messageType: "contribution" | "synthesis";
  createdAt: string;
}

export interface BatchCreateNode {
  title: string;
  description: string;
  dependencies?: (string | number)[];
  roles?: string[];
}

export function startConveneSession(
  blueprintId: string,
  data: { topic: string; roleIds: string[]; contextNodeIds?: string[]; maxRounds?: number },
): Promise<{ status: string; sessionId: string }> {
  return fetchJSON(`${API_BASE}/blueprints/${encodeURIComponent(blueprintId)}/convene`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export function getConveneSessions(blueprintId: string): Promise<ConveneSession[]> {
  return fetchJSON(`${API_BASE}/blueprints/${encodeURIComponent(blueprintId)}/convene-sessions`);
}

export function getConveneSessionDetail(
  blueprintId: string,
  sessionId: string,
): Promise<ConveneSession & { messages: ConveneMessage[] }> {
  return fetchJSON(
    `${API_BASE}/blueprints/${encodeURIComponent(blueprintId)}/convene-sessions/${encodeURIComponent(sessionId)}`,
  );
}

export function approveConveneSession(
  blueprintId: string,
  sessionId: string,
): Promise<{ status: string; createdNodeIds: string[] }> {
  return fetchJSON(
    `${API_BASE}/blueprints/${encodeURIComponent(blueprintId)}/convene-sessions/${encodeURIComponent(sessionId)}/approve`,
    { method: "POST" },
  );
}

export function cancelConveneSession(
  blueprintId: string,
  sessionId: string,
): Promise<{ status: string }> {
  return fetchJSON(
    `${API_BASE}/blueprints/${encodeURIComponent(blueprintId)}/convene-sessions/${encodeURIComponent(sessionId)}/cancel`,
    { method: "POST" },
  );
}

// ─── Image upload ─────────────────────────────────────────────

// ─── Autopilot Types ──────────────────────────────────────────

export interface AutopilotLogEntry {
  id: string;
  blueprintId: string;
  iteration: number;
  observation?: string;
  decision: string;
  action: string;
  actionParams?: string;
  result?: string;
  createdAt: string;
}

export function fetchAutopilotLog(
  blueprintId: string,
  limit = 20,
  offset = 0,
): Promise<AutopilotLogEntry[]> {
  const params = new URLSearchParams();
  params.set("limit", String(limit));
  if (offset > 0) params.set("offset", String(offset));
  return fetchJSON(
    `${API_BASE}/blueprints/${encodeURIComponent(blueprintId)}/autopilot-log?${params}`,
  );
}

export function uploadImage(dataUrl: string, filename?: string): Promise<{ url: string }> {
  return fetchJSON(`${API_BASE}/uploads`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: dataUrl, filename }),
  });
}
