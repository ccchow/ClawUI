# Design Decisions

Detailed architectural and implementation decisions for ClawUI. Referenced from [CLAUDE.md](../CLAUDE.md).

## Core Architecture

- **expect for TTY**: Claude Code requires a TTY — `node-pty` fails on Node 25, so we use `expect` with `set stty_init "columns 2000"`
- **SQLite for index**: `better-sqlite3` sync API, incremental updates via file mtime+size comparison
- **JSON for small data**: Enrichments and app state are JSON files (small, readable, diffable)
- **Layer 1 read-only**: Never write to Claude Code's JSONL files
- **MCP tool detection**: MCP tools use `mcp__serverName__toolName` naming convention (double underscores)
- **Plans are Layer 2 extensions**: Plan data lives in the same SQLite db, not a new layer
- **Localhost-only binding**: Both frontend and backend bind to `127.0.0.1`. External access via `tailscale serve`.
- **Local Auth Token**: `crypto.randomBytes(16)` hex token, rotates every restart. Frontend reads from `localStorage`, seeded via `?auth=` URL param.

## Plan Execution

- **API callbacks for execution signals**: `buildNodePrompt()` instructs Claude to call `report-blocker`, `task-summary`, and `report-status` endpoints. `report-status` is the authoritative result; falls back to legacy inference when absent.
- **Fire-and-forget execution**: Serial queues per workspace/projectCwd (`enqueueBlueprintTask`). Blueprints sharing the same `projectCwd` share one queue — only one agent task runs at a time per workspace. `resolveWorkspaceKey(blueprintId)` resolves the queue key (falls back to `blueprintId` if `projectCwd` is NULL). Endpoints return `{status:"queued"}` immediately; frontend polls.
- **Related session early detection**: `runWithRelatedSessionDetection()` in `plan-routes.ts` wraps agent CLI calls (enrich, reevaluate, split, smart-deps) with background session polling, creating `node_related_sessions` with `completed_at = NULL` during execution (enabling frontend live-polling via `getActiveRelatedSession`), then completing them when done. Evaluation uses the same pattern inlined in `evaluateNodeCompletion()` in `plan-executor.ts`. New related operations should use this wrapper (or inline the pattern) instead of bare `runAgentInteractive()`.
- **Per-session run lock**: `session-lock.ts` provides in-memory `acquireSessionLock`/`releaseSessionLock` to prevent concurrent `--resume` processes on the same JSONL file. `POST /api/sessions/:id/run` returns 409 if locked. `resumeNodeSession()` in `plan-executor.ts` also acquires the lock. Always release in a `finally` block.
- **Session CWD lookup**: `getSessionCwdFromDb()` in `db.ts` reads the `cwd` column from the sessions table — works for all agent types. `getSessionCwd()` in `jsonl-parser.ts` is Claude-only (filesystem scan). Prefer the DB function for multi-agent contexts.

## Frontend Patterns

- **Fire-and-forget UI pattern**: Frontend tracks queued operations via `xxxQueued` derived from `pendingTasks` (e.g. `enrichQueued`, `reevaluateQueued`, `smartDepsQueued`). Optimistic local state bridges the gap until polling picks up the pending task; a `useEffect` watching queue transitions syncs edit fields on completion and shows a toast via `useToast()`. New fire-and-forget ops should follow this pattern and call `showToast()` on completion.
- **Blueprint insights panel**: Blueprint detail page fetches insights in its `Promise.all` poll cycle alongside blueprint and queue data. Insight actions (mark-read, dismiss) use optimistic updates. NavBar polls `GET /api/insights/unread-count` alongside `getGlobalStatus()` to show an unread dot badge on the Blueprints nav link. Severity colors: info=accent-blue, warning=accent-amber, critical=accent-red.
- **`blueprintBusy` prop semantics**: `blueprintBusy` in `page.tsx` only covers blueprint-level operations (Generate, Convene, Coordinate) — NOT "Run All" or individual node runs. `MacroNodeCard` disables Run/Edit/Skip/Delete buttons when `blueprintBusy` is set, but individual node Run buttons remain clickable during other node runs (queues via fire-and-forget). `hasRunningNodes` prop provides informational tooltip ("Queues for execution after current node finishes").
- **`blueprintStatus` prop on `MacroNodeCard`**: Passed from the blueprint detail page to enable per-node actions based on blueprint state. Currently used for the "Reset to Pending" button: visible when `node.status === "done"` AND `blueprintStatus === "approved"`. Uses accent-amber (review/reconsider gesture) with inline confirmation strip. `RoleSelector` in the blueprint detail page is disabled for `running`/`done`/`failed` statuses — reopening to `approved` re-enables it automatically.
- **Toast notifications**: `Toast.tsx` provides `ToastProvider` (in root layout) and `useToast()` hook. Call `showToast(message)` for success, `showToast(message, "error")` for errors. Toasts auto-dismiss after 3s with progress bar. No external library — lightweight custom implementation.

