# Backend Architecture

Detailed backend file descriptions for ClawUI. Referenced from [CLAUDE.md](../CLAUDE.md).

## Core Files

- **config.ts** — Centralized configuration: exports `CLAUDE_PATH` (auto-detected), `PORT`, `CLAWUI_DB_DIR`, `NEXT_PUBLIC_API_PORT`, `LOG_LEVEL`, `CLAWUI_DEV`. All other modules import from here.
- **logger.ts** — Structured logging: `createLogger('module')` returns `{debug, info, warn, error}`. Format: `[ISO timestamp] [LEVEL] [module] msg`. Controlled by `LOG_LEVEL` env var.
- **db.ts** — SQLite initialization (better-sqlite3), tables: `projects`, `sessions`, `timeline_nodes` (all with `agent_type` column). Multi-agent sync: `syncAll()` iterates all registered runtimes via `getRegisteredRuntimes()`, dispatching to agent-specific directory scanners. `syncSession()` accepts optional `agentType` param. `getProjects(agentType?)` and `getSessions(projectId, agentType?)` support agent filtering. `getSessionAgentType()` looks up agent type for routing to correct health analyzer. `getAvailableAgents()` returns runtime info with session counts for `/api/agents`. Project ID namespacing: Claude IDs are unprefixed (backward compat), Pi prefixed `pi:<dirName>`, OpenClaw prefixed `openclaw:<encodedCwd>`. Also exports `getTimeline()`, `getLastMessage()` (single-row query for lightweight polling).
- **jsonl-parser.ts** — Parses JSONL into `TimelineNode[]`. Types: user, assistant, tool_use, tool_result. Exports `parseTimeline()`, `parseTimelineRaw()`, `listProjects()`, `listSessions()`, `analyzeSessionHealth()`, `decodeProjectPath()`, and helpers (`cleanContent`, `summarize`, `extractTextContent`).
- **cli-runner.ts** — Wraps `claude --dangerously-skip-permissions --resume <id> -p "prompt"` via `/usr/bin/expect` (TTY required). Appends `---SUGGESTIONS---` suffix for inline suggestions. Exports `validateSessionId()` (alphanumeric + `-_`, max 128 chars) and `setChildPidTracker()` for process lifecycle management.
- **enrichment.ts** — Reads/writes `.clawui/enrichments.json`. `updateSessionMeta()`, `updateNodeMeta()`, `getAllTags()`.
- **app-state.ts** — Reads/writes `.clawui/app-state.json`. `getAppState()`, `updateAppState()`, `trackSessionView()`.
- **auth.ts** — Local auth token generation (`crypto.randomBytes(16)`) and `requireLocalAuth` Express middleware. Writes token to `.clawui/auth-token` for frontend proxy. Uses timing-safe comparison.
- **routes.ts** — Session REST endpoints (13 endpoints). `GET /api/projects` and `GET /api/projects/:id/sessions` accept `?agent=claude|openclaw|pi|all` filter. `GET /api/agents` returns available agent runtimes with session counts. `GET /api/sessions/:id/health` dispatches to correct analyzer based on session's `agent_type`.
- **index.ts** — Server entry. Binds to `127.0.0.1`. Calls `initDb()` + `syncAll()` on startup, 30s background sync interval. Prints auth URL on startup. Includes CLI concurrency guard middleware (max 5 in-flight), child process SIGTERM/SIGINT cleanup, and auth token masking for non-TTY output.

## Agent Runtime Files

- **agent-runtime.ts** — `AgentRuntime` interface + registry pattern (`registerRuntime`/`getActiveRuntime`/`getRegisteredRuntimes` factory). Defines `runSession()`, `runSessionInteractive()`, `resumeSession()`, `detectNewSession()`, `encodeProjectCwd()`, `getSessionsDir()`. `AGENT_TYPE` env var selects runtime (default: `claude`). `getRegisteredRuntimes()` returns all registered runtimes for multi-agent discovery in `db.ts`.
- **agent-claude.ts** — `ClaudeAgentRuntime implements AgentRuntime`. All Claude-specific CLI logic (expect scripts, TTY handling, ANSI stripping, env cleaning). Self-registers via side-effect import. Also exports `runClaudeTextMode()` and `runClaudeInteractiveMode()` for plan-generator.ts.
- **agent-pimono.ts** — `PiMonoAgentRuntime implements AgentRuntime`. Pi Mono CLI invocation via `-p` print mode (no TTY/expect needed). Sessions in `~/.pi/agent/sessions/--<encoded-cwd>--/`. CWD encoding: `/Users/foo/bar` → `--Users-foo-bar--` (double-dash delimited). Exports `parsePiSessionFile()` for JSONL→TimelineNode[] conversion (handles version 3 tree-structured messages with id/parentId linearization) and `analyzePiSessionHealth()` for failure/context analysis. Self-registers via side-effect import.
- **agent-openclaw.ts** — `OpenClawAgentRuntime implements AgentRuntime`. OpenClaw CLI invocation via `openclaw agent --session-id <id> --message <prompt>` (no TTY/expect needed — clean JSON output). `--json` flag for structured output, omitted for interactive mode. Sessions in `~/.openclaw/agents/<agent-name>/sessions/*.jsonl`. Session discovery scans all agent subdirs and matches by `cwd` field in session header. Exports `parseOpenClawSessionFile()` for JSONL→TimelineNode[] conversion and `analyzeOpenClawSessionHealth()` for failure/context analysis. Self-registers via side-effect import.

