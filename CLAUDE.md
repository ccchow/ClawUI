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

Express server on port 3001. ESM (`"type": "module"`), uses `tsx watch` for dev. For detailed file descriptions, see [`docs/BACKEND-ARCHITECTURE.md`](docs/BACKEND-ARCHITECTURE.md).

**Core files:** config.ts, logger.ts, db.ts (SQLite), jsonl-parser.ts, cli-runner.ts (runtime-dispatched session prompt with suggestions), session-lock.ts (per-session run lock), session-header.ts (shared JSONL header reader for all agent runtimes), enrichment.ts, app-state.ts, auth.ts, routes.ts, index.ts.

**Agent runtimes:** agent-runtime.ts (interface + registry + `getRuntimeByType()` for per-session dispatch), agent-claude.ts, agent-pimono.ts, agent-openclaw.ts, agent-codex.ts. All self-register via side-effect import. Health analysis is a method on each runtime class (`analyzeSessionHealth()`), dispatched polymorphically.

**Plan system:** plan-db.ts (tables + CRUD + insights CRUD), plan-routes.ts (API + insight callback/management endpoints), plan-generator.ts (AI decomposition), plan-executor.ts (execution + role-aware prompt assembly + artifacts + evaluation + insight generation), plan-coordinator.ts (insight-driven blueprint coordination — reads unread insights, instructs agent to create/update nodes). Exported helpers: `resolveNodeRoles(node, blueprint)` (node.roles → blueprint.defaultRole → "sde" fallback), `buildArtifactPrompt(roleIds)` (single/multi-role artifact format). See [`docs/PLAN-EXECUTION.md`](docs/PLAN-EXECUTION.md).

**Role system:** `roles/role-registry.ts` (RoleDefinition/RolePrompts interfaces + Map registry + get/list/filter helpers), `roles/role-sde.ts`, `roles/role-qa.ts`, `roles/role-pm.ts` (built-in role definitions, self-register via side-effect import). Same registration pattern as agent runtimes. See `docs/plans/2026-03-01-multi-role-mechanism-design.md`.

### Frontend (`frontend/`)

Next.js 14, React 18, Tailwind CSS 3, dark/light theme via `next-themes`. For detailed UI patterns, see [`docs/FRONTEND-PATTERNS.md`](docs/FRONTEND-PATTERNS.md).

**Routes:** `/` → `/blueprints`, `/sessions`, `/session/[id]`, `/blueprints`, `/blueprints/new`, `/blueprints/[id]`, `/blueprints/[id]/nodes/[nodeId]`.

**Key components:** `SessionList`, `Timeline`, `TimelineNode`, `ToolPairNode`, `MacroNodeCard`, `StatusIndicator`, `SuggestionButtons`, `PromptInput`, `MarkdownContent`, `AISparkle`, `AuthProvider`, `ThemeProvider`, `ToastProvider`, `NavBar`, `SkeletonLoader`, `AgentSelector`, `AgentBadge`.

**API client:** `lib/api.ts` — relative `/api/*` paths proxied via `next.config.mjs` to backend. Auth via `x-clawui-token` header from `localStorage`.

## Conventions

