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

**Core files:**
- **config.ts** — Centralized configuration: exports `CLAUDE_PATH` (auto-detected), `PORT`, `CLAWUI_DB_DIR`, `NEXT_PUBLIC_API_PORT`, `LOG_LEVEL`. All other modules import from here.
- **logger.ts** — Structured logging: `createLogger('module')` returns `{debug, info, warn, error}`. Format: `[ISO timestamp] [LEVEL] [module] msg`. Controlled by `LOG_LEVEL` env var.
- **db.ts** — SQLite initialization (better-sqlite3), tables: `projects`, `sessions`, `timeline_nodes`. `initDb()`, `syncAll()`, `syncSession()`, `getProjects()`, `getSessions()`, `getTimeline()`.
- **jsonl-parser.ts** — Parses JSONL into `TimelineNode[]`. Types: user, assistant, tool_use, tool_result. Exports `parseTimeline()`, `parseTimelineRaw()`, `listProjects()`, `listSessions()`, and helpers (`cleanContent`, `summarize`, `extractTextContent`).
- **cli-runner.ts** — Wraps `claude --dangerously-skip-permissions --resume <id> -p "prompt"` via `/usr/bin/expect` (TTY required). Appends `---SUGGESTIONS---` suffix for inline suggestions.
- **enrichment.ts** — Reads/writes `.clawui/enrichments.json`. `updateSessionMeta()`, `updateNodeMeta()`, `getAllTags()`.
- **app-state.ts** — Reads/writes `.clawui/app-state.json`. `getAppState()`, `updateAppState()`, `trackSessionView()`.
- **auth.ts** — Local auth token generation (`crypto.randomBytes(16)`) and `requireLocalAuth` Express middleware. Writes token to `.clawui/auth-token` for frontend proxy. Uses timing-safe comparison.
- **routes.ts** — Session REST endpoints (12 endpoints).
- **index.ts** — Server entry. Binds to `127.0.0.1`. Calls `initDb()` + `syncAll()` on startup, 30s background sync interval. Prints auth URL on startup.

**Plan system files:**
- **plan-db.ts** — Plan/Blueprint SQLite tables (`plans`, `plan_nodes`) + CRUD operations.
- **plan-routes.ts** — Plan REST API endpoints.
- **plan-generator.ts** — AI-powered task decomposition: breaks a high-level task into ordered nodes with dependencies.
- **plan-executor.ts** — Node execution via Claude CLI + artifact generation for cross-node context passing.

### Frontend (`frontend/`)

Next.js 14, React 18, Tailwind CSS 3, dark theme.

**Routes:**
- `/` — Session list with project selector + filters
- `/session/[id]` — Session detail with timeline, notes, tag editor
- `/blueprints` — Plan/Blueprint list
- `/blueprints/new` — Create new plan
- `/blueprints/[id]` — Plan detail with node cards and dependency flow
- `/blueprints/[id]/nodes/[nodeId]` — Node detail with execution timeline

**Key components:** `SessionList`, `Timeline`, `TimelineNode`, `ToolPairNode`, `MacroNodeCard`, `StatusIndicator`, `SuggestionButtons`, `PromptInput`, `MarkdownContent`, `AISparkle`, `AuthProvider`.

**API client:** `lib/api.ts` — all requests use relative `/api/*` paths routed through the Next.js proxy. Auth token read from `localStorage` and attached via `x-clawui-token` header. `next.config.mjs` has rewrites proxying `/api/*` → `http://localhost:3001/api/*`.

## Conventions

- Backend imports use `.js` extensions: `import { foo } from "./bar.js"`
- Frontend uses `@/*` path alias → `./src/*`
- All frontend components are `"use client"`
- Dark theme with custom Tailwind tokens: `bg-primary`, `accent-blue`, `accent-purple`, etc. (defined in `tailwind.config.ts`)
- Optimistic UI updates for all mutations (star, bookmark, tag, notes)
- `next.config.mjs` (not `.ts`) for Next.js 14 compatibility
- ESLint scoped to `backend/src/**/*.ts` only (config + deps at root: `eslint.config.mjs`, root `package.json`)
- **CI**: `.github/workflows/ci.yml` — runs typecheck, lint, build on push to main and PRs (Node.js 20)
- **Flex truncation pattern**: For `truncate` to work in nested flex containers, every flex item in the chain needs `min-w-0`. Card containers wrapping truncated text also need `overflow-hidden`. Title links (`<a>`) need `block` display.
- **AI loading indicators**: AI-triggered buttons (Run, Reevaluate, Smart Enrich, Generate Nodes) use `<AISparkle>` component with `animate-ai-sparkle` (pulse+rotate). Non-AI loading states (page loads, data polling refresh) keep standard `animate-spin` spinners. Custom keyframes defined in `globals.css`.

