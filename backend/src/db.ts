import Database from "better-sqlite3";
import { existsSync, mkdirSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { parseTimelineRaw } from "./jsonl-parser.js";
import type { TimelineNode, ProjectInfo, SessionMeta } from "./jsonl-parser.js";
import { CLAWUI_DB_DIR } from "./config.js";
import { createLogger } from "./logger.js";
import { getRegisteredRuntimes } from "./agent-runtime.js";
import type { AgentType, AgentRuntime } from "./agent-runtime.js";
import { parsePiSessionFile } from "./agent-pimono.js";
import { parseOpenClawSessionFile } from "./agent-openclaw.js";
import "./agent-claude.js"; // Side-effect: registers ClaudeAgentRuntime
import "./agent-pimono.js"; // Side-effect: registers PiMonoAgentRuntime
import "./agent-openclaw.js"; // Side-effect: registers OpenClawAgentRuntime

const log = createLogger("db");

const DB_DIR = CLAWUI_DB_DIR;
const DB_PATH = join(DB_DIR, "index.db");

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) throw new Error("Database not initialized — call initDb() first");
  return db;
}

export function initDb(): void {
  if (!existsSync(DB_DIR)) {
    mkdirSync(DB_DIR, { recursive: true });
  }

  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id           TEXT PRIMARY KEY,
      name         TEXT,
      decoded_path TEXT,
      session_count INTEGER DEFAULT 0,
      updated_at   TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id           TEXT PRIMARY KEY,
      project_id   TEXT REFERENCES projects(id),
      slug         TEXT,
      cwd          TEXT,
      created_at   TEXT,
      updated_at   TEXT,
      node_count   INTEGER DEFAULT 0,
      file_size    INTEGER,
      file_mtime   TEXT
    );

    CREATE TABLE IF NOT EXISTS timeline_nodes (
      id           TEXT PRIMARY KEY,
      session_id   TEXT REFERENCES sessions(id),
      seq          INTEGER,
      type         TEXT,
      timestamp    TEXT,
      title        TEXT,
      content      TEXT,
      tool_name    TEXT,
      tool_input   TEXT,
      tool_result  TEXT,
      tool_use_id  TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_nodes_session ON timeline_nodes(session_id, seq);
    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id, updated_at DESC);
  `);

  // Incremental migration: add agent_type columns
  const projCols = db.prepare("PRAGMA table_info(projects)").all() as { name: string }[];
  if (!projCols.some((c) => c.name === "agent_type")) {
    db.exec("ALTER TABLE projects ADD COLUMN agent_type TEXT DEFAULT 'claude'");
  }

  const sessCols = db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
  if (!sessCols.some((c) => c.name === "agent_type")) {
    db.exec("ALTER TABLE sessions ADD COLUMN agent_type TEXT DEFAULT 'claude'");
  }
}

// ─── Runtime instance cache ───────────────────────────────────

const runtimeInstances = new Map<AgentType, AgentRuntime>();

function getRuntimeInstance(agentType: AgentType): AgentRuntime | null {
  if (runtimeInstances.has(agentType)) return runtimeInstances.get(agentType)!;

  const runtimes = getRegisteredRuntimes();
  const factory = runtimes.get(agentType);
  if (!factory) return null;

  try {
    const instance = factory();
    runtimeInstances.set(agentType, instance);
    return instance;
  } catch {
    return null;
  }
}

// ─── Agent-specific parsers ───────────────────────────────────

function parseSessionNodes(filePath: string, raw: string | undefined, agentType: AgentType): TimelineNode[] {
  switch (agentType) {
    case "pi":
      return parsePiSessionFile(filePath, raw);
    case "openclaw":
      return parseOpenClawSessionFile(filePath, raw);
    case "claude":
    default:
      return parseTimelineRaw(filePath, raw);
  }
}

// ─── Multi-agent sync ─────────────────────────────────────────

/**
 * Full scan across all registered agent runtimes — discover and index sessions.
 * Each runtime is scanned independently with its own directory structure.
 */
export function syncAll(): void {
  const runtimes = getRegisteredRuntimes();

  for (const [agentType] of runtimes) {
    try {
      const runtime = getRuntimeInstance(agentType);
      if (!runtime) continue;
      syncAllForAgent(agentType, runtime);
    } catch (err) {
      log.debug(`syncAll: error scanning ${agentType} — ${String(err)}`);
    }
  }
}

/**
 * Scan and sync all sessions for a specific agent runtime.
 */
function syncAllForAgent(agentType: AgentType, runtime: AgentRuntime): void {
  const sessionsDir = runtime.getSessionsDir();
  if (!existsSync(sessionsDir)) return;

  switch (agentType) {
    case "claude":
    case "pi":
      // Both Claude and Pi use flat project dirs: <projectDir>/*.jsonl
      syncFlatProjectDirs(sessionsDir, agentType);
      break;
    case "openclaw":
      // OpenClaw: <agentName>/sessions/*.jsonl — group by CWD from session headers
      syncOpenClawSessions(sessionsDir);
      break;
  }
}

/**
 * Sync sessions from flat project directory structure (used by Claude and Pi Mono).
 * Structure: <sessionsDir>/<projectDir>/<sessionId>.jsonl
 */
function syncFlatProjectDirs(sessionsDir: string, agentType: AgentType): void {
  const projectEntries = readdirSync(sessionsDir, { withFileTypes: true });
  log.debug(`syncAll[${agentType}]: scanning ${projectEntries.length} entries in ${sessionsDir}`);

  // Track which project IDs we see so we can clean up stale ones
  const seenProjectIds = new Set<string>();

  for (const entry of projectEntries) {
    if (!entry.isDirectory()) continue;

    const dirName = entry.name;
    // Prefix non-Claude project IDs to avoid collisions
    const projectId = agentType === "claude" ? dirName : `${agentType}:${dirName}`;
    seenProjectIds.add(projectId);
    const projDir = join(sessionsDir, dirName);

    // Decode project name
    const decodedPath = dirName.replace(/-/g, "/");
    const projectName = decodedPath.split("/").filter(Boolean).slice(-2).join("/");

    const jsonlFiles = readdirSync(projDir).filter((f) => f.endsWith(".jsonl"));

    // Upsert project
    db.prepare(`
      INSERT INTO projects (id, name, decoded_path, session_count, updated_at, agent_type)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        decoded_path = excluded.decoded_path,
        session_count = excluded.session_count,
        updated_at = excluded.updated_at,
        agent_type = excluded.agent_type
    `).run(projectId, projectName || projectId, decodedPath, jsonlFiles.length, new Date().toISOString(), agentType);

    // Track which session IDs we see for this project
    const seenSessionIds = new Set<string>();

    for (const file of jsonlFiles) {
      const sessionId = basename(file, ".jsonl");
      seenSessionIds.add(sessionId);
      const filePath = join(projDir, file);

      syncSessionFile(sessionId, projectId, filePath, agentType);
    }

    // Clean up stale sessions for this project — batch delete
    const existingSessions = db.prepare(
      "SELECT id FROM sessions WHERE project_id = ?"
    ).all(projectId) as { id: string }[];

    const staleSessionIds = existingSessions
      .filter((row) => !seenSessionIds.has(row.id))
      .map((row) => row.id);

    if (staleSessionIds.length > 0) {
      const placeholders = staleSessionIds.map(() => "?").join(",");
      db.prepare(`DELETE FROM timeline_nodes WHERE session_id IN (${placeholders})`).run(...staleSessionIds);
      db.prepare(`DELETE FROM sessions WHERE id IN (${placeholders})`).run(...staleSessionIds);
    }
  }

  // Clean up stale projects for this agent type — batch delete
  const existingProjects = db.prepare(
    "SELECT id FROM projects WHERE agent_type = ?"
  ).all(agentType) as { id: string }[];

  const staleProjectIds = existingProjects
    .filter((row) => !seenProjectIds.has(row.id))
    .map((row) => row.id);

  if (staleProjectIds.length > 0) {
    for (const projectId of staleProjectIds) {
      db.prepare("DELETE FROM timeline_nodes WHERE session_id IN (SELECT id FROM sessions WHERE project_id = ?)").run(projectId);
      db.prepare("DELETE FROM sessions WHERE project_id = ?").run(projectId);
      db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
    }
  }
}

/**
 * Sync sessions from OpenClaw's agent-based directory structure.
 * Structure: <agentsDir>/<agentName>/sessions/<sessionId>.jsonl
 * Sessions are grouped into projects by CWD from session headers.
 */
function syncOpenClawSessions(agentsDir: string): void {
  const agentType: AgentType = "openclaw";
  const agentEntries = readdirSync(agentsDir, { withFileTypes: true });
  log.debug(`syncAll[openclaw]: scanning ${agentEntries.length} agent dirs in ${agentsDir}`);

  // Collect all sessions with their project IDs
  const projectSessions = new Map<string, { sessionId: string; filePath: string; projectName: string; decodedPath: string }[]>();
  const seenProjectIds = new Set<string>();

  for (const agentEntry of agentEntries) {
    if (!agentEntry.isDirectory()) continue;
    const sessionsDir = join(agentsDir, agentEntry.name, "sessions");
    if (!existsSync(sessionsDir)) continue;

    const jsonlFiles = readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));

    for (const file of jsonlFiles) {
      const sessionId = basename(file, ".jsonl");
      const filePath = join(sessionsDir, file);

      // Read CWD from session header (first line) for project grouping
      const { cwd } = readOpenClawSessionHeader(filePath);
      // Create project ID from CWD or fall back to agent name
      const cwdForProject = cwd || agentEntry.name;
      const encodedCwd = cwdForProject.replace(/\//g, "-").replace(/^-/, "");
      const projectId = `openclaw:${encodedCwd}`;

      seenProjectIds.add(projectId);

      const decodedPath = cwdForProject;
      const projectName = decodedPath.split("/").filter(Boolean).slice(-2).join("/");

      const sessions = projectSessions.get(projectId) ?? [];
      sessions.push({ sessionId, filePath, projectName, decodedPath });
      projectSessions.set(projectId, sessions);
    }
  }

  // Upsert projects and sync sessions
  for (const [projectId, sessions] of projectSessions) {
    const { projectName, decodedPath } = sessions[0];

    db.prepare(`
      INSERT INTO projects (id, name, decoded_path, session_count, updated_at, agent_type)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        decoded_path = excluded.decoded_path,
        session_count = excluded.session_count,
        updated_at = excluded.updated_at,
        agent_type = excluded.agent_type
    `).run(projectId, projectName || projectId, decodedPath, sessions.length, new Date().toISOString(), agentType);

    const seenSessionIds = new Set<string>();

    for (const { sessionId, filePath } of sessions) {
      seenSessionIds.add(sessionId);
      syncSessionFile(sessionId, projectId, filePath, agentType);
    }

    // Clean up stale sessions for this project
    const existingSessions = db.prepare(
      "SELECT id FROM sessions WHERE project_id = ?"
    ).all(projectId) as { id: string }[];

    const staleSessionIds = existingSessions
      .filter((row) => !seenSessionIds.has(row.id))
      .map((row) => row.id);

    if (staleSessionIds.length > 0) {
      const placeholders = staleSessionIds.map(() => "?").join(",");
      db.prepare(`DELETE FROM timeline_nodes WHERE session_id IN (${placeholders})`).run(...staleSessionIds);
      db.prepare(`DELETE FROM sessions WHERE id IN (${placeholders})`).run(...staleSessionIds);
    }
  }

  // Clean up stale OpenClaw projects
  const existingProjects = db.prepare(
    "SELECT id FROM projects WHERE agent_type = ?"
  ).all(agentType) as { id: string }[];

  const staleProjectIds = existingProjects
    .filter((row) => !seenProjectIds.has(row.id))
    .map((row) => row.id);

  if (staleProjectIds.length > 0) {
    for (const projectId of staleProjectIds) {
      db.prepare("DELETE FROM timeline_nodes WHERE session_id IN (SELECT id FROM sessions WHERE project_id = ?)").run(projectId);
      db.prepare("DELETE FROM sessions WHERE project_id = ?").run(projectId);
      db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
    }
  }
}

/**
 * Read the session header (first line) of an OpenClaw JSONL file to extract CWD.
 */
function readOpenClawSessionHeader(filePath: string): { cwd?: string; agentName?: string } {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const firstNewline = raw.indexOf("\n");
    const firstLine = firstNewline >= 0 ? raw.slice(0, firstNewline) : raw;
    const header = JSON.parse(firstLine) as { type?: string; cwd?: string; agentName?: string };
    if (header.type === "session") {
      return { cwd: header.cwd, agentName: header.agentName };
    }
  } catch {
    // Can't read or parse — skip
  }
  return {};
}

// ─── Single session sync ──────────────────────────────────────

/**
 * Re-parse a single session by ID.
 * Optionally accepts agent type to narrow the search.
 * If not provided, checks the DB first, then searches all runtimes.
 */
export function syncSession(sessionId: string, agentType?: AgentType): void {
  // If agent type is specified, only search that runtime
  if (agentType) {
    const result = findSessionFileAcrossRuntimes(sessionId, agentType);
    if (result) {
      syncSessionFile(sessionId, result.projectId, result.filePath, agentType);
    }
    return;
  }

  // Check DB for existing agent type
  const existing = db.prepare("SELECT agent_type FROM sessions WHERE id = ?").get(sessionId) as { agent_type: string } | undefined;
  if (existing) {
    const knownType = existing.agent_type as AgentType;
    const result = findSessionFileAcrossRuntimes(sessionId, knownType);
    if (result) {
      syncSessionFile(sessionId, result.projectId, result.filePath, knownType);
      return;
    }
  }

  // Search across all runtimes
  const runtimes = getRegisteredRuntimes();
  for (const [type] of runtimes) {
    const result = findSessionFileAcrossRuntimes(sessionId, type);
    if (result) {
      syncSessionFile(sessionId, result.projectId, result.filePath, type);
      return;
    }
  }

  log.debug(`syncSession: session ${sessionId.slice(0, 8)} not found in any runtime`);
}

/**
 * Find a session file by ID for a specific agent type.
 * Returns the file path and project ID, or null if not found.
 */
function findSessionFileAcrossRuntimes(sessionId: string, agentType: AgentType): { filePath: string; projectId: string } | null {
  const runtime = getRuntimeInstance(agentType);
  if (!runtime) return null;

  const sessionsDir = runtime.getSessionsDir();
  if (!existsSync(sessionsDir)) return null;

  if (agentType === "openclaw") {
    // OpenClaw: agents/<agent>/sessions/<sessionId>.jsonl
    let agents: { name: string; isDirectory: () => boolean }[];
    try {
      agents = readdirSync(sessionsDir, { withFileTypes: true });
    } catch {
      return null;
    }

    for (const agentEntry of agents) {
      if (!agentEntry.isDirectory()) continue;
      const filePath = join(sessionsDir, agentEntry.name, "sessions", `${sessionId}.jsonl`);
      if (existsSync(filePath)) {
        const { cwd } = readOpenClawSessionHeader(filePath);
        const cwdForProject = cwd || agentEntry.name;
        const encodedCwd = cwdForProject.replace(/\//g, "-").replace(/^-/, "");
        const projectId = `openclaw:${encodedCwd}`;
        return { filePath, projectId };
      }
    }
  } else {
    // Claude & Pi: <projectDir>/<sessionId>.jsonl
    let entries: { name: string; isDirectory: () => boolean }[];
    try {
      entries = readdirSync(sessionsDir, { withFileTypes: true });
    } catch {
      return null;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const filePath = join(sessionsDir, entry.name, `${sessionId}.jsonl`);
      if (existsSync(filePath)) {
        const projectId = agentType === "claude" ? entry.name : `${agentType}:${entry.name}`;
        return { filePath, projectId };
      }
    }
  }

  return null;
}

/**
 * Core sync logic for a single session file — checks mtime+size, re-parses if changed.
 */
function syncSessionFile(sessionId: string, projectId: string, filePath: string, agentType: AgentType = "claude"): void {
  const stat = statSync(filePath);
  const fileSize = stat.size;
  const fileMtime = stat.mtime.toISOString();

  // Check if already cached and unchanged
  const existing = db.prepare(
    "SELECT file_size, file_mtime FROM sessions WHERE id = ?"
  ).get(sessionId) as { file_size: number; file_mtime: string } | undefined;

  if (existing && existing.file_size === fileSize && existing.file_mtime === fileMtime) {
    return; // No change
  }
  log.debug(`syncSessionFile: re-parsing ${sessionId.slice(0, 8)} (agent=${agentType}, size=${fileSize}, changed=${!existing ? "new" : "modified"})`);

  // Extract session metadata from first few lines
  let slug: string | undefined;
  let cwd: string | undefined;
  let createdAt: string | undefined;
  let updatedAt: string | undefined;
  let raw: string | undefined;

  try {
    raw = readFileSync(filePath, "utf-8");
    const lines = raw.trim().split("\n");

    // Metadata from first lines
    for (const line of lines.slice(0, 10)) {
      try {
        const obj = JSON.parse(line);
        if (obj.slug) slug = obj.slug;
        if (obj.cwd) cwd = obj.cwd;
        if (obj.timestamp && !createdAt) createdAt = obj.timestamp;
      } catch {
        // skip
      }
    }

    // Latest timestamp from last entries
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
      try {
        const obj = JSON.parse(lines[i]);
        if (obj.timestamp) {
          updatedAt = obj.timestamp;
          break;
        }
      } catch {
        // skip
      }
    }
  } catch {
    // fallback
  }

  if (!createdAt) createdAt = stat.birthtime.toISOString();
  if (!updatedAt) updatedAt = stat.mtime.toISOString();

  // Parse timeline nodes using the agent-specific parser
  const nodes = parseSessionNodes(filePath, raw, agentType);
  const nodeCount = nodes.filter((n) => n.type === "user" || n.type === "assistant").length;

  // Write in a transaction
  const writeSession = db.transaction(() => {
    // Clear existing nodes
    db.prepare("DELETE FROM timeline_nodes WHERE session_id = ?").run(sessionId);

    // Upsert session
    db.prepare(`
      INSERT INTO sessions (id, project_id, slug, cwd, created_at, updated_at, node_count, file_size, file_mtime, agent_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id,
        slug = excluded.slug,
        cwd = excluded.cwd,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        node_count = excluded.node_count,
        file_size = excluded.file_size,
        file_mtime = excluded.file_mtime,
        agent_type = excluded.agent_type
    `).run(sessionId, projectId, slug ?? null, cwd ?? null, createdAt, updatedAt, nodeCount, fileSize, fileMtime, agentType);

    // Insert nodes
    const insertNode = db.prepare(`
      INSERT INTO timeline_nodes (id, session_id, seq, type, timestamp, title, content, tool_name, tool_input, tool_result, tool_use_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      insertNode.run(
        n.id,
        sessionId,
        i,
        n.type,
        n.timestamp,
        n.title,
        n.content,
        n.toolName ?? null,
        n.toolInput ?? null,
        n.toolResult ?? null,
        n.toolUseId ?? null,
      );
    }
  });

  writeSession();
}

