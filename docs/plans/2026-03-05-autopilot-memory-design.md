# Autopilot Memory & Reflection System Design

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give the autopilot agent adaptive learning capabilities through per-blueprint and global memory, updated via periodic dedicated reflection LLM calls.

**Architecture:** Two-layer memory (per-blueprint + global) populated by a separate reflection LLM call every N iterations. Memory is injected into the decision prompt so the agent's behavior evolves based on accumulated experience.

**Tech Stack:** SQLite (per-blueprint memory), markdown file (global memory), existing agent runtime for reflection calls.

---

## 1. Problem Statement

The autopilot decision prompt contains fixed, hardcoded guidelines:

```
- Execute nodes in dependency order.
- If a node failed, analyze the error. Consider: resume with feedback, split it...
- Review suggestions on completed nodes...
```

These guidelines are static and don't adapt to:
- **Blueprint-specific patterns** -- a testing blueprint benefits from `evaluate_node` after every run; a documentation blueprint rarely needs it.
- **Tool usage gaps** -- some tools (e.g. `enrich_node`, `coordinate`, `convene`) are never used because the fixed prompt doesn't emphasize them contextually.
- **Accumulated experience** -- the agent can't learn that "splitting node X worked well" or "resuming more than twice is always futile for this blueprint."
- **Cross-blueprint patterns** -- insights from one blueprint run don't benefit future blueprints.

## 2. Design Overview

```
                    +----------------------------+
                    |     Global Memory           |
                    |  .clawui/autopilot-         |
                    |  strategy.md                |
                    |                             |
                    |  Cross-blueprint patterns   |
                    |  Tool effectiveness stats   |
                    |  General strategy rules     |
                    +-------------+--------------+
                                  |
                                  | read on loop start,
                                  | updated at blueprint complete
                                  v
+-------------------------------------------------------------+
|                    Autopilot Loop                             |
|                                                              |
|  +----------+    +---------+    +---------+                  |
|  | OBSERVE  |--->| DECIDE  |--->| EXECUTE |--+               |
|  +----------+    +---------+    +---------+  |               |
|       ^              ^                       |               |
|       |              |                       |               |
|       |    +---------+-----------+           |               |
|       |    | Per-Blueprint       |           |               |
|       |    | Memory injected     |           |               |
|       |    | into prompt         |           |               |
|       |    +---------------------+           |               |
|       |                                      |               |
|       +--------------------------------------+               |
|                                                              |
|  Every N iterations or at pause/complete:                     |
|  +---------------------------------------+                   |
|  |       REFLECT (separate LLM call)     |                   |
|  |                                       |                   |
|  |  Input: autopilot_log history         |                   |
|  |       + current memory                |                   |
|  |       + tool usage stats              |                   |
|  |                                       |                   |
|  |  Output: updated per-blueprint memory |                   |
|  +---------------------------------------+                   |
|                                                              |
|  At blueprint complete:                                       |
|  +---------------------------------------+                   |
|  |  GLOBAL REFLECT (separate LLM call)   |                   |
|  |                                       |                   |
|  |  Input: per-blueprint memory          |                   |
|  |       + current global memory         |                   |
|  |       + blueprint outcome summary     |                   |
|  |                                       |                   |
|  |  Output: updated global memory        |                   |
|  +---------------------------------------+                   |
+-------------------------------------------------------------+
```

## 3. Per-Blueprint Memory

### 3.1 Storage

New TEXT column on the `blueprints` table:

```sql
ALTER TABLE blueprints ADD COLUMN autopilot_memory TEXT DEFAULT NULL;
```

Content is a structured markdown string, max 2000 characters, managed entirely by the reflection LLM. Example:

```markdown
## Strategy
- This is a code implementation blueprint. Enrich nodes before running for better prompt quality.
- Nodes with >3 dependencies tend to fail; split them first.

## Tool Effectiveness
- enrich_node: Used 4 times, all improved execution quality. Use proactively.
- split_node: Used 2 times on complex nodes, both successful. Recommend for nodes with long descriptions.
- coordinate: Not yet used. Consider after 5+ nodes complete to check cross-cutting concerns.
- evaluate_node: Used on all completed nodes. 3 of 8 produced actionable suggestions.

## Patterns Learned
- resume_node with specific error feedback works better than generic retry.
- Batch-creating nodes from suggestions is more efficient than one-at-a-time.

## Avoid
- Don't resume the same node more than twice -- split or skip instead.
- Don't run coordinate() when <3 nodes are done -- not enough data for useful insights.
```

