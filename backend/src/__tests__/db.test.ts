import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

// We test the db module's SQL logic by creating in-memory databases
// that mirror the schema, and test query functions via direct DB manipulation.

// ─── Schema (mirrors db.ts initDb) ──────────────────────────

const SCHEMA = `
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
`;

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

// ─── Mock JSONL data ────────────────────────────────────────

function makeJsonlLine(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

function createMockJsonl(lines: Record<string, unknown>[]): string {
  return lines.map(makeJsonlLine).join("\n") + "\n";
}

const MOCK_SESSION_JSONL = createMockJsonl([
  {
    type: "user",
    uuid: "uuid-1",
    timestamp: "2024-01-01T00:00:00.000Z",
    slug: "test-session",
    cwd: "/tmp/test-project",
    message: { role: "user", content: "Hello world" },
  },
  {
    type: "assistant",
    uuid: "uuid-2",
    timestamp: "2024-01-01T00:00:01.000Z",
    message: {
      content: [{ type: "text", text: "Hi there! How can I help you?" }],
    },
  },
  {
    type: "assistant",
    uuid: "uuid-3",
    timestamp: "2024-01-01T00:00:02.000Z",
    message: {
      content: [
        {
          type: "tool_use",
          id: "tool-1",
          name: "Read",
          input: { file_path: "/tmp/test.txt" },
        },
      ],
    },
  },
  {
    type: "user",
    uuid: "uuid-4",
    timestamp: "2024-01-01T00:00:03.000Z",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: "file contents here",
        },
      ],
    },
  },
  {
    type: "assistant",
    uuid: "uuid-5",
    timestamp: "2024-01-01T00:00:04.000Z",
    message: {
      content: [{ type: "text", text: "I've read the file. All done!" }],
    },
  },
]);

describe("Database Schema", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("creates projects table with correct columns", () => {
    const info = db.pragma("table_info(projects)") as Array<{
      name: string;
      type: string;
      pk: number;
    }>;
    const colNames = info.map((c) => c.name);
    expect(colNames).toContain("id");
    expect(colNames).toContain("name");
    expect(colNames).toContain("decoded_path");
    expect(colNames).toContain("session_count");
    expect(colNames).toContain("updated_at");
    const idCol = info.find((c) => c.name === "id");
    expect(idCol?.pk).toBe(1);
  });

  it("creates sessions table with correct columns", () => {
    const info = db.pragma("table_info(sessions)") as Array<{
      name: string;
      type: string;
    }>;
    const colNames = info.map((c) => c.name);
    expect(colNames).toEqual(
      expect.arrayContaining([
        "id", "project_id", "slug", "cwd", "created_at",
        "updated_at", "node_count", "file_size", "file_mtime",
      ]),
    );
  });

  it("creates timeline_nodes table with correct columns", () => {
    const info = db.pragma("table_info(timeline_nodes)") as Array<{ name: string }>;
    const colNames = info.map((c) => c.name);
    expect(colNames).toEqual(
      expect.arrayContaining([
        "id", "session_id", "seq", "type", "timestamp",
        "title", "content", "tool_name", "tool_input", "tool_result", "tool_use_id",
      ]),
    );
  });

  it("creates idx_nodes_session index", () => {
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index'")
      .all() as Array<{ name: string }>;
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("idx_nodes_session");
  });
});