## Key Design Decisions

- **expect for TTY**: Claude Code requires a TTY — `node-pty` fails on Node 25, so we use `/usr/bin/expect` with `set stty_init "columns 2000"`
- **Inline suggestions**: One API call per prompt — suffix asks Claude to append `---SUGGESTIONS---` + JSON
- **SQLite for index**: `better-sqlite3` sync API, incremental updates via file mtime+size comparison
- **JSON for small data**: Enrichments and app state are JSON files (small, readable, diffable)
- **Layer 1 read-only**: Never write to Claude Code's JSONL files
- **MCP tool detection**: MCP tools use naming convention `mcp__serverName__toolName` (double underscores). Frontend Timeline filters MCP tools separately from built-in tools using `toolName.startsWith("mcp__")`.
- **Plans are Layer 2 extensions**: Plan data lives in the same SQLite db, not a new layer. Plans are user-created source of truth (unlike sessions which are derived from JSONL).
- **Artifacts for cross-node context**: When a plan node completes, an artifact (summary) is generated and passed as context to downstream dependent nodes. Artifact prompt requires `**What was done:**` marker; post-processing strips preamble before this marker to keep only completed-work content.
- **Task completion markers for artifact isolation**: `buildNodePrompt()` instructs Claude to output `===TASK_COMPLETE===`/`===END_TASK===` markers as the absolute last output, after all other steps including CLAUDE.md revision. `extractTaskCompleteSummary()` is used in both `generateArtifact()` (handoff summary) and `executeNodeInternal()` (outputSummary capture) to prefer marker content over raw tail. Falls back to tail-based approach if markers absent.
- **Fire-and-forget execution**: Node run/reevaluate use serial queues per blueprint (`enqueueBlueprintTask`). Endpoints return `{status:"queued"}` immediately; frontend polls.
- **Background session detection**: `executeNodeInternal()` starts a 3s polling interval that calls `detectNewSession()` while `runClaude()` blocks. Updates the execution record with `sessionId` immediately when found, so the frontend can show the session link during execution (not just after completion).
- **Batch reevaluate**: `reevaluate-all` runs Claude Code in interactive mode (`runClaudeInteractive` — no `--output-format text`). Claude reads actual source code, then updates all nodes via a single `PUT /api/blueprints/:id/nodes/batch` call. No output parsing needed — Claude directly mutates the DB via API.
- **Blueprint node grouping**: Collapsible "older nodes" in `blueprints/[id]/page.tsx` only collapses `done`/`skipped` nodes — active states (pending, running, failed, blocked, queued) are never hidden. When expanded, renders all `displayNodes` in original order (not split top+older) so `computeDepLayout` dependency lines stay correct.
- **Smart node sorting**: `blueprints/[id]/page.tsx` defaults to `smartSort=true` which groups nodes by status priority (running > queued > failed > blocked > pending > done > skipped), maintaining `order` within each group. Toggleable via UI button; when off, falls back to `reverseOrder` (newest/oldest first). Smart sort only applies when `statusFilter === "all"`.
- **RunAll pre-queuing**: `executeAllNodes()` pre-marks all eligible pending nodes as `queued` before the execution loop so the frontend shows the full plan. `executeNode()` skips re-queuing if the node is already `queued` to avoid duplicate pending tasks. On failure, remaining pre-queued nodes are reset to `pending`. `executeNextNode()` picks both `pending` and `queued` nodes.
- **Localhost-only binding**: Both frontend and backend bind to `127.0.0.1`. External access is via `tailscale serve` which proxies to localhost. Never bind to `0.0.0.0`.
- **Local Auth Token**: Backend generates `crypto.randomBytes(16)` hex token on startup, writes to `.clawui/auth-token`. All `/api/*` requests require `x-clawui-token` header or `?auth=` query param. Frontend reads token from `localStorage` (seeded via `?auth=` URL param on first visit). Token rotates on every backend restart.
- **Server restart recovery**: `smartRecoverStaleExecutions()` (plan-executor.ts) checks CLI process liveness (`cli_pid` + `process.kill(pid, 0)`) and session file mtime before marking executions as failed. Still-alive executions get a background monitor (10s interval, 45min timeout). `recoverStaleExecutions(skipIds)` only marks truly-dead executions as failed. Also checks recently-failed "server restart" executions (10min window) and reverts them if their session is still active. `requeueOrphanedNodes()` re-enqueues nodes left in "queued" status (in-memory queue lost on restart). `recover-session` endpoint finds orphaned JSONL files and links them back.

