import Database from "better-sqlite3";
import { existsSync, mkdirSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { parseTimelineRaw } from "./jsonl-parser.js";
import type { TimelineNode, ProjectInfo, SessionMeta } from "./jsonl-parser.js";
import { CLAWUI_DB_DIR } from "./config.js";
import { createLogger } from "./logger.js";

const log = createLogger("db");

const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");
// Resolve project root (one level up from backend/)
const PROJECT_ROOT = join(import.meta.dirname, "..", "..");
const DB_DIR = join(PROJECT_ROOT, CLAWUI_DB_DIR);
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
  `);
}

/**
 * Full scan of ~/.claude/projects/ — compare file_size+mtime, only re-parse changed files.
 */
export function syncAll(): void {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return;

  const projectEntries = readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true });
  log.debug(`syncAll: scanning ${projectEntries.length} entries in ${CLAUDE_PROJECTS_DIR}`);

  // Track which project IDs we see so we can clean up stale ones
  const seenProjectIds = new Set<string>();

  for (const entry of projectEntries) {
    if (!entry.isDirectory()) continue;

    const projectId = entry.name;
    seenProjectIds.add(projectId);
    const projDir = join(CLAUDE_PROJECTS_DIR, projectId);

    // Decode project name
    const decodedPath = projectId.replace(/-/g, "/");
    const projectName = decodedPath.split("/").filter(Boolean).slice(-2).join("/");

    const jsonlFiles = readdirSync(projDir).filter((f) => f.endsWith(".jsonl"));

    // Upsert project
    db.prepare(`
      INSERT INTO projects (id, name, decoded_path, session_count, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        decoded_path = excluded.decoded_path,
        session_count = excluded.session_count,
        updated_at = excluded.updated_at
    `).run(projectId, projectName || projectId, decodedPath, jsonlFiles.length, new Date().toISOString());

    // Track which session IDs we see for this project
    const seenSessionIds = new Set<string>();

    for (const file of jsonlFiles) {
      const sessionId = basename(file, ".jsonl");
      seenSessionIds.add(sessionId);
      const filePath = join(projDir, file);

      syncSessionFile(sessionId, projectId, filePath);
    }

    // Clean up stale sessions for this project
    const existingSessions = db.prepare(
      "SELECT id FROM sessions WHERE project_id = ?"
    ).all(projectId) as { id: string }[];

    for (const row of existingSessions) {
      if (!seenSessionIds.has(row.id)) {
        db.prepare("DELETE FROM timeline_nodes WHERE session_id = ?").run(row.id);
        db.prepare("DELETE FROM sessions WHERE id = ?").run(row.id);
      }
    }
  }

  // Clean up stale projects
  const existingProjects = db.prepare("SELECT id FROM projects").all() as { id: string }[];
  for (const row of existingProjects) {
    if (!seenProjectIds.has(row.id)) {
      db.prepare("DELETE FROM timeline_nodes WHERE session_id IN (SELECT id FROM sessions WHERE project_id = ?)").run(row.id);
      db.prepare("DELETE FROM sessions WHERE project_id = ?").run(row.id);
      db.prepare("DELETE FROM projects WHERE id = ?").run(row.id);
    }
  }
}

/**
 * Re-parse a single session by ID (searches across projects for the file).
 */
export function syncSession(sessionId: string): void {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return;

  log.debug(`syncSession: looking for session ${sessionId.slice(0, 8)}`);
  const projectEntries = readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true });
  for (const entry of projectEntries) {
    if (!entry.isDirectory()) continue;
    const filePath = join(CLAUDE_PROJECTS_DIR, entry.name, `${sessionId}.jsonl`);
    if (existsSync(filePath)) {
      syncSessionFile(sessionId, entry.name, filePath);
      return;
    }
  }
  log.debug(`syncSession: session ${sessionId.slice(0, 8)} not found`);
}

/**
 * Core sync logic for a single session file — checks mtime+size, re-parses if changed.
 */
function syncSessionFile(sessionId: string, projectId: string, filePath: string): void {
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
  log.debug(`syncSessionFile: re-parsing ${sessionId.slice(0, 8)} (size=${fileSize}, changed=${!existing ? "new" : "modified"})`);

  // Extract session metadata from first few lines
  let slug: string | undefined;
  let cwd: string | undefined;
  let createdAt: string | undefined;
  let updatedAt: string | undefined;

  try {
    const raw = readFileSync(filePath, "utf-8");
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

  // Parse timeline nodes
  const nodes = parseTimelineRaw(filePath);
  const nodeCount = nodes.filter((n) => n.type === "user" || n.type === "assistant").length;

  // Write in a transaction
  const writeSession = db.transaction(() => {
    // Clear existing nodes
    db.prepare("DELETE FROM timeline_nodes WHERE session_id = ?").run(sessionId);

    // Upsert session
    db.prepare(`
      INSERT INTO sessions (id, project_id, slug, cwd, created_at, updated_at, node_count, file_size, file_mtime)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id,
        slug = excluded.slug,
        cwd = excluded.cwd,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        node_count = excluded.node_count,
        file_size = excluded.file_size,
        file_mtime = excluded.file_mtime
    `).run(sessionId, projectId, slug ?? null, cwd ?? null, createdAt, updatedAt, nodeCount, fileSize, fileMtime);

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

export function getProjects(): ProjectInfo[] {
  const rows = db.prepare(`
    SELECT id, name, decoded_path, session_count
    FROM projects
    ORDER BY session_count DESC
  `).all() as { id: string; name: string; decoded_path: string; session_count: number }[];

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    path: r.decoded_path,
    sessionCount: r.session_count,
  }));
}

export function getSessions(projectId: string): SessionMeta[] {
  // Decode project name for the response
  const decodedPath = projectId.replace(/-/g, "/");
  const projectName = decodedPath.split("/").filter(Boolean).slice(-2).join("/");

  const rows = db.prepare(`
    SELECT id, project_id, slug, cwd, created_at, updated_at, node_count
    FROM sessions
    WHERE project_id = ?
    ORDER BY updated_at DESC
  `).all(projectId) as {
    id: string;
    project_id: string;
    slug: string | null;
    cwd: string | null;
    created_at: string;
    updated_at: string;
    node_count: number;
  }[];

  return rows.map((r) => ({
    sessionId: r.id,
    projectId: r.project_id,
    projectName,
    timestamp: r.updated_at,
    nodeCount: r.node_count,
    slug: r.slug ?? undefined,
    cwd: r.cwd ?? undefined,
  }));
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
