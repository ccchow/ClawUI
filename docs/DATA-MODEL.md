# ClawUI Four-Layer Data Model

## Overview

```
Layer 4 — App State        .clawui/app-state.json        UI preferences, current view state
Layer 3 — Enrichment       .clawui/enrichments.json      User annotations, tags, bookmarks, notes
Layer 2 — Index/Cache      .clawui/index.db (SQLite)     Parsed structured index + cache
Layer 1 — Raw Source       ~/.claude/projects/**/*.jsonl  Claude Code raw data (read-only)
```

### Storage Location

All persistent data lives in the `.clawui/` hidden directory at the project root:
- Can be tracked by git (or added to `.gitignore`)
- Local single-machine state, no remote sync involved
- Delete `.clawui/` to fully reset — Layer 1 raw data is unaffected

---

## Layer 1 — Raw Source (Read-Only)

**Source**: `~/.claude/projects/<project-hash>/<session-uuid>.jsonl`

**Current behavior**: `jsonl-parser.ts` reads and parses JSONL files from scratch on each request.

**Invariant**: This layer is always read-only. It is the source of truth for all data.

**JSONL line types**:
- `user` / `assistant` — Conversation messages
- `tool_use` / `tool_result` — Tool calls (nested in assistant content)
- `file-history-snapshot` / `progress` / `queue-operation` — Metadata (skipped)

---

## Layer 2 — Index / Cache (SQLite)

**File**: `.clawui/index.db`

**Purpose**: Avoid re-parsing entire JSONL files on every request. Provides fast query, search, and sort.

**Schema**:

```sql
-- Project index
CREATE TABLE projects (
  id           TEXT PRIMARY KEY,   -- Directory name (e.g., "-Users-user-Git-ClawUI")
  name         TEXT,               -- Decoded friendly name (e.g., "Git/ClawUI")
  decoded_path TEXT,               -- Full path
  session_count INTEGER DEFAULT 0,
  updated_at   TEXT                -- Last scan time
);

-- Session index
CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,   -- Session UUID
  project_id   TEXT REFERENCES projects(id),
  slug         TEXT,               -- Claude Code slug
  cwd          TEXT,               -- Working directory
  created_at   TEXT,               -- First message timestamp
  updated_at   TEXT,               -- Last message timestamp
  node_count   INTEGER DEFAULT 0,  -- user+assistant message count
  file_size    INTEGER,            -- JSONL file bytes (for incremental detection)
  file_mtime   TEXT                -- JSONL file mtime (for incremental detection)
);

-- Timeline node cache
CREATE TABLE timeline_nodes (
  id           TEXT PRIMARY KEY,   -- Node UUID
  session_id   TEXT REFERENCES sessions(id),
  seq          INTEGER,            -- Node order
  type         TEXT,               -- user/assistant/tool_use/tool_result/error/system
  timestamp    TEXT,
  title        TEXT,               -- Summary (first 120 chars)
  content      TEXT,               -- Full content
  tool_name    TEXT,
  tool_input   TEXT,
  tool_result  TEXT,
  tool_use_id  TEXT
);

CREATE INDEX idx_nodes_session ON timeline_nodes(session_id, seq);
```

**Incremental update strategy**:
1. Scan the `~/.claude/projects/` directory
2. Compare `file_size` + `file_mtime` — only re-parse changed files
3. For changed files: clear their `timeline_nodes` → re-parse and write
4. Background periodic scan (on startup + every 30s) or triggered by API request for lazy refresh

**Why SQLite**:
- Single file, zero configuration
- Supports full-text search (FTS5) for future use
- Node.js uses `better-sqlite3` (synchronous API, simple and efficient)
- Much faster than JSON files (especially as session count grows)

---

## Layer 3 — Enrichment (JSON)

**File**: `.clawui/enrichments.json`

**Purpose**: User-attached metadata, independent of Claude Code raw data.

**Structure**:

```json
{
  "version": 1,
  "sessions": {
    "<session-uuid>": {
      "starred": true,
      "tags": ["bugfix", "ClawUI"],
      "notes": "This session resolved the TTY issue",
      "alias": "TTY Fix Session",
      "archived": false
    }
  },
  "nodes": {
    "<node-id>": {
      "bookmarked": true,
      "annotation": "Key breakthrough point"
    }
  },
  "tags": ["bugfix", "feature", "experiment", "ClawUI"]
}
```

