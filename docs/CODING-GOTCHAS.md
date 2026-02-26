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
- **Backend `process.cwd()`**: When running the backend (dev or stable), cwd is `backend/`. To reach project root or `scripts/`, use `join(process.cwd(), "..")`.
- **Blueprint `projectCwd` validation**: `POST /api/blueprints` validates `projectCwd` against the real filesystem (`existsSync`, `isDirectory`, CLAUDE.md presence). Backend tests using fake paths must mock `node:fs`.

## Frontend Polling & State

- **Session page poll dedup**: `fetchNodes` in `session/[id]/page.tsx` uses `pollFingerprintRef` (`${count}-${lastNodeId}`) to skip updates when nothing changed. After `handleRun` success, fetches real parsed timeline via `getTimeline()`. On error, fingerprint is reset to `""` so the next poll replaces synthetic nodes.
- **Pending task cleanup**: Fire-and-forget queue tasks must use `finally` blocks to guarantee `removePendingTask()` runs. If pending tasks leak, frontend polling runs indefinitely (capped at 35min safety limit).
- **Post-execution pipeline is async**: `executeNodeInternal()` marks node as `done` BEFORE `generateArtifact()` and `evaluateNodeCompletion()` run. Node detail page uses `postCompletionPolls` countdown (4 cycles x 5s = 20s) to catch artifacts and evaluation results.

## Testing

- **New exports need mock updates**: When adding new exports to a module, all `vi.mock()` blocks for that module in test files must include the new export — Vitest throws "[vitest] No 'exportName' export is defined on the mock" otherwise.

## Auth & Security

- **Auth token on restart**: Token rotates on every backend restart. Phone/tablet users must re-copy the secure URL from terminal output. The old `?auth=` bookmark will 403.
- **Session ID validation**: All endpoints accepting session IDs must call `validateSessionId()` before passing to shell commands. Prevents Tcl injection via `expect` script interpolation. Regex: `/^[a-zA-Z0-9_-]{1,128}$/`.
- **Error response sanitization**: Never expose internal error messages in API responses. Use `safeError()` helper. Log the real error server-side via `log.error()`.

## Plan System

- **Evaluation uses interactive mode**: `evaluateNodeCompletion()` runs Claude in interactive mode with a callback URL. Claude calls the `evaluation-callback` endpoint directly — no output parsing needed.
- **INSERT_BETWEEN artifact continuity**: After rewiring dependents from completedNode to refinementNode, the completedNode's artifacts become orphaned. This is correct — refinementNode inherits them via `getArtifactsForNode(depId, "output")`.
- **`generateArtifact()` try/catch**: All calls in `plan-executor.ts` are wrapped in try/catch to prevent artifact generation failures from overwriting a node's "done" status.

## Data Formats

- **JSONL session structure**: Each line is a JSON object with `type` (user/assistant/system/progress/queue-operation), `message.content` (array of blocks), `message.usage` (token counts), `isApiErrorMessage` flag. System messages have `subtype`: `compact_boundary`, `turn_duration`, `stop_hook_summary`, `local_command`. Auto-compaction triggers at ~167K-174K tokens.
- **MarkdownEditor base64 images**: Clipboard-pasted images are converted to `data:image/...` data URLs and inserted inline. No backend upload endpoint. `MarkdownContent` renderer passes data URLs through `resolveImageUrl` untouched.

## Performance Optimizations

- **`parseTimelineRaw()` content passing**: Accepts optional `rawContent` param to avoid re-reading JSONL files already loaded by callers.
- **`analyzeSessionHealth()` filepath param**: Accepts optional `knownFilePath` to skip redundant `findSessionFile()`.
- **`trackSessionView()` debounce**: Deduplicates disk writes — skips if same session tracked within 10s.
- **`decodeProjectPath()` memoization**: Results cached in a `Map<string, string | undefined>` since filesystem-aware backtracking is expensive.