## Gotchas

- **CLI output echo**: Claude CLI echoes the full prompt before the AI response. Greedy regex `\{[\s\S]*\}` captures JSON templates from the echoed prompt, not the AI's response. Use depth-counting brace extraction, last-to-first (see `extractTitleDescJson` in `plan-routes.ts`).
- **Array extraction**: Same echo problem applies to `[...]` arrays. `extractReevaluateArray` in `plan-routes.ts` uses `[`/`]` depth counting with last-to-first fallback, then tries individual `{...}` objects as secondary fallback.
- **`syncSession()` re-indexes**: Calling `syncSession()` re-parses JSONL into SQLite, updating metadata timestamps — sessions appear "recently updated" in the UI. Avoid in recovery/background paths.
- **In-memory queue vs SQLite**: `blueprintQueues`/`blueprintPendingTasks` in `plan-executor.ts` are in-memory only. Node `status` in SQLite persists across restarts, but the queue doesn't. `requeueOrphanedNodes()` bridges this gap on startup. Frontend must fetch queue status (`getQueueStatus`) on initial page load, not just during polling.
- **`stripEchoedPrompt` markers must track prompt tail**: When adding/reordering instructions in `buildNodePrompt()`, update the `markers` array in `stripEchoedPrompt()` to include text from the last instruction line. Otherwise the echo won't be fully stripped and response extraction degrades.
- **`execFile` callback TDZ**: `const child = execFile(...)` — mock tests call the callback synchronously, before `child` is assigned (temporal dead zone). Never reference `child` inside the callback; use a separate `let` variable assigned after the call.
- **CLI runner error handling**: `runClaudeInteractive` and `runClaude` must reject on `execFile` errors (especially timeouts). Never silently resolve — callers depend on rejection to clean up pending tasks and stop frontend polling. `withTimeout()` in `plan-executor.ts` provides an additional safety net for wrapping long-running promises.
- **Auth token on restart**: Token rotates on every backend restart. Phone/tablet users must re-copy the secure URL from terminal output. The old `?auth=` bookmark will 403.
- **Pending task cleanup**: Fire-and-forget queue tasks (`enqueueBlueprintTask`) that add `pendingTasks` must use `finally` blocks to guarantee `removePendingTask()` runs on success, error, or timeout. If pending tasks leak, frontend polling runs indefinitely (capped at 35min safety limit).

## Environment Variables

All config is centralized in `backend/src/config.ts`. See `.env.example` for defaults.

- `PORT` — Backend port (default: `3001`)
- `CLAWUI_DB_DIR` — Database directory name relative to project root (default: `.clawui`)
- `NEXT_PUBLIC_API_PORT` — Frontend API port (default: `3001`, must match backend PORT)
- `CLAUDE_PATH` — Path to Claude CLI binary (auto-detected: checks `~/.local/bin/claude`, `/usr/local/bin/claude`, then PATH)
- `LOG_LEVEL` — Log verbosity: `debug`, `info`, `warn`, `error` (default: `info`)

## Development Environments

This project supports separate dev and stable environments to prevent development from disrupting daily use. See [CONTRIBUTING.md](CONTRIBUTING.md#dev-vs-stable-environments) for details and helper scripts.
