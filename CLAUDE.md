# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository. It's also a useful reference for contributors — see [CONTRIBUTING.md](CONTRIBUTING.md) for the full contributor guide.

## Project Overview

ClawUI reads Claude Code session JSONL files from `~/.claude/projects/`, visualizes them as vertical timelines, and provides interactive continuation via `claude --resume -p`. Uses a four-layer data model (see `docs/DATA-MODEL.md`). Also includes a Plan/Blueprint system for structured task decomposition and execution (see `docs/PLAN-SYSTEM.md`).

## Commands

```bash
npm run dev              # Start backend + frontend together (concurrently)
npm run dev:backend      # Express on port 3001 (tsx watch)
npm run dev:frontend     # Next.js on port 3000 (binds 127.0.0.1)
npm run build            # Build all
npm run build:backend    # TypeScript → dist/
npm run build:frontend   # Next.js production build
npm run start:backend    # Run compiled backend (node dist/index.js)
npm run lint             # ESLint (backend only)
```

Tests use Vitest in both backend and frontend:
```bash
cd backend && npx vitest run     # Backend tests
cd frontend && npx vitest run    # Frontend tests
cd backend && npx tsc --noEmit   # Type-check backend
cd frontend && npx tsc --noEmit  # Type-check frontend
```

## Architecture

**Monorepo** with npm workspaces: `backend/` (Express) + `frontend/` (Next.js).

### Four-Layer Data Model

```
Layer 1 — Raw:        ~/.claude/projects/**/*.jsonl (read-only source of truth)
Layer 2 — Index:      .clawui/index.db (SQLite, incremental sync by mtime+size)
                      + plans, plan_nodes tables (Plan system extension)
Layer 3 — Enrichment: .clawui/enrichments.json (stars, tags, notes, bookmarks)
Layer 4 — App State:  .clawui/app-state.json (UI preferences, recent sessions)
```

### Backend (`backend/`)

Express server on port 3001. ESM (`"type": "module"`), uses `tsx watch` for dev.

**Core:** config.ts (centralized config), logger.ts (structured logging via `createLogger()`), db.ts (SQLite via better-sqlite3), jsonl-parser.ts (JSONL→TimelineNode[]), cli-runner.ts (Claude CLI via `expect`), enrichment.ts (stars/tags/notes JSON), app-state.ts (UI prefs JSON), auth.ts (local token auth), routes.ts (session REST API), index.ts (server entry, binds `127.0.0.1`).

**Plan system:** plan-db.ts (SQLite CRUD), plan-routes.ts (REST API), plan-generator.ts (AI task decomposition), plan-executor.ts (node execution + artifacts + evaluation). See `docs/PLAN-EXECUTION.md` for internals.

### Frontend (`frontend/`)

Next.js 14, React 18, Tailwind CSS 3, dark/light theme via `next-themes`.

**Routes:** `/` → `/blueprints`, `/sessions`, `/session/[id]`, `/blueprints`, `/blueprints/new`, `/blueprints/[id]`, `/blueprints/[id]/nodes/[nodeId]`

**API client:** `lib/api.ts` — relative `/api/*` paths proxied via `next.config.mjs` → `http://localhost:3001/api/*`. Auth via `x-clawui-token` header from `localStorage`.

## Conventions

- Backend imports use `.js` extensions: `import { foo } from "./bar.js"`
- Frontend uses `@/*` path alias → `./src/*`; all components are `"use client"`
- Use semantic color tokens (`bg-bg-primary`, `text-accent-blue`), never hardcoded colors
- Never use `window.confirm()` — use inline confirmation pattern
- Inline SVGs over emoji for interactive icons
- Optimistic UI updates for all mutations (star, bookmark, tag, notes)
- `next.config.mjs` (not `.ts`) for Next.js 14 compatibility
- ESLint scoped to `backend/src/**/*.ts` only
- **CI**: `.github/workflows/ci.yml` — typecheck, lint, build, tests on push/PRs (Node 20+22)
- Node numbering: always `node.order + 1` for display, never array index
- Session ID validation: call `validateSessionId()` before passing to shell commands
- Error sanitization: never expose internal errors in API responses; use `safeError()` helper
- Dev-only endpoints must check `CLAWUI_DEV` config, return 403 in production
- Batch DB queries over N+1 loops (see `getNodesForBlueprint()`)
- Incremental DB migrations: new columns use `PRAGMA table_info()` + `ALTER TABLE ADD COLUMN`. Don't bump `CURRENT_SCHEMA_VERSION` for additive changes.
- Fire-and-forget button loading: use optimistic flag + pendingTasks polling, not promise `finally`

