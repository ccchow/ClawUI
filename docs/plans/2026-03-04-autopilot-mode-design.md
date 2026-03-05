# Autopilot Mode — Design Specification

**Date:** 2026-03-04 (revised 2026-03-05)
**Status:** Draft
**Target Release:** ClawUI 0.6.0
**Dependencies:** None (builds on existing evaluation, insights, suggestions, and all existing endpoints)

---

## 1. Problem Statement

Currently, blueprint execution requires significant manual intervention even when things go well. The typical `Run All` flow:

1. User clicks `Run All` → nodes execute in dependency order
2. Each node: execute → generate artifact → evaluate
3. **If evaluation passes** → node marked `done`, but the user must monitor and may need to trigger further actions
4. **If evaluation returns NEEDS_REFINEMENT** → execution stops, user must manually retry
5. **If evaluation returns HAS_BLOCKER** → execution stops, user must investigate and decide next steps

Beyond execution, the biggest pain point is **post-evaluation triage**: evaluation produces suggestions and insights, and the user must manually decide which to act on, create nodes, set priorities, and arrange execution order. This triage work is what the user spends most of their time on.

### Success Criteria

- After approval, a blueprint can execute to completion without any user intervention (happy path)
- Autopilot intelligently uses ALL available ClawUI operations (not just "run next node")
- The AI handles suggestion triage, node creation, splitting, retrying — all decisions currently made by the user
- User is only pulled in for genuinely ambiguous decisions
- User can toggle between manual and autopilot modes at any time

---

## 2. Core Design: AI Agent Loop

### 2.1 Design Philosophy

ClawUI already exposes a rich set of operations via API endpoints: run, resume, evaluate, split, enrich, smart-deps, create/update/skip nodes, coordinate, convene, and more. Instead of building a separate triage classification system or a hardcoded state machine, Autopilot is an **AI Agent Loop** where the agent has access to all these operations as tools and makes intelligent decisions at each step.

This mirrors Claude Code's own architecture: an AI with tools, not a scripted automation.

**Key insight: No separate triage system needed.** The agent sees raw suggestions (title + description) in its state snapshot and decides directly: create a fix node, split the source node, skip it, or start a discussion. A pre-classification step (critical/important/optional) would be redundant — the agent makes richer decisions with full context.

### 2.2 Architecture

```
┌──────────────────────────────────────────────────────┐
│                  Autopilot Agent Loop                  │
│                                                        │
│  ┌──────────┐    ┌──────────────┐    ┌─────────────┐  │
│  │  Observe  │───>│    Decide    │───>│   Execute   │  │
│  │  (state)  │    │  (AI agent)  │    │ (API call)  │  │
│  └──────────┘    └──────────────┘    └──────┬──────┘  │
│       ^                                      │         │
│       │              ┌───────────┐           │         │
│       └──────────────│   Wait    │<──────────┘         │
│                      │(complete) │                     │
│                      └───────────┘                     │
│                                                        │
│  Exit conditions:                                      │
│  • All nodes done/skipped → blueprint "done"           │
│  • AI decides: "needs human input" → blueprint "paused"│
│  • Max iterations reached → blueprint "paused"         │
│  • User switches to manual mode                        │
└──────────────────────────────────────────────────────┘
```

### 2.3 Why Not a Separate Triage System?

| Approach | Pros | Cons |
|----------|------|------|
| Separate triage (classify → auto-action) | Simpler per-step logic | Extra system to build; gets replaced by Autopilot; rigid classification misses context |
| Agent decides directly | Richer decisions; no intermediate layer; leverages ALL existing tools | Requires good prompt engineering; depends on AI quality |

The agent can do everything triage would do, plus more:
- Triage would say "critical → create fix node." Agent can say "this suggestion is about test coverage, but the downstream node already tests this — skip it."
- Triage would batch-approve "important" items. Agent can say "3 of these 5 suggestions are about error handling — let me create one node that covers all 3."
- Triage can't split, enrich, convene, or restructure the graph. Agent can.

---

