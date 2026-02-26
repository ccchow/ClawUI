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
- **config.ts** — Centralized configuration: exports `CLAUDE_PATH` (auto-detected), `PORT`, `CLAWUI_DB_DIR`, `NEXT_PUBLIC_API_PORT`, `LOG_LEVEL`, `CLAWUI_DEV`. All other modules import from here.
- **logger.ts** — Structured logging: `createLogger('module')` returns `{debug, info, warn, error}`. Format: `[ISO timestamp] [LEVEL] [module] msg`. Controlled by `LOG_LEVEL` env var.
- **db.ts** — SQLite initialization (better-sqlite3), tables: `projects`, `sessions`, `timeline_nodes`. `initDb()`, `syncAll()`, `syncSession()`, `getProjects()`, `getSessions()`, `getTimeline()`, `getLastMessage()` (single-row query for lightweight polling).
- **jsonl-parser.ts** — Parses JSONL into `TimelineNode[]`. Types: user, assistant, tool_use, tool_result. Exports `parseTimeline()`, `parseTimelineRaw()`, `listProjects()`, `listSessions()`, `analyzeSessionHealth()`, `decodeProjectPath()`, and helpers (`cleanContent`, `summarize`, `extractTextContent`).
- **cli-runner.ts** — Wraps `claude --dangerously-skip-permissions --resume <id> -p "prompt"` via `/usr/bin/expect` (TTY required). Appends `---SUGGESTIONS---` suffix for inline suggestions. Exports `validateSessionId()` (alphanumeric + `-_`, max 128 chars) and `setChildPidTracker()` for process lifecycle management.
- **enrichment.ts** — Reads/writes `.clawui/enrichments.json`. `updateSessionMeta()`, `updateNodeMeta()`, `getAllTags()`.
- **app-state.ts** — Reads/writes `.clawui/app-state.json`. `getAppState()`, `updateAppState()`, `trackSessionView()`.
- **auth.ts** — Local auth token generation (`crypto.randomBytes(16)`) and `requireLocalAuth` Express middleware. Writes token to `.clawui/auth-token` for frontend proxy. Uses timing-safe comparison.
- **routes.ts** — Session REST endpoints (12 endpoints).
- **index.ts** — Server entry. Binds to `127.0.0.1`. Calls `initDb()` + `syncAll()` on startup, 30s background sync interval. Prints auth URL on startup. Includes CLI concurrency guard middleware (max 5 in-flight), child process SIGTERM/SIGINT cleanup, and auth token masking for non-TTY output.

**Plan system files:**
- **plan-db.ts** — Plan/Blueprint SQLite tables (`plans`, `plan_nodes`, `node_related_sessions`) + CRUD operations.
- **plan-routes.ts** — Plan REST API endpoints.
- **plan-generator.ts** — AI-powered task decomposition: breaks a high-level task into ordered nodes with dependencies. Supports cross-dependencies to existing nodes (by ID) and uses handoff summaries (output artifacts) instead of raw descriptions for done node context. Exports `runClaudeInteractiveGen()`, `getApiBase()`, `getAuthParam()` used by plan-routes.ts for interactive-mode flows.
- **plan-executor.ts** — Node execution via Claude CLI + artifact generation for cross-node context passing + post-completion evaluation with graph mutations (INSERT_BETWEEN, ADD_SIBLING). Also exports `getGlobalQueueInfo()` for cross-blueprint queue aggregation.

### Frontend (`frontend/`)

Next.js 14, React 18, Tailwind CSS 3, dark/light theme via `next-themes`.

**Routes:**
- `/` — Redirects to `/blueprints` (blueprint-centric landing page)
- `/sessions` — Session list with project selector + filters
- `/session/[id]` — Session detail with timeline, notes, tag editor
- `/blueprints` — Plan/Blueprint list
- `/blueprints/new` — Create new plan
- `/blueprints/[id]` — Plan detail with node cards and dependency flow
- `/blueprints/[id]/nodes/[nodeId]` — Node detail with execution timeline

**Key components:** `SessionList`, `Timeline`, `TimelineNode`, `ToolPairNode`, `MacroNodeCard`, `StatusIndicator`, `SuggestionButtons`, `PromptInput`, `MarkdownContent`, `AISparkle`, `AuthProvider`, `ThemeProvider` (wraps `next-themes`, syncs to backend app-state), `NavBar` (theme toggle via `useTheme()` + global execution indicator via `getGlobalStatus()` polling), `SkeletonLoader` (reusable skeleton with variants: `card`, `list`, `nodeCard`, `nodeDetail`).

