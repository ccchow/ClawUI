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

**Plan system:** plan-db.ts (tables + CRUD + insights CRUD + convene CRUD), plan-routes.ts (API + insight callback/management endpoints + convene endpoints), plan-generator.ts (AI decomposition), plan-executor.ts (execution + role-aware prompt assembly + artifacts + evaluation + insight generation), plan-coordinator.ts (insight-driven blueprint coordination — reads unread insights, instructs agent to create/update nodes), plan-convene.ts (multi-role discussion orchestration — round-robin contributions + synthesis). Exported helpers: `resolveNodeRoles(node, blueprint)` (node.roles → blueprint.defaultRole → "sde" fallback), `buildArtifactPrompt(roleIds)` (single/multi-role artifact format). See [`docs/PLAN-EXECUTION.md`](docs/PLAN-EXECUTION.md).

**Role system:** `roles/role-registry.ts` (RoleDefinition/RolePrompts interfaces + Map registry + get/list/filter helpers), `roles/load-all-roles.ts` (dynamic loader — auto-discovers and imports all `role-*.ts` files via `readdirSync` + top-level `await import()`), `roles/role-sde.ts`, `roles/role-qa.ts`, `roles/role-pm.ts`, `roles/role-uxd.ts`, `roles/role-sa.ts` (built-in role definitions, self-register via `registerRole()` on import). Adding a new role: create `roles/role-<id>.ts` — auto-discovered, no other file changes needed. See `docs/plans/2026-03-01-multi-role-mechanism-design.md`.

### Frontend (`frontend/`)

Next.js 14, React 18, Tailwind CSS 3, TanStack Query v5, dark/light theme via `next-themes`. For detailed UI patterns, see [`docs/FRONTEND-PATTERNS.md`](docs/FRONTEND-PATTERNS.md).

**Routes:** `/` → `/blueprints`, `/sessions`, `/session/[id]`, `/blueprints`, `/blueprints/new`, `/blueprints/[id]`, `/blueprints/[id]/nodes/[nodeId]`.

