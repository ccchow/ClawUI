# Coding Gotchas

Detailed implementation gotchas for ClawUI. Referenced from [CLAUDE.md](../CLAUDE.md).

## CLI & Process

- **CLI output echo**: Claude CLI echoes the full prompt before the AI response. Greedy regex `\{[\s\S]*\}` captures JSON templates from the echoed prompt, not the AI's response. Use depth-counting brace extraction, last-to-first (see `extractTitleDescJson` in `plan-routes.ts`).
- **Array extraction**: Same echo problem applies to `[...]` arrays. `extractReevaluateArray` in `plan-routes.ts` uses `[`/`]` depth counting with last-to-first fallback, then tries individual `{...}` objects as secondary fallback.
- **`execFile` ENOENT is misleading**: Node.js `execFile` reports `spawn <binary> ENOENT` when the `cwd` directory doesn't exist, not just when the binary is missing. Always validate `cwd` with `existsSync` before passing to `execFile`.
- **`execFile` callback TDZ**: `const child = execFile(...)` — mock tests call the callback synchronously, before `child` is assigned (temporal dead zone). Never reference `child` inside the callback; use a separate `let` variable assigned after the call.
- **CLI runner error handling**: `runClaudeInteractive` and `runClaude` must reject on `execFile` errors (especially timeouts). Never silently resolve — callers depend on rejection to clean up pending tasks and stop frontend polling. `withTimeout()` provides an additional safety net.
- **`CLAUDECODE` env var stripping**: All CLI spawning functions use `cleanEnvForClaude()` which strips `CLAUDECODE` from the environment. This prevents the "cannot be launched inside another Claude Code session" error.
- **`stripEchoedPrompt` is deprecated**: No longer called from production code paths (replaced by API callback pattern). Kept with eslint-disable for backward compat.

## Database

- **Incremental DB migrations**: New columns use `PRAGMA table_info()` + `ALTER TABLE ADD COLUMN`. New tables use `SELECT name FROM sqlite_master` check before `CREATE TABLE IF NOT EXISTS`. Bumping `CURRENT_SCHEMA_VERSION` triggers full table recreation — only for structural changes, not additive columns/tables.
- **`syncSession()` re-indexes**: Calling `syncSession()` re-parses JSONL into SQLite, updating metadata timestamps — sessions appear "recently updated" in the UI. Avoid in recovery/background paths.
- **In-memory queue vs SQLite**: `blueprintQueues`/`blueprintPendingTasks` in `plan-executor.ts` are in-memory only. Node `status` persists in SQLite, but the queue doesn't. `requeueOrphanedNodes()` bridges on startup. Frontend must fetch queue status on initial page load.
- **Batch DB queries over N+1**: `getNodesForBlueprint()` batch-loads all artifacts and executions in 3 queries, then partitions in-memory. Avoid per-node queries in loops.

## Path & Encoding

- **Project path encoding is ambiguous**: Claude CLI encodes project paths by replacing both `/` and `.` (leading dot) with `-`, so hyphens in directory names are indistinguishable from path separators. `decodeProjectPath()` uses filesystem-aware backtracking to disambiguate. Never use naive `replace(/-/g, "/")` for paths that will be used as `cwd`. The `db.ts` naive decode is acceptable for display-only project names.
- **Multi-agent project ID namespacing**: Claude IDs unprefixed, Pi `pi:<dirName>`, OpenClaw `openclaw:<encodedCwd>`, Codex `codex:<encodedCwd>`. Account for prefix differences when comparing.
- **`encodeProjectCwd` cross-platform pattern**: All agent runtimes' `encodeProjectCwd()` must use `/[/\\]/g` (not `/\//g`) and handle drive letter colons with `/:/g`. Reference: `agent-claude.ts` lines 92-96 and `cli-utils.ts:encodeProjectPath()`.
- **Backend `process.cwd()`**: When running the backend (dev or stable), cwd is `backend/`. To reach project root or `scripts/`, use `join(process.cwd(), "..")`.
- **Blueprint `projectCwd` validation**: `POST /api/blueprints` validates `projectCwd` against the real filesystem (`existsSync`, `isDirectory`, CLAUDE.md presence). Backend tests using fake paths must mock `node:fs`.

## Frontend Polling & State