**API client:** `lib/api.ts` — all requests use relative `/api/*` paths routed through the Next.js proxy. Auth token read from `localStorage` and attached via `x-clawui-token` header. `next.config.mjs` has rewrites proxying `/api/*` → `http://localhost:3001/api/*`.

## Conventions

- Backend imports use `.js` extensions: `import { foo } from "./bar.js"`
- Frontend uses `@/*` path alias → `./src/*`
- All frontend components are `"use client"`
- **CSS variable theming**: Color tokens use CSS custom properties (`globals.css`) with RGB channel format (`--bg-primary: 10 10 15`) so Tailwind opacity modifiers (`bg-bg-secondary/50`) work. `:root` = light theme, `.dark` = dark theme. `tailwind.config.ts` references them as `rgb(var(--bg-primary) / <alpha-value>)`. `globals.css` uses `rgb(var(--bg-primary))` for direct CSS usage (body, scrollbars, code blocks, focus rings). Theme switching managed by `next-themes` (`ThemeProvider.tsx`): `attribute='class'`, `defaultTheme='dark'`, `storageKey='clawui-theme'`, syncs to backend via `updateAppState({ ui: { theme } })`. `<html>` tag has `suppressHydrationWarning` (required by next-themes). Never use hardcoded dark-mode colors like `bg-[#0a0a0f]` — use semantic tokens (`bg-bg-primary`) that respond to theme. `html` element has `color-scheme: light` (`:root`) and `color-scheme: dark` (`.dark`) for native scrollbar/form control theming.
- Optimistic UI updates for all mutations (star, bookmark, tag, notes)
- `next.config.mjs` (not `.ts`) for Next.js 14 compatibility
- ESLint scoped to `backend/src/**/*.ts` only (config + deps at root: `eslint.config.mjs`, root `package.json`)
- **CI**: `.github/workflows/ci.yml` — runs typecheck, lint, build, tests on push to main and PRs (Node.js 20 + 22). Note: lint has pre-existing warnings (unused vars in test files) — these are not blockers.
- **Flex truncation pattern**: For `truncate` to work in nested flex containers, every flex item in the chain needs `min-w-0`. Card containers wrapping truncated text also need `overflow-hidden`. Title links (`<a>`) need `block` display.
- **AI loading indicators**: AI-triggered buttons (Run, Reevaluate, Smart Enrich, Generate Nodes) use `<AISparkle>` component with `animate-ai-sparkle` (pulse+rotate). Non-AI loading states (page loads, data polling refresh) keep standard `animate-spin` spinners. Custom keyframes defined in `globals.css`.
- **Overlay/modal animations**: `globals.css` provides `animate-fade-in` (opacity transition) and `animate-slide-up` (bottom-sheet entrance). Used for the node switcher overlay — renders as a bottom sheet on mobile (`rounded-t-2xl`, `animate-slide-up`) and a centered modal on desktop (`sm:rounded-2xl`, `sm:animate-fade-in`).
- **Mobile bottom nav pattern**: Fixed bottom navigation bars use `fixed bottom-0 left-0 right-0 z-40 sm:hidden` with `bg-bg-secondary/95 backdrop-blur-md`. Parent content needs `pb-16 sm:pb-0` to prevent overlap. Node detail page uses this for prev/next navigation on mobile.
- **Mobile touch targets**: Interactive elements need 44px minimum touch area on mobile (WCAG 2.5.5). Use responsive padding `py-2.5 sm:py-1.5` to enlarge on mobile while keeping compact desktop sizes. For small inline buttons (star, archive), use invisible tap expansion: `p-2 -m-1 rounded-lg` to grow the hit area without changing visual size.
- **Mobile overflow menu pattern**: When desktop shows multiple icon buttons (`hidden sm:block`), provide a three-dot `...` menu on mobile (`sm:hidden`) with `useRef` + click-outside `useEffect` to close. Dropdown uses `absolute right-0 top-full z-50` positioning relative to the button wrapper.
- **Touch-friendly hover elements**: Elements using `opacity-0 group-hover:opacity-100` are invisible on touch devices. Use `opacity-40 sm:opacity-0 sm:group-hover:opacity-100` to show at reduced opacity on mobile while keeping hover behavior on desktop.
- **Hover popover gap pattern**: For dropdown popovers positioned below a trigger with a visual gap, use `pt-*` (padding) on the outer positioned wrapper instead of `mt-*` (margin) — padding is part of the element's hit area so the mouse stays "inside" while crossing the gap. Combine with a 200ms delayed hide (`setTimeout` in `onMouseLeave`, cleared in `onMouseEnter`) for robustness. See NavBar global activity popover.
- **Responsive list truncation**: When a list (tags, items) is `hidden sm:flex`, show the first item on mobile with a `+N` count badge instead of hiding everything. Use separate mobile (`sm:hidden`) and desktop (`hidden sm:flex`) containers.
- **Button press feedback**: All interactive buttons use `active:scale-[0.98] transition-all` (smaller elements use `0.97`, card-level items use `0.995`). Disabled buttons use `disabled:opacity-40 disabled:cursor-not-allowed` consistently.
- **Inline confirmation pattern**: Never use `window.confirm()` — it breaks the dark theme. Use inline confirmation with state toggle: `confirmingX` state shows a `Yes`/`Cancel` button pair with `animate-fade-in` where the action button was (see blueprints/[id]/page.tsx generate/reevaluate for reference).
- **SVG over emoji icons**: Use inline SVGs instead of emoji for interactive icons (stars, bookmarks, archive, sort, refresh, chevrons). Chevrons use a rotating SVG (`transition-transform rotate-90`) instead of swapping characters.
- **Semantic color tokens**: Always use semantic tokens (`accent-amber`, `accent-green`, `accent-blue`, etc.) for UI elements. Raw Tailwind colors (`yellow-400`, `green-600`, `amber-400`) are only acceptable for contextual data visualization (e.g., failure reason color coding in node detail, tool badge colors in `TimelineNode.tsx`). Data visualization text colors at the `-400` level lack contrast on light backgrounds — use `dark:` variants: `text-emerald-700 dark:text-emerald-400`. Semi-transparent backgrounds (`bg-emerald-500/15`) work on both themes without variants. SVG `stroke` attributes should use `currentColor` + a `text-*` class instead of hardcoded hex (e.g., `stroke="currentColor" className="text-accent-green"` instead of `stroke="#22c55e"`). Hardcoded hex in `DependencyGraph.tsx` is acceptable (SVG canvas rendering context where CSS variables can't be used).
- **Page fade-in**: All main page root `<div>` elements use `animate-fade-in` class for subtle 0.2s opacity transition on navigation.
- **ARIA labels on icon-only buttons**: Every `<button>` that shows only an icon (no visible text) must have `aria-label`. Dynamic labels for toggles (e.g., `aria-label={starred ? "Unstar session" : "Star session"}`).
- **`aria-expanded` on collapse controls**: All expand/collapse toggles (card sections, time groups, older nodes, collapsible content) must include `aria-expanded={isExpanded}`.
- **Focus trapping in overlays**: Modal overlays (node switcher) use `role="dialog"` + `aria-modal="true"` + `aria-label`. A `useEffect` traps Tab key within the dialog and closes on Escape, returning focus to the trigger button via a ref.
- **`focus-visible` global styles**: `globals.css` provides `*:focus-visible { outline: 2px solid rgb(var(--accent-blue)); outline-offset: 2px; }` for keyboard navigation (theme-aware via CSS variable). No `:focus` styles — only `:focus-visible` to avoid affecting mouse/touch users.
- **StatusIndicator accessibility**: Uses `role="img"` and `aria-label={label}` with full status label mapping (Pending, Running, Completed, Failed, Blocked, Skipped, Waiting in queue, Draft, Approved, Paused).
- **Color contrast**: `text-muted` dark value is `112 128 150` (~#708096) for ~4.9:1 against dark `bg-primary`. Light value is `95 110 132` for ~5.2:1 against white and ~4.7:1 against `bg-tertiary`, meeting WCAG AA. Light-mode accent colors are darkened vs dark theme for text contrast: blue `37 99 235` (5.2:1), purple `124 58 237` (5.7:1), green `21 128 61` (5.0:1), amber `180 83 9` (5.0:1), red `220 38 38` (4.8:1) — all pass AA on white. Dark theme keeps brighter accent values for visibility on dark backgrounds. `text-white` on accent button backgrounds is acceptable (buttons use large enough text); for loading spinners inside buttons, use `border-current` instead of `border-white` to inherit the button's text color.
- **Node numbering**: Always use `node.order + 1` (DB `order` field) for display numbers — in `MacroNodeCard`, dependency picker chips, node switcher, and bottom nav. Never use array index for numbering.
- **Filter state persistence**: Blueprint pages persist filter state to URL search params via `window.history.replaceState` (no history pollution) + `sessionStorage` for cross-page back links. Blueprints list: `?status=running&archived=1` (key: `clawui:blueprints-filters`). Blueprint detail: `?filter=failed&sort=manual&order=oldest` (key: `clawui:blueprint-${id}-filters`). Back links (`blueprintsBackHref`, `blueprintBackHref`) read from sessionStorage to reconstruct the parent page's filter URL. Default values are omitted from URL params.
- **Skipped node filtering**: After a node is split, its status becomes `skipped`. Dependency picker excludes skipped nodes unless already selected (shown dimmed with "(split)" label). Node switcher overlay excludes skipped nodes entirely. Input artifact source links for skipped nodes render as non-clickable text with "(split)" indicator.
- **Session ID validation**: All endpoints accepting session IDs must call `validateSessionId()` from `cli-runner.ts` before passing to shell commands. Prevents Tcl injection via `expect` script interpolation. Regex: `/^[a-zA-Z0-9_-]{1,128}$/`.
- **Error response sanitization**: Never expose internal error messages in API responses. Use a `safeError()` helper that returns "Internal server error" by default, only passing through known-safe messages (e.g., "Invalid session ID", "Missing or empty"). Log the real error server-side via `log.error()`.
- **Dev-only endpoint gating**: Endpoints like `/api/dev/redeploy` must check `CLAWUI_DEV` config and return 403 if not in dev mode. Never expose admin/dev endpoints in production.
- **CLI concurrency guard**: `index.ts` middleware caps in-flight CLI-spawning requests at 5 (`MAX_CONCURRENT_CLI`). Returns 429 when exceeded. Applied to session run and blueprint node run/resume endpoints.
- **Child process cleanup**: `index.ts` tracks PIDs of spawned CLI processes via `setChildPidTracker()`. SIGTERM/SIGINT handlers kill all tracked children before exit. `cli-runner.ts` calls `trackPid`/`untrackPid` around `execFile` lifecycle.
- **Batch DB queries over N+1**: `getNodesForBlueprint()` in `plan-db.ts` batch-loads all artifacts and executions in 3 queries, then partitions in-memory. Avoid per-node queries in loops.
- **`generateArtifact()` try/catch**: All `generateArtifact()` calls in `plan-executor.ts` are wrapped in try/catch to prevent artifact generation failures from overwriting a node's "done" status. Has a 5-minute `withTimeout()` safety net.
- **`parseTimelineRaw()` content passing**: Accepts optional `rawContent` param to avoid re-reading JSONL files already loaded by callers (e.g., `syncTimeline` in `db.ts`).
- **`analyzeSessionHealth()` filepath param**: Accepts optional `knownFilePath` to skip redundant `findSessionFile()` when caller already has the path.
- **`trackSessionView()` debounce**: Deduplicates disk writes — skips if same session tracked within 10s (`TRACK_DEBOUNCE_MS`).
- **`decodeProjectPath()` memoization**: Results cached in a `Map<string, string | undefined>` since filesystem-aware backtracking is expensive and paths are immutable.

## Key Design Decisions

- **expect for TTY**: Claude Code requires a TTY — `node-pty` fails on Node 25, so we use `expect` (path auto-detected via `EXPECT_PATH` config) with `set stty_init "columns 2000"`
- **Inline suggestions**: One API call per prompt — suffix asks Claude to append `---SUGGESTIONS---` + JSON
- **SQLite for index**: `better-sqlite3` sync API, incremental updates via file mtime+size comparison
- **JSON for small data**: Enrichments and app state are JSON files (small, readable, diffable)
- **Layer 1 read-only**: Never write to Claude Code's JSONL files
- **MCP tool detection**: MCP tools use naming convention `mcp__serverName__toolName` (double underscores). Frontend Timeline filters MCP tools separately from built-in tools using `toolName.startsWith("mcp__")`.
- **Plans are Layer 2 extensions**: Plan data lives in the same SQLite db, not a new layer. Plans are user-created source of truth (unlike sessions which are derived from JSONL).
- **Artifacts for cross-node context**: When a plan node completes, an artifact (summary) is generated and passed as context to downstream dependent nodes. Artifact prompt requires `**What was done:**` marker; post-processing strips preamble before this marker to keep only completed-work content.
- **MarkdownEditor base64 images**: Clipboard-pasted images are converted to `data:image/...` data URLs and inserted inline in the markdown text. No backend upload endpoint — simplifies architecture but increases description field size in SQLite. `MarkdownContent` renderer passes data URLs through `resolveImageUrl` untouched.
- **API callbacks for execution signals**: `buildNodePrompt()` instructs Claude to call three endpoints via curl: `report-blocker` (with `{type, description, suggestion}`), `task-summary` (with `{summary}`), and `report-status` (with `{status: "done"|"failed"|"blocked", reason?}`). Data stored in `blocker_info`/`task_summary`/`reported_status`+`reported_reason` columns on `node_executions`. `report-status` is the **authoritative** execution result — when present, `executeNodeInternal()` uses it directly instead of inferring status from output length/blocker detection. When `reported_status` is null (no callback received), falls back to legacy inference logic for backward compatibility. Legacy marker parsing (`===EXECUTION_BLOCKER===`, `===TASK_COMPLETE===`/`===END_TASK===` via `extractTaskCompleteSummary()`) kept as secondary fallback. `buildNodePrompt()` requires `executionId` param — execution record must be created before prompt is built.
- **Two-tier dependency validation**: Queue-time check (`/run` endpoint in plan-routes.ts) is lenient — only blocks when deps are `failed` or `blocked`. Running/queued/pending/done/skipped deps all allow queueing. Execution-time check (`executeNodeInternal` in plan-executor.ts) is strict — deps must be `done` or `skipped`. This lets users queue nodes ahead of running dependencies; if deps aren't complete by execution time, the node fails.
- **Fire-and-forget execution**: Node run/reevaluate use serial queues per blueprint (`enqueueBlueprintTask`). Endpoints return `{status:"queued"}` immediately; frontend polls.
- **Global execution indicator**: `GET /api/global-status` aggregates `blueprintRunning` + `blueprintPendingTasks` across all blueprints, enriched with `nodeTitle`, `blueprintTitle`, and `sessionId` from SQLite. `blueprintRunningNodeId` map tracks which node is currently executing per blueprint. NavBar polls with adaptive intervals (5s active, 10s idle). Hover popover lists each task with node title (links to node detail), blueprint title, type badge, and a separate "session" link (when sessionId available). Two navigation targets per row: node title → node detail, session chip → session timeline. Click on sparkle icon navigates to first active task's session (if available), then node detail, then blueprint.
- **Background session detection**: `executeNodeInternal()` starts a 3s polling interval that calls `detectNewSession()` while `runClaude()` blocks. Updates the execution record with `sessionId` immediately when found, so the frontend can show the session link during execution (not just after completion).
- **Batch reevaluate**: `reevaluate-all` runs Claude Code in interactive mode (`runClaudeInteractive` — no `--output-format text`). Claude reads actual source code, then updates all nodes via a single `PUT /api/blueprints/:id/nodes/batch` call. No output parsing needed — Claude directly mutates the DB via API.
- **Blueprint node grouping**: Collapsible "older nodes" in `blueprints/[id]/page.tsx` only collapses `done`/`skipped` nodes — active states (pending, running, failed, blocked, queued) are never hidden. When expanded, renders all `displayNodes` in original order (not split top+older) so `computeDepLayout` dependency lines stay correct.
- **Smart node sorting**: `blueprints/[id]/page.tsx` defaults to `smartSort=true` which uses two-tier ordering: first active tier (running/queued/failed/blocked/pending) above completed tier (done/skipped). Within the active tier, sorts by dependency depth descending (leaf nodes on top, root nodes at bottom), then status priority, then `createdAt` descending. Completed tier skips depth — sorts by status priority then `createdAt` descending only. Depth is computed via `useMemo` DAG traversal with cycle guard. Toggleable via UI button; when off, falls back to `reverseOrder` (newest/oldest first). Smart sort only applies when `statusFilter === "all"`.
- **RunAll pre-queuing**: `executeAllNodes()` pre-marks all eligible pending nodes as `queued` before the execution loop so the frontend shows the full plan. `executeNode()` skips re-queuing if the node is already `queued` to avoid duplicate pending tasks. On failure, remaining pre-queued nodes are reset to `pending`. `executeNextNode()` picks both `pending` and `queued` nodes.
- **Queue position + unqueue**: `QueueItem` has optional `nodeId` for queue item identification. `removeQueuedTask(blueprintId, nodeId)` (plan-executor.ts) splices from in-memory `blueprintQueues`. Unqueue endpoint (`POST .../nodes/:nodeId/unqueue`) removes from both in-memory queue and reverts SQLite status to `pending`. Queue position derived from `pendingTasks.filter(t => t.type === "run")` array index — only counts run tasks, not reevaluate/enrich/generate.
- **Localhost-only binding**: Both frontend and backend bind to `127.0.0.1`. External access is via `tailscale serve` which proxies to localhost. Never bind to `0.0.0.0`.
- **Local Auth Token**: Backend generates `crypto.randomBytes(16)` hex token on startup, writes to `.clawui/auth-token`. All `/api/*` requests require `x-clawui-token` header or `?auth=` query param. Frontend reads token from `localStorage` (seeded via `?auth=` URL param on first visit). Token rotates on every backend restart.
- **Post-completion evaluation**: After a node completes and its handoff artifact is generated, `evaluateNodeCompletion()` runs Claude in interactive mode (`runClaudeInteractiveGen`) to assess whether the work is truly complete. Claude calls `POST /api/blueprints/:id/nodes/:nodeId/evaluation-callback` directly with its assessment — no output parsing needed. Three outcomes: `COMPLETE` (no action), `NEEDS_REFINEMENT` (INSERT_BETWEEN: creates follow-up node, rewires dependents to depend on it instead), `HAS_BLOCKER` (ADD_SIBLING: creates blocked sibling inheriting predecessors, adds it as dependency for downstream nodes). `applyGraphMutations()` (exported from plan-executor.ts) handles the graph rewiring. Evaluation failures are logged but don't affect node's done status. New nodes created mid-execution are automatically picked up by `executeNextNode()` in run-all flows since it re-reads from DB each iteration.
- **Graph mutation API**: `POST /api/blueprints/:id/nodes/:nodeId/evaluate` triggers manual evaluation of a completed node. Fire-and-forget via blueprint queue. Evaluation result is applied via the `evaluation-callback` endpoint (Claude calls it directly in interactive mode).
- **Interactive mode for enrich/reevaluate**: `enrich-node` and single-node `reevaluate` use `runClaudeInteractiveGen` (interactive mode with bash access). When enriching an existing node (`nodeId` provided in request body), Claude calls `PUT /api/blueprints/:id/nodes/:nodeId` via curl directly — same as reevaluate — so the DB write survives page closure. For new node creation (Smart Create, no `nodeId`), falls back to temp file approach. Frontend passes `nodeId` from both `MacroNodeCard` and `nodes/[nodeId]/page.tsx`.
- **Generate is additive-only**: `generatePlan()` only adds new nodes — it never modifies or removes existing pending/failed nodes. Pending nodes appear in the prompt as read-only context (to avoid duplicates), but the response JSON only contains an `add` array. Any `remove`/`update` keys in the response are ignored defensively. Dependencies in the `add` array support mixed formats: string node IDs for existing nodes + integer indices for new nodes in the same batch. Node descriptions are stripped from prompt context to avoid base64 image bloat. Done nodes show title + handoff summary (output artifact, truncated to 300 chars); nodes without artifacts show title only. Pending nodes show title only. Reevaluate-all (`nodesContext`) also strips descriptions — completed context comes solely from the `completedSummaries` section (handoff artifacts). `getArtifactsForNode(nodeId, "output")` fetches handoff summaries.
- **Session resume for failed nodes**: `resumeNodeSession()` (plan-executor.ts) resumes a failed execution's existing Claude session via `runClaudeResume()` (uses `--resume ${sessionId}` flag) instead of starting fresh with `buildNodePrompt()`. Sends only a lightweight continuation prompt since the resumed session already has full context. Creates a `continuation` type execution record. Post-execution flow (artifact generation, evaluation) runs normally. Frontend shows a play button next to the session link chip for failed executions with a sessionId.
- **Server restart recovery**: `smartRecoverStaleExecutions()` (plan-executor.ts) checks CLI process liveness (`cli_pid` + `process.kill(pid, 0)`) and session file mtime before marking executions as failed. Still-alive executions get a background monitor (10s interval, 45min timeout). `recoverStaleExecutions(skipIds)` only marks truly-dead executions as failed. Also checks recently-failed "server restart" executions (10min window) and reverts them if their session is still active. `requeueOrphanedNodes()` re-enqueues nodes left in "queued" status (in-memory queue lost on restart). `recover-session` endpoint finds orphaned JSONL files and links them back.
- **Node split (AI decomposition)**: `POST /api/blueprints/:id/nodes/:nodeId/split` decomposes a pending node into 2-3 sub-nodes via `runClaudeInteractiveGen`. Claude executes curl calls in sequence: (1) `batch-create` sub-nodes (first inherits original's deps, subsequent chain sequentially), (2) rewire downstream dependents to point to the last sub-node, (3) mark original as `skipped`. Fire-and-forget via `enqueueBlueprintTask` with `"split"` pending task type. Frontend detects completion when node status becomes `skipped` and navigates to the blueprint page.

- **Smart Dependencies (AI auto-pick)**: `POST /api/blueprints/:id/nodes/:nodeId/smart-dependencies` uses `runClaudeInteractiveGen` + curl `PUT` callback pattern (same as enrich-node for existing nodes). Claude analyzes node titles/descriptions to pick 0-3 logical dependencies. Fire-and-forget via `enqueueBlueprintTask` with `"smart_deps"` pending task type. Frontend polls for updated dependencies. Sparkle button only shows for pending/failed/blocked nodes with non-skipped siblings available.
- **Related sessions tracking**: `node_related_sessions` table stores sessions from interactive operations (enrich, reevaluate, split, evaluate, reevaluate_all, smart_deps). Uses `detectNewSession()` pattern — record `beforeTimestamp` before CLI call, detect session after call returns. `captureRelatedSession()` helper in plan-routes.ts handles detection + DB write. API: `GET /api/blueprints/:id/nodes/:nodeId/related-sessions`. Frontend shows collapsible "Related Sessions" section on node detail page below Execution History.
- **MCP tools in node executions**: MCP tools (Playwright, Serena, Context7, Linear) are "deferred tools" in Claude Code — available but require `ToolSearch` to discover and load. Plugins are loaded (startup hooks fire in `-p` mode), but the model won't search for them unless prompted. `buildNodePrompt()` includes a hint about `ToolSearch` and available MCP tools so the model uses them when built-in tools are insufficient.
- **Execution failure classification**: `classifyFailure()` and `classifyHungFailure()` (plan-executor.ts) analyze CLI errors, output, and JSONL session data to categorize failures as `timeout`, `context_exhausted`, `output_token_limit`, `hung`, or `error`. Stored in `failure_reason` column on `node_executions`. `analyzeSessionHealth()` (jsonl-parser.ts) reads JSONL for `compact_boundary` events (context compaction at ~167K tokens), `isApiErrorMessage` entries (output token limit, context_length_exceeded, overloaded errors), peak token usage, and post-compaction activity. Returns `contextPressure` level (none/moderate/high/critical), `endedAfterCompaction` flag, and `responsesAfterLastCompact` count. `storeContextHealth()` persists these metrics (`compact_count`, `peak_tokens`, `context_pressure` columns) on execution records via a `finally` block in both `executeNodeInternal` and `resumeNodeSession`. Frontend shows color-coded failure reasons, context health metrics (compaction count, peak tokens), context pressure warnings on successful executions, and actionable guidance for context-related failures.

## Gotchas

- **Incremental DB migrations**: New columns on existing tables use `PRAGMA table_info()` + `ALTER TABLE ADD COLUMN`. New tables use `SELECT name FROM sqlite_master WHERE type='table' AND name='...'` check before `CREATE TABLE IF NOT EXISTS`. Both patterns applied in `initPlanTables()` in `plan-db.ts`. Bumping `CURRENT_SCHEMA_VERSION` triggers full table recreation — only for structural changes, not additive columns/tables.
- **CLI output echo**: Claude CLI echoes the full prompt before the AI response. Greedy regex `\{[\s\S]*\}` captures JSON templates from the echoed prompt, not the AI's response. Use depth-counting brace extraction, last-to-first (see `extractTitleDescJson` in `plan-routes.ts`).
- **Array extraction**: Same echo problem applies to `[...]` arrays. `extractReevaluateArray` in `plan-routes.ts` uses `[`/`]` depth counting with last-to-first fallback, then tries individual `{...}` objects as secondary fallback.
- **`syncSession()` re-indexes**: Calling `syncSession()` re-parses JSONL into SQLite, updating metadata timestamps — sessions appear "recently updated" in the UI. Avoid in recovery/background paths.
- **In-memory queue vs SQLite**: `blueprintQueues`/`blueprintPendingTasks` in `plan-executor.ts` are in-memory only. Node `status` in SQLite persists across restarts, but the queue doesn't. `requeueOrphanedNodes()` bridges this gap on startup. Frontend must fetch queue status (`getQueueStatus`) on initial page load, not just during polling.
- **`stripEchoedPrompt` is deprecated**: No longer called from production code paths (replaced by API callback pattern). Kept in plan-executor.ts with eslint-disable for potential backward compat. Tests maintain a local copy for unit testing the algorithm.
- **`execFile` callback TDZ**: `const child = execFile(...)` — mock tests call the callback synchronously, before `child` is assigned (temporal dead zone). Never reference `child` inside the callback; use a separate `let` variable assigned after the call.
- **CLI runner error handling**: `runClaudeInteractive` and `runClaude` must reject on `execFile` errors (especially timeouts). Never silently resolve — callers depend on rejection to clean up pending tasks and stop frontend polling. `withTimeout()` in `plan-executor.ts` provides an additional safety net for wrapping long-running promises.
- **Project path encoding is ambiguous**: Claude CLI encodes project paths by replacing both `/` and `.` (leading dot) with `-`, so hyphens in directory names are indistinguishable from path separators (e.g., `-Users-foo-my-project` could be `/Users/foo/my/project` or `/Users/foo/my-project`). `decodeProjectPath()` in `jsonl-parser.ts` uses filesystem-aware backtracking to disambiguate. Never use naive `replace(/-/g, "/")` for paths that will be used as `cwd` — it causes `ENOENT` when directory names contain hyphens or dots. The `db.ts` naive decode is acceptable for display-only project names.
- **`execFile` ENOENT is misleading**: Node.js `execFile` reports `spawn <binary> ENOENT` when the `cwd` directory doesn't exist, not just when the binary is missing. Always validate `cwd` with `existsSync` before passing to `execFile`.
- **Auth token on restart**: Token rotates on every backend restart. Phone/tablet users must re-copy the secure URL from terminal output. The old `?auth=` bookmark will 403.
- **Evaluation uses interactive mode**: `evaluateNodeCompletion()` runs Claude in interactive mode with a callback URL. Claude calls `POST /api/blueprints/:id/nodes/:nodeId/evaluation-callback` directly — no output parsing or echo-stripping needed. The callback endpoint validates the JSON body and calls `applyGraphMutations()` to create refinement/blocker nodes.
- **INSERT_BETWEEN artifact continuity**: After rewiring dependents from completedNode to refinementNode, the completedNode's artifacts (with `targetNodeId` pointing to original dependents) become orphaned. This is correct — refinementNode gets completedNode's artifacts via `getArtifactsForNode(depId, "output")`, and dependents later get refinementNode's artifacts.
- **Pending task cleanup**: Fire-and-forget queue tasks (`enqueueBlueprintTask`) that add `pendingTasks` must use `finally` blocks to guarantee `removePendingTask()` runs on success, error, or timeout. If pending tasks leak, frontend polling runs indefinitely (capped at 35min safety limit).
- **Post-execution pipeline is async after status change**: `executeNodeInternal()` marks node as `done` BEFORE `generateArtifact()` and `evaluateNodeCompletion()` run. Node detail page uses `postCompletionPolls` countdown (4 cycles × 5s = 20s) triggered by detecting `running`/`queued` → terminal status transition via `prevStatusRef`, so artifacts and evaluation results appear without manual refresh.
- **Session page poll dedup**: `fetchNodes` in `session/[id]/page.tsx` uses `pollFingerprintRef` (`${count}-${lastNodeId}`) to skip updates when nothing changed. This detects both new nodes (count changes) and content replacement (synthetic optimistic → real parsed nodes with different IDs but same count). After `handleRun` success, the code fetches the real parsed timeline via `getTimeline()`. On error, the fingerprint is reset to `""` so the next poll replaces synthetic nodes with real data.
- **Backend `process.cwd()`**: When running the backend (dev or stable), cwd is `backend/`. To reach project root or `scripts/`, use `join(process.cwd(), "..")`.
- **`CLAUDECODE` env var stripping**: All CLI spawning functions (`runClaude`, `runClaudeInteractive`, `runClaudeResume` in plan-executor.ts, cli-runner.ts, plan-generator.ts) use `cleanEnvForClaude()` which strips `CLAUDECODE` from the environment. This prevents the "cannot be launched inside another Claude Code session" error if the backend was started from within a Claude Code session (e.g., via dev/redeploy or manual `npm run dev` from inside Claude).
- **Blueprint `projectCwd` validation**: `POST /api/blueprints` validates `projectCwd` against the real filesystem (`existsSync`, `isDirectory`, CLAUDE.md presence). Backend tests using fake paths like `/test` must mock `node:fs` to pass validation.
- **JSONL session structure**: Each line is a JSON object with `type` (user/assistant/system/progress/queue-operation), `message.content` (array of blocks), `message.usage` (token counts), `isApiErrorMessage` flag. System messages have `subtype`: `compact_boundary` (context compaction with `compactMetadata.preTokens`), `turn_duration`, `stop_hook_summary`, `local_command`. Auto-compaction triggers at ~167K-174K tokens. API errors show `{input_tokens: 0, output_tokens: 0}` with error text in content.
- **Fire-and-forget button loading state**: AI-triggered buttons that use `enqueueBlueprintTask` must NOT use promise-based `finally { setLoading(false) }` — the API returns immediately so loading clears before work starts. Instead, use an optimistic flag (`setOptimistic(true)` on click) combined with a derived loading state from `pendingTasks` polling (e.g., `const loading = optimistic || pendingTasks.some(t => t.type === "my_type")`). Clear optimistic flag once polling confirms the task exists. Call `loadData()` after the API call to trigger immediate polling.
- **New exports need mock updates**: When adding new exports to a module (e.g., `validateSessionId` to `cli-runner.ts`), all `vi.mock()` blocks for that module in test files must include the new export — Vitest throws "[vitest] No 'exportName' export is defined on the mock" otherwise.

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