### 3.2 When Per-Blueprint Memory is Read

- **Once** at the start of `runAutopilotLoop` -- cached in a local variable.
- **After each reflection** -- the local variable is updated with the new memory.
- **Injected into** `buildAutopilotPrompt()` as a `## Your Memory` section.

### 3.3 Prompt Injection

```typescript
export function buildAutopilotPrompt(
  state: AutopilotState,
  iteration: number,
  maxIterations: number,
  memory: { blueprint: string | null; global: string | null },  // NEW
): string {
  // ... existing prompt ...

  // Inject memory sections
  let memorySection = "";
  if (memory.global) {
    memorySection += `\n## Global Strategy (from previous blueprints)\n${memory.global}\n`;
  }
  if (memory.blueprint) {
    memorySection += `\n## Blueprint Memory (your notes from earlier iterations)\n${memory.blueprint}\n`;
  }

  return `...existing prompt...${memorySection}...`;
}
```

## 4. Global Memory

### 4.1 Storage

File: `.clawui/autopilot-strategy.md`

Max 3000 characters. Contains cross-blueprint learnings that are blueprint-type-agnostic. Example:

```markdown
## General Patterns
- Blueprints with >15 nodes benefit from coordinate() after every 5 completed nodes.
- evaluate_node produces the most useful suggestions on implementation nodes, less so on documentation nodes.
- enrich_node before first run of any node improves success rate significantly.

## Tool Usage Guidelines
- coordinate(): Most effective with 5+ completed nodes. Triggers useful cross-cutting insights.
- convene(): Best for architectural decisions. Use when multiple roles are enabled and a design choice is ambiguous.
- split_node(): Use when node description exceeds ~500 chars or has >3 dependencies.
- batch_mark_suggestions_used(): Always prefer over individual mark_suggestion_used for efficiency.

## Anti-Patterns
- Running 5+ nodes in sequence without evaluate/coordinate leads to accumulated quality debt.
- Resuming failed nodes without modifying the prompt rarely helps.
- Creating nodes from every suggestion leads to scope creep. Only act on high-severity or clearly actionable ones.
```

### 4.2 When Global Memory is Read

- **Once** at the start of `runAutopilotLoop` -- read from file, cached.
- Not re-read during the loop (it only changes at blueprint completion, which ends the loop).

### 4.3 When Global Memory is Updated

- **At blueprint completion** (when the loop exits with `allNodesDone` or `complete()` action).
- A dedicated global reflection LLM call takes the per-blueprint memory + blueprint outcome and distills cross-blueprint learnings into the global file.

## 5. Reflection Mechanism (Approach B)

### 5.1 Trigger Conditions

A reflection is triggered when **any** of these conditions are met:

| Trigger | Memory Updated | Rationale |
|---------|---------------|-----------|
| Every 5 iterations | Per-blueprint | Regular checkpoint |
| After a `pause` decision | Per-blueprint | Pause means something noteworthy happened |
| After a failed action | Per-blueprint | Learn from failure |
| At blueprint completion | Per-blueprint + Global | Final summary |

The reflection **does not** happen on every iteration -- it's expensive and most iterations are routine `run_node` calls that don't produce new insights.

### 5.2 Reflection Input

The reflection LLM call receives:

```typescript
interface ReflectionInput {
  // Recent autopilot log entries (since last reflection)
  recentLog: AutopilotLogEntry[];

  // Auto-computed tool usage statistics
  toolStats: ToolUsageStats;

  // Current per-blueprint memory (to update, not replace from scratch)
  currentMemory: string | null;

  // Blueprint summary (node count, status distribution, enabled roles)
  blueprintSummary: string;
}
```

### 5.3 Tool Usage Stats (Auto-Computed, No LLM)

Before calling the reflection LLM, compute stats from `autopilot_log`:

```typescript
interface ToolUsageStats {
  totalIterations: number;
  actionCounts: Record<string, number>;       // e.g. { run_node: 12, evaluate_node: 0, ... }
  successRate: Record<string, number>;        // e.g. { run_node: 0.83, split_node: 1.0 }
  neverUsedTools: string[];                   // e.g. ["enrich_node", "coordinate", "convene"]
  consecutiveRunNodeCount: number;            // how many run_node in a row right now
  averageIterationsBetweenNonRunActions: number;
}
```

This is computed purely from the DB -- **no LLM call needed** for stats. The stats are included in the reflection prompt so the LLM can reason about patterns.

```sql
-- Action counts and success rates
SELECT action, COUNT(*) as cnt,
       SUM(CASE WHEN result NOT LIKE 'ERROR%' THEN 1 ELSE 0 END) as success_cnt
