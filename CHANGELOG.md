# Changelog

All notable changes to ClawUI are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2026-03-05

### Added

- **Autopilot mode for blueprints** — Autonomous agent loop that iterates over blueprint nodes, making decisions about which tool to use next (execute, enrich, split, reevaluate, skip, pause, etc.). Configurable via `execution_mode` (manual/autopilot) and `max_iterations` on each blueprint.
- **Autopilot state snapshot and prompt** — `buildStateSnapshot()` in `backend/src/autopilot.ts` collects node statuses, unused suggestions, undismissed insights, and queue info into a token-efficient prompt for the agent.
- **19-tool decision palette** — `executeDecision()` maps agent decisions to internal functions: execute_node, skip_node, enrich_node, split_node, smart_dependencies, reevaluate_node, reevaluate_all, add_node, update_node_description, set_node_dependencies, reorder_node, dismiss_insight, pause, mark_done, mark_failed, resume_node, create_insight, triage_suggestion, batch_triage_suggestions.
- **Infinite-loop safeguards** — Max iteration limit, per-node attempt tracking, idle-iteration detection with auto-pause, JSON parse retry on malformed agent output.
- **Autopilot memory and reflection** — Per-blueprint `autopilot_memory` column and global memory file. `reflectAndUpdateMemory()` and `globalReflection()` run every N iterations. Tool usage stats (`computeToolUsageStats`) injected into reflection prompt.
- **Autopilot log** — `autopilot_log` SQLite table with paginated `GET /api/blueprints/:id/autopilot-log` endpoint. Stores iteration number, action, target, reasoning, success flag, and error messages.
- **AutopilotToggle component** — Pill-shaped toggle in blueprint header with green pulse dot for active state, disabled when blueprint is draft. Loading spinner during mutation.
- **AutopilotLog component** — Collapsible decision log with 5s polling during active autopilot, descending time order, relative timestamps with absolute tooltip on hover, per-entry and global expand/collapse toggles, duration separators between entries, auto-scroll to newest entry.
- **PauseBanner component** — Alert banner with `role=alert` and `aria-live=assertive` showing pause reason and resume button.
- **Mode-aware Run All** — `runAllNodes` checks `execution_mode` and routes to `runAutopilotLoop` for autopilot blueprints.
- **Startup recovery** — `smartRecoverStaleExecutions` handles autopilot blueprints, pausing with descriptive reason on recovery failure.
- **ARIA accessibility** — `aria-pressed` on toggle, `aria-expanded`/`aria-label` on log header, `role=alert`/`aria-live=assertive` on pause banner.
- **`opacity-disabled` semantic token** — New Tailwind token (value 0.4) standardizing all disabled-state opacity.
- **`plan-operations.ts` extraction** — `enrichNodeInternal`, `reevaluateNodeInternal`, `splitNodeInternal`, `smartDepsInternal`, `reevaluateAllInternal`, and `runWithRelatedSessionDetection` extracted from route handlers for reuse by both `plan-routes.ts` and `autopilot.ts`.

### Fixed

- Hardened `smartRecoverStaleExecutions` error handling for autopilot blueprints.
- Optimized duplicate `getSuggestionsForNode` calls in `buildStateSnapshot`.
- Fixed disabled opacity inconsistencies across codebase (standardized to `opacity-disabled` token).
- Removed dead ternary in Run All button.

## [0.4.0] - 2026-03-02

### Added