## 3. Execution Mode Schema

### 3.1 `blueprints` Table — New Columns

```sql
ALTER TABLE blueprints ADD COLUMN execution_mode TEXT DEFAULT 'manual';
ALTER TABLE blueprints ADD COLUMN max_iterations INTEGER DEFAULT 50;
ALTER TABLE blueprints ADD COLUMN pause_reason TEXT DEFAULT NULL;
```

`execution_mode`: `"manual"` (current behavior) or `"autopilot"`.

`max_iterations`: Safety cap on agent loop iterations per autopilot run (10–200, default 50).

`pause_reason`: When autopilot pauses, stores the AI's reason. NULL when not paused.

Migration: `PRAGMA table_info(blueprints)` check in `initPlanTables()`, same as existing incremental migrations.

### 3.2 `autopilot_log` Table — New

Logs every decision the autopilot agent makes for auditability and UI display.

```sql
CREATE TABLE IF NOT EXISTS autopilot_log (
  id           TEXT PRIMARY KEY,
  blueprint_id TEXT NOT NULL REFERENCES blueprints(id) ON DELETE CASCADE,
  iteration    INTEGER NOT NULL,
  observation  TEXT,              -- Summary of blueprint state the AI saw
  decision     TEXT NOT NULL,     -- The action the AI chose + reasoning
  action       TEXT NOT NULL,     -- The tool name called
  action_params TEXT,             -- JSON of parameters passed
  result       TEXT,              -- Outcome (success/error)
  created_at   TEXT NOT NULL
);

CREATE INDEX idx_autopilot_log_blueprint ON autopilot_log(blueprint_id, iteration);
```

Migration: `sqlite_master` check for table existence (same pattern as `convene_sessions`).

### 3.3 Backend Type Changes

```typescript
// plan-db.ts
export type ExecutionMode = "manual" | "autopilot";

export interface Blueprint {
  // ... existing fields ...
  executionMode?: ExecutionMode;
  maxIterations?: number;
  pauseReason?: string;
}

export interface AutopilotLogEntry {
  id: string;
  blueprintId: string;
  iteration: number;
  observation?: string;
  decision: string;
  action: string;
  actionParams?: string;
  result?: string;
  createdAt: string;
}
```

### 3.4 Frontend Type Mirrors

```typescript
// api.ts
export type ExecutionMode = "manual" | "autopilot";

export interface Blueprint {
  // ... existing fields ...
  executionMode?: ExecutionMode;
  maxIterations?: number;
  pauseReason?: string;
}

export interface AutopilotLogEntry {
  id: string;
  blueprintId: string;
  iteration: number;
  observation?: string;
  decision: string;
  action: string;
  actionParams?: string;
  result?: string;
  createdAt: string;
}
```

---

## 4. Backend — Autopilot Agent Engine

### 4.1 New Module: `backend/src/autopilot.ts`

```typescript
export async function runAutopilotLoop(blueprintId: string): Promise<void>
```

Must include side-effect imports for all agent runtimes and roles (same pattern as `plan-coordinator.ts`).

### 4.2 Tool Palette

The autopilot agent has access to the following ClawUI operations, described as tools in its prompt. Each tool maps to an existing internal function (called directly, not via HTTP).

**Node Execution:**

| Tool | Maps To | Description |
|------|---------|-------------|
| `run_node(nodeId)` | `executeNode()` | Execute a single pending/queued node |
| `resume_node(nodeId, feedback?)` | `resumeNodeSession()` | Resume a node's session with optional guidance |
| `evaluate_node(nodeId)` | `evaluateNodeCompletion()` | Trigger evaluation on a completed node |
| `reevaluate_node(nodeId)` | Reevaluate logic | Re-run evaluation on a previously evaluated node |

**Node Intelligence:**

| Tool | Maps To | Description |
|------|---------|-------------|
| `enrich_node(nodeId)` | Enrich logic | AI-enrich a node's description for better execution |
| `split_node(nodeId)` | Split logic | Split a complex node into smaller sub-nodes |
| `smart_dependencies(nodeId)` | Smart-deps logic | Auto-detect and set dependencies for a node |