- **Session page poll dedup**: `fetchNodes` in `session/[id]/page.tsx` uses `pollFingerprintRef` (`${count}-${lastNodeId}`) to skip updates when nothing changed. After `handleRun` success, fetches real parsed timeline via `getTimeline()`. On error, fingerprint is reset to `""` so the next poll replaces synthetic nodes.
- **Pending task cleanup**: Fire-and-forget queue tasks must use `finally` blocks to guarantee `removePendingTask()` runs. If pending tasks leak, frontend polling runs indefinitely (capped at 35min safety limit).
- **Post-execution pipeline is async**: `executeNodeInternal()` marks node as `done` BEFORE `generateArtifact()` and `evaluateNodeCompletion()` run. Node detail page uses `postCompletionPolls` countdown (4 cycles x 5s = 20s) to catch artifacts and evaluation results.

## Testing

- **New exports need mock updates**: When adding new exports to a module, all `vi.mock()` blocks for that module in test files must include the new export — Vitest throws "[vitest] No 'exportName' export is defined on the mock" otherwise.
- **`plan-db.test.ts` uses shared DB**: Tests run against the real `.clawui/index.db`, not an isolated per-run database. Data accumulates across test runs, so `listBlueprints()` calls get slower over time. Any `it()` test calling `listBlueprints()` needs `{ timeout: 30_000 }` as the second argument.

## Auth & Security

- **Auth token on restart**: Token rotates on every backend restart. Phone/tablet users must re-copy the secure URL from terminal output. The old `?auth=` bookmark will 403.
- **Session ID validation**: All endpoints accepting session IDs must call `validateSessionId()` before passing to shell commands. Prevents Tcl injection via `expect` script interpolation. Regex: `/^[a-zA-Z0-9_-]{1,128}$/`.
- **Error response sanitization**: Never expose internal error messages in API responses. Use `safeError()` helper. Log the real error server-side via `log.error()`.

## Plan System

- **Evaluation uses interactive mode**: `evaluateNodeCompletion()` runs Claude in interactive mode with a callback URL. Claude calls the `evaluation-callback` endpoint directly — no output parsing needed.
- **INSERT_BETWEEN artifact continuity**: After rewiring dependents from completedNode to refinementNode, the completedNode's artifacts become orphaned. This is correct — refinementNode inherits them via `getArtifactsForNode(depId, "output")`.
- **`generateArtifact()` try/catch**: All calls in `plan-executor.ts` are wrapped in try/catch to prevent artifact generation failures from overwriting a node's "done" status.
- **Plan system type sync**: `backend/src/plan-db.ts` types (`NodeExecution`, `MacroNode`, `Blueprint`, `Artifact`, `BlueprintInsight`, `NodeSuggestion`, `ConveneSession`, `ConveneMessage`, `BatchCreateNode`) and `PendingTask.type` in `plan-executor.ts` must stay in sync with `frontend/src/lib/api.ts` mirror types. When adding fields to backend row-to-object helpers or new pending task types, update the frontend interface too. Also update the `hasRelatedOps` check in `NodeDetailPage` when adding new related operation types.
- **New per-node tables need batch loading**: `getNodesForBlueprint()` in `plan-db.ts` batch-loads artifacts, executions, and suggestion counts to avoid N+1 queries. When adding a new per-node data table, add a batch query in `getNodesForBlueprint()` and pass the data through `rowToMacroNode()`. Also add both the `CREATE TABLE` in the main schema block (for fresh DBs) AND an incremental migration (for existing DBs).
- **Per-blueprint counts need batch loading in `listBlueprints`**: `listBlueprints()` in `plan-db.ts` batch-loads convene session counts to avoid N+1 queries. When adding new per-blueprint aggregate data, add a batch query in `listBlueprints()` and pass through `rowToBlueprint()`. `getBlueprint()` can use individual count functions directly.
- **Blueprint-level agent operations**: Blueprint-wide operations (coordinator, convene) use `runAgentInteractive()` directly without `runWithRelatedSessionDetection()`, since they have no specific nodeId. The `addPendingTask` call omits `nodeId`. Follow the coordinator endpoint pattern in `plan-routes.ts` for new blueprint-level fire-and-forget operations.
- **`createMacroNode` doesn't accept `roles`**: The `roles` field must be set via `updateMacroNode()` after creation. The `batch-create` endpoint in `plan-routes.ts` uses this workaround.
- **BlueprintStatus vs MacroNodeStatus naming**: `BlueprintStatus` uses `"draft"/"approved"` while `MacroNodeStatus` uses `"pending"`. Don't confuse them — `blueprint.status !== "pending"` is a TypeScript error since `"pending"` is not in `BlueprintStatus`.

## Agent Runtimes

### OpenClaw