**Why JSON instead of SQLite**:
- Small data volume (a few hundred annotations at most)
- Good readability, easy to manually edit
- Can be git-tracked as project knowledge
- No query optimization needed

---

## Layer 4 — App State (JSON)

**File**: `.clawui/app-state.json`

**Purpose**: UI runtime state, persists across restarts.

**Structure**:

```json
{
  "version": 1,
  "ui": {
    "theme": "dark",
    "sidebarWidth": 300,
    "timelineExpandAll": false,
    "lastViewedSession": "e9b4b7f9-c4f0-4456-9975-5bed7e7a7678",
    "lastViewedProject": "-Users-user-Git-ClawUI"
  },
  "recentSessions": [
    { "id": "e9b4b7f9-...", "viewedAt": "2026-02-21T18:00:00Z" }
  ],
  "filters": {
    "hideArchivedSessions": true,
    "defaultSort": "updated_at"
  }
}
```

**Should be `.gitignore`d**: This is personal preference data, not worth version controlling.

---

## Migration Path: From Initial State to Four-Layer Model

### Initial State

```
Request → jsonl-parser.ts reads file on every request → Response
           (no persistence, no cache)
```

### Phase 1 — Add Layer 2 Index (Highest Priority)

**Changes**:
1. New `backend/src/db.ts` — SQLite initialization + incremental sync logic
2. Modify `jsonl-parser.ts` → Split `parseTimeline()` into:
   - `syncSession(sessionId)` — Detect changes → parse → write to SQLite
   - `getTimeline(sessionId)` — Read from SQLite
3. Modify `routes.ts` → Trigger full scan on startup, API reads from SQLite
4. New `.clawui/` directory + `index.db`
5. `.gitignore` add `.clawui/index.db`

**Compatibility**: API interface unchanged, zero frontend changes. Pure backend optimization.

**Benefits**:
- Session list drops from O(n * file_size) to O(1) query
- Timeline cached after first load, incremental updates only
- Foundation for search features

### Phase 2 — Add Layers 3 + 4

**Changes**:
1. New `backend/src/enrichment.ts` — Read/write `enrichments.json`
2. New APIs:
   - `PATCH /api/sessions/:id/meta` — Update star/tags/notes
   - `PATCH /api/nodes/:id/meta` — Update bookmark/annotation
   - `GET /api/tags` — List all tags
3. New `backend/src/app-state.ts` — Read/write `app-state.json`
4. Frontend additions: starring, tag filtering, node bookmarks, etc.

### Phase 3 — Search & Advanced Features

- SQLite FTS5 full-text search
- Cross-session search
- Time range filtering
- Token/cost statistics (extract usage fields from JSONL)

---

## Directory Structure

```
~/Git/ClawUI/
├── .clawui/                    # Persistent data directory
│   ├── index.db                # Layer 2 (gitignored)
│   ├── enrichments.json        # Layer 3 (git tracked)
│   └── app-state.json          # Layer 4 (gitignored)
├── .gitignore                  # Includes .clawui/index.db, .clawui/app-state.json
├── backend/
│   └── src/
│       ├── db.ts               # SQLite management
│       ├── enrichment.ts       # Layer 3 read/write
│       ├── app-state.ts        # Layer 4 read/write
│       ├── jsonl-parser.ts     # Parsing logic, writes to SQLite
│       ├── cli-runner.ts       # Unchanged
│       ├── routes.ts           # New API endpoints
│       └── index.ts            # DB initialization on startup
└── frontend/                   # No changes in Phase 1
```

---

## Design Principles

1. **Layer 1 is read-only** — Never write to Claude Code's JSONL files
2. **Upper layers are disposable** — Delete `.clawui/` and everything rebuilds (Layer 2 re-parses, Layer 3/4 are lost but non-critical)
3. **Incremental first** — Use mtime+size to detect changes, avoid redundant parsing
4. **JSON for small data, SQLite for large data** — Annotations use JSON, index uses SQLite
5. **Stable API interface** — Phase 1 does not change the existing API contract, zero frontend changes