describe("Project CRUD operations", () => {
  let db: Database.Database;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it("inserts and retrieves a project", () => {
    db.prepare(
      "INSERT INTO projects (id, name, decoded_path, session_count, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("proj-1", "MyProject", "/Users/test/MyProject", 5, "2024-01-01T00:00:00Z");

    const rows = db
      .prepare("SELECT id, name, decoded_path, session_count FROM projects ORDER BY session_count DESC")
      .all() as Array<{ id: string; name: string; decoded_path: string; session_count: number }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("proj-1");
    expect(rows[0].name).toBe("MyProject");
    expect(rows[0].session_count).toBe(5);
  });

  it("upserts project correctly (ON CONFLICT)", () => {
    const upsert = db.prepare(`
      INSERT INTO projects (id, name, decoded_path, session_count, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, decoded_path = excluded.decoded_path,
        session_count = excluded.session_count, updated_at = excluded.updated_at
    `);

    upsert.run("proj-1", "OldName", "/old/path", 2, "2024-01-01T00:00:00Z");
    upsert.run("proj-1", "NewName", "/new/path", 5, "2024-01-02T00:00:00Z");

    const rows = db.prepare("SELECT * FROM projects WHERE id = ?").all("proj-1") as Array<{ name: string; session_count: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("NewName");
    expect(rows[0].session_count).toBe(5);
  });

  it("lists multiple projects sorted by session_count DESC", () => {
    const insert = db.prepare("INSERT INTO projects (id, name, decoded_path, session_count, updated_at) VALUES (?, ?, ?, ?, ?)");
    insert.run("proj-a", "A", "/a", 1, "2024-01-01T00:00:00Z");
    insert.run("proj-b", "B", "/b", 10, "2024-01-01T00:00:00Z");
    insert.run("proj-c", "C", "/c", 5, "2024-01-01T00:00:00Z");

    const rows = db.prepare("SELECT id FROM projects ORDER BY session_count DESC").all() as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(["proj-b", "proj-c", "proj-a"]);
  });
});

describe("Session CRUD operations", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    db.prepare("INSERT INTO projects (id, name, decoded_path, session_count, updated_at) VALUES (?, ?, ?, ?, ?)").run("proj-1", "TestProject", "/test", 1, "2024-01-01T00:00:00Z");
  });
  afterEach(() => { db.close(); });

  it("inserts and retrieves a session", () => {
    db.prepare(`
      INSERT INTO sessions (id, project_id, slug, cwd, created_at, updated_at, node_count, file_size, file_mtime)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("session-1", "proj-1", "test-session", "/tmp/test", "2024-01-01T00:00:00Z", "2024-01-01T00:01:00Z", 5, 1024, "2024-01-01T00:00:00Z");

    const rows = db.prepare("SELECT * FROM sessions WHERE project_id = ? ORDER BY updated_at DESC").all("proj-1") as Array<{ id: string; slug: string; node_count: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("session-1");
    expect(rows[0].slug).toBe("test-session");
    expect(rows[0].node_count).toBe(5);
  });

  it("upserts session correctly (ON CONFLICT)", () => {
    const upsert = db.prepare(`
      INSERT INTO sessions (id, project_id, slug, cwd, created_at, updated_at, node_count, file_size, file_mtime)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id, slug = excluded.slug, cwd = excluded.cwd,
        created_at = excluded.created_at, updated_at = excluded.updated_at,
        node_count = excluded.node_count, file_size = excluded.file_size, file_mtime = excluded.file_mtime
    `);

    upsert.run("session-1", "proj-1", "old-slug", "/old", "2024-01-01T00:00:00Z", "2024-01-01T00:00:00Z", 2, 500, "2024-01-01T00:00:00Z");
    upsert.run("session-1", "proj-1", "new-slug", "/new", "2024-01-01T00:00:00Z", "2024-01-02T00:00:00Z", 10, 2048, "2024-01-02T00:00:00Z");

    const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get("session-1") as { slug: string; node_count: number; file_size: number };
    expect(row.slug).toBe("new-slug");
    expect(row.node_count).toBe(10);
    expect(row.file_size).toBe(2048);
  });

  it("filters sessions by project_id", () => {
    db.prepare("INSERT INTO projects (id, name, decoded_path, session_count, updated_at) VALUES (?, ?, ?, ?, ?)").run("proj-2", "Project2", "/test2", 1, "2024-01-01T00:00:00Z");

    const ins = db.prepare("INSERT INTO sessions (id, project_id, slug, created_at, updated_at, node_count, file_size, file_mtime) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    ins.run("s1", "proj-1", "slug1", "2024-01-01T00:00:00Z", "2024-01-01T00:00:00Z", 1, 100, "2024-01-01T00:00:00Z");
    ins.run("s2", "proj-2", "slug2", "2024-01-01T00:00:00Z", "2024-01-01T00:00:00Z", 1, 100, "2024-01-01T00:00:00Z");
    ins.run("s3", "proj-1", "slug3", "2024-01-01T00:00:00Z", "2024-01-01T00:00:00Z", 1, 100, "2024-01-01T00:00:00Z");

    const proj1Sessions = db.prepare("SELECT id FROM sessions WHERE project_id = ?").all("proj-1") as Array<{ id: string }>;
    expect(proj1Sessions).toHaveLength(2);
    expect(proj1Sessions.map((s) => s.id).sort()).toEqual(["s1", "s3"]);
  });

  it("orders sessions by updated_at DESC", () => {
    const ins = db.prepare("INSERT INTO sessions (id, project_id, slug, created_at, updated_at, node_count, file_size, file_mtime) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    ins.run("s1", "proj-1", "a", "2024-01-01T00:00:00Z", "2024-01-01T00:00:00Z", 1, 100, "2024-01-01T00:00:00Z");
    ins.run("s2", "proj-1", "b", "2024-01-02T00:00:00Z", "2024-01-03T00:00:00Z", 1, 100, "2024-01-03T00:00:00Z");
    ins.run("s3", "proj-1", "c", "2024-01-01T00:00:00Z", "2024-01-02T00:00:00Z", 1, 100, "2024-01-02T00:00:00Z");

    const rows = db.prepare("SELECT id FROM sessions WHERE project_id = ? ORDER BY updated_at DESC").all("proj-1") as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(["s2", "s3", "s1"]);
  });
});

describe("Timeline Node operations", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    db.prepare("INSERT INTO projects (id, name, decoded_path, session_count, updated_at) VALUES (?, ?, ?, ?, ?)").run("proj-1", "TestProject", "/test", 1, "2024-01-01T00:00:00Z");
    db.prepare("INSERT INTO sessions (id, project_id, slug, created_at, updated_at, node_count, file_size, file_mtime) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("session-1", "proj-1", "test", "2024-01-01T00:00:00Z", "2024-01-01T00:00:00Z", 3, 500, "2024-01-01T00:00:00Z");
  });
  afterEach(() => { db.close(); });

  it("inserts and retrieves timeline nodes in order", () => {
    const insert = db.prepare("INSERT INTO timeline_nodes (id, session_id, seq, type, timestamp, title, content, tool_name, tool_input, tool_result, tool_use_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    insert.run("n1", "session-1", 0, "user", "2024-01-01T00:00:00Z", "Hello", "Hello world", null, null, null, null);
    insert.run("n2", "session-1", 1, "assistant", "2024-01-01T00:00:01Z", "Hi there", "Hi there!", null, null, null, null);
    insert.run("n3", "session-1", 2, "tool_use", "2024-01-01T00:00:02Z", "Read", '{"file_path":"/tmp/t.txt"}', "Read", '{"file_path":"/tmp/t.txt"}', null, "tool-id-1");

    const rows = db.prepare("SELECT * FROM timeline_nodes WHERE session_id = ? ORDER BY seq ASC").all("session-1") as Array<{ id: string; type: string; tool_name: string | null; tool_use_id: string | null }>;

    expect(rows).toHaveLength(3);
    expect(rows[0].type).toBe("user");
    expect(rows[1].type).toBe("assistant");
    expect(rows[2].type).toBe("tool_use");
    expect(rows[2].tool_name).toBe("Read");
    expect(rows[2].tool_use_id).toBe("tool-id-1");
  });

  it("maps optional tool fields correctly", () => {
    const insert = db.prepare("INSERT INTO timeline_nodes (id, session_id, seq, type, timestamp, title, content, tool_name, tool_input, tool_result, tool_use_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    insert.run("n1", "session-1", 0, "user", "2024-01-01T00:00:00Z", "Hello", "Hello", null, null, null, null);
    insert.run("n2", "session-1", 1, "tool_use", "2024-01-01T00:00:01Z", "Read", "{}", "Read", '{"path":"f"}', null, "tu-1");

    const rows = db.prepare("SELECT id, type, tool_name, tool_input, tool_result, tool_use_id FROM timeline_nodes WHERE session_id = ? ORDER BY seq ASC").all("session-1") as Array<{ id: string; type: string; tool_name: string | null; tool_input: string | null; tool_result: string | null; tool_use_id: string | null }>;

    // User node — optional fields null
    expect(rows[0].tool_name).toBeNull();
    expect(rows[0].tool_use_id).toBeNull();

    // Tool node — optional fields present
    expect(rows[1].tool_name).toBe("Read");
    expect(rows[1].tool_use_id).toBe("tu-1");

    // Simulate getTimeline mapping
    const mapped = rows.map((r) => ({
      id: r.id, type: r.type,
      ...(r.tool_name ? { toolName: r.tool_name } : {}),
      ...(r.tool_use_id ? { toolUseId: r.tool_use_id } : {}),
    }));

    expect(mapped[0]).not.toHaveProperty("toolName");
    expect(mapped[1]).toHaveProperty("toolName", "Read");
  });

  it("cleanup removes nodes when session deleted", () => {
    const insert = db.prepare("INSERT INTO timeline_nodes (id, session_id, seq, type, timestamp, title, content, tool_name, tool_input, tool_result, tool_use_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    insert.run("n1", "session-1", 0, "user", "2024-01-01T00:00:00Z", "Hi", "Hi", null, null, null, null);
    insert.run("n2", "session-1", 1, "assistant", "2024-01-01T00:00:01Z", "Hi", "Hi", null, null, null, null);

    db.prepare("DELETE FROM timeline_nodes WHERE session_id = ?").run("session-1");
    db.prepare("DELETE FROM sessions WHERE id = ?").run("session-1");

    const nodes = db.prepare("SELECT * FROM timeline_nodes WHERE session_id = ?").all("session-1");
    expect(nodes).toHaveLength(0);
  });
});

describe("Incremental sync logic (mtime+size check)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    db.prepare("INSERT INTO projects (id, name, decoded_path, session_count, updated_at) VALUES (?, ?, ?, ?, ?)").run("proj-1", "TestProject", "/test", 1, "2024-01-01T00:00:00Z");
  });
  afterEach(() => { db.close(); });

  it("detects file unchanged when size and mtime match", () => {
    db.prepare("INSERT INTO sessions (id, project_id, slug, created_at, updated_at, node_count, file_size, file_mtime) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("session-1", "proj-1", "test", "2024-01-01T00:00:00Z", "2024-01-01T00:00:00Z", 5, 1024, "2024-01-01T00:00:00.000Z");

    const existing = db.prepare("SELECT file_size, file_mtime FROM sessions WHERE id = ?").get("session-1") as { file_size: number; file_mtime: string };
    const unchanged = existing.file_size === 1024 && existing.file_mtime === "2024-01-01T00:00:00.000Z";
    expect(unchanged).toBe(true);
  });

  it("detects file changed when size differs", () => {
    db.prepare("INSERT INTO sessions (id, project_id, slug, created_at, updated_at, node_count, file_size, file_mtime) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("session-1", "proj-1", "test", "2024-01-01T00:00:00Z", "2024-01-01T00:00:00Z", 5, 1024, "2024-01-01T00:00:00.000Z");

    const existing = db.prepare("SELECT file_size, file_mtime FROM sessions WHERE id = ?").get("session-1") as { file_size: number; file_mtime: string };
    const unchanged = existing.file_size === 2048 && existing.file_mtime === "2024-01-01T00:00:00.000Z";
    expect(unchanged).toBe(false);
  });

  it("returns undefined for non-existent session", () => {
    const existing = db.prepare("SELECT file_size, file_mtime FROM sessions WHERE id = ?").get("nonexistent");
    expect(existing).toBeUndefined();
  });
});

describe("Stale data cleanup", () => {
  let db: Database.Database;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it("removes stale sessions not in current scan", () => {
    db.prepare("INSERT INTO projects (id, name, decoded_path, session_count, updated_at) VALUES (?, ?, ?, ?, ?)").run("proj-1", "P", "/p", 2, "2024-01-01T00:00:00Z");
    const ins = db.prepare("INSERT INTO sessions (id, project_id, slug, created_at, updated_at, node_count, file_size, file_mtime) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    ins.run("s1", "proj-1", "a", "2024-01-01T00:00:00Z", "2024-01-01T00:00:00Z", 1, 100, "2024-01-01T00:00:00Z");
    ins.run("s2", "proj-1", "b", "2024-01-01T00:00:00Z", "2024-01-01T00:00:00Z", 1, 100, "2024-01-01T00:00:00Z");

    db.prepare("INSERT INTO timeline_nodes (id, session_id, seq, type, timestamp, title, content, tool_name, tool_input, tool_result, tool_use_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("n1", "s1", 0, "user", "2024-01-01T00:00:00Z", "Hi", "Hi", null, null, null, null);
    db.prepare("INSERT INTO timeline_nodes (id, session_id, seq, type, timestamp, title, content, tool_name, tool_input, tool_result, tool_use_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("n2", "s2", 0, "user", "2024-01-01T00:00:00Z", "Hi", "Hi", null, null, null, null);

    // Only s1 was seen in current scan
    const seenSessionIds = new Set(["s1"]);
    const existingSessions = db.prepare("SELECT id FROM sessions WHERE project_id = ?").all("proj-1") as { id: string }[];
    for (const row of existingSessions) {
      if (!seenSessionIds.has(row.id)) {
        db.prepare("DELETE FROM timeline_nodes WHERE session_id = ?").run(row.id);
        db.prepare("DELETE FROM sessions WHERE id = ?").run(row.id);
      }
    }

    const remaining = db.prepare("SELECT id FROM sessions").all() as { id: string }[];
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe("s1");
  });

  it("removes stale projects not in current scan", () => {
    const ins = db.prepare("INSERT INTO projects (id, name, decoded_path, session_count, updated_at) VALUES (?, ?, ?, ?, ?)");
    ins.run("proj-1", "A", "/a", 1, "2024-01-01T00:00:00Z");
    ins.run("proj-2", "B", "/b", 1, "2024-01-01T00:00:00Z");
    db.prepare("INSERT INTO sessions (id, project_id, slug, created_at, updated_at, node_count, file_size, file_mtime) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("s1", "proj-2", "a", "2024-01-01T00:00:00Z", "2024-01-01T00:00:00Z", 1, 100, "2024-01-01T00:00:00Z");

    const seenProjectIds = new Set(["proj-1"]);
    const existingProjects = db.prepare("SELECT id FROM projects").all() as { id: string }[];
    for (const row of existingProjects) {
      if (!seenProjectIds.has(row.id)) {
        db.prepare("DELETE FROM timeline_nodes WHERE session_id IN (SELECT id FROM sessions WHERE project_id = ?)").run(row.id);
        db.prepare("DELETE FROM sessions WHERE project_id = ?").run(row.id);
        db.prepare("DELETE FROM projects WHERE id = ?").run(row.id);
      }
    }

    const remaining = db.prepare("SELECT id FROM projects").all() as { id: string }[];
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe("proj-1");
  });
});

describe("JSONL parsing (parseTimelineRaw)", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = join(tmpdir(), `clawui-test-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("parses a valid JSONL file into timeline nodes", async () => {
    const filePath = join(tmpDir, "test-session.jsonl");
    writeFileSync(filePath, MOCK_SESSION_JSONL, "utf-8");

    const { parseTimelineRaw } = await import("../jsonl-parser.js");
    const nodes = parseTimelineRaw(filePath);

    expect(nodes.length).toBeGreaterThanOrEqual(3);
    const userNodes = nodes.filter((n) => n.type === "user");
    const assistantNodes = nodes.filter((n) => n.type === "assistant");
    const toolUseNodes = nodes.filter((n) => n.type === "tool_use");
    const toolResultNodes = nodes.filter((n) => n.type === "tool_result");

    expect(userNodes.length).toBeGreaterThanOrEqual(1);
    expect(assistantNodes.length).toBeGreaterThanOrEqual(1);
    expect(toolUseNodes).toHaveLength(1);
    expect(toolResultNodes).toHaveLength(1);
    expect(toolUseNodes[0].toolName).toBe("Read");
  });

  it("handles empty JSONL file", async () => {
    const filePath = join(tmpDir, "empty.jsonl");
    writeFileSync(filePath, "", "utf-8");

    const { parseTimelineRaw } = await import("../jsonl-parser.js");
    const nodes = parseTimelineRaw(filePath);
    expect(nodes).toHaveLength(0);
  });

  it("skips malformed JSON lines", async () => {
    const filePath = join(tmpDir, "malformed.jsonl");
    const content = [
      '{"type":"user","uuid":"u1","timestamp":"2024-01-01T00:00:00Z","message":{"role":"user","content":"Hello"}}',
      "this is not json",
      '{"type":"assistant","uuid":"a1","timestamp":"2024-01-01T00:00:01Z","message":{"content":[{"type":"text","text":"Hi"}]}}',
    ].join("\n");
    writeFileSync(filePath, content, "utf-8");

    const { parseTimelineRaw } = await import("../jsonl-parser.js");
    const nodes = parseTimelineRaw(filePath);
    expect(nodes.length).toBeGreaterThanOrEqual(2);
  });

  it("skips non-user/assistant types", async () => {
    const filePath = join(tmpDir, "with-system.jsonl");
    const content = [
      '{"type":"system","uuid":"sys1","timestamp":"2024-01-01T00:00:00Z","message":{"content":"system init"}}',
      '{"type":"user","uuid":"u1","timestamp":"2024-01-01T00:00:01Z","message":{"role":"user","content":"Hello"}}',
      '{"type":"progress","uuid":"p1","timestamp":"2024-01-01T00:00:02Z","data":"50%"}',
    ].join("\n");
    writeFileSync(filePath, content, "utf-8");

    const { parseTimelineRaw } = await import("../jsonl-parser.js");
    const nodes = parseTimelineRaw(filePath);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe("user");
  });
});

describe("JSONL helper functions", () => {
  it("cleanContent strips suggestion suffix from user messages", async () => {
    const { cleanContent } = await import("../jsonl-parser.js");
    const userMsg = `Fix the bug\n\nAfter completing the task above, append a line "---SUGGESTIONS---" followed by 3 suggested next actions.`;
    const cleaned = cleanContent(userMsg, "user");
    expect(cleaned).toBe("Fix the bug");
  });

  it("cleanContent strips suggestion JSON from assistant messages", async () => {
    const { cleanContent } = await import("../jsonl-parser.js");
    const assistantMsg = `I fixed the bug by updating the handler.\n\n---SUGGESTIONS---\n["Suggestion 1","Suggestion 2"]`;
    const cleaned = cleanContent(assistantMsg, "assistant");
    expect(cleaned).toBe("I fixed the bug by updating the handler.");
  });

  it("cleanContent leaves normal content unchanged", async () => {
    const { cleanContent } = await import("../jsonl-parser.js");
    expect(cleanContent("Hello world", "user")).toBe("Hello world");
    expect(cleanContent("Some response", "assistant")).toBe("Some response");
  });

  it("summarize truncates long text", async () => {
    const { summarize } = await import("../jsonl-parser.js");
    const longText = "A".repeat(200);
    const result = summarize(longText, 120);
    expect(result.length).toBeLessThanOrEqual(123);
    expect(result).toContain("...");
  });

  it("summarize returns short text unchanged", async () => {
    const { summarize } = await import("../jsonl-parser.js");
    expect(summarize("Hello")).toBe("Hello");
  });

  it("extractTextContent handles string input", async () => {
    const { extractTextContent } = await import("../jsonl-parser.js");
    expect(extractTextContent("hello")).toBe("hello");
  });

  it("extractTextContent handles array with text blocks", async () => {
    const { extractTextContent } = await import("../jsonl-parser.js");
    const content = [{ type: "text", text: "Hello" }, { type: "text", text: "World" }];
    expect(extractTextContent(content)).toBe("Hello\nWorld");
  });

  it("extractTextContent handles array with mixed blocks", async () => {
    const { extractTextContent } = await import("../jsonl-parser.js");
    const content = [
      { type: "text", text: "Hello" },
      { type: "thinking", thinking: "I need to think..." },
      { type: "tool_use", name: "Read", input: { file_path: "/tmp/x" } },
    ];
    const result = extractTextContent(content);
    expect(result).toContain("Hello");
    expect(result).toContain("[Thinking]");
    expect(result).toContain("[Tool: Read]");
  });
});

// ─── naiveDecodePath logic (re-implemented locally) ──────────

describe("naiveDecodePath logic", () => {
  // Re-implement the private naiveDecodePath function from db.ts for isolated testing
  function naiveDecodePath(projectId: string, sep: string): string {
    // Detect Windows drive-letter pattern: single letter followed by "--"
    const winMatch = projectId.match(/^([A-Za-z])--(.*)/);
    if (winMatch) {
      const drive = winMatch[1].toUpperCase();
      const rest = winMatch[2].replace(/-/g, sep);
      return `${drive}:${sep}${rest}`;
    }
    return projectId.replace(/-/g, "/");
  }

  describe("Windows (sep = \\)", () => {
    const sep = "\\";

    it("decodes drive-letter pattern Q--src-ClawUI", () => {
      expect(naiveDecodePath("Q--src-ClawUI", sep)).toBe("Q:\\src\\ClawUI");
    });

    it("decodes C--Users-user-project", () => {
      expect(naiveDecodePath("C--Users-user-project", sep)).toBe("C:\\Users\\user\\project");
    });

    it("uppercases lowercase drive letters", () => {
      expect(naiveDecodePath("c--Users-test", sep)).toBe("C:\\Users\\test");
    });

    it("handles drive root with no path segments", () => {
      expect(naiveDecodePath("D--", sep)).toBe("D:\\");
    });
  });

  describe("Unix (sep = /)", () => {
    const sep = "/";

    it("decodes standard Unix path -home-user-project", () => {
      expect(naiveDecodePath("-home-user-project", sep)).toBe("/home/user/project");
    });

    it("decodes root path -", () => {
      expect(naiveDecodePath("-", sep)).toBe("/");
    });

    it("decodes path without leading dash", () => {
      expect(naiveDecodePath("home-user", sep)).toBe("home/user");
    });
  });

  describe("Edge cases", () => {
    it("single letter without -- is not treated as drive letter", () => {
      // "A-foo-bar" has just a single dash after 'A', not '--'
      // So the regex ^([A-Za-z])--(.*)$ should NOT match
      const result = naiveDecodePath("A-foo-bar", "/");
      expect(result).toBe("A/foo/bar"); // falls through to Unix-style decode
    });

    it("multi-letter prefix is not treated as drive letter", () => {
      const result = naiveDecodePath("AB--stuff", "/");
      expect(result).toBe("AB//stuff");
    });

    it("no dashes returns string unchanged", () => {
      expect(naiveDecodePath("projectname", "/")).toBe("projectname");
    });
  });
});

describe("Transaction behavior (sync write)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    db.prepare("INSERT INTO projects (id, name, decoded_path, session_count, updated_at) VALUES (?, ?, ?, ?, ?)").run("proj-1", "P", "/p", 1, "2024-01-01T00:00:00Z");
  });
  afterEach(() => { db.close(); });

  it("writes session and nodes atomically", () => {
    const writeSession = db.transaction(() => {
      db.prepare("DELETE FROM timeline_nodes WHERE session_id = ?").run("s1");
      db.prepare(`
        INSERT INTO sessions (id, project_id, slug, created_at, updated_at, node_count, file_size, file_mtime) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET node_count = excluded.node_count
      `).run("s1", "proj-1", "test", "2024-01-01T00:00:00Z", "2024-01-01T00:00:00Z", 2, 500, "2024-01-01T00:00:00Z");

      const insertNode = db.prepare("INSERT INTO timeline_nodes (id, session_id, seq, type, timestamp, title, content, tool_name, tool_input, tool_result, tool_use_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      insertNode.run("n1", "s1", 0, "user", "2024-01-01T00:00:00Z", "Hi", "Hi", null, null, null, null);
      insertNode.run("n2", "s1", 1, "assistant", "2024-01-01T00:00:01Z", "Hello", "Hello", null, null, null, null);
    });

    writeSession();

    const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get("s1") as { node_count: number };
    expect(session.node_count).toBe(2);
    const nodes = db.prepare("SELECT * FROM timeline_nodes WHERE session_id = ? ORDER BY seq").all("s1");
    expect(nodes).toHaveLength(2);
  });

  it("re-syncing session replaces old nodes", () => {
    db.prepare("INSERT INTO sessions (id, project_id, slug, created_at, updated_at, node_count, file_size, file_mtime) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("s1", "proj-1", "test", "2024-01-01T00:00:00Z", "2024-01-01T00:00:00Z", 1, 500, "2024-01-01T00:00:00Z");
    db.prepare("INSERT INTO timeline_nodes (id, session_id, seq, type, timestamp, title, content, tool_name, tool_input, tool_result, tool_use_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("n-old", "s1", 0, "user", "2024-01-01T00:00:00Z", "Old", "Old", null, null, null, null);

    const resync = db.transaction(() => {
      db.prepare("DELETE FROM timeline_nodes WHERE session_id = ?").run("s1");
      db.prepare(`
        INSERT INTO sessions (id, project_id, slug, created_at, updated_at, node_count, file_size, file_mtime) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET node_count = excluded.node_count, file_size = excluded.file_size, file_mtime = excluded.file_mtime
      `).run("s1", "proj-1", "test", "2024-01-01T00:00:00Z", "2024-01-02T00:00:00Z", 2, 1024, "2024-01-02T00:00:00Z");

      const ins = db.prepare("INSERT INTO timeline_nodes (id, session_id, seq, type, timestamp, title, content, tool_name, tool_input, tool_result, tool_use_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      ins.run("n-new-1", "s1", 0, "user", "2024-01-01T00:00:00Z", "New1", "New1", null, null, null, null);
      ins.run("n-new-2", "s1", 1, "assistant", "2024-01-01T00:00:01Z", "New2", "New2", null, null, null, null);
    });
    resync();

    const nodes = db.prepare("SELECT id FROM timeline_nodes WHERE session_id = ? ORDER BY seq").all("s1") as Array<{ id: string }>;
    expect(nodes).toHaveLength(2);
    expect(nodes[0].id).toBe("n-new-1");
    const oldNode = db.prepare("SELECT * FROM timeline_nodes WHERE id = ?").get("n-old");
    expect(oldNode).toBeUndefined();
  });
});