- **Session discovery scans all agent dirs**: OpenClaw stores sessions in `~/.openclaw/agents/<agent-name>/sessions/`, not project-scoped dirs. `detectNewSession()`, `findSessionFile()`, and `syncOpenClawSessions()` must iterate all agent subdirectories. A session's project association comes from the `cwd` field in the first line (session header), not from the directory structure.
- **`skill_call` is an alias for `tool_call`**: The JSONL format uses both `tool_call` and `skill_call` event types. Both are handled identically in parsing — the tool name comes from `toolName` or `skillName` respectively.
- **`extractOutput()` handles both JSON and plain text**: When `--json` is used, output is `{ message: { content } }`. When it's not valid JSON (e.g., error output or plain text mode), the raw string is returned. Always try JSON parse first, fall back to raw.
- **No `--dangerously-skip-permissions` flag**: `supportsDangerousMode` is `false`. Plan execution prompts should not reference permission-skipping when the active runtime is OpenClaw.
- **`cleanEnv()` strips `OPENCLAW_SESSION`**: In addition to `CLAUDECODE`, the OpenClaw runtime removes `OPENCLAW_SESSION` from subprocess environments to prevent session nesting.
- **OpenClaw session file locations**: Local sessions in `~/.openclaw/agents/<agent-name>/sessions/*.jsonl`. Docker instances store sessions in their own config dir (e.g. `~/.openclaw/openclaw-<instance>/agents/`).
- **OpenClaw Docker config**: Custom model providers in `openclaw.json` under `models.providers.<name>` require `baseUrl`, `apiKey` (supports `env:VAR_NAME`), `api`, and `models[]`. Invalid keys cause startup failure — use `openclaw doctor --fix`. For codex models, use a separate `openai-codex` provider with `"api": "openai-codex-responses"`.
- **OpenClaw Docker gateway auth**: Docker instances require `gateway.auth.token` in their `openclaw.json`. Remote CLI profiles (at `~/.openclaw-<profile>/openclaw.json`) must set `gateway.remote.url` and `gateway.remote.token` to match. Use the operator token from the container's `identity/device-auth.json` or set a custom `gateway.auth.token`. Note: `gateway.mode` only accepts `"local"` or `"remote"` (not `"embedded"`).
- **OpenClaw codex model API type**: GPT-5.x codex models require `"api": "openai-codex-responses"` (not `"openai-completions"`) in the OpenClaw `openclaw.json` provider config. Valid API types: `openai-completions`, `openai-responses`, `openai-codex-responses`, `anthropic-messages`, `google-generative-ai`, `github-copilot`, `bedrock-converse-stream`, `ollama`.
- **OpenClaw multi-dir sync stale cleanup**: `syncOpenClawSessions()` is called per directory (local + Docker). Must pass a shared `seenProjectIds` set across all calls, then run `cleanupStaleOpenClawProjects()` once at the end — otherwise earlier directories' projects get incorrectly deleted as stale.
- **Non-Anthropic models and shell JSON**: GPT-4o (and similar older models) fail on complex nested JSON quoting in shell curl commands (e.g. enrich, split, evaluation callbacks). GPT-5.3-codex handles all JSON complexity correctly. When using OpenClaw with OpenAI models, prefer GPT-5.x codex models for plan operations requiring callback JSON.
- **OpenClaw Docker session scanning on Windows**: `getAllSessionsDirs()` scans `~/.openclaw/openclaw-*/agents/` for Docker instance sessions. This path pattern is Linux/macOS only — Docker Desktop on Windows uses WSL2. Windows users can only use local OpenClaw sessions unless running ClawUI inside WSL2.

### Codex

- **Codex session file locations**: Sessions in `~/.codex/sessions/YYYY/MM/DD/rollout-<datetime>-<UUID>.jsonl` (date-organized, not path-organized). First line uses `{type:"session_meta", payload:{id, cwd, ...}}` — note `cwd` is nested under `payload`, unlike Claude/OpenClaw top-level fields.
- **Codex sandbox blocks localhost**: `--full-auto` forces `workspace-write` sandbox which blocks network calls (curl exit 7). Use `--dangerously-bypass-approvals-and-sandbox` for any mode where Codex needs to call back to ClawUI API endpoints (generation, execution, enrichment, reevaluation, smart-deps).
- **Codex trust requirement**: `codex exec` requires the working directory to be in `~/.codex/config.toml` under `[projects."<path>"]` with `trust_level = "trusted"` AND be a git repo. macOS `/tmp` → `/private/tmp` symlink means both paths may need trust entries. Use `--skip-git-repo-check` to bypass.
- **Codex sandbox behavior on Windows**: `--dangerously-bypass-approvals-and-sandbox` may behave differently on Windows due to OS-level sandboxing differences. The `workspace-write` sandbox is Linux-specific (uses seccomp/namespaces).
- **Codex/OpenClaw/Pi don't use `expect` on Windows**: These agent runtimes use `execFile` directly (not TTY wrapping). Only `agent-claude.ts` uses `expect` for TTY handling, and on Windows it uses `CLAUDE_CLI_JS` with direct node invocation instead.

