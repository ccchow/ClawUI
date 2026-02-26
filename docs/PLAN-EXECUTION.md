# Plan Execution Internals

Detailed design decisions for the Plan/Blueprint execution system. Referenced from [CLAUDE.md](../CLAUDE.md).

For the overall Plan system architecture, see [PLAN-SYSTEM.md](./PLAN-SYSTEM.md).

## API Callback Pattern

- `buildNodePrompt()` instructs Claude to call three endpoints via curl: `report-blocker` (with `{type, description, suggestion}`), `task-summary` (with `{summary}`), and `report-status` (with `{status: "done"|"failed"|"blocked", reason?}`).
- Data stored in `blocker_info`/`task_summary`/`reported_status`+`reported_reason` columns on `node_executions`.
- `report-status` is the **authoritative** execution result — when present, `executeNodeInternal()` uses it directly instead of inferring status from output length/blocker detection.
- When `reported_status` is null (no callback received), falls back to legacy inference logic for backward compatibility.
- Legacy marker parsing (`===EXECUTION_BLOCKER===`, `===TASK_COMPLETE===`/`===END_TASK===` via `extractTaskCompleteSummary()`) kept as secondary fallback.
- `buildNodePrompt()` requires `executionId` param — execution record must be created before prompt is built.

## Dependency Validation (Two-Tier)

- **Queue-time** (`/run` endpoint in plan-routes.ts): lenient — only blocks when deps are `failed` or `blocked`. Running/queued/pending/done/skipped deps all allow queueing.
- **Execution-time** (`executeNodeInternal` in plan-executor.ts): strict — deps must be `done` or `skipped`.
- This lets users queue nodes ahead of running dependencies; if deps aren't complete by execution time, the node fails.

## Execution Queue

- **Fire-and-forget**: Node run/reevaluate use serial queues per blueprint (`enqueueBlueprintTask`). Endpoints return `{status:"queued"}` immediately; frontend polls.
- **In-memory**: `blueprintQueues`/`blueprintPendingTasks` are in-memory only. `requeueOrphanedNodes()` bridges on restart.
- **Queue position + unqueue**: `QueueItem` has optional `nodeId`. `removeQueuedTask(blueprintId, nodeId)` splices from in-memory queue. Unqueue endpoint reverts SQLite status to `pending`. Queue position derived from `pendingTasks.filter(t => t.type === "run")` array index.
- **RunAll pre-queuing**: `executeAllNodes()` pre-marks all eligible pending nodes as `queued` before the execution loop. `executeNode()` skips re-queuing if already `queued`. On failure, remaining pre-queued nodes are reset to `pending`.

## Global Execution Indicator

- `GET /api/global-status` aggregates `blueprintRunning` + `blueprintPendingTasks` across all blueprints, enriched with `nodeTitle`, `blueprintTitle`, and `sessionId` from SQLite.
- `blueprintRunningNodeId` map tracks which node is currently executing per blueprint.
- NavBar polls with adaptive intervals (5s active, 10s idle).
- Hover popover lists each task with node title (links to node detail), blueprint title, type badge, and "session" link.
- Click on sparkle icon navigates to first active task's session (if available), then node detail, then blueprint.

## Background Session Detection

- `executeNodeInternal()` starts a 3s polling interval that calls `detectNewSession()` while `runClaude()` blocks.
- Updates the execution record with `sessionId` immediately when found, so the frontend can show the session link during execution.

## Post-Completion Evaluation

- After a node completes and its handoff artifact is generated, `evaluateNodeCompletion()` runs Claude in interactive mode.
- Claude calls `POST /api/blueprints/:id/nodes/:nodeId/evaluation-callback` directly with its assessment.
- Three outcomes: `COMPLETE` (no action), `NEEDS_REFINEMENT` (INSERT_BETWEEN: creates follow-up node, rewires dependents), `HAS_BLOCKER` (ADD_SIBLING: creates blocked sibling).
- `applyGraphMutations()` handles the graph rewiring. Evaluation failures are logged but don't affect node's done status.
- New nodes created mid-execution are automatically picked up by `executeNextNode()` since it re-reads from DB each iteration.
- `POST /api/blueprints/:id/nodes/:nodeId/evaluate` triggers manual evaluation. Fire-and-forget via blueprint queue.

## Artifacts for Cross-Node Context

- When a plan node completes, an artifact (summary) is generated and passed as context to downstream dependent nodes.
- Artifact prompt requires `**What was done:**` marker; post-processing strips preamble before this marker.
- `generateArtifact()` calls are wrapped in try/catch to prevent failures from overwriting a node's "done" status. Has a 5-minute `withTimeout()` safety net.

## Interactive Mode Operations