FROM autopilot_log
WHERE blueprint_id = ?
GROUP BY action;
```

### 5.4 Reflection Prompt (Per-Blueprint)

```
You are reflecting on an autopilot run to update its memory.

## Blueprint Context
{blueprintSummary}

## Recent Actions (since last reflection)
{recentLog formatted as table}

## Tool Usage Statistics (all-time for this blueprint)
{toolStats}

## Tools Never Used
{neverUsedTools} -- Consider whether any of these could improve outcomes.

## Current Memory
{currentMemory or "(empty -- first reflection)"}

## Instructions
Update the memory based on what you've observed. The memory will be injected
into future autopilot decision prompts, so write actionable guidance.

Rules:
- Keep total length under 2000 characters.
- Structure as: Strategy, Tool Effectiveness, Patterns Learned, Avoid.
- UPDATE existing entries rather than appending -- memory should stay concise.
- Remove advice that turned out wrong or is no longer relevant.
- Focus on actionable, specific guidance -- not generic platitudes.
- If a tool was never used but could help, note when to use it.
- If a tool was used but ineffective, note when to avoid it.

Respond with ONLY the updated memory markdown. No preamble, no explanation.
```

### 5.5 Global Reflection Prompt

Triggered once at blueprint completion:

```
You are updating the global autopilot strategy based on a completed blueprint run.

## Completed Blueprint
Title: {title}
Outcome: {done/paused} after {iterations} iterations
Nodes: {done}/{total} completed, {failed} failed, {skipped} skipped

## Per-Blueprint Memory (learnings from this run)
{blueprintMemory}

## Current Global Strategy
{globalMemory or "(empty -- first blueprint completion)"}

## Instructions
Distill cross-blueprint learnings into the global strategy.
This will be shown to autopilot on ALL future blueprints.

Rules:
- Keep total length under 3000 characters.
- Only add patterns that are likely generalizable (not blueprint-specific).
- Update/refine existing entries based on new evidence.
- Remove advice contradicted by this run's experience.
- Structure as: General Patterns, Tool Usage Guidelines, Anti-Patterns.

Respond with ONLY the updated global strategy markdown.
```

### 5.6 Implementation in the Loop

```typescript
// In runAutopilotLoop():

const REFLECT_EVERY_N = 5;

// Read memory once at start
let blueprintMemory = getBlueprint(blueprintId)?.autopilotMemory ?? null;
const globalMemory = readGlobalMemory();  // reads .clawui/autopilot-strategy.md
let lastReflectionIteration = 0;

while (iteration < maxIterations) {
  iteration++;

  // ... OBSERVE, CHECK EXIT, DECIDE, EXECUTE (existing) ...

  // REFLECT -- check if reflection is due
  const shouldReflect =
    (iteration - lastReflectionIteration >= REFLECT_EVERY_N) ||
    decision.action === "pause" ||
    (!result.success && result.error);

  if (shouldReflect) {
    blueprintMemory = await reflectAndUpdateMemory(
      blueprintId, lastReflectionIteration, iteration, blueprintMemory,
    );
    lastReflectionIteration = iteration;
  }
}

// At loop exit -- final reflection + global update
blueprintMemory = await reflectAndUpdateMemory(
  blueprintId, lastReflectionIteration, iteration, blueprintMemory,
);
if (state.allNodesDone || decision?.action === "complete") {
  await updateGlobalMemory(blueprintId, blueprintMemory, globalMemory);
}
```

## 6. Constants

```typescript
const REFLECT_EVERY_N = 5;                    // Reflect every 5 iterations
const BLUEPRINT_MEMORY_MAX_CHARS = 2000;      // Per-blueprint memory cap
const GLOBAL_MEMORY_MAX_CHARS = 3000;         // Global memory cap
const GLOBAL_MEMORY_PATH = path.join(config.dbDir, "autopilot-strategy.md");
```

## 7. DB Migration

Single new column:

```typescript
// In ensurePlanTables() incremental migration:
const bpCols = db.prepare("PRAGMA table_info(blueprints)").all();
if (!bpCols.some((c) => c.name === "autopilot_memory")) {
  db.exec("ALTER TABLE blueprints ADD COLUMN autopilot_memory TEXT DEFAULT NULL");
}
```

No frontend type change needed -- `autopilotMemory` is backend-only, not exposed via API.

## 8. Data Flow Summary

```
Iteration 1:  OBSERVE -> DECIDE (with memory) -> EXECUTE -> run_node
Iteration 2:  OBSERVE -> DECIDE (with memory) -> EXECUTE -> run_node
Iteration 3:  OBSERVE -> DECIDE (with memory) -> EXECUTE -> evaluate_node
Iteration 4:  OBSERVE -> DECIDE (with memory) -> EXECUTE -> run_node
Iteration 5:  OBSERVE -> DECIDE (with memory) -> EXECUTE -> run_node
              +-- REFLECT -> update per-blueprint memory