**Node CRUD:**

| Tool | Maps To | Description |
|------|---------|-------------|
| `create_node(title, description, dependsOn?, roles?)` | `createMacroNode()` | Create a new node |
| `update_node(nodeId, {title?, description?, prompt?})` | `updateMacroNode()` | Modify an existing node |
| `skip_node(nodeId, reason)` | `updateMacroNode({status:"skipped"})` | Skip a node that's no longer needed |
| `batch_create_nodes([{title, description, ...}])` | Batch-create logic | Create multiple nodes at once |
| `reorder_nodes([{id, order}])` | `reorderMacroNodes()` | Change execution order |

**Blueprint Intelligence:**

| Tool | Maps To | Description |
|------|---------|-------------|
| `coordinate()` | `coordinateBlueprint()` | Run the coordinator to process insights |
| `convene(topic, roleIds)` | Convene logic | Start a multi-role discussion |
| `reevaluate_all()` | Reevaluate-all logic | Re-evaluate all completed nodes |

**Insight & Suggestion Management:**

| Tool | Maps To | Description |
|------|---------|-------------|
| `mark_insight_read(insightId)` | `markInsightRead()` | Acknowledge an insight |
| `dismiss_insight(insightId)` | `dismissInsight()` | Dismiss an irrelevant insight |
| `mark_suggestion_used(nodeId, suggestionId)` | `markSuggestionUsed()` | Mark a suggestion as acted upon |

**Control Flow:**

| Tool | Maps To | Description |
|------|---------|-------------|
| `pause(reason)` | — | Pause autopilot, requires human input |
| `complete()` | — | Signal that the blueprint is done |

### 4.3 Agent Loop Implementation

```typescript
export async function runAutopilotLoop(blueprintId: string): Promise<void> {
  updateBlueprint(blueprintId, { status: "running" });
  let iteration = 0;
  const blueprint = getBlueprint(blueprintId);
  const maxIterations = blueprint?.maxIterations ?? 50;

  while (iteration < maxIterations) {
    iteration++;

    // 1. OBSERVE — Build current state snapshot
    const state = buildStateSnapshot(blueprintId);

    // 2. CHECK EXIT CONDITIONS
    if (state.allNodesDone) {
      updateBlueprint(blueprintId, { status: "done" });
      logAutopilot(blueprintId, iteration, "All nodes complete", "complete", "complete");
      break;
    }

    // Check if user switched to manual mode
    const current = getBlueprint(blueprintId);
    if (current?.executionMode !== "autopilot") {
      logAutopilot(blueprintId, iteration, "Mode switched to manual", "pause", "mode_switch");
      break;
    }

    // 3. DECIDE — Ask AI what to do next
    const prompt = buildAutopilotPrompt(state, iteration, maxIterations);
    const decision = await callAgentForDecision(prompt, current.projectCwd);

    // 4. EXECUTE — Carry out the AI's decision
    const result = await executeDecision(blueprintId, decision);

    // 5. LOG
    logAutopilot(blueprintId, iteration, state.summary, decision, result);

    // 6. Handle pause/complete decisions
    if (decision.action === "pause") {
      updateBlueprint(blueprintId, {
        status: "paused",
        pauseReason: decision.reason,
      });
      break;
    }

    // 7. Wait for async operations to complete (e.g., node execution)
    if (result.waitForCompletion) {
      await waitForTaskCompletion(blueprintId, result.taskId);
    }
  }

  // Safety: max iterations reached
  if (iteration >= maxIterations) {
    updateBlueprint(blueprintId, {
      status: "paused",
      pauseReason: `Autopilot reached maximum iterations (${maxIterations}). Review progress and resume.`,
    });
  }
}
```

### 4.4 State Snapshot

The `buildStateSnapshot()` function collects everything the AI needs to make decisions. **Suggestions are included directly** — no separate triage step needed.

