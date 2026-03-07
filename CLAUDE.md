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
- **SQLite variable limit**: SQLite allows max 999 variables per query. All `IN (...)` clauses with dynamic parameter lists must use `queryInChunks()` helper in `plan-db.ts` (chunks at 500). Never build raw `IN (${placeholders})` without chunking.
- **Autopilot runs inside workspace queue**: `runAutopilotLoop` is wrapped in `enqueueBlueprintTask` at call sites. Inside the loop, use `executeNodeDirect` (not `executeNode`) to avoid nested enqueue deadlock. `resumeNodeSession()` requires an `executionId` — look up latest execution with a session via `getExecutionsForNode()`.
- **BlueprintStatus vs MacroNodeStatus naming**: `BlueprintStatus` uses `"draft"/"approved"`, `MacroNodeStatus` uses `"pending"/"queued"/"running"/"done"/"failed"/"blocked"/"skipped"` (notably `"running"` not `"in_progress"`).
- **ExecutionMode values**: `"manual" | "autopilot" | "fsd"`. The `isAutopilotMode()` helper in `plan-routes.ts` groups `"autopilot"` and `"fsd"` together — switching between them does NOT trigger `switchingToAutopilot` (no re-enqueue). FSD skips all safeguard checks in the autopilot loop (`skipSafeguards = isFsd`) and defaults to `Infinity` iterations (no hard stop). Autopilot defaults to 50 iterations. Users can override via `blueprint.maxIterations`.
- **No auto-completion of blueprints**: Blueprints do NOT auto-transition to `"done"` when all nodes finish. The LLM must explicitly call `complete()` (or the user must take action). This applies everywhere: `runAutopilotLoop`, `maybeFinalizeBlueprint`, and `executeNextNode`. The `maybeFinalizeBlueprint` helper only resets stuck "running" blueprints back to "approved" — it never sets "done". The `complete` action in `executeDecision` has a structural guard: it rejects with `"active_nodes"` error if any nodes are still `"running"` or `"queued"`, and logs a warning if unacknowledged messages exist.
- **Autopilot test mock ordering with reflections**: `mockRunSession` is shared between decision calls and reflection calls (`reflectAndUpdateMemory`). Reflections happen every `REFLECT_EVERY_N` (5) iterations, on pause, and on error. Tests with 5+ loop iterations must insert reflection response mocks at the right positions. For persistent `mockImplementation`, filter on prompt content: reflections contain `"reflecting"`, global memory contains `"global autopilot"` or `"global strategy"`.
- **AI operations in plan-operations.ts**: `enrichNodeInternal`, `reevaluateNodeInternal`, `splitNodeInternal`, `smartDepsInternal`, `reevaluateAllInternal` are extracted from route handlers. Called by `plan-routes.ts` in manual mode only. In autopilot/FSD mode, these endpoints create a user message via `createAutopilotMessage` and call `triggerAutopilotIfNeeded` instead — the autopilot loop handles the request via its tool palette. `runWithRelatedSessionDetection` helper also lives here.
- **Autopilot tool palette**: `autopilot.ts` uses read tools (`get_node_titles`, `get_node_details`, `get_node_handoff`), message tools (`read_user_messages`, `acknowledge_message`, `send_message`), and `run_direct(prompt)` for simple tasks. Two execution paths: **run_direct** for simple/transactional tasks (git commit, Q&A, quick checks — runs an agent session directly, output sent as assistant message) vs **create_node + run_node** for complex engineering tasks (full node lifecycle). `AutopilotNodeState` is lightweight (no `description` or `suggestions` — fetched on-demand). Unacknowledged user messages are injected directly into the prompt at each iteration (via `buildAutopilotPrompt`'s `userMessages` param) so the LLM sees them even without calling `read_user_messages`. The prompt instructs the LLM to act first (run_direct or create_node), then `acknowledge_message` last — the unacknowledged message naturally prevents auto-exit (`pendingMessages.length > 0`) and keeps context in the prompt until the LLM has acted.
- **triggerAutopilotIfNeeded helper**: `plan-routes.ts` has a `triggerAutopilotIfNeeded(blueprintId)` helper that checks if blueprint is in autopilot/FSD mode and no loop is running, then enqueues `runAutopilotLoop`. Used by message endpoint and AI operation endpoints to wake the autopilot when needed.
- **Autopilot pause/resume flow**: When resuming from a safeguard pause, the resume handler must clear `pauseReason` and set `status: "running"` (both via API and optimistically in local state). `runAutopilotLoop` also clears `pauseReason` on start. The PUT endpoint's `switchingToAutopilot` only fires when `executionMode` changes FROM non-autopilot, so re-entering autopilot from a paused-autopilot state uses `runAllNodes` instead. The pause/resume UI is now inside `BlueprintChat` (not standalone `PauseBanner`).
- **BlueprintChat replaces generator section**: The blueprint detail page uses `BlueprintChat` component instead of the old generator textarea + action buttons. It also subsumes `PauseBanner` (inline pause messages with Resume button) and `AutopilotLog` (interleaved log entries). The standalone `PauseBanner` and `AutopilotLog` components still exist for potential reuse but are no longer rendered on the blueprint detail page.
- **IntersectionObserver in tests**: Components using `new IntersectionObserver()` must guard with `typeof IntersectionObserver === "undefined"` — jsdom doesn't define it. Without the guard, any test rendering the component (even via a parent) will throw `ReferenceError`. Mocking in individual test files only helps that specific test.
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