## Blueprint Status & Recovery

- **Stuck blueprint status recovery**: `maybeFinalizeBlueprint()` in `plan-routes.ts` handles two cases: (1) all nodes terminal → status "done", (2) no active nodes + no pending tasks → status "approved" (stuck recovery). Called opportunistically from the `GET /api/blueprints/:id/queue` endpoint during frontend polling. Startup recovery also exists in `recoverStaleExecutions()` in `plan-db.ts`. Blueprint detail page shows a manual "Reset" button (accent-amber, with inline confirmation strip) when status is "running" but no nodes are active.
- **Manual blueprint status transitions**: Blueprint detail page provides inline confirmation buttons for status changes: `done`/`failed` → `approved` (Reopen), `approved` → `draft` (Back to Draft), `paused` → `approved` (Resume). All use accent-blue (state-transition gesture). `confirmingStatusTransition` state holds the transition type (`"reopen" | "draft" | "resume" | null`). Backend `PUT /api/blueprints/:id` accepts these transitions without validation — the controls are frontend-only.

## Blueprint Discussions

- **Blueprint discussions panel**: Convene sessions are fetched in the same `Promise.all` poll cycle as insights. The Discussions section mirrors the Insights panel pattern (collapsible with chevron rotation, inline expansion). Convene is a blueprint-level `pendingTask` (no `nodeId`) — added to `blueprintBusy` check. `BroadcastOpType` includes `"convene"`. Expanded sessions fetch detail via `getConveneSessionDetail()`. Synthesis review uses inline confirmation strip pattern (not `window.confirm()`). Active convene sessions (`status === "active" | "synthesizing"`) speed up the main poll cycle to 2s (vs 5s normal); a dedicated `useEffect` also polls the expanded session detail at 2s to stream new round messages.

## TanStack Query

- **Data fetching hooks**: `blueprints/[id]/page.tsx` uses `useBlueprintDetailQueries` hook which bundles four `useQuery` calls (blueprint, queue, insights, convene sessions) with coordinated dynamic polling. `session/[id]/page.tsx` uses `useSessionDetailQueries` hook which bundles four `useQuery` calls (timeline, meta, status, blueprintContext). `blueprints/[id]/nodes/[nodeId]/page.tsx` uses `useNodeDetailQueries` hook which bundles eight `useQuery` calls with dynamic polling.
- **Query key factories**: `blueprintKeys.detail(id)`, `.queue(id)`, `.insights(id)`, `.conveneSessions(id)`. `sessionKeys.timeline(id)`, `.meta(id)`, `.status(id)`, `.blueprintContext(id)`. `nodeDetailKeys.executions(bpId, nodeId)`, `.relatedSessions(...)`, `.suggestions(...)`, `.lastMessage(sessionId)`, `.activeRelatedSession(...)`, `.relatedLastMessage(sessionId)`.
- **Blueprint list**: `useBlueprintListQuery` hook wraps a single `useQuery` with filter-based query keys. Provides `prefetchBlueprintDetail(id)` for hover/focus pre-caching. No polling — invalidated on mutations.
- **Dynamic polling pattern**: `refetchInterval` callback reads query caches via `queryClient.getQueryData()`. All three page hooks use `usePollingInterval(computeFn)` from `lib/polling-utils.ts` which encapsulates the `useRef` + `useCallback` + `createDynamicInterval` safety cap pattern (35 min via `POLL_SAFETY_CAP_MS`). Multi-key invalidation uses `invalidateKeys(queryClient, keys)`.
- **Session run overlay**: Session page uses a `runOverlay` state for optimistic nodes during active runs (user message + thinking indicator) that overlays query data without fighting TanStack Query's cache. `displayNodes = runOverlay ?? rawNodes`.

## Cross-Tab Sync

- **Blueprints**: `useBlueprintBroadcast` hook uses `BroadcastChannel` to notify other open tabs when operations start. Receiving tabs immediately fetch fresh data. New fire-and-forget operations should call `broadcastOperation(type, nodeId)` after the API call resolves.
- **Sessions**: `useSessionBroadcast` hook uses `BroadcastChannel` to notify other tabs when a session run starts/stops. Session page also polls `GET /api/sessions/:id/status` to detect runs from other sources. Shows "Session is running in another tab" warning when disabled by remote run.
- **Session live-polling during runs**: 2s `refetchInterval` during active runs (vs 5s normal). `runOverlay` cleared after `await invalidateTimeline()` on completion to avoid flash.