## OpenClaw Agent Runtime (Detailed)

The OpenClaw agent runtime (`agent-openclaw.ts`) is the newest agent backend. Unlike Claude Code (which requires TTY/expect for CLI interaction), OpenClaw outputs clean JSON — no terminal emulation needed.

### CLI Invocation

```
openclaw agent --session-id <uuid> --message "<prompt>" [--json]
```

- **Text mode** (`runSession`): `--json` flag produces structured JSON output: `{ status, session_id, message: { role, content, usage } }`. The `extractOutput()` method parses this to extract the text content.
- **Interactive mode** (`runSessionInteractive`): No `--json` flag. Used for tasks where the agent calls API endpoints via curl (plan execution callbacks). Raw stdout returned.
- **Resume** (`resumeSession`): Same `--session-id` flag continues an existing session. No separate `--resume` flag needed (unlike Claude Code).
- **Timeout**: 30-minute `EXEC_TIMEOUT` per invocation, 10MB max buffer.
- **Environment**: `cleanEnv()` strips `CLAUDECODE` and `OPENCLAW_SESSION` to prevent session nesting.

### Binary Resolution

Priority order (via `resolveOpenClawPath()`):
1. `OPENCLAW_PATH` env var
2. `~/.local/bin/openclaw`
3. `/usr/local/bin/openclaw`
4. `which openclaw` (PATH lookup)
5. Bare `"openclaw"` fallback (fails at runtime if not in PATH)

### Session JSONL Format

Sessions stored in `~/.openclaw/agents/<agent-name>/sessions/<uuid>.jsonl`. Each line is a JSON event:

| Event Type | Key Fields | Timeline Mapping |
|---|---|---|
| `session` | `version`, `cwd`, `timestamp`, `agentName` | Skipped (header metadata) |
| `message` | `message.role`, `message.content`, `message.usage` | `user` or `assistant` node; tool_use blocks extracted from content arrays |
| `tool_call` | `toolName`, `toolCallId`, `input`, `output`, `isError` | `tool_use` + `tool_result` node pair |
| `skill_call` | `skillName`, `toolCallId`, `input`, `output`, `isError` | Same as `tool_call` (unified handling) |
| `error` | `message`, `isApiError` | `error` node |
| `model_change` | `model` | Skipped (metadata) |
| `thinking_level_change` | `level` | Skipped (metadata) |
| `compaction` / `compact_boundary` | `preTokens` | Skipped (tracked by health analysis) |

**Content blocks** in message events can be:
- `{ type: "text", text: "..." }` — rendered as assistant text
- `{ type: "thinking", text: "..." }` — skipped in timeline (internal reasoning)
- `{ type: "tool_use", toolCallId, toolName, input }` — extracted as `tool_use` nodes

### Session Discovery & Project Mapping

