import { randomUUID } from "node:crypto";
import { getDb } from "./db.js";
import { createLogger } from "./logger.js";

const log = createLogger("plan-db");

// ─── PRD v3 Types ────────────────────────────────────────────

export type BlueprintStatus = "draft" | "approved" | "running" | "paused" | "done" | "failed";
export type MacroNodeStatus = "pending" | "queued" | "running" | "done" | "failed" | "blocked" | "skipped";
export type ArtifactType = "handoff_summary" | "file_diff" | "test_report" | "custom";
export type ExecutionType = "primary" | "retry" | "continuation" | "subtask";
export type ExecutionStatus = "running" | "done" | "failed" | "cancelled";
export type FailureReason = "timeout" | "context_exhausted" | "output_token_limit" | "hung" | "error" | null;
export type ReportedStatus = "done" | "failed" | "blocked" | null;
export type RelatedSessionType = "enrich" | "reevaluate" | "split" | "evaluate" | "reevaluate_all" | "generate" | "smart_deps";

// Layer 1: Blueprint (was "Plan")
export interface Blueprint {
  id: string;
  title: string;
  description: string;
  projectCwd?: string;
  status: BlueprintStatus;
  starred?: boolean;
  archivedAt?: string;
  agentType?: string;
  nodes: MacroNode[];
  createdAt: string;
  updatedAt: string;
}

// Layer 2: MacroNode (was "PlanNode")
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
  agentType?: string;
  createdAt: string;
  updatedAt: string;
}

// Artifact: cross-node state transfer
export interface Artifact {
  id: string;
  type: ArtifactType;
  content: string;
  sourceNodeId: string;
  targetNodeId?: string;
  blueprintId: string;
  createdAt: string;
}

// Layer 3: NodeExecution
export interface NodeExecution {
  id: string;
  nodeId: string;
  blueprintId: string;
  sessionId?: string;
  type: ExecutionType;
  status: ExecutionStatus;
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
  contextPressure?: string;
  startedAt: string;
  completedAt?: string;
}

// Related session: tracks sessions from enrich, reevaluate, split, evaluate operations
export interface RelatedSession {
  id: string;
  nodeId: string;
  blueprintId: string;
  sessionId: string;
  type: RelatedSessionType;
  startedAt: string;
  completedAt?: string;
}

// Info returned by getStaleRunningExecutions for smart recovery
export interface StaleExecution {
  id: string;
  nodeId: string;
  blueprintId: string;
  sessionId: string | null;
  cliPid: number | null;
  startedAt: string;
  projectCwd: string | null;
}

// Backward-compat aliases
export type Plan = Blueprint;
export type PlanNode = MacroNode;
export type PlanStatus = BlueprintStatus;
export type NodeStatus = MacroNodeStatus;

// ─── Schema version & migration ──────────────────────────────

const CURRENT_SCHEMA_VERSION = 3;