// ─── Query functions (matching existing API shapes) ───

export function getProjects(agentType?: AgentType): ProjectInfo[] {
  let sql = "SELECT id, name, decoded_path, session_count, agent_type FROM projects";
  const params: unknown[] = [];

  if (agentType) {
    sql += " WHERE agent_type = ?";
    params.push(agentType);
  }

  sql += " ORDER BY session_count DESC";

  const rows = db.prepare(sql).all(...params) as {
    id: string;
    name: string;
    decoded_path: string;
    session_count: number;
    agent_type: string;
  }[];

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    path: r.decoded_path,
    sessionCount: r.session_count,
    agentType: r.agent_type,
  }));
}

export function getSessions(projectId: string, agentType?: AgentType): SessionMeta[] {
  // Decode project name for the response — strip agent prefix if present
  const rawProjectId = projectId.replace(/^(pi|openclaw):/, "");
  const decodedPath = rawProjectId.replace(/-/g, "/");
  const projectName = decodedPath.split("/").filter(Boolean).slice(-2).join("/");

  let sql = `
    SELECT id, project_id, slug, cwd, created_at, updated_at, node_count, agent_type
    FROM sessions
    WHERE project_id = ?
  `;
  const params: unknown[] = [projectId];

  if (agentType) {
    sql += " AND agent_type = ?";
    params.push(agentType);
  }

  sql += " ORDER BY updated_at DESC";

  const rows = db.prepare(sql).all(...params) as {
    id: string;
    project_id: string;
    slug: string | null;
    cwd: string | null;
    created_at: string;
    updated_at: string;
    node_count: number;
    agent_type: string;
  }[];

  return rows.map((r) => ({
    sessionId: r.id,
    projectId: r.project_id,
    projectName,
    timestamp: r.updated_at,
    nodeCount: r.node_count,
    slug: r.slug ?? undefined,
    cwd: r.cwd ?? undefined,
    agentType: r.agent_type,
  }));
}