- Backend imports use `.js` extensions: `import { foo } from "./bar.js"`
- Frontend uses `@/*` path alias → `./src/*`
- All frontend components are `"use client"`
- Optimistic UI updates for all mutations (star, bookmark, tag, notes)
- `next.config.mjs` (not `.ts`) for Next.js 14 compatibility
- ESLint scoped to `backend/src/**/*.ts` only (config + deps at root)
- **CI**: `.github/workflows/ci.yml` — typecheck, lint, build, tests on push to main and PRs (Node.js 20 + 22)
- **Semantic color tokens**: Use `accent-amber`, `accent-green`, `bg-bg-primary` etc. — never hardcoded colors like `bg-[#0a0a0f]`. See [`docs/FRONTEND-PATTERNS.md`](docs/FRONTEND-PATTERNS.md) for full CSS/color/accessibility conventions.
- **Available accent tokens**: Only `accent-blue`, `accent-purple`, `accent-green`, `accent-amber`, `accent-red` exist. No `accent-yellow`, `accent-orange`, or `accent-cyan` — use `accent-amber` as the closest warm alternative. Exception: `BADGE_COLOR` in `TimelineNode.tsx` uses Tailwind defaults with `dark:` variants for tool-type differentiation (14+ tool types exceed the 5-accent palette).
- **Node numbering**: Always use `node.seq` for display numbers (monotonic, never reused). `node.order` is for positional sorting only.
- **Session ID validation**: All endpoints must call `validateSessionId()` before shell commands. See [`docs/BACKEND-ARCHITECTURE.md`](docs/BACKEND-ARCHITECTURE.md) for security patterns.
- **Error sanitization**: Never expose internal error messages in API responses — use `safeError()` helper
- **Agent runtime side-effect imports**: Modules using `getActiveRuntime()` or `getRegisteredRuntimes()` must import all runtime modules as side-effects. Currently done in `plan-executor.ts`, `plan-generator.ts`, `plan-coordinator.ts`, `db.ts`, and `routes.ts`.
- **Role side-effect imports**: Modules using `getRole()`, `getAllRoles()`, or `getBuiltinRoles()` must import all role modules (`roles/role-sde.js`, `roles/role-qa.js`, `roles/role-pm.js`) as side-effects. Currently done in `plan-executor.ts`, `plan-generator.ts`, `plan-coordinator.ts`, and `plan-routes.ts`. Same pattern as agent runtimes.
- **Blueprint vs node status labels**: Blueprint-level "running" displays as "In Progress" in the UI; node-level "running" displays as "Running". `StatusIndicator` accepts `context?: "blueprint" | "node"` prop — pass `context="blueprint"` when rendering blueprint status.
- **Agent-neutral UI language**: Frontend user-facing text uses "agent" (not "Claude Code") since multiple agent runtimes are supported. Tooltips say "using the selected agent", empty states say "use an agent", etc.
- **Version sync**: Version numbers must match across `package.json` (root), `backend/package.json`, and `frontend/package.json`. Update all three when bumping versions.
- **CHANGELOG.md**: Maintained at project root following [Keep a Changelog](https://keepachangelog.com/) format. Update with each release.

## Key Design Decisions

- **expect for TTY**: Claude Code requires a TTY — `node-pty` fails on Node 25, so we use `expect` with `set stty_init "columns 2000"`
- **SQLite for index**: `better-sqlite3` sync API, incremental updates via file mtime+size comparison
- **JSON for small data**: Enrichments and app state are JSON files (small, readable, diffable)
- **Layer 1 read-only**: Never write to Claude Code's JSONL files
- **MCP tool detection**: MCP tools use `mcp__serverName__toolName` naming convention (double underscores)
- **Plans are Layer 2 extensions**: Plan data lives in the same SQLite db, not a new layer
- **API callbacks for execution signals**: `buildNodePrompt()` instructs Claude to call `report-blocker`, `task-summary`, and `report-status` endpoints. `report-status` is the authoritative result; falls back to legacy inference when absent.
- **Fire-and-forget execution**: Serial queues per workspace/projectCwd (`enqueueBlueprintTask`). Blueprints sharing the same `projectCwd` share one queue — only one agent task runs at a time per workspace. `resolveWorkspaceKey(blueprintId)` resolves the queue key (falls back to `blueprintId` if `projectCwd` is NULL). Endpoints return `{status:"queued"}` immediately; frontend polls.
- **Related session early detection**: `runWithRelatedSessionDetection()` in `plan-routes.ts` wraps agent CLI calls (enrich, reevaluate, split, smart-deps) with background session polling, creating `node_related_sessions` with `completed_at = NULL` during execution (enabling frontend live-polling via `getActiveRelatedSession`), then completing them when done. Evaluation uses the same pattern inlined in `evaluateNodeCompletion()` in `plan-executor.ts`. New related operations should use this wrapper (or inline the pattern) instead of bare `runAgentInteractive()`.
- **Fire-and-forget UI pattern**: Frontend tracks queued operations via `xxxQueued` derived from `pendingTasks` (e.g. `enrichQueued`, `reevaluateQueued`, `smartDepsQueued`). Optimistic local state bridges the gap until polling picks up the pending task; a `useEffect` watching queue transitions syncs edit fields on completion and shows a toast via `useToast()`. New fire-and-forget ops should follow this pattern and call `showToast()` on completion.
- **Blueprint insights panel**: Blueprint detail page fetches insights in its `Promise.all` poll cycle alongside blueprint and queue data. Insight actions (mark-read, dismiss) use optimistic updates. NavBar polls `GET /api/insights/unread-count` alongside `getGlobalStatus()` to show an unread dot badge on the Blueprints nav link. Severity colors: info=accent-blue, warning=accent-amber, critical=accent-red.
- **Toast notifications**: `Toast.tsx` provides `ToastProvider` (in root layout) and `useToast()` hook. Call `showToast(message)` for success, `showToast(message, "error")` for errors. Toasts auto-dismiss after 3s with progress bar. No external library — lightweight custom implementation.
- **Cross-tab state sync (blueprints)**: `useBlueprintBroadcast` hook (`lib/useBlueprintBroadcast.ts`) uses `BroadcastChannel` to notify other open tabs when operations start. Receiving tabs immediately fetch fresh data to activate polling. New fire-and-forget operations should call `broadcastOperation(type, nodeId)` after the API call resolves. `MacroNodeCard` receives `broadcastOperation` as a prop from its parent page.
- **Cross-tab state sync (sessions)**: `useSessionBroadcast` hook (`lib/useSessionBroadcast.ts`) uses `BroadcastChannel` to notify other tabs when a session run starts/stops. Session page also polls `GET /api/sessions/:id/status` to detect runs from other sources (blueprint execution). Shows "Session is running in another tab" warning when disabled by remote run.
- **Per-session run lock**: `session-lock.ts` provides in-memory `acquireSessionLock`/`releaseSessionLock` to prevent concurrent `--resume` processes on the same JSONL file. `POST /api/sessions/:id/run` returns 409 if locked. `resumeNodeSession()` in `plan-executor.ts` also acquires the lock. Always release in a `finally` block.
- **Session CWD lookup**: `getSessionCwdFromDb()` in `db.ts` reads the `cwd` column from the sessions table — works for all agent types. `getSessionCwd()` in `jsonl-parser.ts` is Claude-only (filesystem scan). Prefer the DB function for multi-agent contexts.
- **Session live-polling during runs**: Session detail page polls at 2s during active `runPrompt()` (vs 5s normal) to stream incremental Claude responses. Uses ref-mirrored state (`runningRef`, `thinkingNodeRef`, `preRunNodeCountRef`) so `fetchNodes` reads running status without being in the `useCallback` dependency array. Real nodes from JSONL replace optimistic nodes once server count exceeds pre-run count; thinking indicator is appended until the run resolves.
- **Localhost-only binding**: Both frontend and backend bind to `127.0.0.1`. External access via `tailscale serve`.
- **Local Auth Token**: `crypto.randomBytes(16)` hex token, rotates every restart. Frontend reads from `localStorage`, seeded via `?auth=` URL param.

For plan execution internals (dependency validation, evaluation, artifacts, session resume, recovery, node split, smart deps), see [`docs/PLAN-EXECUTION.md`](docs/PLAN-EXECUTION.md).

## Gotchas

For the full list, see [`docs/CODING-GOTCHAS.md`](docs/CODING-GOTCHAS.md). Most critical:

- **Incremental DB migrations**: New columns use `PRAGMA table_info()` + `ALTER TABLE ADD COLUMN`. New tables use `sqlite_master` check. Bumping `CURRENT_SCHEMA_VERSION` triggers full recreation — only for structural changes.
- **CLI output echo**: Claude CLI echoes the full prompt. Use depth-counting brace extraction, last-to-first (see `extractTitleDescJson` in `plan-routes.ts`).
- **In-memory queue vs SQLite**: `workspaceQueues`/`workspacePendingTasks` are in-memory only (keyed by `projectCwd`). `requeueOrphanedNodes()` resets orphaned queued nodes to pending on startup.
- **Project path encoding**: Hyphens in directory names are ambiguous. `decodeProjectPath()` uses filesystem-aware backtracking — never use naive `replace(/-/g, "/")`.
- **Multi-agent project ID namespacing**: Claude IDs unprefixed, Pi `pi:<dirName>`, OpenClaw `openclaw:<encodedCwd>`, Codex `codex:<encodedCwd>`. Account for prefix differences when comparing.
- **OpenClaw session file locations**: Local sessions in `~/.openclaw/agents/<agent-name>/sessions/*.jsonl`. Docker instances store sessions in their own config dir (e.g. `~/.openclaw/openclaw-<instance>/agents/`).
- **Codex session file locations**: Sessions in `~/.codex/sessions/YYYY/MM/DD/rollout-<datetime>-<UUID>.jsonl` (date-organized, not path-organized). First line uses `{type:"session_meta", payload:{id, cwd, ...}}` — note `cwd` is nested under `payload`, unlike Claude/OpenClaw top-level fields.
- **OpenClaw Docker config**: Custom model providers in `openclaw.json` under `models.providers.<name>` require `baseUrl`, `apiKey` (supports `env:VAR_NAME`), `api`, and `models[]`. Invalid keys cause startup failure — use `openclaw doctor --fix`. For codex models, use a separate `openai-codex` provider with `"api": "openai-codex-responses"`.
- **OpenClaw Docker gateway auth**: Docker instances require `gateway.auth.token` in their `openclaw.json`. Remote CLI profiles (at `~/.openclaw-<profile>/openclaw.json`) must set `gateway.remote.url` and `gateway.remote.token` to match. Use the operator token from the container's `identity/device-auth.json` or set a custom `gateway.auth.token`. Note: `gateway.mode` only accepts `"local"` or `"remote"` (not `"embedded"`).
- **New exports need mock updates**: All `vi.mock()` blocks must include new exports or Vitest throws "[vitest] No 'exportName' export is defined on the mock". NavBar.test.tsx mocks `@/lib/api` — add new API exports there (e.g. `getUnreadInsightCount`). When adding new modules imported by `plan-routes.ts`, also add a `vi.mock()` block in `plan-routes.test.ts` (e.g. `plan-coordinator.js`).
- **Adding new AgentType variants**: Besides updating the union type and `resolveAgentType()` valid array, also update: `agentNames` in `db.ts:getAvailableAgents()`, side-effect imports in `db.ts`/`plan-executor.ts`/`plan-generator.ts`, `parseSessionNodes()` switch in `db.ts`, `syncAllForAgent()` switch + sync function in `db.ts`, `findSessionFileAcrossRuntimes()` case in `db.ts`, implement `analyzeSessionHealth()` method on the new runtime class (health analysis is dispatched polymorphically via `getRuntimeByType()` — no switch in routes.ts), `vi.mock()` block in `routes.test.ts`, and frontend: `AgentType` union in `api.ts`, `AGENT_COLORS` + `AGENT_LABELS` in `AgentSelector.tsx` (which also contains `AgentBadge` — no separate file).
- **Plan system type sync**: `backend/src/plan-db.ts` types (`NodeExecution`, `MacroNode`, `Blueprint`, `Artifact`, `BlueprintInsight`) and `PendingTask.type` in `plan-executor.ts` must stay in sync with `frontend/src/lib/api.ts` mirror types. When adding fields to backend row-to-object helpers or new pending task types, update the frontend interface too. Also update the `hasRelatedOps` check in `NodeDetailPage` when adding new related operation types.
- **New per-node tables need batch loading**: `getNodesForBlueprint()` in `plan-db.ts` batch-loads artifacts, executions, and suggestion counts to avoid N+1 queries. When adding a new per-node data table, add a batch query in `getNodesForBlueprint()` and pass the data through `rowToMacroNode()`. Also add both the `CREATE TABLE` in the main schema block (for fresh DBs) AND an incremental migration (for existing DBs).
- **`createMacroNode` doesn't accept `roles`**: The `roles` field must be set via `updateMacroNode()` after creation. The `batch-create` endpoint in `plan-routes.ts` uses this workaround.
- **Adding fields to `RolePrompts`**: Also update `makePrompts()` helper in `role-registry.test.ts` — it constructs a complete `RolePrompts` object and will fail typecheck if new required fields are missing.
- **plan-db tests share real DB**: Tests use `.clawui/index.db` (not isolated). Use unique `projectCwd` / session IDs (`randomUUID()`) in tests to avoid collisions and N+1 query timeouts from `listBlueprints()` scanning all rows.
- **Codex sandbox blocks localhost**: `--full-auto` forces `workspace-write` sandbox which blocks network calls (curl exit 7). Use `--dangerously-bypass-approvals-and-sandbox` for any mode where Codex needs to call back to ClawUI API endpoints (generation, execution, enrichment, reevaluation, smart-deps).
- **Codex trust requirement**: `codex exec` requires the working directory to be in `~/.codex/config.toml` under `[projects."<path>"]` with `trust_level = "trusted"` AND be a git repo. macOS `/tmp` → `/private/tmp` symlink means both paths may need trust entries. Use `--skip-git-repo-check` to bypass.
- **Timeline node IDs must be globally unique**: `timeline_nodes.id` is PRIMARY KEY across all sessions. Agent JSONL parsers must use session-scoped prefixes (e.g., `${sessionId.slice(0,12)}-${lineNum}`), not plain `line-N`.
- **syncSessionFile needs project ensurance**: Single-session sync (e.g., execution polling `detectNewSession`) may encounter a project not yet in the `projects` table. `syncSessionFile` ensures the project exists before INSERT to prevent `SQLITE_CONSTRAINT_FOREIGNKEY`.
- **OpenClaw multi-dir sync stale cleanup**: `syncOpenClawSessions()` is called per directory (local + Docker). Must pass a shared `seenProjectIds` set across all calls, then run `cleanupStaleOpenClawProjects()` once at the end — otherwise earlier directories' projects get incorrectly deleted as stale.
- **Non-Anthropic models and shell JSON**: GPT-4o (and similar older models) fail on complex nested JSON quoting in shell curl commands (e.g. enrich, split, evaluation callbacks). GPT-5.3-codex handles all JSON complexity correctly — enrich, split (multi-step with arrays), and evaluation with nested mutations all produce valid JSON. When using OpenClaw with OpenAI models, prefer GPT-5.x codex models for plan operations requiring callback JSON.
- **ESLint `_` prefix doesn't suppress unused-vars**: The ESLint config (`tseslint.configs.recommended`) does NOT configure `argsIgnorePattern: "^_"`. Prefixing variables/params with `_` still triggers `@typescript-eslint/no-unused-vars` errors. Use `// eslint-disable-next-line @typescript-eslint/no-unused-vars` instead.
- **OpenClaw codex model API type**: GPT-5.x codex models require `"api": "openai-codex-responses"` (not `"openai-completions"`) in the OpenClaw `openclaw.json` provider config. OpenClaw may auto-detect this for models with "codex" in their ID, but explicit configuration under a dedicated `openai-codex` provider is more reliable. Valid API types: `openai-completions`, `openai-responses`, `openai-codex-responses`, `anthropic-messages`, `google-generative-ai`, `github-copilot`, `bedrock-converse-stream`, `ollama`.

## Environment Variables

All config is centralized in `backend/src/config.ts`. See `.env.example` for defaults.

- `PORT` — Backend port (default: `3001`)
- `CLAWUI_DB_DIR` — Database directory name relative to project root (default: `.clawui`)
- `NEXT_PUBLIC_API_PORT` — Frontend API port (default: `3001`, must match backend PORT)
- `CLAUDE_PATH` — Path to Claude CLI binary (auto-detected: checks `~/.local/bin/claude`, `/usr/local/bin/claude`, then PATH)
- `EXPECT_PATH` — Path to `expect` binary (auto-detected: checks `/usr/bin/expect`, `/usr/local/bin/expect`, `/opt/local/bin/expect`, `/opt/homebrew/bin/expect`, then PATH)
- `LOG_LEVEL` — Log verbosity: `debug`, `info`, `warn`, `error` (default: `info`)
- `CLAWUI_DEV` — Set to `1` to reuse existing auth token across backend restarts and enable dev UI features (default: unset, token rotates every restart). Exposed to frontend via `GET /api/dev/status`.
- `AGENT_TYPE` — Select agent runtime: `claude` (default), `openclaw` (OpenClaw), `pi` (Pi Mono), `codex` (Codex CLI). Used by `getActiveRuntime()` factory in `agent-runtime.ts`.
- `OPENCLAW_PATH` — Path to OpenClaw CLI binary (auto-detected: checks `~/.local/bin/openclaw`, `/usr/local/bin/openclaw`, then PATH). Docker instances run on custom ports (e.g. 19000/19001) separate from local gateway (18789); CLI connects to local gateway by default.
- `PI_PATH` — Path to Pi CLI binary (auto-detected: checks `~/.local/bin/pi`, `/usr/local/bin/pi`, then PATH, then falls back to `npx @mariozechner/pi-coding-agent`)
- `CODEX_PATH` — Path to Codex CLI binary (auto-detected: checks `~/.local/bin/codex`, `/opt/homebrew/bin/codex`, `/usr/local/bin/codex`, then PATH)
- `OPENCLAW_PROFILE` — OpenClaw profile name for Docker instances. Adds `--profile <name>` to CLI invocations and scans `~/.openclaw/openclaw-<name>/agents/` for Docker sessions (default: unset).

## Development Environments

This project supports separate dev and stable environments to prevent development from disrupting daily use. See [CONTRIBUTING.md](CONTRIBUTING.md#dev-vs-stable-environments) for details and helper scripts.

- **Stable**: ports 3000 (frontend) / 3001 (backend), DB in `.clawui/`, scripts: `scripts/deploy-stable.sh`, `scripts/start-stable.sh`
- **Dev**: ports 3100 (frontend) / 3101 (backend), DB in `.clawui-dev/`, script: `scripts/start-dev.sh`
- **Frontend dev-mode detection**: Dev UI (e.g. redeploy button) shows when either `window.location.port !== "3000"` (dev port) OR backend reports `CLAWUI_DEV=1` via `GET /api/dev/status`
- **Dev redeploy endpoint**: `POST /api/dev/redeploy` (routes.ts) — runs deploy-stable.sh then start-stable.sh via nohup. Gated behind `CLAWUI_DEV` check (returns 403 in production).