Iteration 6:  OBSERVE -> DECIDE (with UPDATED memory) -> EXECUTE -> enrich_node
  ...
Iteration 10: OBSERVE -> DECIDE -> EXECUTE -> run_node
              +-- REFLECT -> update per-blueprint memory
  ...
Iteration 15: allNodesDone
              +-- FINAL REFLECT -> update per-blueprint memory
              +-- GLOBAL REFLECT -> update .clawui/autopilot-strategy.md
```

## 9. Edge Cases

| Scenario | Handling |
|----------|----------|
| First-ever blueprint run (no global memory) | Global memory file doesn't exist -> `null` passed to prompt, reflection creates it |
| Blueprint paused at iteration 2 (before first reflection) | Final reflection still runs at loop exit |
| Reflection LLM call fails | Log warning, keep existing memory, continue loop |
| Memory exceeds max chars | Reflection prompt instructs LLM to stay under limit; if exceeded, truncate to limit |
| Blueprint restarted (resume after pause) | Reads existing `autopilotMemory` from DB -- picks up where reflection left off |
| Multiple blueprints running concurrently | Each has its own `autopilotMemory` column; global memory uses file-level read/write (last-write-wins for global strategy is acceptable) |

## 10. Implementation Tasks

### Task 1: DB migration + memory read/write helpers
**Files:**
- Modify: `backend/src/plan-db.ts` (add column, add getter/setter)

Add `autopilot_memory` column to blueprints. Add `getAutopilotMemory(blueprintId)` and `setAutopilotMemory(blueprintId, memory)` helpers. Add `readGlobalMemory()` and `writeGlobalMemory(content)` file helpers in a new section of autopilot.ts (or a small helper).

### Task 2: Compute tool usage stats from autopilot_log
**Files:**
- Modify: `backend/src/autopilot.ts`

Add `computeToolUsageStats(blueprintId, sinceIteration?)` function that queries `autopilot_log` and returns `ToolUsageStats`. Pure SQL, no LLM.

### Task 3: Implement reflection LLM call
**Files:**
- Modify: `backend/src/autopilot.ts`

Add `reflectAndUpdateMemory(blueprintId, sinceIteration, currentIteration, currentMemory)` that:
1. Fetches recent log entries
2. Computes tool stats
3. Builds reflection prompt
4. Calls agent runtime
5. Parses response (plain markdown)
6. Saves to DB via `setAutopilotMemory`
7. Returns updated memory string

### Task 4: Implement global reflection LLM call
**Files:**
- Modify: `backend/src/autopilot.ts`

Add `updateGlobalMemory(blueprintId, blueprintMemory, currentGlobalMemory)` that:
1. Builds global reflection prompt with blueprint outcome summary
2. Calls agent runtime
3. Writes result to `.clawui/autopilot-strategy.md`

### Task 5: Inject memory into autopilot prompt
**Files:**
- Modify: `backend/src/autopilot.ts` -- `buildAutopilotPrompt()`

Add `memory` parameter, inject `## Global Strategy` and `## Blueprint Memory` sections into the prompt.

### Task 6: Wire reflection into the autopilot loop
**Files:**
- Modify: `backend/src/autopilot.ts` -- `runAutopilotLoop()`

Add reflection trigger logic (every N iterations, on pause, on failure, at exit). Wire up memory reading at loop start and passing to `buildAutopilotPrompt`. Add global reflection at loop completion.

### Task 7: Tests
**Files:**
- Modify: `backend/src/__tests__/autopilot.test.ts`
- Modify: `backend/src/__tests__/autopilot-integration.test.ts`

Test:
- `computeToolUsageStats` returns correct counts and rates
- Reflection trigger conditions (every 5, on pause, on failure)
- Memory is injected into prompt
- Global memory file read/write
- Reflection failure is non-fatal (loop continues)
- Memory character limit enforcement