export function initPlanTables(): void {
  const db = getDb();

  // Schema version tracking
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (key TEXT PRIMARY KEY, version INTEGER NOT NULL)");

  const row = db.prepare("SELECT version FROM schema_version WHERE key = ?").get("plan_schema") as
    | { version: number }
    | undefined;
  const currentVersion = row?.version ?? 0;

  if (currentVersion < 2) {
    // Drop old v1 tables if they exist
    db.exec("DROP TABLE IF EXISTS plan_nodes");
    db.exec("DROP TABLE IF EXISTS plans");

    // Create v2+ tables (includes cli_pid from the start for new installations)
    db.exec(`
      CREATE TABLE IF NOT EXISTS blueprints (
        id           TEXT PRIMARY KEY,
        title        TEXT NOT NULL,
        description  TEXT,
        status       TEXT DEFAULT 'draft',
        project_cwd  TEXT,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS macro_nodes (
        id                TEXT PRIMARY KEY,
        blueprint_id      TEXT NOT NULL REFERENCES blueprints(id) ON DELETE CASCADE,
        "order"           INTEGER NOT NULL,
        title             TEXT NOT NULL,
        description       TEXT,
        status            TEXT DEFAULT 'pending',
        dependencies      TEXT,
        parallel_group    TEXT,
        prompt            TEXT,
        estimated_minutes REAL,
        actual_minutes    REAL,
        error             TEXT,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id              TEXT PRIMARY KEY,
        blueprint_id    TEXT NOT NULL REFERENCES blueprints(id) ON DELETE CASCADE,
        source_node_id  TEXT NOT NULL REFERENCES macro_nodes(id) ON DELETE CASCADE,
        target_node_id  TEXT REFERENCES macro_nodes(id) ON DELETE SET NULL,
        type            TEXT NOT NULL DEFAULT 'handoff_summary',
        content         TEXT NOT NULL,
        created_at      TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS node_executions (
        id                   TEXT PRIMARY KEY,
        node_id              TEXT NOT NULL REFERENCES macro_nodes(id) ON DELETE CASCADE,
        blueprint_id         TEXT NOT NULL REFERENCES blueprints(id) ON DELETE CASCADE,
        session_id           TEXT,
        type                 TEXT NOT NULL DEFAULT 'primary',
        status               TEXT NOT NULL DEFAULT 'running',
        input_context        TEXT,
        output_summary       TEXT,
        context_tokens_used  INTEGER,
        parent_execution_id  TEXT,
        cli_pid              INTEGER,
        started_at           TEXT NOT NULL,
        completed_at         TEXT
      );

      CREATE TABLE IF NOT EXISTS node_related_sessions (
        id            TEXT PRIMARY KEY,
        node_id       TEXT NOT NULL REFERENCES macro_nodes(id) ON DELETE CASCADE,
        blueprint_id  TEXT NOT NULL REFERENCES blueprints(id) ON DELETE CASCADE,
        session_id    TEXT NOT NULL,
        type          TEXT NOT NULL,
        started_at    TEXT NOT NULL,
        completed_at  TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_macro_nodes_blueprint ON macro_nodes(blueprint_id, "order");
      CREATE INDEX IF NOT EXISTS idx_artifacts_source ON artifacts(source_node_id);
      CREATE INDEX IF NOT EXISTS idx_artifacts_target ON artifacts(target_node_id);
      CREATE INDEX IF NOT EXISTS idx_executions_node ON node_executions(node_id);
      CREATE INDEX IF NOT EXISTS idx_executions_session ON node_executions(session_id);
      CREATE INDEX IF NOT EXISTS idx_executions_status ON node_executions(status);
      CREATE INDEX IF NOT EXISTS idx_executions_blueprint ON node_executions(blueprint_id);
      CREATE INDEX IF NOT EXISTS idx_executions_completed ON node_executions(completed_at);
      CREATE INDEX IF NOT EXISTS idx_related_sessions_node ON node_related_sessions(node_id);
      CREATE INDEX IF NOT EXISTS idx_related_sessions_blueprint ON node_related_sessions(blueprint_id);
    `);
  }

  // Incremental migration: add cli_pid column for process tracking
  const cols = db.prepare("PRAGMA table_info(node_executions)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "cli_pid")) {
    db.exec("ALTER TABLE node_executions ADD COLUMN cli_pid INTEGER");
  }
  // Incremental migration: add blocker_info and task_summary columns for API callbacks
  if (!cols.some((c) => c.name === "blocker_info")) {
    db.exec("ALTER TABLE node_executions ADD COLUMN blocker_info TEXT");
  }
  if (!cols.some((c) => c.name === "task_summary")) {
    db.exec("ALTER TABLE node_executions ADD COLUMN task_summary TEXT");
  }
  // Incremental migration: add failure_reason column for failure categorization
  if (!cols.some((c) => c.name === "failure_reason")) {
    db.exec("ALTER TABLE node_executions ADD COLUMN failure_reason TEXT");
  }
  // Incremental migration: add reported_status and reported_reason columns for explicit status reporting
  if (!cols.some((c) => c.name === "reported_status")) {
    db.exec("ALTER TABLE node_executions ADD COLUMN reported_status TEXT");
  }
  if (!cols.some((c) => c.name === "reported_reason")) {
    db.exec("ALTER TABLE node_executions ADD COLUMN reported_reason TEXT");
  }
  // Incremental migration: add context health columns for context-full detection
  if (!cols.some((c) => c.name === "compact_count")) {
    db.exec("ALTER TABLE node_executions ADD COLUMN compact_count INTEGER");
  }
  if (!cols.some((c) => c.name === "peak_tokens")) {
    db.exec("ALTER TABLE node_executions ADD COLUMN peak_tokens INTEGER");
  }
  if (!cols.some((c) => c.name === "context_pressure")) {
    db.exec("ALTER TABLE node_executions ADD COLUMN context_pressure TEXT");
  }

  // Incremental migration: create node_related_sessions table if not exists
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='node_related_sessions'").all();
  if (tables.length === 0) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS node_related_sessions (
        id            TEXT PRIMARY KEY,
        node_id       TEXT NOT NULL REFERENCES macro_nodes(id) ON DELETE CASCADE,
        blueprint_id  TEXT NOT NULL REFERENCES blueprints(id) ON DELETE CASCADE,
        session_id    TEXT NOT NULL,
        type          TEXT NOT NULL,
        started_at    TEXT NOT NULL,
        completed_at  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_related_sessions_node ON node_related_sessions(node_id);
      CREATE INDEX IF NOT EXISTS idx_related_sessions_blueprint ON node_related_sessions(blueprint_id);
    `);
  }

  // Incremental migration: add archived_at column to blueprints
  const bpCols = db.prepare("PRAGMA table_info(blueprints)").all() as { name: string }[];
  if (!bpCols.some((c) => c.name === "archived_at")) {
    db.exec("ALTER TABLE blueprints ADD COLUMN archived_at TEXT");
  }

  // Incremental migration: add agent_type column to blueprints
  const bpCols2 = db.prepare("PRAGMA table_info(blueprints)").all() as { name: string }[];
  if (!bpCols2.some((c) => c.name === "agent_type")) {
    db.exec("ALTER TABLE blueprints ADD COLUMN agent_type TEXT DEFAULT 'claude'");
  }

  // Incremental migration: add starred column to blueprints
  const bpCols3 = db.prepare("PRAGMA table_info(blueprints)").all() as { name: string }[];
  if (!bpCols3.some((c) => c.name === "starred")) {
    db.exec("ALTER TABLE blueprints ADD COLUMN starred INTEGER DEFAULT 0");
  }

  // Incremental migration: add agent_type column to macro_nodes (per-node agent override)
  const mnCols = db.prepare("PRAGMA table_info(macro_nodes)").all() as { name: string }[];
  if (!mnCols.some((c) => c.name === "agent_type")) {
    db.exec("ALTER TABLE macro_nodes ADD COLUMN agent_type TEXT DEFAULT 'claude'");
  }

  if (currentVersion < CURRENT_SCHEMA_VERSION) {
    db.prepare("INSERT OR REPLACE INTO schema_version (key, version) VALUES (?, ?)").run(
      "plan_schema",
      CURRENT_SCHEMA_VERSION,
    );
  }
}

// ─── Row types ───────────────────────────────────────────────

interface BlueprintRow {
  id: string;
  title: string;
  description: string | null;
  status: string;
  project_cwd: string | null;
  starred: number;
  archived_at: string | null;
  agent_type: string | null;
  created_at: string;
  updated_at: string;
}

interface MacroNodeRow {
  id: string;
  blueprint_id: string;
  order: number;
  title: string;
  description: string | null;
  status: string;
  dependencies: string | null;
  parallel_group: string | null;
  prompt: string | null;
  estimated_minutes: number | null;
  actual_minutes: number | null;
  error: string | null;
  agent_type: string | null;
  created_at: string;
  updated_at: string;
}

interface ArtifactRow {
  id: string;
  blueprint_id: string;
  source_node_id: string;
  target_node_id: string | null;
  type: string;
  content: string;
  created_at: string;
}

interface ExecutionRow {
  id: string;
  node_id: string;
  blueprint_id: string;
  session_id: string | null;
  type: string;
  status: string;
  input_context: string | null;
  output_summary: string | null;
  context_tokens_used: number | null;
  parent_execution_id: string | null;
  cli_pid: number | null;
  blocker_info: string | null;
  task_summary: string | null;
  failure_reason: string | null;
  reported_status: string | null;
  reported_reason: string | null;
  compact_count: number | null;
  peak_tokens: number | null;
  context_pressure: string | null;
  started_at: string;
  completed_at: string | null;
}

// ─── Row → object helpers ────────────────────────────────────

function rowToArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    type: row.type as ArtifactType,
    content: row.content,
    sourceNodeId: row.source_node_id,
    ...(row.target_node_id ? { targetNodeId: row.target_node_id } : {}),
    blueprintId: row.blueprint_id,
    createdAt: row.created_at,
  };
}

function rowToExecution(row: ExecutionRow): NodeExecution {
  return {
    id: row.id,
    nodeId: row.node_id,
    blueprintId: row.blueprint_id,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    type: row.type as ExecutionType,
    status: row.status as ExecutionStatus,
    ...(row.input_context ? { inputContext: row.input_context } : {}),
    ...(row.output_summary ? { outputSummary: row.output_summary } : {}),
    ...(row.context_tokens_used != null ? { contextTokensUsed: row.context_tokens_used } : {}),
    ...(row.parent_execution_id ? { parentExecutionId: row.parent_execution_id } : {}),
    ...(row.cli_pid != null ? { cliPid: row.cli_pid } : {}),
    ...(row.blocker_info ? { blockerInfo: row.blocker_info } : {}),
    ...(row.task_summary ? { taskSummary: row.task_summary } : {}),
    ...(row.failure_reason ? { failureReason: row.failure_reason as FailureReason } : {}),
    ...(row.reported_status ? { reportedStatus: row.reported_status as ReportedStatus } : {}),
    ...(row.reported_reason ? { reportedReason: row.reported_reason } : {}),
    ...(row.compact_count != null ? { compactCount: row.compact_count } : {}),
    ...(row.peak_tokens != null ? { peakTokens: row.peak_tokens } : {}),
    ...(row.context_pressure ? { contextPressure: row.context_pressure } : {}),
    startedAt: row.started_at,
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
  };
}

function rowToMacroNode(
  row: MacroNodeRow,
  inputArtifacts: Artifact[] = [],
  outputArtifacts: Artifact[] = [],
  executions: NodeExecution[] = [],
): MacroNode {
  let dependencies: string[] = [];
  if (row.dependencies) {
    try {
      dependencies = JSON.parse(row.dependencies);
    } catch {
      dependencies = [];
    }
  }
  return {
    id: row.id,
    blueprintId: row.blueprint_id,
    order: row.order,
    title: row.title,
    description: row.description ?? "",
    status: row.status as MacroNodeStatus,
    dependencies,
    ...(row.parallel_group ? { parallelGroup: row.parallel_group } : {}),
    ...(row.prompt ? { prompt: row.prompt } : {}),
    ...(row.estimated_minutes != null ? { estimatedMinutes: row.estimated_minutes } : {}),
    ...(row.actual_minutes != null ? { actualMinutes: row.actual_minutes } : {}),
    inputArtifacts,
    outputArtifacts,
    executions,
    ...(row.error ? { error: row.error } : {}),
    ...(row.agent_type ? { agentType: row.agent_type } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToBlueprint(row: BlueprintRow, nodes: MacroNode[] = []): Blueprint {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? "",
    status: row.status as BlueprintStatus,
    ...(row.starred ? { starred: true } : {}),
    ...(row.project_cwd ? { projectCwd: row.project_cwd } : {}),
    ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
    ...(row.agent_type ? { agentType: row.agent_type } : {}),
    nodes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── Eager loading helpers ───────────────────────────────────

function getArtifactsForNodeInternal(nodeId: string): { input: Artifact[]; output: Artifact[] } {
  const db = getDb();

  // Input artifacts: explicitly targeted at this node
  const targetedRows = db
    .prepare("SELECT * FROM artifacts WHERE target_node_id = ? ORDER BY created_at ASC")
    .all(nodeId) as ArtifactRow[];

  // Also include output artifacts from dependency nodes that have no specific target
  // (created when the source had no dependents at completion time)
  const nodeRow = db.prepare("SELECT dependencies FROM macro_nodes WHERE id = ?").get(nodeId) as { dependencies: string | null } | undefined;
  const depIds: string[] = nodeRow?.dependencies ? JSON.parse(nodeRow.dependencies) : [];

  const seenSources = new Set(targetedRows.map(r => r.source_node_id));
  let untargetedFromDeps: ArtifactRow[] = [];
  if (depIds.length > 0) {
    const placeholders = depIds.map(() => "?").join(",");
    untargetedFromDeps = (db
      .prepare(`SELECT * FROM artifacts WHERE source_node_id IN (${placeholders}) AND target_node_id IS NULL AND type = 'handoff_summary' ORDER BY created_at ASC`)
      .all(...depIds) as ArtifactRow[])
      .filter(r => !seenSources.has(r.source_node_id));
  }

  const inputRows = [...targetedRows, ...untargetedFromDeps];

  const outputRows = db
    .prepare("SELECT * FROM artifacts WHERE source_node_id = ? ORDER BY created_at ASC")
    .all(nodeId) as ArtifactRow[];
  return {
    input: inputRows.map(rowToArtifact),
    output: outputRows.map(rowToArtifact),
  };
}

function getExecutionsForNodeInternal(nodeId: string): NodeExecution[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM node_executions WHERE node_id = ? ORDER BY started_at ASC")
    .all(nodeId) as ExecutionRow[];
  return rows.map(rowToExecution);
}

function getNodesForBlueprint(blueprintId: string): MacroNode[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM macro_nodes WHERE blueprint_id = ? ORDER BY "order" ASC')
    .all(blueprintId) as MacroNodeRow[];

  if (rows.length === 0) return [];

  const nodeIds = rows.map((r) => r.id);
  const placeholders = nodeIds.map(() => "?").join(",");

  // Batch-load all artifacts for these nodes (P1/P11 fix — eliminates N+1)
  const allArtifacts = db
    .prepare(`SELECT * FROM artifacts WHERE blueprint_id = ? ORDER BY created_at ASC`)
    .all(blueprintId) as ArtifactRow[];

  // Build maps: nodeId → { input artifacts, output artifacts }
  const artifactsByTarget = new Map<string, ArtifactRow[]>();
  const artifactsBySource = new Map<string, ArtifactRow[]>();
  const untargetedBySource = new Map<string, ArtifactRow[]>();

  for (const art of allArtifacts) {
    if (art.target_node_id) {
      const list = artifactsByTarget.get(art.target_node_id) ?? [];
      list.push(art);
      artifactsByTarget.set(art.target_node_id, list);
    } else if (art.type === "handoff_summary") {
      const list = untargetedBySource.get(art.source_node_id) ?? [];
      list.push(art);
      untargetedBySource.set(art.source_node_id, list);
    }
    const srcList = artifactsBySource.get(art.source_node_id) ?? [];
    srcList.push(art);
    artifactsBySource.set(art.source_node_id, srcList);
  }

  // Batch-load all executions for these nodes (P1 fix)
  const allExecs = db
    .prepare(`SELECT * FROM node_executions WHERE node_id IN (${placeholders}) ORDER BY started_at ASC`)
    .all(...nodeIds) as ExecutionRow[];

  const execsByNode = new Map<string, ExecutionRow[]>();
  for (const exec of allExecs) {
    const list = execsByNode.get(exec.node_id) ?? [];
    list.push(exec);
    execsByNode.set(exec.node_id, list);
  }

  return rows.map((row) => {
    // Compute input artifacts: targeted at this node + untargeted from deps
    const targeted = artifactsByTarget.get(row.id) ?? [];
    const depIds: string[] = row.dependencies ? JSON.parse(row.dependencies) : [];
    const seenSources = new Set(targeted.map((r) => r.source_node_id));
    const untargetedFromDeps = depIds.flatMap((depId) =>
      (untargetedBySource.get(depId) ?? []).filter((r) => !seenSources.has(r.source_node_id))
    );
    const inputArts = [...targeted, ...untargetedFromDeps].map(rowToArtifact);
    const outputArts = (artifactsBySource.get(row.id) ?? []).map(rowToArtifact);
    const execs = (execsByNode.get(row.id) ?? []).map(rowToExecution);

    return rowToMacroNode(row, inputArts, outputArts, execs);
  });
}

// ─── Blueprint CRUD ──────────────────────────────────────────

export function createBlueprint(
  title: string,
  description?: string,
  projectCwd?: string,
  agentType?: string,
): Blueprint {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO blueprints (id, title, description, status, project_cwd, agent_type, created_at, updated_at)
    VALUES (?, ?, ?, 'draft', ?, ?, ?, ?)
  `).run(id, title, description ?? null, projectCwd ?? null, agentType ?? "claude", now, now);

  return {
    id,
    title,
    description: description ?? "",
    status: "draft",
    ...(projectCwd ? { projectCwd } : {}),
    ...(agentType ? { agentType } : {}),
    nodes: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function getBlueprint(id: string): Blueprint | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM blueprints WHERE id = ?").get(id) as BlueprintRow | undefined;
  if (!row) return null;
  return rowToBlueprint(row, getNodesForBlueprint(id));
}

export function listBlueprints(filters?: { status?: string; projectCwd?: string; includeArchived?: boolean; limit?: number; offset?: number }): Blueprint[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters?.status) {
    conditions.push("status = ?");
    params.push(filters.status);
  }
  if (filters?.projectCwd) {
    conditions.push("project_cwd = ?");
    params.push(filters.projectCwd);
  }
  // By default, exclude archived blueprints unless explicitly requested
  if (!filters?.includeArchived) {
    conditions.push("archived_at IS NULL");
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  let sql = `SELECT * FROM blueprints ${where} ORDER BY starred DESC, updated_at DESC`;
  if (filters?.limit) {
    sql += ` LIMIT ?`;
    params.push(filters.limit);
    if (filters.offset) {
      sql += ` OFFSET ?`;
      params.push(filters.offset);
    }
  }
  const rows = db
    .prepare(sql)
    .all(...params) as BlueprintRow[];

  return rows.map((row) => rowToBlueprint(row, getNodesForBlueprint(row.id)));
}

export function listArchivedBlueprints(): Blueprint[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM blueprints WHERE archived_at IS NOT NULL ORDER BY archived_at DESC")
    .all() as BlueprintRow[];
  return rows.map((row) => rowToBlueprint(row, getNodesForBlueprint(row.id)));
}

export function archiveBlueprint(id: string): Blueprint | null {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM blueprints WHERE id = ?").get(id) as BlueprintRow | undefined;
  if (!existing) return null;

  const now = new Date().toISOString();
  db.prepare("UPDATE blueprints SET archived_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
  return getBlueprint(id);
}

export function unarchiveBlueprint(id: string): Blueprint | null {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM blueprints WHERE id = ?").get(id) as BlueprintRow | undefined;
  if (!existing) return null;

  const now = new Date().toISOString();
  db.prepare("UPDATE blueprints SET archived_at = NULL, updated_at = ? WHERE id = ?").run(now, id);
  return getBlueprint(id);
}

export function starBlueprint(id: string): Blueprint | null {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM blueprints WHERE id = ?").get(id) as BlueprintRow | undefined;
  if (!existing) return null;

  db.prepare("UPDATE blueprints SET starred = 1 WHERE id = ?").run(id);
  return getBlueprint(id);
}

export function unstarBlueprint(id: string): Blueprint | null {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM blueprints WHERE id = ?").get(id) as BlueprintRow | undefined;
  if (!existing) return null;

  db.prepare("UPDATE blueprints SET starred = 0 WHERE id = ?").run(id);
  return getBlueprint(id);
}

export function updateBlueprint(
  id: string,
  patch: Partial<Pick<Blueprint, "title" | "description" | "status" | "projectCwd" | "agentType">>,
): Blueprint | null {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM blueprints WHERE id = ?").get(id) as BlueprintRow | undefined;
  if (!existing) return null;

  const now = new Date().toISOString();
  const sets: string[] = ["updated_at = ?"];
  const params: unknown[] = [now];

  if (patch.title !== undefined) {
    sets.push("title = ?");
    params.push(patch.title);
  }
  if (patch.description !== undefined) {
    sets.push("description = ?");
    params.push(patch.description);
  }
  if (patch.status !== undefined) {
    sets.push("status = ?");
    params.push(patch.status);
  }
  if (patch.projectCwd !== undefined) {
    sets.push("project_cwd = ?");
    params.push(patch.projectCwd);
  }
  if (patch.agentType !== undefined) {
    sets.push("agent_type = ?");
    params.push(patch.agentType);
  }

  params.push(id);
  db.prepare(`UPDATE blueprints SET ${sets.join(", ")} WHERE id = ?`).run(...params);

  return getBlueprint(id);
}

export function deleteBlueprint(id: string): void {
  const db = getDb();
  db.prepare("DELETE FROM blueprints WHERE id = ?").run(id);
}

// ─── MacroNode CRUD ──────────────────────────────────────────

export function createMacroNode(
  blueprintId: string,
  data: {
    title: string;
    description?: string;
    order: number;
    dependencies?: string[];
    parallelGroup?: string;
    prompt?: string;
    estimatedMinutes?: number;
    agentType?: string;
  },
): MacroNode {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  const depsJson = data.dependencies?.length ? JSON.stringify(data.dependencies) : null;

  // Atomic: shift + insert + touch parent (P6 fix)
  const insertTransaction = db.transaction(() => {
    // Shift existing nodes at or above this order to make room
    db.prepare(
      'UPDATE macro_nodes SET "order" = "order" + 1, updated_at = ? WHERE blueprint_id = ? AND "order" >= ?'
    ).run(now, blueprintId, data.order);

    db.prepare(`
      INSERT INTO macro_nodes (id, blueprint_id, "order", title, description, status, dependencies, parallel_group, prompt, estimated_minutes, agent_type, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      blueprintId,
      data.order,
      data.title,
      data.description ?? null,
      depsJson,
      data.parallelGroup ?? null,
      data.prompt ?? null,
      data.estimatedMinutes ?? null,
      data.agentType ?? null,
      now,
      now,
    );

    // Touch parent blueprint
    db.prepare("UPDATE blueprints SET updated_at = ? WHERE id = ?").run(now, blueprintId);
  });
  insertTransaction();

  return {
    id,
    blueprintId,
    order: data.order,
    title: data.title,
    description: data.description ?? "",
    status: "pending",
    dependencies: data.dependencies ?? [],
    ...(data.parallelGroup ? { parallelGroup: data.parallelGroup } : {}),
    ...(data.prompt ? { prompt: data.prompt } : {}),
    ...(data.estimatedMinutes != null ? { estimatedMinutes: data.estimatedMinutes } : {}),
    ...(data.agentType ? { agentType: data.agentType } : {}),
    inputArtifacts: [],
    outputArtifacts: [],
    executions: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function updateMacroNode(
  blueprintId: string,
  nodeId: string,
  patch: Partial<
    Pick<
      MacroNode,
      | "title"
      | "description"
      | "status"
      | "dependencies"
      | "parallelGroup"
      | "prompt"
      | "estimatedMinutes"
      | "actualMinutes"
      | "error"
      | "order"
      | "agentType"
    >
  >,
): MacroNode | null {
  const db = getDb();
  const existing = db
    .prepare("SELECT * FROM macro_nodes WHERE id = ? AND blueprint_id = ?")
    .get(nodeId, blueprintId) as MacroNodeRow | undefined;
  if (!existing) return null;

  const now = new Date().toISOString();
  const sets: string[] = ["updated_at = ?"];
  const params: unknown[] = [now];

  if (patch.title !== undefined) { sets.push("title = ?"); params.push(patch.title); }
  if (patch.description !== undefined) { sets.push("description = ?"); params.push(patch.description); }
  if (patch.status !== undefined) { sets.push("status = ?"); params.push(patch.status); }
  if (patch.dependencies !== undefined) { sets.push("dependencies = ?"); params.push(JSON.stringify(patch.dependencies)); }
  if (patch.parallelGroup !== undefined) { sets.push("parallel_group = ?"); params.push(patch.parallelGroup); }
  if (patch.prompt !== undefined) { sets.push("prompt = ?"); params.push(patch.prompt); }
  if (patch.estimatedMinutes !== undefined) { sets.push("estimated_minutes = ?"); params.push(patch.estimatedMinutes); }
  if (patch.actualMinutes !== undefined) { sets.push("actual_minutes = ?"); params.push(patch.actualMinutes); }
  if (patch.error !== undefined) { sets.push("error = ?"); params.push(patch.error); }
  if (patch.order !== undefined) { sets.push('"order" = ?'); params.push(patch.order); }
  if (patch.agentType !== undefined) { sets.push("agent_type = ?"); params.push(patch.agentType); }

  params.push(nodeId, blueprintId);
  db.prepare(`UPDATE macro_nodes SET ${sets.join(", ")} WHERE id = ? AND blueprint_id = ?`).run(...params);

  // Touch parent blueprint
  db.prepare("UPDATE blueprints SET updated_at = ? WHERE id = ?").run(now, blueprintId);

  // When dependencies change, create input artifact rows for newly-added deps that already have output artifacts
  if (patch.dependencies !== undefined) {
    const oldDeps: string[] = JSON.parse(existing.dependencies || "[]");
    const newDeps = patch.dependencies as string[];
    const addedDeps = newDeps.filter(d => !oldDeps.includes(d));

    for (const depId of addedDeps) {
      // Find output artifacts from the dependency node that don't already target this node
      const existingTargeted = db
        .prepare("SELECT id FROM artifacts WHERE source_node_id = ? AND target_node_id = ?")
        .all(depId, nodeId) as { id: string }[];

      if (existingTargeted.length === 0) {
        // Get any output artifacts from the dep node (targeted or untargeted)
        const outputArts = db
          .prepare("SELECT * FROM artifacts WHERE source_node_id = ? AND type = 'handoff_summary' ORDER BY created_at DESC LIMIT 1")
          .get(depId) as ArtifactRow | undefined;

        if (outputArts) {
          // Create a new artifact row targeting this node
          const artId = randomUUID();
          db.prepare(`
            INSERT INTO artifacts (id, blueprint_id, source_node_id, target_node_id, type, content, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(artId, blueprintId, depId, nodeId, outputArts.type, outputArts.content, now);
          log.debug(`Created input artifact for node ${nodeId} from late-added dep ${depId}`);
        }
      }
    }

    // Remove artifact rows for removed dependencies
    const removedDeps = oldDeps.filter(d => !newDeps.includes(d));
    for (const depId of removedDeps) {
      db.prepare("DELETE FROM artifacts WHERE source_node_id = ? AND target_node_id = ?").run(depId, nodeId);
      log.debug(`Removed input artifacts for node ${nodeId} from removed dep ${depId}`);
    }
  }

  // Return fully-loaded node
  const row = db.prepare("SELECT * FROM macro_nodes WHERE id = ?").get(nodeId) as MacroNodeRow;
  const arts = getArtifactsForNodeInternal(nodeId);
  const execs = getExecutionsForNodeInternal(nodeId);
  return rowToMacroNode(row, arts.input, arts.output, execs);
}

export function deleteMacroNode(blueprintId: string, nodeId: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare("DELETE FROM macro_nodes WHERE id = ? AND blueprint_id = ?").run(nodeId, blueprintId);
  db.prepare("UPDATE blueprints SET updated_at = ? WHERE id = ?").run(now, blueprintId);
}

export function reorderMacroNodes(blueprintId: string, ordering: { id: string; order: number }[]): void {
  const db = getDb();
  const now = new Date().toISOString();

  const update = db.prepare('UPDATE macro_nodes SET "order" = ?, updated_at = ? WHERE id = ? AND blueprint_id = ?');
  const reorder = db.transaction(() => {
    for (const item of ordering) {
      update.run(item.order, now, item.id, blueprintId);
    }
    db.prepare("UPDATE blueprints SET updated_at = ? WHERE id = ?").run(now, blueprintId);
  });
  reorder();
}

// ─── Artifact CRUD ───────────────────────────────────────────

export function createArtifact(
  blueprintId: string,
  sourceNodeId: string,
  type: ArtifactType,
  content: string,
  targetNodeId?: string,
): Artifact {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO artifacts (id, blueprint_id, source_node_id, target_node_id, type, content, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, blueprintId, sourceNodeId, targetNodeId ?? null, type, content, now);

  return {
    id,
    type,
    content,
    sourceNodeId,
    ...(targetNodeId ? { targetNodeId } : {}),
    blueprintId,
    createdAt: now,
  };
}

export function getArtifactsForNode(
  nodeId: string,
  direction: "input" | "output",
): Artifact[] {
  const db = getDb();
  const col = direction === "input" ? "target_node_id" : "source_node_id";
  const rows = db
    .prepare(`SELECT * FROM artifacts WHERE ${col} = ? ORDER BY created_at ASC`)
    .all(nodeId) as ArtifactRow[];
  return rows.map(rowToArtifact);
}

export function deleteArtifact(id: string): void {
  const db = getDb();
  db.prepare("DELETE FROM artifacts WHERE id = ?").run(id);
}

// ─── NodeExecution CRUD ──────────────────────────────────────

export function createExecution(
  nodeId: string,
  blueprintId: string,
  sessionId: string | undefined,
  type: ExecutionType,
  inputContext?: string,
  parentExecutionId?: string,
  status?: ExecutionStatus,
  outputSummary?: string,
  completedAt?: string,
  cliPid?: number,
): NodeExecution {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  const effectiveStatus = status ?? "running";

  db.prepare(`
    INSERT INTO node_executions (id, node_id, blueprint_id, session_id, type, status, input_context, output_summary, parent_execution_id, cli_pid, started_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, nodeId, blueprintId, sessionId ?? null, type, effectiveStatus, inputContext ?? null, outputSummary ?? null, parentExecutionId ?? null, cliPid ?? null, now, completedAt ?? null);

  return {
    id,
    nodeId,
    blueprintId,
    ...(sessionId ? { sessionId } : {}),
    type,
    status: effectiveStatus,
    ...(inputContext ? { inputContext } : {}),
    ...(outputSummary ? { outputSummary } : {}),
    ...(parentExecutionId ? { parentExecutionId } : {}),
    ...(cliPid != null ? { cliPid } : {}),
    startedAt: now,
    ...(completedAt ? { completedAt } : {}),
  };
}

export function updateExecution(
  id: string,
  patch: Partial<Pick<NodeExecution, "status" | "outputSummary" | "contextTokensUsed" | "completedAt" | "sessionId" | "cliPid" | "failureReason" | "compactCount" | "peakTokens" | "contextPressure">>,
): NodeExecution | null {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM node_executions WHERE id = ?").get(id) as ExecutionRow | undefined;
  if (!existing) return null;

  const sets: string[] = [];
  const params: unknown[] = [];

  if (patch.status !== undefined) { sets.push("status = ?"); params.push(patch.status); }
  if (patch.outputSummary !== undefined) { sets.push("output_summary = ?"); params.push(patch.outputSummary); }
  if (patch.contextTokensUsed !== undefined) { sets.push("context_tokens_used = ?"); params.push(patch.contextTokensUsed); }
  if (patch.completedAt !== undefined) { sets.push("completed_at = ?"); params.push(patch.completedAt); }
  if (patch.sessionId !== undefined) { sets.push("session_id = ?"); params.push(patch.sessionId); }
  if (patch.cliPid !== undefined) { sets.push("cli_pid = ?"); params.push(patch.cliPid); }
  if (patch.failureReason !== undefined) { sets.push("failure_reason = ?"); params.push(patch.failureReason); }
  if (patch.compactCount !== undefined) { sets.push("compact_count = ?"); params.push(patch.compactCount); }
  if (patch.peakTokens !== undefined) { sets.push("peak_tokens = ?"); params.push(patch.peakTokens); }
  if (patch.contextPressure !== undefined) { sets.push("context_pressure = ?"); params.push(patch.contextPressure); }

  if (sets.length === 0) return rowToExecution(existing);

  params.push(id);
  db.prepare(`UPDATE node_executions SET ${sets.join(", ")} WHERE id = ?`).run(...params);

  const row = db.prepare("SELECT * FROM node_executions WHERE id = ?").get(id) as ExecutionRow;
  return rowToExecution(row);
}

export function setExecutionBlocker(executionId: string, blockerJson: string): void {
  const db = getDb();
  db.prepare("UPDATE node_executions SET blocker_info = ? WHERE id = ?").run(blockerJson, executionId);
}

export function setExecutionTaskSummary(executionId: string, summary: string): void {
  const db = getDb();
  db.prepare("UPDATE node_executions SET task_summary = ? WHERE id = ?").run(summary, executionId);
}

export function setExecutionReportedStatus(executionId: string, status: ReportedStatus, reason?: string): void {
  const db = getDb();
  db.prepare("UPDATE node_executions SET reported_status = ?, reported_reason = ? WHERE id = ?")
    .run(status, reason ?? null, executionId);
}

export function getExecution(executionId: string): NodeExecution | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM node_executions WHERE id = ?").get(executionId) as ExecutionRow | undefined;
  return row ? rowToExecution(row) : null;
}

export function getExecutionsForNode(nodeId: string): NodeExecution[] {
  return getExecutionsForNodeInternal(nodeId);
}

export function getExecutionBySession(sessionId: string): NodeExecution | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM node_executions WHERE session_id = ?")
    .get(sessionId) as ExecutionRow | undefined;
  return row ? rowToExecution(row) : null;
}

// ─── Backward-compat aliases ─────────────────────────────────

export const createPlan = createBlueprint;
export const getPlan = getBlueprint;
export const listPlans = listBlueprints;
export const updatePlan = updateBlueprint;
export const deletePlan = deleteBlueprint;

export function createNode(
  blueprintId: string,
  data: { title: string; description?: string; seq: number; dependsOn?: string[]; prompt?: string },
): MacroNode {
  return createMacroNode(blueprintId, {
    title: data.title,
    description: data.description,
    order: data.seq,
    dependencies: data.dependsOn,
    prompt: data.prompt,
  });
}

export function updateNode(
  blueprintId: string,
  nodeId: string,
  patch: Record<string, unknown>,
): MacroNode | null {
  const mapped: Record<string, unknown> = {};
  if (patch.title !== undefined) mapped.title = patch.title;
  if (patch.description !== undefined) mapped.description = patch.description;
  if (patch.status !== undefined) mapped.status = patch.status;
  if (patch.dependsOn !== undefined) mapped.dependencies = patch.dependsOn;
  if (patch.dependencies !== undefined) mapped.dependencies = patch.dependencies;
  if (patch.prompt !== undefined) mapped.prompt = patch.prompt;
  if (patch.error !== undefined) mapped.error = patch.error;
  if (patch.parallelGroup !== undefined) mapped.parallelGroup = patch.parallelGroup;
  if (patch.estimatedMinutes !== undefined) mapped.estimatedMinutes = patch.estimatedMinutes;
  if (patch.actualMinutes !== undefined) mapped.actualMinutes = patch.actualMinutes;
  if (patch.seq !== undefined) mapped.order = patch.seq;
  if (patch.order !== undefined) mapped.order = patch.order;
  if (patch.agentType !== undefined) mapped.agentType = patch.agentType;
  return updateMacroNode(blueprintId, nodeId, mapped as Partial<Pick<MacroNode, "title" | "description" | "status" | "dependencies" | "parallelGroup" | "prompt" | "estimatedMinutes" | "actualMinutes" | "error" | "order" | "agentType">>);
}

export const deleteNode = deleteMacroNode;

export function reorderNodes(blueprintId: string, ordering: { id: string; seq: number }[]): void {
  reorderMacroNodes(
    blueprintId,
    ordering.map((o) => ({ id: o.id, order: o.seq })),
  );
}

/**
 * Batch lookup: for a list of session IDs, return the associated macro node title + description.
 * Uses a single SQL query for efficiency.
 */
export function getNodeInfoForSessions(sessionIds: string[]): Map<string, { nodeTitle: string; nodeDescription: string; blueprintId: string }> {
  if (sessionIds.length === 0) return new Map();
  const db = getDb();
  const placeholders = sessionIds.map(() => "?").join(", ");
  const rows = db.prepare(`
    SELECT ne.session_id, mn.title, mn.description, mn.blueprint_id
    FROM node_executions ne
    JOIN macro_nodes mn ON ne.node_id = mn.id
    WHERE ne.session_id IN (${placeholders})
  `).all(...sessionIds) as { session_id: string; title: string; description: string | null; blueprint_id: string }[];

  const result = new Map<string, { nodeTitle: string; nodeDescription: string; blueprintId: string }>();
  for (const row of rows) {
    result.set(row.session_id, {
      nodeTitle: row.title,
      nodeDescription: row.description ?? "",
      blueprintId: row.blueprint_id,
    });
  }
  return result;
}

export function getNodeBySession(sessionId: string): MacroNode | null {
  const execution = getExecutionBySession(sessionId);
  if (!execution) return null;
  const db = getDb();
  const row = db.prepare("SELECT * FROM macro_nodes WHERE id = ?").get(execution.nodeId) as MacroNodeRow | undefined;
  if (!row) return null;
  const arts = getArtifactsForNodeInternal(row.id);
  const execs = getExecutionsForNodeInternal(row.id);
  return rowToMacroNode(row, arts.input, arts.output, execs);
}

/**
 * Returns all executions stuck in "running" state with their blueprint context.
 * Used by smartRecoverStaleExecutions() in plan-executor.ts to check liveness
 * before deciding whether to mark as failed.
 */
export function getStaleRunningExecutions(): StaleExecution[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT ne.id, ne.node_id, ne.blueprint_id, ne.session_id, ne.cli_pid, ne.started_at, b.project_cwd
    FROM node_executions ne
    JOIN blueprints b ON ne.blueprint_id = b.id
    WHERE ne.status = 'running'
  `).all() as { id: string; node_id: string; blueprint_id: string; session_id: string | null; cli_pid: number | null; started_at: string; project_cwd: string | null }[];
  return rows.map(r => ({
    id: r.id,
    nodeId: r.node_id,
    blueprintId: r.blueprint_id,
    sessionId: r.session_id,
    cliPid: r.cli_pid,
    startedAt: r.started_at,
    projectCwd: r.project_cwd,
  }));
}

/**
 * Returns executions that were recently marked as failed due to "server restart"
 * but may still have active sessions running.
 */
export function getRecentRestartFailedExecutions(withinMinutes: number): StaleExecution[] {
  const db = getDb();
  const cutoff = new Date(Date.now() - withinMinutes * 60 * 1000).toISOString();
  const rows = db.prepare(`
    SELECT ne.id, ne.node_id, ne.blueprint_id, ne.session_id, ne.cli_pid, ne.started_at, b.project_cwd
    FROM node_executions ne
    JOIN blueprints b ON ne.blueprint_id = b.id
    WHERE ne.status = 'failed'
      AND ne.output_summary LIKE '%Server restarted%'
      AND ne.completed_at > ?
  `).all(cutoff) as { id: string; node_id: string; blueprint_id: string; session_id: string | null; cli_pid: number | null; started_at: string; project_cwd: string | null }[];
  return rows.map(r => ({
    id: r.id,
    nodeId: r.node_id,
    blueprintId: r.blueprint_id,
    sessionId: r.session_id,
    cliPid: r.cli_pid,
    startedAt: r.started_at,
    projectCwd: r.project_cwd,
  }));
}

/**
 * On startup, mark truly-dead stale executions as failed.
 * Accepts an optional skipIds set of execution IDs that should NOT be marked
 * as failed (because they're still alive and being monitored).
 */
export function recoverStaleExecutions(skipIds?: Set<string>): void {
  const db = getDb();

  // Find running executions
  const staleExecs = db
    .prepare("SELECT id, node_id, blueprint_id FROM node_executions WHERE status = 'running'")
    .all() as { id: string; node_id: string; blueprint_id: string }[];

  const now = new Date().toISOString();

  // Note: "queued" nodes are NOT reset here — they will be re-enqueued
  // by requeueOrphanedNodes() in plan-executor.ts after server startup.

  const toFail = skipIds ? staleExecs.filter(e => !skipIds.has(e.id)) : staleExecs;

  if (toFail.length > 0) {
    log.info(`Marking ${toFail.length} truly-dead execution(s) as failed (${staleExecs.length - toFail.length} still alive, being monitored)...`);

    for (const exec of toFail) {
      db.prepare(
        "UPDATE node_executions SET status = 'failed', output_summary = 'Server restarted while execution was running', completed_at = ? WHERE id = ?"
      ).run(now, exec.id);

      // Reset the node to "failed" so it can be retried
      db.prepare(
        "UPDATE macro_nodes SET status = 'failed', error = 'Execution interrupted by server restart' WHERE id = ? AND status = 'running'"
      ).run(exec.node_id);
    }
  }

  // Reset ALL blueprints stuck in "running" that have no active nodes
  const stuckBlueprints = db
    .prepare("SELECT id FROM blueprints WHERE status = 'running'")
    .all() as { id: string }[];
  for (const bp of stuckBlueprints) {
    const stillActive = db
      .prepare("SELECT COUNT(*) as cnt FROM macro_nodes WHERE blueprint_id = ? AND status IN ('running', 'queued')")
      .get(bp.id) as { cnt: number };
    if (stillActive.cnt === 0) {
      db.prepare("UPDATE blueprints SET status = 'approved' WHERE id = ?").run(bp.id);
    }
  }

  if (toFail.length > 0 || staleExecs.length > 0) {
    log.info("Recovery complete.");
  }
}

/**
 * Returns all nodes with "queued" status (orphaned from a previous server process).
 * Called by plan-executor.ts to re-enqueue them after startup.
 */
export function getOrphanedQueuedNodes(): { id: string; blueprintId: string }[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT id, blueprint_id FROM macro_nodes WHERE status = 'queued'")
    .all() as { id: string; blueprint_id: string }[];
  return rows.map((r) => ({ id: r.id, blueprintId: r.blueprint_id }));
}

// ─── Related Sessions CRUD ──────────────────────────────────

interface RelatedSessionRow {
  id: string;
  node_id: string;
  blueprint_id: string;
  session_id: string;
  type: string;
  started_at: string;
  completed_at: string | null;
}

function rowToRelatedSession(row: RelatedSessionRow): RelatedSession {
  return {
    id: row.id,
    nodeId: row.node_id,
    blueprintId: row.blueprint_id,
    sessionId: row.session_id,
    type: row.type as RelatedSessionType,
    startedAt: row.started_at,
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
  };
}

export function createRelatedSession(
  nodeId: string,
  blueprintId: string,
  sessionId: string,
  type: RelatedSessionType,
  startedAt?: string,
  completedAt?: string,
): RelatedSession {
  const db = getDb();
  const id = randomUUID();
  const now = startedAt ?? new Date().toISOString();

  db.prepare(`
    INSERT INTO node_related_sessions (id, node_id, blueprint_id, session_id, type, started_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, nodeId, blueprintId, sessionId, type, now, completedAt ?? null);

  return {
    id,
    nodeId,
    blueprintId,
    sessionId,
    type,
    startedAt: now,
    ...(completedAt ? { completedAt } : {}),
  };
}

export function completeRelatedSession(id: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare("UPDATE node_related_sessions SET completed_at = ? WHERE id = ?").run(now, id);
}

export function getRelatedSessionsForNode(nodeId: string): RelatedSession[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM node_related_sessions WHERE node_id = ? ORDER BY started_at DESC")
    .all(nodeId) as RelatedSessionRow[];
  return rows.map(rowToRelatedSession);
}

export function getRelatedSessionBySession(sessionId: string): RelatedSession | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM node_related_sessions WHERE session_id = ?")
    .get(sessionId) as RelatedSessionRow | undefined;
  return row ? rowToRelatedSession(row) : null;
}