```typescript
interface AutopilotState {
  blueprint: {
    id: string;
    title: string;
    description: string;
    status: BlueprintStatus;
    enabledRoles: string[];
  };
  nodes: {
    id: string;
    seq: number;
    title: string;
    description: string;     // truncated to 200 chars
    status: MacroNodeStatus;
    dependencies: string[];
    roles?: string[];
    error?: string;          // if failed
    resumeCount: number;     // times resumed in this autopilot run
    suggestions: {           // DIRECTLY INCLUDED — no triage needed
      id: string;
      title: string;
      description: string;   // truncated to 150 chars
      used: boolean;
      roles?: string[];
    }[];
  }[];
  insights: {
    id: string;
    severity: InsightSeverity;
    message: string;         // truncated to 200 chars
    sourceNodeId?: string;
    read: boolean;
  }[];
  queueInfo: {
    running: boolean;
    pendingTasks: PendingTask[];
  };
  // Summary stats
  allNodesDone: boolean;
  summary: string;  // "7/12 nodes done, 2 failed, 3 pending, 8 unused suggestions, 3 unread insights"
}
```

**Token efficiency:** Descriptions are truncated. Suggestions marked `used: true` are excluded. Only unread/undismissed insights are included. For blueprints with many nodes, only include nodes with status != `done`/`skipped` plus their immediate dependencies (to provide context), keeping the snapshot compact.

### 4.5 Autopilot Prompt Template

```
You are the Autopilot agent for a software blueprint. Your goal is to drive this
blueprint to completion by choosing the best next action at each step.

## Current Blueprint State
{JSON.stringify(state, null, 2)}

## Iteration {iteration} of {maxIterations}

## Available Tools
{tool descriptions from §4.2}

## Guidelines
- Execute nodes in dependency order. Don't run a node whose dependencies aren't done.
- If a node failed, analyze the error. Consider: resume with feedback, split it,
  modify its description/prompt, or skip it if non-critical.
- Review suggestions on completed nodes. Decide for each:
  - Create a fix/improvement node if the suggestion addresses a real issue
  - Combine multiple related suggestions into a single new node
  - Mark as used and move on if the issue is minor or already addressed
  - Skip if the suggestion is irrelevant
- If critical insights exist (severity: "critical"), address them before proceeding.
- If a node seems too complex (long description, many dependencies), consider splitting.
- If you're stuck or need a human decision (architectural choice, ambiguous requirement,
  external dependency), use pause(reason) — don't loop trying different approaches.
- Be efficient: prefer the simplest action that makes progress.
- You have {remaining} iterations left. Prioritize high-impact actions.

## Decision Format
Respond with exactly one JSON object:
{
  "reasoning": "Brief explanation of why this action",
  "action": "<tool_name>",
  "params": { ... tool-specific parameters ... }
}

Pick the single highest-priority action. You'll be called again for the next action.
```

### 4.6 Decision Parsing and Execution

```typescript
interface AutopilotDecision {
  reasoning: string;
  action: string;
  params: Record<string, unknown>;
}

async function executeDecision(
  blueprintId: string,
  decision: AutopilotDecision,
): Promise<ExecutionResult> {
  switch (decision.action) {
    case "run_node":
      return await executeNode(blueprintId, decision.params.nodeId);
    case "resume_node":
      return await resumeNodeSession(blueprintId, decision.params.nodeId, decision.params.feedback);
    case "evaluate_node":
      return await enqueueEvaluation(blueprintId, decision.params.nodeId);
    case "split_node":
      return await enqueueSplit(blueprintId, decision.params.nodeId);
    case "enrich_node":
      return await enqueueEnrich(blueprintId, decision.params.nodeId);
    case "smart_dependencies":
      return await enqueueSmartDeps(blueprintId, decision.params.nodeId);
    case "create_node":
      return createMacroNode(blueprintId, decision.params);
    case "update_node":
      return updateMacroNode(blueprintId, decision.params.nodeId, decision.params);
    case "skip_node":
      return updateMacroNode(blueprintId, decision.params.nodeId, { status: "skipped" });
    case "batch_create_nodes":
      return batchCreateNodes(blueprintId, decision.params.nodes);
    case "coordinate":
      return await enqueueCoordinate(blueprintId);
    case "convene":
      return await enqueueConvene(blueprintId, decision.params.topic, decision.params.roleIds);
    case "mark_insight_read":
      return markInsightRead(blueprintId, decision.params.insightId);
    case "dismiss_insight":
      return dismissInsight(blueprintId, decision.params.insightId);
    case "mark_suggestion_used":
      return markSuggestionUsed(decision.params.nodeId, decision.params.suggestionId);
    case "pause":
      return { action: "pause", reason: decision.params.reason };
    case "complete":
      return { action: "complete" };
    default:
      return { error: `Unknown action: ${decision.action}` };
  }
}
```