For detailed frontend patterns (CSS theming, mobile, accessibility, animations): see `docs/FRONTEND-PATTERNS.md`

## Key Design Decisions

- **expect for TTY**: Claude CLI requires TTY — uses `expect` (auto-detected via `EXPECT_PATH`) with `set stty_init "columns 2000"`
- **SQLite + JSON**: SQLite for index/plans (better-sqlite3), JSON files for enrichments/app-state
- **Layer 1 read-only**: Never write to Claude Code's JSONL files
- **Localhost-only**: Both frontend and backend bind to `127.0.0.1`, never `0.0.0.0`
- **Local auth token**: `crypto.randomBytes(16)` hex, rotates on restart, written to `.clawui/auth-token`
- **Fire-and-forget execution**: Blueprint tasks use serial queues per blueprint (`enqueueBlueprintTask`), endpoints return immediately, frontend polls
- **API callback pattern**: Executed nodes report status via curl callbacks — `report-status` is authoritative, legacy output parsing is fallback
- **MCP tool detection**: `mcp__serverName__toolName` naming convention (double underscores)
- **Plans are Layer 2 extensions**: Plan data lives in the same SQLite db, not a new layer
- **Artifacts for cross-node context**: Completed nodes generate handoff summaries passed to downstream dependents

For detailed plan execution internals: see `docs/PLAN-EXECUTION.md`

## Gotchas

- **CLI output echo**: Claude CLI echoes the full prompt. Use depth-counting brace extraction, not greedy regex
- **In-memory queue vs SQLite**: `blueprintQueues` are in-memory only; `requeueOrphanedNodes()` bridges on restart
- **execFile ENOENT**: Reports `ENOENT` when `cwd` doesn't exist, not just missing binary — validate `cwd` first
- **`CLAUDECODE` env stripping**: All CLI spawn functions use `cleanEnvForClaude()` to strip `CLAUDECODE` env var
- **New exports need mock updates**: All `vi.mock()` blocks must include new exports or Vitest throws
- **Backend `process.cwd()`**: cwd is `backend/` at runtime — use `join(process.cwd(), "..")` for project root
- **Blueprint `projectCwd` validation**: Tests with fake paths must mock `node:fs` to pass validation

For detailed gotchas: see `docs/CODING-GOTCHAS.md`

## Environment Variables

All config is centralized in `backend/src/config.ts`. See `.env.example` for defaults.

- `PORT` — Backend port (default: `3001`)
- `CLAWUI_DB_DIR` — Database directory name relative to project root (default: `.clawui`)
- `NEXT_PUBLIC_API_PORT` — Frontend API port (default: `3001`, must match backend PORT)
- `CLAUDE_PATH` — Path to Claude CLI binary (auto-detected: checks `~/.local/bin/claude`, `/usr/local/bin/claude`, then PATH)
- `EXPECT_PATH` — Path to `expect` binary (auto-detected: checks `/usr/bin/expect`, `/usr/local/bin/expect`, `/opt/local/bin/expect`, `/opt/homebrew/bin/expect`, then PATH)
- `LOG_LEVEL` — Log verbosity: `debug`, `info`, `warn`, `error` (default: `info`)
- `CLAWUI_DEV` — Set to `1` to reuse existing auth token across backend restarts and enable dev UI features (default: unset, token rotates every restart). Exposed to frontend via `GET /api/dev/status`.

## Development Environments

This project supports separate dev and stable environments to prevent development from disrupting daily use. See [CONTRIBUTING.md](CONTRIBUTING.md#dev-vs-stable-environments) for details and helper scripts.

- **Stable**: ports 3000 (frontend) / 3001 (backend), DB in `.clawui/`, scripts: `scripts/deploy-stable.sh`, `scripts/start-stable.sh`
- **Dev**: ports 3100 (frontend) / 3101 (backend), DB in `.clawui-dev/`, script: `scripts/start-dev.sh`
- **Frontend dev-mode detection**: Dev UI (e.g. redeploy button) shows when either `window.location.port !== "3000"` (dev port) OR backend reports `CLAWUI_DEV=1` via `GET /api/dev/status`
- **Dev redeploy endpoint**: `POST /api/dev/redeploy` (routes.ts) — runs deploy-stable.sh then start-stable.sh via nohup. Gated behind `CLAWUI_DEV` check (returns 403 in production).