/**
 * Get the agent type for a session by ID.
 * Used by routes to select the correct parser/health analyzer.
 */
export function getSessionAgentType(sessionId: string): AgentType | null {
  const row = db.prepare("SELECT agent_type FROM sessions WHERE id = ?").get(sessionId) as { agent_type: string } | undefined;
  return (row?.agent_type as AgentType) ?? null;
}

export function getTimeline(sessionId: string): TimelineNode[] {
  const rows = db.prepare(`
    SELECT id, type, timestamp, title, content, tool_name, tool_input, tool_result, tool_use_id
    FROM timeline_nodes
    WHERE session_id = ?
    ORDER BY seq ASC
  `).all(sessionId) as {
    id: string;
    type: string;
    timestamp: string;
    title: string;
    content: string;
    tool_name: string | null;
    tool_input: string | null;
    tool_result: string | null;
    tool_use_id: string | null;
  }[];

  return rows.map((r) => ({
    id: r.id,
    type: r.type as TimelineNode["type"],
    timestamp: r.timestamp,
    title: r.title,
    content: r.content,
    ...(r.tool_name ? { toolName: r.tool_name } : {}),
    ...(r.tool_input ? { toolInput: r.tool_input } : {}),
    ...(r.tool_result ? { toolResult: r.tool_result } : {}),
    ...(r.tool_use_id ? { toolUseId: r.tool_use_id } : {}),
  }));
}