OpenClaw organizes sessions by agent name, not by project path (unlike Claude's `~/.claude/projects/<encoded-path>/` structure). Discovery works by:

1. `getSessionsDir()` → `~/.openclaw/agents/`
2. Scan all `<agent-name>/sessions/` subdirectories
3. For each `.jsonl` file, read the first line (session header) to get the `cwd` field
4. Match `cwd` against the target project path

**Project ID namespacing**: `openclaw:<encodedCwd>` where encoding is `cwd.replace(/\//g, "-").replace(/^-/, "")`. Example: `/Users/foo/project` → `openclaw:Users-foo-project`.

**`detectNewSession()`** scans all agent dirs for files modified after a given timestamp, matching by header `cwd`. Returns the newest matching session ID.

**`findSessionFile()`** searches all agent dirs for `<sessionId>.jsonl` (no project-scoping needed since IDs are UUIDs).

### Session Health Analysis

`analyzeOpenClawSessionHealth()` reads the full JSONL and tracks:

- **Compaction events**: `compaction` / `compact_boundary` types with `preTokens` counts
- **Token usage**: Peak from `message.usage.totalTokens` or `input + output` sums
- **Error events**: Last API error message for failure classification
- **Post-compaction recovery**: Counts assistant responses after the last compaction

**Context pressure classification** (same thresholds as Claude/Pi):

| Level | Condition |
|---|---|
| `critical` | ≥3 compactions, or ≥2 compactions + ended after last compaction |
| `high` | ≥2 compactions, or ≥1 compaction + peak >150K tokens |
| `moderate` | ≥1 compaction, or peak >120K tokens |
| `none` | Default |

**Failure reason inference**:
- `context_exhausted` — error mentions "context"/"token limit", or ≥2 compactions + ended after compaction, or ≥3 compactions
- `output_token_limit` — error mentions "output" + "token"
- `error` — any other API error

### Integration Points

- **db.ts**: `syncOpenClawSessions()` scans agent dirs, reads session headers for CWD, creates `openclaw:`-prefixed project IDs. `parseSessionForAgent("openclaw")` delegates to `parseOpenClawSessionFile()`.
- **plan-executor.ts**: Side-effect import registers the runtime. `getActiveRuntime()` returns `OpenClawAgentRuntime` when `AGENT_TYPE=openclaw`.
- **routes.ts**: `/api/sessions/:id/health` dispatches to `analyzeOpenClawSessionHealth()` for sessions with `agent_type = "openclaw"`.

### Capabilities

```typescript
{
  supportsResume: true,        // --session-id continues existing sessions
  supportsInteractive: true,   // Native tool use without --json
  supportsTextOutput: true,    // --json flag for structured output
  supportsDangerousMode: false // No permission-skip flag (OpenClaw has its own permissions model)
}
```

## Plan System Files

- **plan-db.ts** — Plan/Blueprint SQLite tables (`plans`, `plan_nodes`, `node_related_sessions`) + CRUD operations. `blueprints` and `macro_nodes` tables have `agent_type` column. `createBlueprint()` accepts optional `agentType` param.
- **plan-routes.ts** — Plan REST API endpoints.
- **plan-generator.ts** — AI-powered task decomposition: breaks a high-level task into ordered nodes with dependencies. Supports cross-dependencies to existing nodes (by ID) and uses handoff summaries (output artifacts) instead of raw descriptions for done node context. Exports `runClaudeInteractiveGen()` (delegates to agent-claude.ts), `getApiBase()`, `getAuthParam()` used by plan-routes.ts for interactive-mode flows.
- **plan-executor.ts** — Node execution via agent runtime (`getActiveRuntime()`) + artifact generation for cross-node context passing + post-completion evaluation with graph mutations (INSERT_BETWEEN, ADD_SIBLING). CLI functions (`runClaude`, `runClaudeResume`, `runClaudeInteractive`, `detectNewSession`) delegate to active runtime. Also exports `getGlobalQueueInfo()` for cross-blueprint queue aggregation.

## Security Patterns

- **Session ID validation**: All endpoints accepting session IDs must call `validateSessionId()` from `cli-runner.ts` before passing to shell commands. Prevents Tcl injection via `expect` script interpolation. Regex: `/^[a-zA-Z0-9_-]{1,128}$/`.
- **Error response sanitization**: Never expose internal error messages in API responses. Use a `safeError()` helper that returns "Internal server error" by default, only passing through known-safe messages. Log the real error server-side via `log.error()`.
- **Dev-only endpoint gating**: Endpoints like `/api/dev/redeploy` must check `CLAWUI_DEV` config and return 403 if not in dev mode.
- **CLI concurrency guard**: `index.ts` middleware caps in-flight CLI-spawning requests at 5 (`MAX_CONCURRENT_CLI`). Returns 429 when exceeded.
- **Child process cleanup**: `index.ts` tracks PIDs of spawned CLI processes via `setChildPidTracker()`. SIGTERM/SIGINT handlers kill all tracked children before exit. `cli-runner.ts` calls `trackPid`/`untrackPid` around `execFile` lifecycle.

## Frontend API Client

`lib/api.ts` — all requests use relative `/api/*` paths routed through the Next.js proxy. Auth token read from `localStorage` and attached via `x-clawui-token` header. `next.config.mjs` has rewrites proxying `/api/*` → `http://localhost:3001/api/*`. Exports `AgentType` (`"claude" | "openclaw" | "pi"`), `AgentInfo` interface, `getAgents()`. `getProjects(agentType?)` and `getSessions(projectId, filters?, agentType?)` accept optional agent filtering. `Blueprint`, `MacroNode` types include optional `agentType` field.