- **Multi-agent runtime support** — Claude Code, OpenClaw, Pi Mono, and Codex CLI as selectable backends via `AGENT_TYPE` env var. All blueprint operations (generation, execution, evaluation, enrichment) route through a pluggable `AgentRuntime` interface.
- **Codex CLI agent runtime** — Full integration with OpenAI's Codex CLI, including session parsing, sandbox-bypass flags, and trust requirement handling.
- **OpenClaw Docker multi-directory support** — Scan local + Docker instance session directories with `OPENCLAW_PROFILE`. Shared `seenProjectIds` set prevents stale project cleanup across directories.
- **Multi-role mechanism** — Role registry (`roles/role-registry.ts`) with SDE, QA, and PM built-in roles. Same side-effect import pattern as agent runtimes. Blueprint schema fields `enabled_roles` and `default_role`; node schema `roles` field. `resolveNodeRoles()` and `buildArtifactPrompt()` helpers for role-aware prompt assembly across execution, evaluation, generation, enrichment, reevaluation, split, and smart-deps.
- **Role UI components** — `RoleBadge.tsx`, `RoleSelector.tsx`, and `role-colors.ts` with semantic color mapping (SDE=accent-blue, QA=accent-green, PM=accent-purple, unknown=accent-amber).
- **Role API endpoints** — `GET /api/roles` and `GET /api/roles/:id` in `plan-routes.ts`.
- **Blueprint Insights system** — `blueprint_insights` table in SQLite with API endpoints for insight callbacks, listing, mark-read, mark-all-read, dismiss, and global unread count. Severity levels: info, warning, critical with accent color mapping.
- **NavBar insights badge** — Polls unread insight count alongside global status, shows unread dot badge on the Blueprints nav link.
- **Plan Coordinator** — `plan-coordinator.ts` reads unread insights, builds a coordinator prompt, and instructs the agent to create/update blueprint nodes or dismiss insights.
- **Comprehensive Windows platform support** — All agent runtimes resolve binary paths with `.cmd` shim detection in `AppData/Roaming/npm/` and `.npm-global/`, `where.exe` PATH lookup, and drive-letter colon handling. Centralized resolution in `config.ts` with `process.platform === "win32"` branches.
- **Cross-platform `encodeProjectCwd`** — `cli-utils.ts` uses `/[/\\]/g` regex and handles drive letter colons with `/:/g` for Windows backslash paths.
- **Windows-compatible auth temp directory** — `auth.ts` uses `os.tmpdir()` instead of hardcoded `/tmp` for token file storage.
- **Windows shell execution in `plan-executor.ts`** — Conditional `shell: true` on Windows for `execFile` calls in plan execution.
- **Dark/light mode toggle** — CSS variable-based theming via `next-themes` with semantic color tokens (`bg-primary`, `accent-blue`, etc.).
- **Context-aware tooltips** — All AI-triggered buttons (enrich, reevaluate, smart deps, split) show descriptive tooltips.
- **2-line description preview** — `MacroNodeCard` shows description preview with Show more/less toggle.
- **Cross-tab state sync** — `BroadcastChannel`-based hooks (`useBlueprintBroadcast`, `useSessionBroadcast`) notify other open tabs when operations start or sessions run.
- **Per-session run lock** — In-memory lock prevents concurrent `--resume` processes on the same session file (HTTP 409 on conflict).
- **Toast notifications** — Lightweight custom `ToastProvider` with auto-dismiss, progress bar, and success/error variants. No external library.
- **Optimistic state management** — Enhanced optimistic UI for node execution in `NodeDetailPage` and `MacroNodeCard`.
- **Comprehensive test coverage** — Backend: auth, cli-runner, db, enrichment, jsonl-parser, routes, config, logger, plan-db, plan-executor, plan-generator, plan-routes. Frontend: 28 test files covering RoleBadge, RoleSelector, Toast, useBlueprintBroadcast, useSessionBroadcast, NavBar, MarkdownContent, StatusIndicator, api, AISparkle, MarkdownEditor, SkeletonLoader, ThemeProvider, DependencyGraph, MacroNodeCard, and page-level tests for blueprint detail, node detail, session detail, blueprint list, and blueprint creation.
- **Windows test coverage** — `windows-agent-smoke.test.ts` (25 tests for cross-platform agent binary resolution), `windows-real-platform.test.ts` (22 tests for real Windows platform behavior), and expanded `config.test.ts` coverage (453+ lines for Windows `.cmd` shim resolution, `where.exe` fallback, Unix candidate paths).
- **CI matrix expansion** — `.github/workflows/ci.yml` updated to include Windows in the test matrix.
- **Dev/stable environment separation** — Separate ports and databases for dev (3100/3101, `.clawui-dev/`) vs stable (3000/3001, `.clawui/`). Helper scripts: `start-dev.sh`, `start-stable.sh`, `deploy-stable.sh`.
- **Dev redeploy endpoint** — `POST /api/dev/redeploy` (gated behind `CLAWUI_DEV`) for one-click stable redeployment from dev UI.
- **Global status endpoint** — `GET /api/global-status` for aggregate queue info across all blueprints.

### Changed

- **Plan generator routes through AgentRuntime** — `plan-generator.ts` uses the active runtime instead of hardcoded Claude CLI calls.
- **Agent-neutral UI language** — Frontend uses "agent" instead of "Claude Code" in user-facing text.
- **MacroNodeCard edit buttons** — Moved into `MarkdownEditor` actions prop for cleaner component composition.
- **Session live-polling** — 2s poll interval during active runs (vs 5s normal) for faster response streaming.

### Fixed

- **Auto-finalize blueprint** — Blueprint automatically transitions to `done` status when all nodes reach `done` or `skipped` via API callbacks (`report-status`, `reevaluate-all`).
- **`MarkdownContent.tsx` rendering** — Fixed rendering issues in the markdown content component.
- **`index.ts` Windows compatibility** — Server startup adjustments for Windows platform.
- **`routes.ts` Windows path handling** — Route handlers updated for cross-platform path operations.
- 21 performance and security issues from codebase audit.
- 14 bugs across backend and frontend.
- Missing logger instance in `agent-claude.ts`.
- Path encoding in `encodeProjectCwd` for cross-platform compatibility.
- Post-merge type errors, lint errors, and test failures.

## [0.3.0] - 2025-12-15

### Added

- **Blueprint system** — AI-powered task decomposition, dependency DAG, autonomous execution with evaluation loop.
- **Smart operations** — AI enrich, reevaluate, split, smart-dependencies for nodes.
- **Fire-and-forget execution** — Serial queues per workspace, polling-based status updates.
- **Execution callbacks** — `report-blocker`, `task-summary`, `report-status` API endpoints called by Claude during execution.
- **Session resume & recovery** — Resume failed nodes in existing sessions; recover lost sessions.
- **Run All** — One-click execution of all pending nodes in dependency order.
- **Artifact system** — AI-distilled handoff artifacts passed between nodes.

## [0.2.1] - 2025-11-20

### Fixed

- Global npm install compatibility — replaced `--workspace` flags with `cd` for proper dependency resolution.

## [0.2.0] - 2025-11-15

### Added

- npm CLI package `@clawui/cli` — `npx @clawui/cli` or `npm install -g @clawui/cli && claw-ui`.
- Automated npm publish workflow via GitHub Releases with OIDC Trusted Publishing.

## [0.1.0] - 2025-10-01

### Added

- Initial release — session timeline visualization, interactive continuation, enrichment (star, tag, notes, bookmarks), search and filtering, proactive suggestion buttons.
