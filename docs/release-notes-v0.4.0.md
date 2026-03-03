# ClawUI v0.4.0 Release Notes

ClawUI v0.4.0 is a major release that transforms ClawUI from a Claude Code-specific tool into a **multi-agent session manager**. This release adds support for four agent runtimes, full Windows compatibility, a role-based blueprint system, and an AI-powered insights mechanism.

---

## Highlights

### Multi-Agent Support

ClawUI now supports **4 agent runtimes** as backends:

- **Claude Code** — the original, fully supported runtime
- **Codex CLI** — OpenAI's Codex CLI with session parsing and sandbox-bypass handling
- **OpenClaw** — including Docker multi-directory support with `OPENCLAW_PROFILE`
- **Pi Mono** — lightweight alternative runtime

Switch between runtimes with the `AGENT_TYPE` environment variable. Each runtime has full JSONL parsing, session sync, health analysis, and blueprint execution support. The UI is now agent-neutral — all user-facing text refers to "agent" rather than a specific product name.

### Windows Support

Full cross-platform compatibility across all features:

- All agent runtimes resolve binaries on Windows (`.cmd` shims in `AppData/Roaming/npm/`, `where.exe` PATH lookup)
- Cross-platform path encoding handles backslashes and drive letter colons
- Windows-compatible temp directories and shell execution
- CI matrix now includes **Ubuntu + Windows** on **Node 20 + 22**

### Multi-Role Blueprint System

Assign specialized roles to blueprint nodes for more targeted AI execution:

- **SDE** (blue) — Software Development Engineer tasks
- **QA** (green) — Quality Assurance and testing tasks
- **PM** (purple) — Product Management and planning tasks

Role-aware prompt assembly tailors agent instructions per role. Visual `RoleBadge` and `RoleSelector` components with semantic color coding. When no roles are configured, the system defaults to SDE-only mode (fully backward compatible).

### Blueprint Insights

An automatic insight system that surfaces actionable intelligence during blueprint execution:

- Insights are generated during node execution and evaluation
- Three severity levels: **info**, **warning**, **critical** — each with distinct color coding
- NavBar shows an unread count badge on the Blueprints link
- The **Plan Coordinator** reads unread insights and suggests blueprint graph changes (add/update nodes, dismiss low-value insights)

---

## New Features

- **Multi-agent runtime architecture** with pluggable `AgentRuntime` interface — all blueprint operations (generation, execution, evaluation, enrichment) route through the active runtime
- **Codex CLI integration** with session parsing, `--dangerously-bypass-approvals-and-sandbox` support, and `~/.codex/config.toml` trust requirement handling
- **OpenClaw Docker support** — scan local + Docker instance session directories via `OPENCLAW_PROFILE` environment variable
- **Role registry system** with SDE, QA, and PM built-in roles, `resolveNodeRoles()` and `buildArtifactPrompt()` helpers
- **Role API endpoints** — `GET /api/roles` and `GET /api/roles/:id`
- **Blueprint Insights table** with full API: callbacks, listing, mark-read, mark-all-read, dismiss, and global unread count
- **Plan Coordinator** for insight-driven blueprint graph management
- **Cross-tab state sync** via `BroadcastChannel` — other open tabs auto-refresh when operations start or sessions run
- **Per-session run lock** — prevents concurrent resume processes on the same session (HTTP 409 on conflict)
- **Toast notification system** — lightweight custom implementation with auto-dismiss, progress bar, and success/error variants
- **Dark/light mode toggle** with CSS variable-based theming and semantic color tokens
- **Context-aware tooltips** on all AI-triggered buttons (enrich, reevaluate, smart deps, split)
- **2-line description preview** on blueprint node cards with show more/less toggle
- **Session live-polling** — 2s poll interval during active runs for faster response streaming
- **Dev/stable environment separation** — isolated ports and databases for parallel development and production use
- **Dev redeploy endpoint** — one-click stable redeployment from the dev UI
- **Global status endpoint** — `GET /api/global-status` for aggregate queue info across all blueprints
- **Comprehensive test suite** — 907 backend tests across 22 files + 416 frontend tests across 28 files, including Windows platform coverage

---

## Bug Fixes

- **Auto-finalize blueprint** — blueprints now correctly transition to `done` status when all nodes reach `done` or `skipped` via API callbacks
- **MarkdownContent rendering** — fixed rendering issues in the markdown content component
- **Windows server startup** — `index.ts` adjusted for Windows platform compatibility
- **Windows path handling in routes** — route handlers updated for cross-platform path operations
- **Cross-platform path encoding** — `encodeProjectCwd` now uses `/[/\\]/g` regex and handles drive letter colons
- **Missing logger instance** in `agent-claude.ts`
- **Post-merge type errors, lint errors, and test failures** resolved
- 21 performance and security issues identified and fixed from codebase audit
- 14 additional bugs fixed across backend and frontend

---

## Breaking Changes

None. Existing setups continue working without changes. All new features are additive and backward compatible.

---

## Upgrade Guide

### Install

```bash
npm install -g @clawui/cli@0.4.0
```

Or run directly:

```bash
npx @clawui/cli@0.4.0
```

### New Environment Variables (all optional)

| Variable | Description | Default |
|----------|-------------|---------|
| `AGENT_TYPE` | Agent runtime: `claude`, `openclaw`, `pi`, `codex` | `claude` |
| `OPENCLAW_PATH` | Path to OpenClaw CLI binary | Auto-detected |
| `PI_PATH` | Path to Pi Mono CLI binary | Auto-detected |
| `CODEX_PATH` | Path to Codex CLI binary | Auto-detected |
| `OPENCLAW_PROFILE` | OpenClaw Docker profile name | Unset |
| `CLAWUI_DEV` | Enable dev mode (reuse auth token, dev UI features) | Unset |

### Backward Compatibility

- **Existing setups** continue working unchanged — `AGENT_TYPE` defaults to `claude`
- **Role system** defaults to SDE-only mode when no roles are configured on a blueprint
- **Insights** are generated automatically during execution — no configuration needed
- **Windows users** benefit immediately from cross-platform path resolution

### For Windows Users

ClawUI now fully supports Windows. Agent CLI binaries are auto-detected via `.cmd` shim paths and `where.exe`. Note:

- Ensure your agent CLI (`claude`, `codex`, `openclaw`, or `pi-mono`) is installed globally via npm
- OpenClaw Docker instance session scanning is not available on Windows (Docker Desktop uses WSL2 with different path layout)
- If using `git`, ensure `core.autocrlf` is configured correctly — `.gitattributes` enforces LF line endings

---

## Full Changelog

See [CHANGELOG.md](../CHANGELOG.md) for the complete list of changes.

## Contributors

Thanks to everyone who contributed to this release!
