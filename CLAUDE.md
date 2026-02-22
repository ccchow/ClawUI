# CLAUDE.md

## Project Overview

ClawUI reads Claude Code session JSONL files from `~/.claude/projects/`, visualizes them as vertical timelines, and provides interactive continuation via `claude --resume -p`. Uses a four-layer data model (see `docs/DATA-MODEL.md`).

## Commands

```bash
npm run dev              # Start backend + frontend together
npm run dev:backend      # Express on port 3001 (tsx watch)
npm run dev:frontend     # Next.js on port 3000
npm run build            # Build all
npm run build:backend    # TypeScript → dist/
npm run build:frontend   # Next.js production build
npm run lint             # ESLint (backend only)
```

No test framework yet. Verify with `cd backend && npx tsc --noEmit` and `cd frontend && npx tsc --noEmit`.

## Architecture

**Monorepo**: `backend/` (Express) + `frontend/` (Next.js). Legacy `packages/` directory exists but is unused.

### Four-Layer Data Model

```
Layer 1 — Raw:        ~/.claude/projects/**/*.jsonl (read-only source of truth)
Layer 2 — Index:      .clawui/index.db (SQLite, incremental sync by mtime+size)
Layer 3 — Enrichment: .clawui/enrichments.json (stars, tags, notes, bookmarks)
Layer 4 — App State:  .clawui/app-state.json (UI preferences, recent sessions)
```

### Backend (`backend/`)

Express server on port 3001. ESM (`"type": "module"`), uses `tsx watch` for dev.

- **db.ts** — SQLite initialization (better-sqlite3), tables: `projects`, `sessions`, `timeline_nodes`. `initDb()`, `syncAll()`, `syncSession()`, `getProjects()`, `getSessions()`, `getTimeline()`.
- **jsonl-parser.ts** — Parses JSONL into `TimelineNode[]`. Types: user, assistant, tool_use, tool_result. Exports `parseTimeline()`, `parseTimelineRaw()`, `listProjects()`, `listSessions()`, and helpers (`cleanContent`, `summarize`, `extractTextContent`).
- **cli-runner.ts** — Wraps `claude --dangerously-skip-permissions --resume <id> -p "prompt"` via `/usr/bin/expect` (TTY required). Appends `---SUGGESTIONS---` suffix for inline suggestions.
- **enrichment.ts** — Reads/writes `.clawui/enrichments.json`. `updateSessionMeta()`, `updateNodeMeta()`, `getAllTags()`.
- **app-state.ts** — Reads/writes `.clawui/app-state.json`. `getAppState()`, `updateAppState()`, `trackSessionView()`.
- **routes.ts** — 12 REST endpoints (see README).
- **index.ts** — Server entry. Calls `initDb()` + `syncAll()` on startup, 30s background sync interval.

### Frontend (`frontend/`)

Next.js 14, React 18, Tailwind CSS 3, dark theme.

- **Pages**: Session list (`/`) with project selector + filters; Session detail (`/session/[id]`) with timeline, notes, tag editor.
- **Components**: `SessionList` (star toggle, tag chips, filter bar), `Timeline`, `TimelineNode` (bookmark, annotation), `ToolPairNode`, `SuggestionButtons`, `PromptInput`, `MarkdownContent`.
- **API Client**: `lib/api.ts` — direct fetch to `http://localhost:3001` (bypasses Next.js proxy to avoid timeout issues).

## Conventions

- Backend imports use `.js` extensions: `import { foo } from "./bar.js"`
- Frontend uses `@/*` path alias → `./src/*`
- All frontend components are `"use client"`
- Dark theme with custom Tailwind tokens: `bg-primary`, `accent-blue`, `accent-purple`, etc. (defined in `tailwind.config.ts`)
- Optimistic UI updates for all mutations (star, bookmark, tag, notes)
- `next.config.mjs` (not `.ts`) for Next.js 14 compatibility
- ESLint scoped to `backend/src/**/*.ts` only

## Key Design Decisions

- **expect for TTY**: Claude Code requires a TTY — `node-pty` fails on Node 25, so we use `/usr/bin/expect` with `set stty_init "columns 2000"`
- **Inline suggestions**: One API call per prompt — suffix asks Claude to append `---SUGGESTIONS---` + JSON
- **SQLite for index**: `better-sqlite3` sync API, incremental updates via file mtime+size comparison
- **JSON for small data**: Enrichments and app state are JSON files (small, readable, diffable)
- **Layer 1 read-only**: Never write to Claude Code's JSONL files