### 4.7 Waiting for Async Operations

Some tools (run_node, resume_node, split, enrich, coordinate, convene) are async fire-and-forget operations that enqueue tasks. The autopilot loop must wait for them to complete before the next iteration.

```typescript
async function waitForTaskCompletion(
  blueprintId: string,
): Promise<void> {
  // Poll getQueueInfo(blueprintId) until running === false and pendingTasks is empty
  // Polling interval: 3s
  // Timeout: 30 minutes (reuse existing withTimeout pattern)
}
```

For synchronous operations (create_node, skip_node, update_node, mark_insight_read, mark_suggestion_used, dismiss_insight), no waiting is needed — the loop immediately proceeds to the next iteration.

---

## 5. Infinite Loop Prevention

Multiple safeguards since the AI is making decisions:

1. **Max iterations**: Configurable cap (default 50, max 200). Each observe-decide-execute cycle = 1 iteration. Reaching the cap → pause with reason.

2. **Same-action detection**: If the AI repeats the exact same action+params 3 times consecutively, force a pause: "Autopilot appears stuck — repeating the same action."

3. **No-progress detection**: If no node status changes after 5 consecutive iterations, force a pause: "No progress detected after 5 iterations."

4. **Per-node resume cap**: Track resume count per node within this autopilot run. If a node has been resumed >3 times, the state snapshot includes a warning: "This node has been retried 3 times — consider skipping or splitting it." If resumed >5 times, force a pause.

5. **Cost awareness**: The state snapshot includes `iteration` and `maxIterations`. The prompt says: "You have {remaining} iterations left."

---

## 6. Backend API

### 6.1 `PUT /api/blueprints/:id` — Extended

Existing endpoint. Add support for:

```json
{
  "executionMode": "autopilot",
  "maxIterations": 50
}
```

Validation:
- `executionMode` must be `"manual"` or `"autopilot"`
- `maxIterations` must be 10–200

Side effect when switching to autopilot on a paused/approved blueprint:
- Clear `pause_reason`
- If status is `approved` or `paused`: enqueue `runAutopilotLoop()`

### 6.2 `POST /api/blueprints/:id/run-all` — Mode-Aware

Existing endpoint. Modified to check `execution_mode`:

```typescript
if (blueprint.executionMode === "autopilot") {
  runAutopilotLoop(blueprintId);
} else {
  executeAllNodes(blueprintId);
}
```

### 6.3 `GET /api/blueprints/:id/autopilot-log`

New endpoint. Returns the autopilot decision log.

Query params: `limit` (default 20), `offset` (default 0).

Response: `AutopilotLogEntry[]` ordered by `iteration DESC`.

### 6.4 `GET /api/blueprints/:id` — Extended Response

Include new fields: `executionMode`, `maxIterations`, `pauseReason`.

---

## 7. Frontend

### 7.1 Autopilot Toggle

**Location:** Blueprint detail page header, next to existing status transition buttons.

```
┌─────────────────────────────────────────────────┐
│  API Refactor Blueprint              [Autopilot ●]  │
│  Status: approved                                    │
└─────────────────────────────────────────────────┘
```