export function getLastMessage(sessionId: string): TimelineNode | null {
  const row = db.prepare(`
    SELECT id, type, timestamp, title, content, tool_name, tool_input, tool_result, tool_use_id
    FROM timeline_nodes
    WHERE session_id = ?
    ORDER BY seq DESC
    LIMIT 1
  `).get(sessionId) as {
    id: string;
    type: string;
    timestamp: string;
    title: string;
    content: string;
    tool_name: string | null;
    tool_input: string | null;
    tool_result: string | null;
    tool_use_id: string | null;
  } | undefined;

  if (!row) return null;

  return {
    id: row.id,
    type: row.type as TimelineNode["type"],
    timestamp: row.timestamp,
    title: row.title,
    content: row.content,
    ...(row.tool_name ? { toolName: row.tool_name } : {}),
    ...(row.tool_input ? { toolInput: row.tool_input } : {}),
    ...(row.tool_result ? { toolResult: row.tool_result } : {}),
    ...(row.tool_use_id ? { toolUseId: row.tool_use_id } : {}),
  };
}

// ─── Agent discovery ──────────────────────────────────────────

export interface AgentInfo {
  name: string;
  type: AgentType;
  available: boolean;
  sessionsPath: string;
  sessionCount: number;
}

/**
 * Get info about all registered agent runtimes, including availability and session counts.
 */
export function getAvailableAgents(): AgentInfo[] {
  const runtimes = getRegisteredRuntimes();
  const agents: AgentInfo[] = [];

  const agentNames: Record<AgentType, string> = {
    claude: "Claude Code",
    openclaw: "OpenClaw",
    pi: "Pi Mono",
  };

  for (const [agentType] of runtimes) {
    const runtime = getRuntimeInstance(agentType);
    const sessionsPath = runtime?.getSessionsDir() ?? "";
    const available = !!runtime && existsSync(sessionsPath);

    // Count sessions from the DB for this agent type
    const countRow = db.prepare(
      "SELECT COUNT(*) as count FROM sessions WHERE agent_type = ?"
    ).get(agentType) as { count: number };

    agents.push({
      name: agentNames[agentType] ?? agentType,
      type: agentType,
      available,
      sessionsPath,
      sessionCount: countRow.count,
    });
  }

  return agents;
}