**Key components:** `SessionList`, `Timeline`, `TimelineNode`, `ToolPairNode`, `MacroNodeCard`, `StatusIndicator`, `SuggestionButtons`, `PromptInput`, `MarkdownContent` (react-markdown + remark-gfm + react-syntax-highlighter), `MarkdownEditor`, `AISparkle`, `AuthProvider`, `ThemeProvider`, `QueryProvider` (TanStack Query), `ToastProvider`, `NavBar`, `SkeletonLoader`, `AgentSelector`, `AgentBadge`, `RoleBadge`, `RoleSelector`.

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
- **Role color convention**: SDE=accent-blue, QA=accent-green, PM=accent-purple, UXD=accent-amber, SA=accent-red, unknown=accent-amber (fallback). Defined in `role-colors.ts` (single source of truth), imported by `RoleBadge.tsx` and `RoleSelector.tsx`. Pattern-matches `AgentBadge`/`AgentSelector` from `AgentSelector.tsx`.
- **Node numbering**: Always use `node.seq` for display numbers (monotonic, never reused). `node.order` is for positional sorting only.
- **Session ID validation**: All endpoints must call `validateSessionId()` before shell commands. See [`docs/BACKEND-ARCHITECTURE.md`](docs/BACKEND-ARCHITECTURE.md) for security patterns.
- **Error sanitization**: Never expose internal error messages in API responses — use `safeError()` helper
- **Agent runtime side-effect imports**: Modules using `getActiveRuntime()` or `getRegisteredRuntimes()` must import all runtime modules as side-effects. Currently done in `plan-executor.ts`, `plan-generator.ts`, `plan-coordinator.ts`, `plan-convene.ts`, `db.ts`, and `routes.ts`.
- **Role auto-loading via `load-all-roles.ts`**: Modules using `getRole()`, `getAllRoles()`, or `getBuiltinRoles()` import `./roles/load-all-roles.js` as a single side-effect (replaces per-role imports). The loader auto-discovers `role-*.ts` files via `readdirSync` + dynamic `import()` with top-level await. Adding a new role requires **only** creating `roles/role-<id>.ts` — no import updates in consumer modules. **Test mocks**: `vi.mock("../roles/load-all-roles.js", () => ({}))` — single line replaces per-role mocks. Still need `registerRole: vi.fn()` in the `role-registry.js` mock.
- **Blueprint vs node status labels**: Blueprint-level "running" displays as "In Progress" in the UI; node-level "running" displays as "Running". `StatusIndicator` accepts `context?: "blueprint" | "node"` prop — pass `context="blueprint"` when rendering blueprint status.
- **Agent-neutral UI language**: Frontend user-facing text uses "agent" (not "Claude Code") since multiple agent runtimes are supported. Tooltips say "using the selected agent", empty states say "use an agent", etc.
- **Version sync**: Version numbers must match across `package.json` (root), `backend/package.json`, and `frontend/package.json`. Update all three when bumping versions.
- **CHANGELOG.md**: Maintained at project root following [Keep a Changelog](https://keepachangelog.com/) format. Update with each release.
- **Windows path resolution pattern**: All `resolve*Path()` functions in `config.ts` use `process.platform === "win32"` branches. Windows: candidates use `.cmd` extensions in `AppData/Roaming/npm/` and `.npm-global/`, PATH lookup via `execFileSync("where", [...], { encoding: "utf-8", timeout: 5000, windowsHide: true }).trim().split(/\r?\n/)[0]`. Unix: `~/.local/bin/`, `/usr/local/bin/`, PATH lookup via `/usr/bin/which`. Reference implementation: `resolveClaudePath()`.
- **Agent binary paths import from config.ts**: Agent files (`agent-codex.ts`, `agent-openclaw.ts`, `agent-pimono.ts`) import `CODEX_PATH`/`OPENCLAW_PATH`/`PI_PATH` from `config.ts` with bare-command fallback (e.g., `CONFIG_CODEX_PATH ?? "codex"`). Don't add local resolution functions — keep resolution centralized in config.ts.
- **Gesture color semantics**: Fire-and-forget buttons follow a strict color taxonomy (green=execution, purple=AI creation, amber=review/reconsider, red=destructive, blue=state transition, text-secondary=neutral). Same gesture = same color everywhere. See "Gesture Color Semantics" in [`docs/FRONTEND-PATTERNS.md`](docs/FRONTEND-PATTERNS.md).

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
- **`blueprintBusy` prop semantics**: `blueprintBusy` in `page.tsx` only covers blueprint-level operations (Generate, Convene, Coordinate) — NOT "Run All" or individual node runs. `MacroNodeCard` disables Run/Edit/Skip/Delete buttons when `blueprintBusy` is set, but individual node Run buttons remain clickable during other node runs (queues via fire-and-forget). `hasRunningNodes` prop provides informational tooltip ("Queues for execution after current node finishes").
- **Stuck blueprint status recovery**: `maybeFinalizeBlueprint()` in `plan-routes.ts` handles two cases: (1) all nodes terminal → status "done", (2) no active nodes + no pending tasks → status "approved" (stuck recovery). Called opportunistically from the `GET /api/blueprints/:id/queue` endpoint during frontend polling. Startup recovery also exists in `recoverStaleExecutions()` in `plan-db.ts`. Blueprint detail page shows a manual "Reset" button (accent-amber, with inline confirmation strip) when status is "running" but no nodes are active.
- **Blueprint discussions panel**: Convene sessions are fetched in the same `Promise.all` poll cycle as insights. The Discussions section mirrors the Insights panel pattern (collapsible with chevron rotation, inline expansion). Convene is a blueprint-level `pendingTask` (no `nodeId`) — added to `blueprintBusy` check. `BroadcastOpType` includes `"convene"`. Expanded sessions fetch detail via `getConveneSessionDetail()`. Synthesis review uses inline confirmation strip pattern (not `window.confirm()`). Active convene sessions (`status === "active" | "synthesizing"`) speed up the main poll cycle to 2s (vs 5s normal); a dedicated `useEffect` also polls the expanded session detail at 2s to stream new round messages.
- **TanStack Query data fetching**: `blueprints/[id]/page.tsx` uses `useBlueprintDetailQueries` hook (`lib/useBlueprintDetailQueries.ts`) which bundles four `useQuery` calls (blueprint, queue, insights, convene sessions) with coordinated dynamic polling via `refetchInterval` function. Query key factory: `blueprintKeys.detail(id)`, `.queue(id)`, `.insights(id)`, `.conveneSessions(id)`. `session/[id]/page.tsx` uses `useSessionDetailQueries` hook (`lib/useSessionDetailQueries.ts`) which bundles four `useQuery` calls (timeline, meta, status, blueprintContext) with dynamic polling (2s during runs / 5s normal). Query key factory: `sessionKeys.timeline(id)`, `.meta(id)`, `.status(id)`, `.blueprintContext(id)`. Both hooks derive `remoteRunning` from cached status data. Session page uses a `runOverlay` state pattern for optimistic nodes during active runs (user message + thinking indicator) that overlays query data without fighting TanStack Query's cache. Mutations use `invalidateAll()` or targeted `queryClient.invalidateQueries()`. Optimistic updates use `queryClient.setQueryData()` via hook-provided helpers. `blueprints/[id]/nodes/[nodeId]/page.tsx` uses `useNodeDetailQueries` hook (`lib/useNodeDetailQueries.ts`) which bundles eight `useQuery` calls (blueprint, executions, queue, related sessions, suggestions + three dependent queries for lastMessage, activeRelatedSession, relatedLastMessage) with dynamic polling (5s active / 10s recovery-only / off when idle). Query key factory: `nodeDetailKeys.executions(bpId, nodeId)`, `.relatedSessions(...)`, `.suggestions(...)`, `.lastMessage(sessionId)`, `.activeRelatedSession(...)`, `.relatedLastMessage(sessionId)`. Reuses `blueprintKeys.detail(id)` and `.queue(id)` from `useBlueprintDetailQueries` for shared caching. Hook accepts `postCompletionPolling` and `recoveryPolling` booleans from page-level state. Dependent queries use `enabled` flag based on derived state (running execution exists, has related ops). Optimistic `setNode` patches node within the blueprint cache.
- **TanStack Query blueprint list**: `blueprints/page.tsx` uses `useBlueprintListQuery` hook (`lib/useBlueprintListQuery.ts`) which wraps a single `useQuery` for `listBlueprints` with filter-based query keys. Provides `prefetchBlueprintDetail(id)` that pre-caches blueprint detail data (blueprint + queue + insights + convene sessions) on link hover/focus. Query key factory: `blueprintKeys.all` (broad invalidation), `blueprintKeys.list(filters)` (specific list query). No polling — list is fetched once and invalidated on mutations.
- **TanStack Query dynamic polling pattern**: The `refetchInterval` callback reads query caches via `queryClient.getQueryData()` to compute the interval without circular dependencies. Blueprint: 2s active convene / 5s normal / `false` when idle. Session: 2s during local or remote runs / 5s normal / `false` when autoRefresh disabled. Node detail: 5s active / 10s recovery-only / `false` when idle; accepts `postCompletionPolling`/`recoveryPolling` booleans from page. All three use `usePollingInterval(computeFn)` from `lib/polling-utils.ts` which encapsulates the `useRef` + `useCallback` + `createDynamicInterval` safety cap pattern (35 min via `POLL_SAFETY_CAP_MS`). Multi-key invalidation uses `invalidateKeys(queryClient, keys)` from the same module. Session hook takes `localRunning` as param (local state from page) and derives `remoteRunning` from the status query cache.
- **Toast notifications**: `Toast.tsx` provides `ToastProvider` (in root layout) and `useToast()` hook. Call `showToast(message)` for success, `showToast(message, "error")` for errors. Toasts auto-dismiss after 3s with progress bar. No external library — lightweight custom implementation.
- **Cross-tab state sync (blueprints)**: `useBlueprintBroadcast` hook (`lib/useBlueprintBroadcast.ts`) uses `BroadcastChannel` to notify other open tabs when operations start. Receiving tabs immediately fetch fresh data to activate polling. New fire-and-forget operations should call `broadcastOperation(type, nodeId)` after the API call resolves. `MacroNodeCard` receives `broadcastOperation` as a prop from its parent page.
- **Cross-tab state sync (sessions)**: `useSessionBroadcast` hook (`lib/useSessionBroadcast.ts`) uses `BroadcastChannel` to notify other tabs when a session run starts/stops. Session page also polls `GET /api/sessions/:id/status` to detect runs from other sources (blueprint execution). Shows "Session is running in another tab" warning when disabled by remote run.
- **Per-session run lock**: `session-lock.ts` provides in-memory `acquireSessionLock`/`releaseSessionLock` to prevent concurrent `--resume` processes on the same JSONL file. `POST /api/sessions/:id/run` returns 409 if locked. `resumeNodeSession()` in `plan-executor.ts` also acquires the lock. Always release in a `finally` block.
- **Session CWD lookup**: `getSessionCwdFromDb()` in `db.ts` reads the `cwd` column from the sessions table — works for all agent types. `getSessionCwd()` in `jsonl-parser.ts` is Claude-only (filesystem scan). Prefer the DB function for multi-agent contexts.
- **Session live-polling during runs**: Session detail page uses TanStack Query with 2s `refetchInterval` during active runs (vs 5s normal). A `runOverlay` state holds synthetic nodes (user message + thinking indicator) that overlay the query's `rawNodes` during runs. A `useEffect` watching `rawNodes` updates the overlay when server returns new content (`rawNodes.length > preRunNodeCountRef`). On run completion, overlay is cleared after `await invalidateTimeline()` to avoid flash. `displayNodes = runOverlay ?? rawNodes`.
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
- **`encodeProjectCwd` cross-platform pattern**: All agent runtimes' `encodeProjectCwd()` must use `/[/\\]/g` (not `/\//g`) and handle drive letter colons with `/:/g`. Reference: `agent-claude.ts` lines 92-96 and `cli-utils.ts:encodeProjectPath()`.
- **Plan system type sync**: `backend/src/plan-db.ts` types (`NodeExecution`, `MacroNode`, `Blueprint`, `Artifact`, `BlueprintInsight`, `ConveneSession`, `ConveneMessage`, `BatchCreateNode`) and `PendingTask.type` in `plan-executor.ts` must stay in sync with `frontend/src/lib/api.ts` mirror types. When adding fields to backend row-to-object helpers or new pending task types, update the frontend interface too. Also update the `hasRelatedOps` check in `NodeDetailPage` when adding new related operation types.
- **New per-node tables need batch loading**: `getNodesForBlueprint()` in `plan-db.ts` batch-loads artifacts, executions, and suggestion counts to avoid N+1 queries. When adding a new per-node data table, add a batch query in `getNodesForBlueprint()` and pass the data through `rowToMacroNode()`. Also add both the `CREATE TABLE` in the main schema block (for fresh DBs) AND an incremental migration (for existing DBs).
- **Per-blueprint counts need batch loading in `listBlueprints`**: `listBlueprints()` in `plan-db.ts` batch-loads convene session counts to avoid N+1 queries. When adding new per-blueprint aggregate data, add a batch query in `listBlueprints()` and pass through `rowToBlueprint()`. `getBlueprint()` can use individual count functions directly.
- **Blueprint-level agent operations**: Blueprint-wide operations (coordinator, convene) use `runAgentInteractive()` directly without `runWithRelatedSessionDetection()`, since they have no specific nodeId. The `addPendingTask` call omits `nodeId`. Follow the coordinator endpoint pattern in `plan-routes.ts` for new blueprint-level fire-and-forget operations.
- **`createMacroNode` doesn't accept `roles`**: The `roles` field must be set via `updateMacroNode()` after creation. The `batch-create` endpoint in `plan-routes.ts` uses this workaround.
- **Adding fields to `RolePrompts`**: Also update `makePrompts()` helper in `role-registry.test.ts` — it constructs a complete `RolePrompts` object and will fail typecheck if new required fields are missing.
- **Adding new role tests**: Use `assertRoleRegistration(roleId, expectedShape)` helper in `role-registry.test.ts`. Each role test is a single `describe` block with `clearRoles()` + dynamic import + one `assertRoleRegistration` call. The helper validates registration, metadata, artifactTypes, blockerTypes, workVerb, prompt substrings (via `promptContains`), and toolHints.
- **BlueprintStatus vs MacroNodeStatus naming**: `BlueprintStatus` uses `"draft"/"approved"` while `MacroNodeStatus` uses `"pending"`. Don't confuse them — `blueprint.status !== "pending"` is a TypeScript error since `"pending"` is not in `BlueprintStatus`.
- **plan-db tests share real DB**: Tests use `.clawui/index.db` (not isolated). Use unique `projectCwd` / session IDs (`randomUUID()`) in tests to avoid collisions and N+1 query timeouts from `listBlueprints()` scanning all rows.
- **Codex sandbox blocks localhost**: `--full-auto` forces `workspace-write` sandbox which blocks network calls (curl exit 7). Use `--dangerously-bypass-approvals-and-sandbox` for any mode where Codex needs to call back to ClawUI API endpoints (generation, execution, enrichment, reevaluation, smart-deps).
- **Codex trust requirement**: `codex exec` requires the working directory to be in `~/.codex/config.toml` under `[projects."<path>"]` with `trust_level = "trusted"` AND be a git repo. macOS `/tmp` → `/private/tmp` symlink means both paths may need trust entries. Use `--skip-git-repo-check` to bypass.
- **Timeline node IDs must be globally unique**: `timeline_nodes.id` is PRIMARY KEY across all sessions. Agent JSONL parsers must use session-scoped prefixes (e.g., `${sessionId.slice(0,12)}-${lineNum}`), not plain `line-N`.
- **syncSessionFile needs project ensurance**: Single-session sync (e.g., execution polling `detectNewSession`) may encounter a project not yet in the `projects` table. `syncSessionFile` ensures the project exists before INSERT to prevent `SQLITE_CONSTRAINT_FOREIGNKEY`.
- **OpenClaw multi-dir sync stale cleanup**: `syncOpenClawSessions()` is called per directory (local + Docker). Must pass a shared `seenProjectIds` set across all calls, then run `cleanupStaleOpenClawProjects()` once at the end — otherwise earlier directories' projects get incorrectly deleted as stale.
- **Non-Anthropic models and shell JSON**: GPT-4o (and similar older models) fail on complex nested JSON quoting in shell curl commands (e.g. enrich, split, evaluation callbacks). GPT-5.3-codex handles all JSON complexity correctly — enrich, split (multi-step with arrays), and evaluation with nested mutations all produce valid JSON. When using OpenClaw with OpenAI models, prefer GPT-5.x codex models for plan operations requiring callback JSON.
- **ESLint `_` prefix doesn't suppress unused-vars**: The ESLint config (`tseslint.configs.recommended`) does NOT configure `argsIgnorePattern: "^_"`. Prefixing variables/params with `_` still triggers `@typescript-eslint/no-unused-vars` errors. Use `// eslint-disable-next-line @typescript-eslint/no-unused-vars` instead.
- **React context value stability**: Context providers must memoize their `value` prop with `useMemo` (e.g. `useMemo(() => ({ showToast }), [showToast])`). Passing `value={{ fn }}` inline creates a new object each render, re-rendering ALL consumers. `ToastProvider` uses this pattern — new context providers should follow suit.
- **OpenClaw codex model API type**: GPT-5.x codex models require `"api": "openai-codex-responses"` (not `"openai-completions"`) in the OpenClaw `openclaw.json` provider config. OpenClaw may auto-detect this for models with "codex" in their ID, but explicit configuration under a dedicated `openai-codex` provider is more reliable. Valid API types: `openai-completions`, `openai-responses`, `openai-codex-responses`, `anthropic-messages`, `google-generative-ai`, `github-copilot`, `bedrock-converse-stream`, `ollama`.
- **`vi.mock` hoisting requires `vi.hoisted` for shared variables**: `vi.mock()` factories are hoisted above all code, so referenced variables must use `vi.hoisted(() => ({ fn: vi.fn() }))`. Type annotations on return values are required to avoid `never[]` inference from empty arrays (e.g., `(): Promise<Blueprint[]> => Promise.resolve([])`).
- **`vi.mock` factory objects are reused after `resetModules`**: The mock object is created once and reused on re-import. For dynamic mock values that change between tests, use getters: `vi.mock("./mod.js", () => ({ get PROP() { return mutableRef.value; } }))`.
- **Test path strings on Windows**: Use `join()` (not template literals with `/`) for mock file paths compared with `===`. `join()` uses `\` on Windows; hardcoded `/` won't match.
- **Mocking `process.platform` doesn't change native APIs**: `os.homedir()`, `path.join()`, `path.sep` always use the real OS regardless of `Object.defineProperty(process, "platform", ...)`. Mocked-platform tests must not assert on native path separators or home dir format — use flexible assertions or guard with `describe.runIf(process.platform === "win32")`. `windows-real-platform.test.ts` validates real Windows behavior; mocked tests validate branching logic only.
- **Shared frontend test utilities**: `test-utils.tsx` provides `renderWithProviders` (QueryClientProvider + ToastProvider wrapper), mock factories (`makeMockBlueprint`, `makeMockNode`, `makeMockExecution`, `makeMockInsight`), and `mockAllApiDefaults()`. `test-setup.ts` includes a global `BroadcastChannel` mock (jsdom doesn't provide one).
- **TanStack Query in tests**: Components using TanStack Query hooks need `QueryClientProvider` with `retry: false` and `refetchOnWindowFocus: false`. `renderWithProviders` includes this. For page-level tests that mock `@/lib/api`, TanStack Query calls the mocked functions transparently — no need to mock the query hooks themselves. Create a fresh `QueryClient` per test to avoid cache leakage.
- **`vi.importActual("@/lib/api")` OOM with TanStack Query pages**: Tests for pages using TanStack Query custom hooks (e.g., `useBlueprintListQuery`) will OOM if `vi.importActual("@/lib/api")` is used — the import chain pulls in the entire TanStack Query dep tree in the worker. Instead, mock the custom hook directly: `vi.mock("@/lib/useBlueprintListQuery", () => ({ useBlueprintListQuery: vi.fn(() => hookState) }))` with `vi.hoisted` state, and mock `@/lib/api` with only the directly-used functions (no `vi.importActual`). See `blueprints/page.test.tsx` for the pattern.
- **BroadcastChannel mock override for hook tests**: The global mock in `test-setup.ts` is no-op (can't track instances). Tests for `useBlueprintBroadcast`/`useSessionBroadcast` must override `globalThis.BroadcastChannel` in `beforeEach` with a `class`-based mock that pushes to a `channelInstances` array. Arrow functions in `vi.fn()` can't be used as constructors — Vitest requires `class` or `function` keyword.
- **Page tests: duplicate text in DOM**: Page components render the same text in multiple places (e.g., node title in breadcrumb `<span>` + `<h1>`, session alias in header + info panel, tags in compact view + editable view). Use `getAllByText`, `getByRole("heading")`, or `getByTitle()` instead of `getByText` to avoid "Found multiple elements" errors.
- **Page tests: buttons with SVG icons**: Buttons containing `<><svg/>Text</>` fragments can't be reliably found with `getByText`. Use `getByTitle()` with the button's `title` attribute instead.
- **NodeDetailPage edit mode layout**: Smart Enrich and Save buttons are inside edit mode (as `MarkdownEditor` `actions` prop). The Re-evaluate button is in the **non-editing** description view (below `MarkdownContent`). Don't enter edit mode to click Re-evaluate.
- **`SessionMeta` required fields in tests**: Can't use partial `as SessionMeta` casts — TS rejects insufficient overlap. Must include `sessionId`, `projectId`, `projectName`, `timestamp`, `nodeCount` in all mock `SessionMeta` objects.
- **`TimelineNode.type` valid values**: `"user" | "assistant" | "tool_use" | "tool_result" | "error" | "system"` — no `"tool"` shorthand.
- **OpenClaw Docker session scanning on Windows**: `getAllSessionsDirs()` scans `~/.openclaw/openclaw-*/agents/` for Docker instance sessions. This path pattern is Linux/macOS only — Docker Desktop on Windows uses WSL2, so container session paths differ and are not accessible at `%USERPROFILE%\.openclaw\openclaw-*\`. Windows users can only use local OpenClaw sessions (not Docker instances) unless running ClawUI inside WSL2.
- **Codex sandbox behavior on Windows**: `--dangerously-bypass-approvals-and-sandbox` may behave differently on Windows due to OS-level sandboxing differences. The `workspace-write` sandbox that `--full-auto` forces is Linux-specific (uses seccomp/namespaces). On Windows, Codex may have fewer sandbox restrictions or different failure modes when network calls are needed.
- **Codex/OpenClaw/Pi don't use `expect` on Windows**: These agent runtimes use `execFile` directly (not TTY wrapping), so the `expect` binary limitation does not apply. Only `agent-claude.ts` uses `expect` for TTY handling, and on Windows it uses `CLAUDE_CLI_JS` with direct node invocation instead.
- **React hooks before early returns**: `useEffect` hooks must be placed before conditional early returns (`if (loading) return <Skeleton/>`). Derived consts defined after early returns (e.g., `const canRun = node.status === "pending"`) can't be referenced in effects above. Solution: compute inline within the effect or use `pendingTasks.some()` directly.
- **Confirmation gate breaks existing tests**: When adding inline confirmation strips to existing buttons (e.g., Run All), tests must be updated to include the confirmation step — click button, wait for confirmation strip, then click "Yes".
- **react-markdown `pre`/`code` override pattern**: In `MarkdownContent.tsx`, fenced code blocks are handled by the `pre` component override (extracts child code element props and renders `CodeBlock`), NOT in the `code` override. This is because react-markdown calls `code` for both inline and fenced blocks — fenced blocks without a language have no `className`, making them indistinguishable from inline code in the `code` handler alone. The `code` override handles only inline code.
- **`useTheme()` mock in tests**: Components importing `useTheme` from `next-themes` (e.g., `MarkdownContent` for theme-aware syntax highlighting) need `vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }))` in their test files. See `ThemeProvider.test.tsx` for a more complete mock with `setTheme`.
- **CRLF line endings block `git add` on Windows**: `.gitattributes` enforces `eol=lf` for all source files. Windows tools often write CRLF, causing `git add` to fail with `fatal: CRLF would be replaced by LF`. Setting `core.autocrlf=false` doesn't help — convert files with `sed -i 's/\r$//'` before staging.
- **Keyboard shortcut modifier guards**: All single-key shortcuts (e.g., `r` for Run, `e` for Edit) must check `!e.metaKey && !e.ctrlKey` to avoid intercepting browser shortcuts like Cmd+R (refresh). Node detail page uses an early `if (e.metaKey || e.ctrlKey) return;` guard before all letter-key handlers.

## Environment Variables

All config is centralized in `backend/src/config.ts`. See `.env.example` for defaults.

- `PORT` — Backend port (default: `3001`)
- `CLAWUI_DB_DIR` — Database directory name relative to project root (default: `.clawui`)
- `NEXT_PUBLIC_API_PORT` — Frontend API port (default: `3001`, must match backend PORT)
- `CLAUDE_PATH` — Path to Claude CLI binary (auto-detected: Windows checks `AppData/Roaming/npm/claude.cmd` then `where`; Unix checks `~/.local/bin/claude`, `/usr/local/bin/claude`, then PATH)
- `EXPECT_PATH` — Path to `expect` binary (Unix-only, returns "" on Windows; auto-detected: checks `/usr/bin/expect`, `/usr/local/bin/expect`, `/opt/local/bin/expect`, `/opt/homebrew/bin/expect`, then PATH)
- `LOG_LEVEL` — Log verbosity: `debug`, `info`, `warn`, `error` (default: `info`)
- `CLAWUI_DEV` — Set to `1` to reuse existing auth token across backend restarts and enable dev UI features (default: unset, token rotates every restart). Exposed to frontend via `GET /api/dev/status`.
- `AGENT_TYPE` — Select agent runtime: `claude` (default), `openclaw` (OpenClaw), `pi` (Pi Mono), `codex` (Codex CLI). Used by `getActiveRuntime()` factory in `agent-runtime.ts`.
- `OPENCLAW_PATH` — Path to OpenClaw CLI binary (auto-detected: Windows checks `AppData/Roaming/npm/openclaw.cmd` then `where`; Unix checks `~/.local/bin/openclaw`, `/usr/local/bin/openclaw`, then PATH). Docker instances run on custom ports (e.g. 19000/19001) separate from local gateway (18789); CLI connects to local gateway by default.
- `PI_PATH` — Path to Pi CLI binary (auto-detected: Windows checks `AppData/Roaming/npm/pi-mono.cmd` then `where`; Unix checks `~/.local/bin/pi-mono`, `/usr/local/bin/pi-mono`, then PATH)
- `CODEX_PATH` — Path to Codex CLI binary (auto-detected: Windows checks `AppData/Roaming/npm/codex.cmd` then `where`; Unix checks `~/.local/bin/codex`, `/opt/homebrew/bin/codex`, `/usr/local/bin/codex`, then PATH)
- `OPENCLAW_PROFILE` — OpenClaw profile name for Docker instances. Adds `--profile <name>` to CLI invocations and scans `~/.openclaw/openclaw-<name>/agents/` for Docker sessions (default: unset).

## Development Environments

This project supports separate dev and stable environments to prevent development from disrupting daily use. See [CONTRIBUTING.md](CONTRIBUTING.md#dev-vs-stable-environments) for details and helper scripts.

- **Stable**: ports 3000 (frontend) / 3001 (backend), DB in `.clawui/`, scripts: `scripts/deploy-stable.sh`, `scripts/start-stable.sh`
- **Dev**: ports 3100 (frontend) / 3101 (backend), DB in `.clawui-dev/`, script: `scripts/start-dev.sh`
- **Frontend dev-mode detection**: Dev UI (e.g. redeploy button) shows when either `window.location.port !== "3000"` (dev port) OR backend reports `CLAWUI_DEV=1` via `GET /api/dev/status`
- **Dev redeploy endpoint**: `POST /api/dev/redeploy` (routes.ts) — runs deploy-stable.sh then start-stable.sh via nohup. Gated behind `CLAWUI_DEV` check (returns 403 in production).