Toggle component:
```
className="inline-flex items-center gap-2 px-3 py-1 rounded-full
  border text-sm font-medium cursor-pointer transition-all
  {isAutopilot
    ? 'bg-accent-green/15 text-accent-green border-accent-green/30'
    : 'bg-bg-tertiary text-text-secondary border-border-primary'}
  hover:opacity-80 active:scale-[0.98]"
```

- Toggle dot: `w-2 h-2 rounded-full {isAutopilot ? 'bg-accent-green animate-pulse' : 'bg-text-muted'}`
- Tooltip (enabled): "Autopilot: AI agent drives execution using all available operations"
- Tooltip (disabled): "Manual: you control execution"
- Disabled when blueprint status is `draft` (must approve first)

### 7.2 Paused State UI

When `blueprint.status === "paused"` and `pauseReason` exists:

```
┌─────────────────────────────────────────────────────────┐
│  ⚠ Autopilot Paused                                     │
│                                                          │
│  Reason: Node #4 "Build auth system" failed after 3      │
│  retries — needs human decision on database schema.       │
│                                                          │
│  [Review Issue]  [Resume Autopilot]  [Switch to Manual]  │
└─────────────────────────────────────────────────────────┘
```

Banner: `bg-accent-amber/10 border border-accent-amber/30 rounded-lg p-4 mb-4`

Buttons:
- **Review Issue:** scrolls to / opens the relevant node, `text-accent-blue`
- **Resume Autopilot:** `bg-accent-green/15 text-accent-green border-accent-green/30`
- **Switch to Manual:** `text-text-secondary`

### 7.3 Autopilot Decision Log

Collapsible **"Autopilot Log"** section on the blueprint detail page:

```
┌──────────────────────────────────────────────────────────┐
│  Autopilot Log (12 iterations)                     [v]  │
│──────────────────────────────────────────────────────────│
│                                                          │
│  #12  ✓ run_node(#5 "Frontend UI")               2m ago │
│       "All dependencies met, executing next node"        │
│                                                          │
│  #11  ✓ create_node("Add input validation")       4m ago │
│       "Suggestion on #3 about missing validation —       │
│        creating a fix node dependent on #3"              │
│                                                          │
│  #10  ✓ mark_suggestion_used(#3, "Add logging")   4m ago │
│       "Low-priority suggestion, already covered by #7"   │
│                                                          │
│  #9   ✓ run_node(#4 "Auth system")               6m ago │
│       "Dependencies met, executing"                      │
│                                                          │
│  #8   ✓ split_node(#3 "API endpoints")           12m ago│
│       "Node too complex — 3 separate concerns"           │
│                                                          │
│  #7   ↻ resume_node(#3, feedback)                15m ago │
│       "Evaluation: NEEDS_REFINEMENT — missing tests"     │
│                                                          │
│  [Show earlier...]                                       │
└──────────────────────────────────────────────────────────┘
```

**Styling:**
- Iteration: `text-text-muted text-xs font-mono w-8`
- Status icon: `✓` green, `↻` blue, `⚠` amber, `✕` red
- Action: `font-medium text-sm text-text-primary`
- Reasoning: `text-text-secondary text-xs`
- Timestamp: `text-text-muted text-xs`

Data source: `GET /api/blueprints/:id/autopilot-log`, polled at 5s during active autopilot.

### 7.4 Run All Button

When autopilot is enabled:
- Label: "Run All (Autopilot)"
- Color: `accent-green` instead of `accent-blue`
- Triggers `runAutopilotLoop()` instead of `executeAllNodes()`

---

## 8. Interaction with Other Features

### 8.1 Individual Node Run

Individual "Run" buttons remain available in autopilot mode for one-off execution. Does NOT trigger the autopilot loop.

### 8.2 Convene / Coordinate

The autopilot agent can **decide** to trigger coordinate or convene. These are tools in its palette. The agent might convene when it detects conflicting suggestions, or coordinate when critical insights pile up.

### 8.3 Suggestions and Insights (Direct Handling)

**No separate triage system.** The agent sees raw suggestions and insights in its state snapshot and decides directly:

- **Suggestions:** Each node's unused suggestions are listed. The agent can create fix nodes, combine related suggestions into a single node, mark as used, or ignore. This replaces what a triage classification system would do, with richer context-aware decisions.
- **Insights:** Unread insights with severity levels are listed. The agent can coordinate, dismiss, or address them by creating/modifying nodes.

### 8.4 Cross-Tab Broadcast

Autopilot state changes broadcast via `useBlueprintBroadcast`:
- Types: `"autopilot_start"`, `"autopilot_pause"`, `"autopilot_resume"`, `"autopilot_complete"`

### 8.5 Manual Mode Unchanged

Manual mode continues to use existing `executeAllNodes()`. No changes to the manual flow. All existing tools (split, enrich, etc.) remain available for manual use.

---

## 9. Error Handling & Edge Cases

| Scenario | Behavior |
|----------|----------|
| Server restart during autopilot | `recoverStaleExecutions()` detects state. If `execution_mode === "autopilot"`, re-enter loop from current state |
| AI returns unparseable decision | Log error, retry once with corrective prompt. If still fails, count as wasted iteration |
| AI calls tool with invalid params | Return error in next iteration's state. AI adjusts |
| User deletes a node during autopilot | AI sees updated state in next iteration, adapts |
| AI repeats same action 3x | Same-action detection → force pause |
| Agent runtime unavailable | Tool returns error, AI should decide to pause |
| All remaining nodes have unsatisfied deps | AI detects in state, uses smart-dependencies or creates bridging nodes, or pauses |
| Max iterations reached | Auto-pause with reason |

---

## 10. Acceptance Criteria

1. Blueprint has `execution_mode` toggle (manual/autopilot) in the UI
2. Autopilot runs as an AI agent loop (observe → decide → execute → log → repeat)
3. Agent has full tool palette: run, resume, evaluate, split, enrich, smart-deps, create/update/skip nodes, coordinate, convene, insight/suggestion management
4. Agent handles suggestions directly — no separate triage classification needed
5. Decision log stored in `autopilot_log` table and visible in UI
6. Infinite loop prevention: max iterations, same-action detection, no-progress detection, per-node resume cap
7. Paused state shows AI's reason and provides Resume/Review/Manual buttons
8. Mode can be switched at any time without data loss
9. Cross-tab broadcast for autopilot state changes
10. Server restart recovery respects autopilot mode
11. Manual `executeAllNodes()` is unaffected

---

## 11. Implementation Sequencing

1. **DB migration** — `execution_mode`, `max_iterations`, `pause_reason` on blueprints; `autopilot_log` table
2. **State snapshot builder** — `buildStateSnapshot()` collecting nodes, suggestions, insights, queue
3. **Tool palette** — `executeDecision()` mapping decisions to internal functions
4. **Agent loop** — `runAutopilotLoop()` with observe-decide-execute cycle
5. **Autopilot prompt** — prompt template with state, tools, and guidelines
6. **Infinite loop safeguards** — same-action detection, no-progress detection, max iterations
7. **Mode-aware Run All** — route to autopilot or manual based on `execution_mode`
8. **API endpoints** — autopilot-log, extended blueprint fields
9. **Frontend toggle** — autopilot switch in blueprint header
10. **Decision log UI** — Autopilot Log collapsible section
11. **Pause UI** — banner with reason + resume/review/manual actions
12. **Recovery** — startup recovery for autopilot blueprints
13. **Tests** — agent loop, decision parsing, safeguards, mode switching

---

## 12. Future Enhancements (Out of Scope for v0.6.0)

- **Parallel tool execution**: Agent requests multiple independent actions in one iteration
- **User approval gates**: Mark specific nodes as "requires human approval before execution"
- **Cost tracking**: Track token usage per autopilot run, show in dashboard
- **Learning from decisions**: Feed successful autopilot runs back as few-shot examples
- **Custom tool extensions**: Users define project-specific tools (e.g., "run migration", "deploy staging")

---

*End of specification.*
