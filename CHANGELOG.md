# Changelog

All notable changes to ClawUI are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-03-01

### Added

- **Multi-agent runtime support** — Claude Code, OpenClaw, Pi Mono, and Codex CLI as selectable backends via `AGENT_TYPE` env var. All blueprint operations (generation, execution, evaluation, enrichment) route through a pluggable `AgentRuntime` interface.
- **Codex CLI agent runtime** — Full integration with OpenAI's Codex CLI, including session parsing, sandbox-bypass flags, and trust requirement handling.
- **OpenClaw Docker multi-directory support** — Scan local + Docker instance session directories with `OPENCLAW_PROFILE`. Shared `seenProjectIds` set prevents stale project cleanup across directories.
- **Windows CLI support** — Direct CLI execution without `expect` TTY wrapping on Windows. Includes `.cmd` shim resolution, `where.exe` PATH lookup, cross-platform npm scripts via `cross-env`, and drive-letter path decoding.
- **Dark/light mode toggle** — CSS variable-based theming via `next-themes` with semantic color tokens (`bg-primary`, `accent-blue`, etc.).
- **Context-aware tooltips** — All AI-triggered buttons (enrich, reevaluate, smart deps, split) show descriptive tooltips.
- **2-line description preview** — `MacroNodeCard` shows description preview with Show more/less toggle.
- **Cross-tab state sync** — `BroadcastChannel`-based hooks (`useBlueprintBroadcast`, `useSessionBroadcast`) notify other open tabs when operations start or sessions run.
- **Per-session run lock** — In-memory lock prevents concurrent `--resume` processes on the same session file (HTTP 409 on conflict).
- **Toast notifications** — Lightweight custom `ToastProvider` with auto-dismiss, progress bar, and success/error variants. No external library.
- **Optimistic state management** — Enhanced optimistic UI for node execution in `NodeDetailPage` and `MacroNodeCard`.
- **Comprehensive test coverage** — Backend: auth, cli-runner, db, enrichment, jsonl-parser, routes, config, logger, plan-db, plan-executor, plan-generator, plan-routes. Frontend: StatusIndicator, api, AISparkle, MarkdownEditor, SkeletonLoader, ThemeProvider, DependencyGraph, MacroNodeCard.
- **Dev/stable environment separation** — Separate ports and databases for dev (3100/3101, `.clawui-dev/`) vs stable (3000/3001, `.clawui/`). Helper scripts: `start-dev.sh`, `start-stable.sh`, `deploy-stable.sh`.
- **Dev redeploy endpoint** — `POST /api/dev/redeploy` (gated behind `CLAWUI_DEV`) for one-click stable redeployment from dev UI.
- **Global status endpoint** — `GET /api/global-status` for aggregate queue info across all blueprints.

### Changed

- **Plan generator routes through AgentRuntime** — `plan-generator.ts` uses the active runtime instead of hardcoded Claude CLI calls.
- **Agent-neutral UI language** — Frontend uses "agent" instead of "Claude Code" in user-facing text.
- **MacroNodeCard edit buttons** — Moved into `MarkdownEditor` actions prop for cleaner component composition.
- **Session live-polling** — 2s poll interval during active runs (vs 5s normal) for faster response streaming.

### Fixed

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