### Adding New Agent Types

- **Adding new AgentType variants**: Besides updating the union type and `resolveAgentType()` valid array, also update: `agentNames` in `db.ts:getAvailableAgents()`, side-effect imports in `db.ts`/`plan-executor.ts`/`plan-generator.ts`, `parseSessionNodes()` switch in `db.ts`, `syncAllForAgent()` switch + sync function in `db.ts`, `findSessionFileAcrossRuntimes()` case in `db.ts`, implement `analyzeSessionHealth()` method on the new runtime class, `vi.mock()` block in `routes.test.ts`, and frontend: `AgentType` union in `api.ts`, `AGENT_COLORS` + `AGENT_LABELS` in `AgentSelector.tsx`.

## Data Formats

- **JSONL session structure**: Each line is a JSON object with `type` (user/assistant/system/progress/queue-operation), `message.content` (array of blocks), `message.usage` (token counts), `isApiErrorMessage` flag. System messages have `subtype`: `compact_boundary`, `turn_duration`, `stop_hook_summary`, `local_command`. Auto-compaction triggers at ~167K-174K tokens.
- **MarkdownEditor base64 images**: Clipboard-pasted images are converted to `data:image/...` data URLs and inserted inline. No backend upload endpoint. `MarkdownContent` renderer passes data URLs through `resolveImageUrl` untouched.

## React & Frontend

- **React hooks before early returns**: `useEffect` hooks must be placed before conditional early returns (`if (loading) return <Skeleton/>`). Derived consts defined after early returns can't be referenced in effects above. Solution: compute inline within the effect.
- **React context value stability**: Context providers must memoize their `value` prop with `useMemo`. Passing `value={{ fn }}` inline creates a new object each render, re-rendering ALL consumers. `ToastProvider` uses this pattern — new context providers should follow suit.
- **react-markdown `pre`/`code` override pattern**: In `MarkdownContent.tsx`, fenced code blocks are handled by the `pre` component override, NOT in the `code` override. The `code` override handles only inline code.
- **Keyboard shortcut modifier guards**: All single-key shortcuts (e.g., `r` for Run, `e` for Edit) must check `!e.metaKey && !e.ctrlKey` to avoid intercepting browser shortcuts like Cmd+R (refresh).
- **Timeline node IDs must be globally unique**: `timeline_nodes.id` is PRIMARY KEY across all sessions. Agent JSONL parsers must use session-scoped prefixes (e.g., `${sessionId.slice(0,12)}-${lineNum}`), not plain `line-N`.
- **syncSessionFile needs project ensurance**: Single-session sync may encounter a project not yet in the `projects` table. `syncSessionFile` ensures the project exists before INSERT to prevent `SQLITE_CONSTRAINT_FOREIGNKEY`.

## ESLint & Tooling

- **ESLint `_` prefix doesn't suppress unused-vars**: The ESLint config does NOT configure `argsIgnorePattern: "^_"`. Use `// eslint-disable-next-line @typescript-eslint/no-unused-vars` instead.
- **CRLF line endings block `git add` on Windows**: `.gitattributes` enforces `eol=lf`. Windows tools often write CRLF. Convert with `sed -i 's/\r$//'` before staging.
- **Zsh bracket paths in git commands**: `git add frontend/src/app/blueprints/[id]/page.tsx` fails in zsh (brackets are glob characters). Use `git add -A`, quote paths with single quotes, or use `noglob git add`.

## Performance Optimizations

- **`parseTimelineRaw()` content passing**: Accepts optional `rawContent` param to avoid re-reading JSONL files already loaded by callers.
- **`analyzeSessionHealth()` filepath param**: Accepts optional `knownFilePath` to skip redundant `findSessionFile()`.
- **`trackSessionView()` debounce**: Deduplicates disk writes — skips if same session tracked within 10s.
- **`decodeProjectPath()` memoization**: Results cached in a `Map<string, string | undefined>` since filesystem-aware backtracking is expensive.