- `enrich-node` and single-node `reevaluate` use `runClaudeInteractiveGen` (interactive mode with bash access).
- When enriching an existing node (`nodeId` provided), Claude calls `PUT /api/blueprints/:id/nodes/:nodeId` via curl directly — DB write survives page closure.
- For new node creation (Smart Create, no `nodeId`), falls back to temp file approach.
- `reevaluate-all` runs Claude in interactive mode, reads source code, updates all nodes via `PUT /api/blueprints/:id/nodes/batch`.

## Generate (Additive-Only)

- `generatePlan()` only adds new nodes — never modifies or removes existing nodes.
- Pending nodes appear in prompt as read-only context (to avoid duplicates), but response JSON only contains an `add` array. Any `remove`/`update` keys are ignored.
- Dependencies in `add` array support mixed formats: string node IDs for existing nodes + integer indices for new nodes in the same batch.
- Node descriptions are stripped from prompt context to avoid base64 image bloat.
- Done nodes show title + handoff summary (truncated to 300 chars); pending nodes show title only.

## Session Resume for Failed Nodes

- `resumeNodeSession()` resumes a failed execution's existing Claude session via `runClaudeResume()` (`--resume ${sessionId}` flag).
- Sends only a lightweight continuation prompt since the resumed session already has full context.
- Creates a `continuation` type execution record. Post-execution flow runs normally.
- Frontend shows a play button next to the session link chip for failed executions with a sessionId.

## Server Restart Recovery

- `smartRecoverStaleExecutions()` checks CLI process liveness (`cli_pid` + `process.kill(pid, 0)`) and session file mtime before marking executions as failed.
- Still-alive executions get a background monitor (10s interval, 45min timeout).
- `recoverStaleExecutions(skipIds)` only marks truly-dead executions as failed.
- Also checks recently-failed "server restart" executions (10min window) and reverts if session is still active.
- `requeueOrphanedNodes()` re-enqueues nodes left in "queued" status.
- `recover-session` endpoint finds orphaned JSONL files and links them back.

## Node Split (AI Decomposition)

- `POST /api/blueprints/:id/nodes/:nodeId/split` decomposes a pending node into 2-3 sub-nodes via `runClaudeInteractiveGen`.
- Claude executes curl calls: (1) `batch-create` sub-nodes (first inherits original's deps, subsequent chain sequentially), (2) rewire downstream dependents to last sub-node, (3) mark original as `skipped`.
- Frontend detects completion when node status becomes `skipped` and navigates to blueprint page.

## Smart Dependencies

- `POST /api/blueprints/:id/nodes/:nodeId/smart-dependencies` uses `runClaudeInteractiveGen` + curl `PUT` callback.
- Claude analyzes node titles/descriptions to pick 0-3 logical dependencies.
- Sparkle button only shows for pending/failed/blocked nodes with non-skipped siblings available.

## Blueprint Node Grouping & Sorting

- Collapsible "older nodes" only collapses `done`/`skipped` nodes — active states are never hidden. When expanded, renders all nodes in original order so dependency lines stay correct.
- **Smart sort** (default): two-tier ordering — active tier above completed tier. Active tier sorts by dependency depth descending (leaf nodes on top), then status priority, then `createdAt` descending. Depth computed via `useMemo` DAG traversal with cycle guard. Only applies when `statusFilter === "all"`.

## Related Sessions

- `node_related_sessions` table stores sessions from interactive operations (enrich, reevaluate, split, evaluate, reevaluate_all, smart_deps).
- Uses `detectNewSession()` pattern — record `beforeTimestamp` before CLI call, detect session after.
- `captureRelatedSession()` helper in plan-routes.ts handles detection + DB write.

## MCP Tools in Executions

- MCP tools are "deferred tools" — available but require `ToolSearch` to discover and load.
- `buildNodePrompt()` includes a hint about `ToolSearch` and available MCP tools so the model uses them when built-in tools are insufficient.

## Execution Failure Classification

- `classifyFailure()` and `classifyHungFailure()` categorize failures as `timeout`, `context_exhausted`, `output_token_limit`, `hung`, or `error`. Stored in `failure_reason` column.
- `analyzeSessionHealth()` reads JSONL for `compact_boundary` events, `isApiErrorMessage` entries, peak token usage, and post-compaction activity.
- Returns `contextPressure` level (none/moderate/high/critical), `endedAfterCompaction` flag, `responsesAfterLastCompact` count.
- `storeContextHealth()` persists metrics on execution records via `finally` block.

## Post-Execution Pipeline

- `executeNodeInternal()` marks node as `done` BEFORE `generateArtifact()` and `evaluateNodeCompletion()` run.
- Node detail page uses `postCompletionPolls` countdown (4 cycles x 5s = 20s) triggered by detecting status transition via `prevStatusRef`.
