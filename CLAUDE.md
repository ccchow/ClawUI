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

Express server on port 3001. ESM (`"type": "module"`), uses `tsx watch` for dev. See [`docs/BACKEND-ARCHITECTURE.md`](docs/BACKEND-ARCHITECTURE.md) for detailed file descriptions and security patterns.

Adding a new role: create `roles/role-<id>.ts` — auto-discovered, no other file changes needed. See `docs/plans/2026-03-01-multi-role-mechanism-design.md`.

### Frontend (`frontend/`)

Next.js 14, React 18, Tailwind CSS 3, TanStack Query v5, dark/light theme via `next-themes`. See [`docs/FRONTEND-PATTERNS.md`](docs/FRONTEND-PATTERNS.md) for detailed UI conventions.

**Routes:** `/` → `/blueprints`, `/sessions`, `/session/[id]`, `/blueprints`, `/blueprints/new`, `/blueprints/[id]`, `/blueprints/[id]/nodes/[nodeId]`.

**API client:** `lib/api.ts` — relative `/api/*` paths proxied via `next.config.mjs` to backend. Auth via `x-clawui-token` header from `localStorage`.

## Conventions

- Backend imports use `.js` extensions: `import { foo } from "./bar.js"`
- Frontend uses `@/*` path alias → `./src/*`
- All frontend components are `"use client"`
- Optimistic UI updates for all mutations (star, bookmark, tag, notes)
- `next.config.mjs` (not `.ts`) for Next.js 14 compatibility
- ESLint scoped to `backend/src/**/*.ts` only (config + deps at root)
- **CI**: `.github/workflows/ci.yml` — typecheck, lint, build, tests on push to main and PRs (Node.js 20 + 22)
- **Semantic color tokens**: Use `accent-amber`, `accent-green`, `bg-bg-primary` etc. — never hardcoded colors. See [`docs/FRONTEND-PATTERNS.md`](docs/FRONTEND-PATTERNS.md).
- **Node numbering**: Always use `node.seq` for display numbers (monotonic, never reused). `node.order` is for positional sorting only.
- **Session ID validation**: All endpoints must call `validateSessionId()` before shell commands. See [`docs/BACKEND-ARCHITECTURE.md`](docs/BACKEND-ARCHITECTURE.md).
- **Error sanitization**: Never expose internal error messages in API responses — use `safeError()` helper.
- **Version sync**: Version numbers must match across `package.json` (root), `backend/package.json`, and `frontend/package.json`.
- **CHANGELOG.md**: Maintained at project root following [Keep a Changelog](https://keepachangelog.com/) format.

## Key Design Decisions

Core architectural patterns documented in [`docs/DESIGN-DECISIONS.md`](docs/DESIGN-DECISIONS.md). Key principles:

- Layer 1 read-only — never write to agent JSONL files
- Fire-and-forget execution with serial queues per workspace
- TanStack Query with dynamic polling intervals (see `lib/polling-utils.ts`)
- Localhost-only binding (`127.0.0.1`); external access via `tailscale serve`
- Plan execution uses API callbacks (`report-status`, `report-blocker`, `task-summary`)

## Gotchas

Full lists: [`docs/CODING-GOTCHAS.md`](docs/CODING-GOTCHAS.md), [`docs/TESTING-GOTCHAS.md`](docs/TESTING-GOTCHAS.md). Most critical:

- **Incremental DB migrations**: New columns use `PRAGMA table_info()` + `ALTER TABLE ADD COLUMN`. Bumping `CURRENT_SCHEMA_VERSION` triggers full recreation.
- **Plan system type sync**: Backend `plan-db.ts` types must stay in sync with `frontend/src/lib/api.ts` mirror types.
- **Side-effect imports**: Modules using `getActiveRuntime()`/`getRegisteredRuntimes()` must import all runtime modules. Modules using `getRole()`/`getAllRoles()` import `./roles/load-all-roles.js`.
- **New exports need mock updates**: All `vi.mock()` blocks must include new exports or Vitest throws.
- **ESLint `_` prefix doesn't suppress unused-vars**: Use `// eslint-disable-next-line` instead.
- **CLI output echo**: Claude CLI echoes the full prompt. Use depth-counting brace extraction.
- **In-memory queue vs SQLite**: `workspaceQueues`/`workspacePendingTasks` are in-memory only.
- **Autopilot runs inside workspace queue**: `runAutopilotLoop` is wrapped in `enqueueBlueprintTask` at call sites. Inside the loop, use `executeNodeDirect` (not `executeNode`) to avoid nested enqueue deadlock. `resumeNodeSession()` requires an `executionId` — look up latest execution with a session via `getExecutionsForNode()`.
- **BlueprintStatus vs MacroNodeStatus naming**: `BlueprintStatus` uses `"draft"/"approved"`, `MacroNodeStatus` uses `"pending"`.
- **Circular dependency: autopilot ↔ plan-executor**: `autopilot.ts` imports from `plan-executor.ts`. If `plan-executor.ts` needs to call autopilot (e.g. recovery), use dynamic `import("./autopilot.js")` to avoid circular import.

## Environment Variables

All config is centralized in `backend/src/config.ts`. See `.env.example` for defaults.

- `PORT` (3001), `NEXT_PUBLIC_API_PORT` (3001), `LOG_LEVEL` (info), `CLAWUI_DB_DIR` (.clawui)
- `CLAWUI_DEV` — Set to `1` for dev mode (reuses auth token, enables dev UI)
- `AGENT_TYPE` — `claude` (default), `openclaw`, `pi`, `codex`
- Binary paths (all auto-detected): `CLAUDE_PATH`, `EXPECT_PATH`, `OPENCLAW_PATH`, `PI_PATH`, `CODEX_PATH`
- `OPENCLAW_PROFILE` — Docker instance profile name

## Development Environments

This project supports separate dev and stable environments to prevent development from disrupting daily use. See [CONTRIBUTING.md](CONTRIBUTING.md#dev-vs-stable-environments) for details and helper scripts.

- **Stable**: ports 3000 (frontend) / 3001 (backend), DB in `.clawui/`, scripts: `scripts/deploy-stable.sh`, `scripts/start-stable.sh`
- **Dev**: ports 3100 (frontend) / 3101 (backend), DB in `.clawui-dev/`, script: `scripts/start-dev.sh`
- **Frontend dev-mode detection**: Dev UI (e.g. redeploy button) shows when either `window.location.port !== "3000"` (dev port) OR backend reports `CLAWUI_DEV=1` via `GET /api/dev/status`
- **Dev redeploy endpoint**: `POST /api/dev/redeploy` (routes.ts) — runs deploy-stable.sh then start-stable.sh via nohup. Gated behind `CLAWUI_DEV` check (returns 403 in production).
