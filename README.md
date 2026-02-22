# ClawUI — Claude Code Session Viewer

Visualize Claude Code session history as interactive timelines, with continuation via suggestion buttons.

## Architecture

```
~/.claude/projects/**/*.jsonl     ← Layer 1: Raw Source (read-only)
        ↓
.clawui/index.db (SQLite)        ← Layer 2: Index/Cache (incremental sync)
.clawui/enrichments.json          ← Layer 3: Stars, tags, bookmarks, notes
.clawui/app-state.json            ← Layer 4: UI preferences
        ↓
Backend (Express :3001)           → REST API (12 endpoints)
        ↓
Frontend (Next.js :3000)          → Timeline UI + Interactive Controls
```

### Four-Layer Data Model

| Layer | Storage | Purpose |
|-------|---------|---------|
| 1 — Raw | `~/.claude/projects/*.jsonl` | Claude Code's native data (read-only) |
| 2 — Index | `.clawui/index.db` | SQLite cache with incremental mtime+size sync |
| 3 — Enrichment | `.clawui/enrichments.json` | User annotations: stars, tags, notes, bookmarks |
| 4 — App State | `.clawui/app-state.json` | UI preferences, recent sessions |

Delete `.clawui/` to reset — Layer 2 rebuilds from JSONL, Layer 3/4 are non-critical.

See [docs/DATA-MODEL.md](docs/DATA-MODEL.md) for full design.

## Features

- **Session List** — Browse all Claude Code projects and sessions
  - ⭐ Star sessions, 🏷️ tag & filter, 📦 archive
  - Search by slug, ID, or path
- **Timeline View** — Vertical timeline of every interaction
  - 👤 User messages, 🤖 Assistant responses, 🔧 Tool calls with collapsible I/O
  - 🔖 Bookmark nodes, add annotations
  - 📝 Session notes and inline tag editor
- **Interactive Continuation** — Send prompts via `claude --resume`
  - 3 AI-generated continuation suggestions per response
  - Free-form prompt input
- **Incremental Sync** — Background 30s polling, only re-parses changed files

## Quick Start

```bash
# Install dependencies
npm install
cd backend && npm install && cd ..
cd frontend && npm install && cd ..

# Start both (backend :3001 + frontend :3000)
npm run dev

# Or separately
npm run dev:backend    # Express on port 3001
npm run dev:frontend   # Next.js on port 3000
```

Open http://localhost:3000

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/projects` | List all Claude Code projects |
| GET | `/api/projects/:id/sessions` | List sessions (supports `?starred=true&tag=x&archived=true`) |
| GET | `/api/sessions/:id/timeline` | Parse session into timeline nodes |
| POST | `/api/sessions/:id/run` | Execute prompt, returns `{ output, suggestions }` |
| PATCH | `/api/sessions/:id/meta` | Update star/tags/notes/alias/archived |
| PATCH | `/api/nodes/:id/meta` | Update bookmark/annotation |
| GET | `/api/tags` | List all tags |
| GET | `/api/state` | Get app state |
| PUT | `/api/state` | Update app state |
| GET | `/api/sync` | Trigger manual re-sync |

## Tech Stack

- **Backend**: Node.js, TypeScript, Express, better-sqlite3, `expect` (for Claude CLI TTY)
- **Frontend**: Next.js 14, React 18, Tailwind CSS, shadcn/ui
- **Data**: SQLite (index), JSON (enrichment + state), JSONL (source)

## Project Structure

```
ClawUI/
├── .clawui/                 # Persistent data (auto-created)
│   ├── index.db             # SQLite index cache (gitignored)
│   ├── enrichments.json     # User annotations (git tracked)
│   └── app-state.json       # UI preferences (gitignored)
├── backend/src/
│   ├── index.ts             # Express server entry
│   ├── routes.ts            # REST API routes
│   ├── db.ts                # SQLite init + incremental sync
│   ├── jsonl-parser.ts      # JSONL parsing logic
│   ├── cli-runner.ts        # Claude CLI via expect
│   ├── enrichment.ts        # Layer 3 read/write
│   └── app-state.ts         # Layer 4 read/write
├── frontend/src/
│   ├── app/                 # Next.js pages
│   ├── components/          # React components
│   └── lib/api.ts           # API client
└── docs/
    ├── DATA-MODEL.md        # Four-layer architecture design
    └── PRD-v2.md            # Product requirements
```

## Status

✅ MVP Complete — Session viewing, enrichment, interactive continuation all working.
