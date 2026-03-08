# Autopilot Two-Layer Split Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Split the autopilot into a Message Handler (user intent) and FSD Loop (node execution) to eliminate repetitive loops.

**Architecture:** New `message-handler.ts` handles user messages with its own LLM prompt and tool palette. Existing `autopilot.ts` is simplified to a pure FSD loop that yields when user messages arrive. Both share the workspace queue.

**Tech Stack:** TypeScript, Express, SQLite (better-sqlite3), Vitest

**Design doc:** `docs/plans/2026-03-08-autopilot-two-layer-split-design.md`

---

### Task 1: Rollback session-local patches from autopilot.ts

Remove all temporary fixes added during this debugging session before starting the refactor. These are: `recentLog` parameter, `WORK_ACTIONS`/`isWorkAction`, auto-acknowledge logic, `messageGraceIterations`, 2-step cycle detection, and prompt changes.

**Files:**
- Modify: `backend/src/autopilot.ts`
- Modify: `backend/src/__tests__/autopilot.test.ts`
- Modify: `backend/src/__tests__/autopilot-integration.test.ts`

**Step 1: Revert `buildAutopilotPrompt` signature**

Remove the `recentLog` parameter (last param added this session):

```typescript
// FROM (line 695):
export function buildAutopilotPrompt(
  state: AutopilotState,
  iteration: number,
  maxIterations: number,
  memory: AutopilotMemory = { blueprint: null, global: null },
  fsdMode: boolean = false,
  userMessages: AutopilotMessage[] = [],
  recentLog: Array<{ iteration: number; action: string; decision: string; result?: string }> = [],
): string {

// TO:
export function buildAutopilotPrompt(
  state: AutopilotState,
  iteration: number,
  maxIterations: number,
  memory: AutopilotMemory = { blueprint: null, global: null },
  fsdMode: boolean = false,
  userMessages: AutopilotMessage[] = [],
): string {
```

**Step 2: Remove `historySection` from prompt builder**

Remove the `historySection` variable and its injection into the prompt template (around lines 706-717). Also remove `${historySection}` from the template string (around line 805).

**Step 3: Revert user messages section in prompt**

Restore the original user messages section — undo the "auto-acknowledged after you act" and "Do NOT use send_message" changes. Restore the original `[${m.id}]` format for message listing. The exact original text should match what the tests expect — check `autopilot.test.ts` line ~1408 for the expected format.

Note: We will remove this entire section in Task 3 anyway, so a rough revert is fine. The key is making tests pass.

**Step 4: Revert TOOL_DESCRIPTIONS changes**

Restore `acknowledge_message` and `read_user_messages` tool descriptions to their original text (before this session's changes around "rarely needed").

**Step 5: Revert workflow section**

Restore "Check user messages first" as step 1 in the workflow rhythm (line ~722).

**Step 6: Revert guidelines section**

Restore the original "process them first — create new nodes if needed, then acknowledge" text (undo "auto-acknowledged" changes).

**Step 7: Remove `WORK_ACTIONS`, `isWorkAction`, and the work action classification section**

Delete lines 1278-1297 entirely (the `WORK_ACTIONS` set, JSDoc comment, and `isWorkAction` function).

**Step 8: Revert `checkSameActionRepeat` to original 3-action check**

Replace the current version (which keeps 6 actions and detects 2-step cycles) with the original that keeps only 3 and checks for identical action+params:

```typescript
function checkSameActionRepeat(state: LoopSafeguardState, decision: AutopilotDecision): string | null {
  const current = { action: decision.action, params: JSON.stringify(decision.params) };
  state.recentActions.push(current);

  // Keep only last 3
  if (state.recentActions.length > 3) {
    state.recentActions.shift();
  }

  // Check if last 3 are identical
  if (state.recentActions.length >= 3) {
    const [a, b, c] = state.recentActions.slice(-3);
    if (a.action === b.action && b.action === c.action &&
        a.params === b.params && b.params === c.params) {
      return "Autopilot appears stuck — repeating the same action 3 times consecutively.";
    }
  }
  return null;
}
```

**Step 9: Remove `messageGraceIterations` from loop**

In `runAutopilotLoop`:
- Remove the `let messageGraceIterations = 0;` declaration (around line 1429)
- Remove the grace period decrement in exit check (lines ~1447-1449)
- Remove `messageGraceIterations <= 0` from the exit condition
- Restore exit condition to: `if (state.allNodesDone && pendingMessages.length === 0)`

**Step 10: Remove auto-acknowledge block from loop**

Remove the entire "4b. Auto-acknowledge" block (lines ~1547-1560) including the `messageGraceIterations = 3` assignment.

**Step 11: Remove `recentLogEntries` fetch from loop**

Remove the `getAutopilotLog` call and `.reverse().map()` chain (lines ~1504-1512) that was added to pass `recentLog` to `buildAutopilotPrompt`. Also remove the `recentLogEntries` argument from the `buildAutopilotPrompt` call.

**Step 12: Revert test files**

In `autopilot.test.ts`:
- Restore assertions to match original format: `[m1] Please focus on testing`, `[m2] Skip node 3`, `acknowledge_message(messageId)`
- Restore negative test assertion to original: `acknowledge_message(messageId) to mark it as handled`

In `autopilot-integration.test.ts`:
- Restore the `full message lifecycle` test to original: sequential acknowledge_message calls (not auto-acknowledge)
- Restore the `buildAutopilotPrompt includes user messages section` test: check for `[msg-1]`, `[msg-2]`, `acknowledge_message`

**Step 13: Run tests and verify**

Run: `cd backend && npx tsc --noEmit && npx vitest run`
Expected: All 1207 tests pass, 0 type errors

**Step 14: Commit**

```bash
git add backend/src/autopilot.ts backend/src/__tests__/autopilot.test.ts backend/src/__tests__/autopilot-integration.test.ts
git commit -m "revert: remove session-local autopilot patches before two-layer refactor"
```

---

### Task 2: Create `message-handler.ts` with prompt, executor, and trigger

**Files:**
- Create: `backend/src/message-handler.ts`

**Step 1: Create the file with imports and types**

```typescript
import {
  getBlueprint,
  createMacroNode,
  updateMacroNode,
  getUnacknowledgedMessages,
  acknowledgeMessage,
  createAutopilotMessage,
} from "./plan-db.js";
import type { AutopilotMessage, MacroNode } from "./plan-db.js";
import {
  getQueueInfo,
  executeNodeDirect,
  enqueueBlueprintTask,
  addPendingTask,
  removePendingTask,
} from "./plan-executor.js";
import type { PendingTask } from "./plan-executor.js";
import {
  enrichNodeInternal,
  splitNodeInternal,
  smartDepsInternal,
  reevaluateAllInternal,
} from "./plan-operations.js";
import { callAgentForDecision } from "./autopilot.js";
import { triggerFsdLoopIfNeeded } from "./autopilot.js";
import { getActiveRuntime } from "./agent-runtime.js";
import { createLogger } from "./logger.js";

// Side-effect imports: ensure all runtimes are registered
import "./agent-claude.js";
import "./agent-pimono.js";
import "./agent-openclaw.js";
import "./agent-codex.js";

const log = createLogger("message-handler");
```

Note: `callAgentForDecision` and `triggerFsdLoopIfNeeded` are imported from `autopilot.ts` (they will be exported in Task 3). If circular dependency becomes an issue, use dynamic `import()`.

**Step 2: Build the Message Handler state snapshot**

A lightweight version of `buildStateSnapshot` — only what the Message Handler needs:

```typescript
interface MessageHandlerState {
  blueprint: {
    id: string;
    title: string;
    description: string;
    status: string;
    projectCwd?: string;
  };
  nodes: Array<{
    id: string;
    seq: number;
    title: string;
    status: string;
    dependencies: string[];
    roles?: string[];
  }>;
}

export function buildMessageHandlerState(blueprintId: string): MessageHandlerState {
  const blueprint = getBlueprint(blueprintId);
  if (!blueprint) throw new Error(`Blueprint ${blueprintId} not found`);

  return {
    blueprint: {
      id: blueprint.id,
      title: blueprint.title,
      description: blueprint.description,
      status: blueprint.status,
      projectCwd: blueprint.projectCwd,
    },
    nodes: blueprint.nodes.map((n) => ({
      id: n.id,
      seq: n.seq,
      title: n.title,
      status: n.status,
      dependencies: n.dependencies,
      ...(n.roles && n.roles.length > 0 ? { roles: n.roles } : {}),
    })),
  };
}
```

**Step 3: Build the Message Handler prompt**

```typescript
export const MH_MAX_ITERATIONS = 10;

const MH_TOOL_DESCRIPTIONS = `### Structural Operations
- **create_node(title, description, dependsOn?, roles?)** — Create a new node. dependsOn is an array of node IDs. roles is an array of role IDs.
- **batch_create_nodes([{title, description, dependsOn?, roles?}])** — Create multiple nodes at once.
- **update_node(nodeId, {title?, description?, prompt?})** — Modify an existing node.
- **skip_node(nodeId, reason)** — Skip a node that's no longer needed.

### Direct Execution
- **run_direct(prompt)** — Run a prompt directly as a one-shot agent session. Use for simple tasks (git commit, run tests, Q&A, quick file edits) that do NOT need the full node lifecycle. Output is automatically sent as a reply to the user.

### AI Operations
- **split_node(nodeId)** — Split a complex node into smaller sub-nodes.
- **enrich_node(nodeId)** — Enrich a node's description using AI analysis.
- **smart_deps(nodeId)** — Auto-detect and set dependencies for a node.
- **reevaluate_all()** — Re-evaluate all non-done nodes against the current codebase.

### Communication
- **send_message(content)** — Send a visible reply to the user.

### Context
- **get_node_titles()** — Returns all nodes with {id, seq, title, status, deps}. Use to understand the plan structure.
- **get_node_details(nodeId)** — Returns full node context including description, error, suggestions.

### Control
- **done()** — Signal that you have fully decomposed the user's request into nodes. Call this when there is nothing more to plan.`;

export function buildMessageHandlerPrompt(
  state: MessageHandlerState,
  messages: AutopilotMessage[],
  iteration: number = 0,
): string {
  const messageList = messages.map((m) => `- ${m.content}`).join("\n");

  const iterationNote = iteration > 0
    ? `\n## Iteration ${iteration + 1}\nYou have already taken ${iteration} action(s). The blueprint state above reflects your previous actions. Continue decomposing the user's request or call done() if complete.\n`
    : "";

  return `You are a Message Handler for a software blueprint. Your job is to fully understand user messages and translate them into a complete plan of action nodes.

## Current Blueprint
${JSON.stringify(state, null, 2)}

## User Messages
${messageList}
${iterationNote}
## Available Tools
${MH_TOOL_DESCRIPTIONS}

## Instructions
- Understand what the user wants and take action immediately.
- For simple tasks (Q&A, git operations, quick checks): use **run_direct(prompt)**.
- For complex tasks (new features, refactors, multi-step work): decompose into nodes step by step. You will be called multiple times — create nodes incrementally, setting dependencies as you go.
- For plan operations the user requests (split, enrich, etc.): use the corresponding tool.
- You may use **send_message** to confirm your plan to the user.
- Before creating nodes, check existing nodes in the state to avoid duplicates.
- When you have fully expressed the user's intent as nodes, call **done()**.

## Response Format
Respond with exactly one JSON object:
{ "reasoning": "...", "action": "<tool>", "params": { ... } }

Pick the single best next action. You will be called again for the next action until you call done().`;
}
```

**Step 4: Implement action execution**

```typescript
/** Execute a single Message Handler action. */
export async function executeMessageAction(
  blueprintId: string,
  action: MessageAction,
): Promise<void> {
  const p = action.params;
  switch (action.action) {
    case "create_node": {
      const node = createMacroNode(blueprintId, {
        title: p.title as string,
        description: p.description as string | undefined,
        order: Date.now(),
      });
      if (p.dependsOn && Array.isArray(p.dependsOn)) {
        updateMacroNode(node.id, { dependencies: p.dependsOn as string[] });
      }
      if (p.roles && Array.isArray(p.roles)) {
        updateMacroNode(node.id, { roles: p.roles as string[] });
      }
      log.info(`Message handler created node ${node.id} "${p.title}"`);
      break;
    }

    case "batch_create_nodes": {
      const nodes = p.nodes as Array<{
        title: string;
        description?: string;
        dependsOn?: string[];
        roles?: string[];
      }>;
      for (const spec of nodes) {
        const node = createMacroNode(blueprintId, {
          title: spec.title,
          description: spec.description,
          order: Date.now(),
        });
        if (spec.dependsOn?.length) {
          updateMacroNode(node.id, { dependencies: spec.dependsOn });
        }
        if (spec.roles?.length) {
          updateMacroNode(node.id, { roles: spec.roles });
        }
      }
      log.info(`Message handler batch-created ${nodes.length} nodes`);
      break;
    }

    case "update_node": {
      const nodeId = p.nodeId as string;
      const updates = p.updates as Record<string, unknown> | undefined;
      if (updates) {
        updateMacroNode(nodeId, updates as Partial<MacroNode>);
      }
      break;
    }

    case "skip_node": {
      const nodeId = p.nodeId as string;
      const reason = p.reason as string;
      updateMacroNode(nodeId, { status: "skipped", error: reason });
      break;
    }

    case "run_direct": {
      const prompt = p.prompt as string;
      const blueprint = getBlueprint(blueprintId);
      const runtime = getActiveRuntime();
      const output = await runtime.runSession(prompt, blueprint?.projectCwd);
      // Send output as assistant message so user sees the result
      createAutopilotMessage(blueprintId, "assistant", output.slice(0, 5000));
      log.info(`Message handler run_direct completed (${output.length} chars)`);
      break;
    }

    case "split_node": {
      await splitNodeInternal(blueprintId, p.nodeId as string);
      break;
    }

    case "enrich_node": {
      await enrichNodeInternal(blueprintId, p.nodeId as string);
      break;
    }

    case "smart_deps": {
      await smartDepsInternal(blueprintId, p.nodeId as string);
      break;
    }

    case "reevaluate_all": {
      await reevaluateAllInternal(blueprintId);
      break;
    }

    case "send_message": {
      createAutopilotMessage(blueprintId, "assistant", p.content as string);
      break;
    }

    case "get_node_titles":
    case "get_node_details": {
      // Read-only tools — results were used by the LLM in its reasoning.
      // No side-effect execution needed (the LLM already saw the data in its prompt state).
      log.debug(`Message handler: LLM used read tool ${action.action} (no-op)`);
      break;
    }

    default:
      log.warn(`Message handler: unknown action "${action.action}"`);
  }
}
```

**Step 5: Implement the main `handleUserMessage` function with loop**

```typescript
export async function handleUserMessage(blueprintId: string): Promise<void> {
  const messages = getUnacknowledgedMessages(blueprintId);
  if (messages.length === 0) return; // idempotent

  const blueprint = getBlueprint(blueprintId);
  if (!blueprint) {
    log.error(`Message handler: blueprint ${blueprintId} not found`);
    return;
  }

  addPendingTask(blueprintId, {
    type: "autopilot" as PendingTask["type"],
    queuedAt: new Date().toISOString(),
  });

  try {
    let actionsExecuted = 0;

    for (let i = 0; i < MH_MAX_ITERATIONS; i++) {
      // Rebuild state each iteration (reflects newly created nodes)
      const state = buildMessageHandlerState(blueprintId);
      const prompt = buildMessageHandlerPrompt(state, messages, i);

      let decision;
      try {
        decision = await callAgentForDecision(prompt, blueprint.projectCwd);
      } catch (err) {
        log.error(`Message handler LLM call failed at iteration ${i}: ${err instanceof Error ? err.message : err}`);
        break;
      }

      // Exit: LLM signals intent fully decomposed
      if (decision.action === "done") {
        log.info(`Message handler done at iteration ${i + 1}`);
        break;
      }

      await executeMessageAction(blueprintId, decision);
      actionsExecuted++;
    }

    // Acknowledge all messages after intent is fully decomposed
    for (const msg of messages) {
      acknowledgeMessage(msg.id);
    }
    log.info(`Message handler processed ${messages.length} message(s), executed ${actionsExecuted} action(s)`);
  } catch (err) {
    log.error(`Message handler failed for ${blueprintId}: ${err instanceof Error ? err.message : err}`);
    // Don't acknowledge — messages preserved for retry
    createAutopilotMessage(
      blueprintId,
      "assistant",
      "Failed to process your message. Please try again or switch to manual mode.",
    );
  } finally {
    removePendingTask(blueprintId, undefined, "autopilot");
  }

  // Trigger FSD loop if there are pending nodes to execute
  triggerFsdLoopIfNeeded(blueprintId);
}
```

**Step 6: Implement `triggerMessageHandler`**

```typescript
export function triggerMessageHandler(blueprintId: string): void {
  const bp = getBlueprint(blueprintId);
  if (!bp) return;
  const isAutopilot = bp.executionMode === "autopilot" || bp.executionMode === "fsd";
  if (!isAutopilot) return;

  enqueueBlueprintTask(blueprintId, () => handleUserMessage(blueprintId)).catch((err) => {
    log.error(`Message handler failed for ${blueprintId}: ${err instanceof Error ? err.message : err}`);
  });
}
```

**Step 7: Run typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: May have errors — `triggerFsdLoopIfNeeded` not yet exported from `autopilot.ts`. That's OK, it's created in Task 3. For now just verify no syntax errors in the new file by checking that only the expected import errors appear.

**Step 8: Commit**

```bash
git add backend/src/message-handler.ts
git commit -m "feat: add message-handler.ts — user intent processing layer"
```

---

### Task 3: Simplify autopilot.ts to pure FSD Loop

**Files:**
- Modify: `backend/src/autopilot.ts`

**Step 1: Export `callAgentForDecision` and `triggerFsdLoopIfNeeded`**

`callAgentForDecision` is already exported (line 1177). Add `triggerFsdLoopIfNeeded`:

```typescript
// Add near the top of the file, after imports:
import { getQueueInfo, enqueueBlueprintTask } from "./plan-executor.js";

// Add new function (after runAutopilotLoop or at end of file):
/**
 * Trigger the FSD loop if the blueprint is in autopilot/FSD mode
 * and no loop is currently running or queued.
 * Called by message-handler.ts after processing user messages.
 */
export function triggerFsdLoopIfNeeded(blueprintId: string): void {
  const bp = getBlueprint(blueprintId);
  if (!bp) return;
  const isAutopilot = bp.executionMode === "autopilot" || bp.executionMode === "fsd";
  if (!isAutopilot) return;
  const queueInfo = getQueueInfo(blueprintId);
  const hasLoopTask = queueInfo.pendingTasks.some((t) => t.type === "autopilot");
  if (!hasLoopTask && !queueInfo.running) {
    enqueueBlueprintTask(blueprintId, () => runAutopilotLoop(blueprintId)).catch((err) => {
      log.error(`FSD loop failed for ${blueprintId}: ${err instanceof Error ? err.message : err}`);
    });
  }
}
```

Note: `getQueueInfo` and `enqueueBlueprintTask` are already imported (check existing imports around line 34-42). If already imported, no change needed.

**Step 2: Remove user message handling from `buildAutopilotPrompt`**

- Remove `userMessages: AutopilotMessage[] = []` parameter
- Remove the entire `userMessageSection` variable and its construction (lines ~773-797)
- Remove `${userMessageSection}` from the template string
- Remove the `acknowledge_message`, `read_user_messages`, and `send_message` entries from `TOOL_DESCRIPTIONS`
- Remove the "User Messages" subsection from `### User Messages` in TOOL_DESCRIPTIONS
- Remove all user-message-related guidance from the workflow and guidelines sections:
  - "If user messages appear above, address them first" → remove
  - "process them first — create new nodes if needed. Messages are auto-acknowledged after you act." → remove
  - Any reference to `acknowledge_message` in guidelines

**Step 3: Simplify exit condition and add yield check in `runAutopilotLoop`**

Replace the current exit condition block with:

```typescript
// 2. CHECK EXIT CONDITIONS
// Exit when all nodes are done.
if (state.allNodesDone) {
  logAutopilot(blueprintId, iteration, state.summary, "All nodes complete", "loop_exit");
  log.info(`FSD loop exiting for ${blueprintId.slice(0, 8)} at iteration ${iteration} (all nodes done)`);
  break;
}

// Yield: if user sent new messages, break so Message Handler can process them.
// The Message Handler will re-trigger the FSD loop after processing.
const pendingMessages = getUnacknowledgedMessages(blueprintId);
if (pendingMessages.length > 0) {
  logAutopilot(blueprintId, iteration, state.summary, "yield", "Pending user messages");
  log.info(`FSD loop yielding for ${blueprintId.slice(0, 8)} at iteration ${iteration}: ${pendingMessages.length} pending message(s)`);
  break;
}
```

**Step 4: Remove `pendingMessages` from prompt building call**

The call to `buildAutopilotPrompt` no longer passes `pendingMessages`:

```typescript
// FROM:
const prompt = buildAutopilotPrompt(state, iteration, maxIterations, {
  blueprint: blueprintMemory,
  global: globalMemory,
}, isFsd, pendingMessages);

// TO:
const prompt = buildAutopilotPrompt(state, iteration, maxIterations, {
  blueprint: blueprintMemory,
  global: globalMemory,
}, isFsd);
```

**Step 5: Run typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: Pass (0 errors). The removed `userMessages` param had a default value, so existing test calls should still work.

**Step 6: Commit**

```bash
git add backend/src/autopilot.ts
git commit -m "refactor: simplify autopilot.ts to pure FSD loop with yield"
```

---

### Task 4: Update plan-routes.ts to use new trigger functions

**Files:**
- Modify: `backend/src/plan-routes.ts`

**Step 1: Update imports**

```typescript
// Remove:
import { runAutopilotLoop } from "./autopilot.js";

// Add:
import { runAutopilotLoop, triggerFsdLoopIfNeeded } from "./autopilot.js";
import { triggerMessageHandler } from "./message-handler.js";
```

Note: `runAutopilotLoop` is still needed for the mode-switch and resume-from-pause paths. Check existing imports to see what's already there.

**Step 2: Remove `triggerAutopilotIfNeeded` function**

Delete the function at lines 93-110.

**Step 3: Replace all `triggerAutopilotIfNeeded` call sites**

Search for all occurrences and replace:

- **POST /messages endpoint** (line ~2612): `triggerAutopilotIfNeeded(req.params.id)` → `triggerMessageHandler(req.params.id)`
- **Enrich endpoint** (line ~443): `triggerAutopilotIfNeeded(blueprintId)` → `triggerMessageHandler(blueprintId)`
- **Split endpoint** (line ~619): `triggerAutopilotIfNeeded(blueprintId)` → `triggerMessageHandler(blueprintId)`
- **Smart-deps endpoint** (line ~671): `triggerAutopilotIfNeeded(blueprintId)` → `triggerMessageHandler(blueprintId)`
- **Reevaluate-all endpoint** (line ~1805): `triggerAutopilotIfNeeded(blueprintId)` → `triggerMessageHandler(blueprintId)`
- **Generate nodes endpoint** (line ~1920): `triggerAutopilotIfNeeded(blueprintId)` → `triggerMessageHandler(blueprintId)`

**Step 4: Update mode-switch and resume paths**

Find where `runAutopilotLoop` is enqueued directly (mode switch to autopilot/FSD, resume from pause) and replace with `runAutopilotLoop` (keep as-is since these are direct FSD loop triggers, not message-driven). Verify these paths do NOT go through the deleted `triggerAutopilotIfNeeded`.

**Step 5: Run typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: Pass

**Step 6: Commit**

```bash
git add backend/src/plan-routes.ts
git commit -m "refactor: replace triggerAutopilotIfNeeded with triggerMessageHandler"
```

---

### Task 5: Write message-handler tests

**Files:**
- Create: `backend/src/__tests__/message-handler.test.ts`

**Step 1: Set up test file with mocks**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildMessageHandlerState,
  buildMessageHandlerPrompt,
  normalizeActions,
  executeMessageAction,
  handleUserMessage,
  triggerMessageHandler,
} from "../message-handler.js";

// Mock plan-db
vi.mock("../plan-db.js", () => ({
  getBlueprint: vi.fn(),
  createMacroNode: vi.fn(() => ({ id: "node-new", seq: 1, title: "New", status: "pending", dependencies: [] })),
  updateMacroNode: vi.fn(),
  getUnacknowledgedMessages: vi.fn(() => []),
  acknowledgeMessage: vi.fn(),
  createAutopilotMessage: vi.fn(),
  getSuggestionsForNode: vi.fn(() => []),
  getInsightsForBlueprint: vi.fn(() => []),
  getExecutionsForNode: vi.fn(() => []),
  getAutopilotLog: vi.fn(() => []),
  setAutopilotMemory: vi.fn(),
  getAutopilotMemory: vi.fn(() => null),
  getArtifactsForNode: vi.fn(() => []),
  markInsightRead: vi.fn(),
  dismissInsight: vi.fn(),
  markSuggestionUsed: vi.fn(),
  updateBlueprint: vi.fn(),
  reorderMacroNodes: vi.fn(),
}));

vi.mock("../plan-executor.js", () => ({
  getQueueInfo: vi.fn(() => ({ running: false, pendingTasks: [] })),
  enqueueBlueprintTask: vi.fn((_, task) => task()),
  executeNodeDirect: vi.fn(),
  addPendingTask: vi.fn(),
  removePendingTask: vi.fn(),
}));

vi.mock("../plan-operations.js", () => ({
  enrichNodeInternal: vi.fn(),
  splitNodeInternal: vi.fn(),
  smartDepsInternal: vi.fn(),
  reevaluateAllInternal: vi.fn(() => []),
}));

vi.mock("../autopilot.js", () => ({
  callAgentForDecision: vi.fn(),
  triggerFsdLoopIfNeeded: vi.fn(),
}));

vi.mock("../agent-runtime.js", () => ({
  getActiveRuntime: vi.fn(() => ({
    runSession: vi.fn(async () => "result output"),
  })),
}));

// Side-effect import mocks
vi.mock("../agent-claude.js", () => ({}));
vi.mock("../agent-pimono.js", () => ({}));
vi.mock("../agent-openclaw.js", () => ({}));
vi.mock("../agent-codex.js", () => ({}));
```

**Step 2: Write `normalizeActions` tests**

```typescript
describe("normalizeActions", () => {
  it("normalizes single action format", () => {
    const result = normalizeActions({
      action: "create_node",
      params: { title: "Test" },
    });
    expect(result).toEqual([{ action: "create_node", params: { title: "Test" } }]);
  });

  it("normalizes multi-action format", () => {
    const result = normalizeActions({
      actions: [
        { action: "send_message", params: { content: "Hi" } },
        { action: "create_node", params: { title: "Test" } },
      ],
    });
    expect(result).toHaveLength(2);
    expect(result[0].action).toBe("send_message");
    expect(result[1].action).toBe("create_node");
  });

  it("returns empty array for invalid format", () => {
    expect(normalizeActions({})).toEqual([]);
  });
});
```

**Step 3: Write `buildMessageHandlerPrompt` tests**

```typescript
describe("buildMessageHandlerPrompt", () => {
  const state = {
    blueprint: { id: "bp-1", title: "Test", description: "Desc", status: "approved" },
    nodes: [{ id: "n-1", seq: 1, title: "Node A", status: "pending", dependencies: [] }],
  };
  const messages = [
    { id: "m1", blueprintId: "bp-1", role: "user" as const, content: "Add login feature", acknowledged: false, createdAt: "2024-01-01" },
  ];

  it("includes user message content", () => {
    const prompt = buildMessageHandlerPrompt(state, messages);
    expect(prompt).toContain("Add login feature");
  });

  it("includes blueprint state", () => {
    const prompt = buildMessageHandlerPrompt(state, messages);
    expect(prompt).toContain("Node A");
  });

  it("includes MH tools but not FSD tools", () => {
    const prompt = buildMessageHandlerPrompt(state, messages);
    expect(prompt).toContain("create_node");
    expect(prompt).toContain("run_direct");
    expect(prompt).toContain("split_node");
    expect(prompt).not.toContain("resume_node");
    expect(prompt).not.toContain("coordinate");
    expect(prompt).not.toContain("evaluate_node");
  });
});
```

**Step 4: Write `executeMessageAction` tests**

```typescript
describe("executeMessageAction", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a node via create_node action", async () => {
    const { createMacroNode } = await import("../plan-db.js");
    await executeMessageAction("bp-1", {
      action: "create_node",
      params: { title: "Login", description: "Add login page" },
    });
    expect(createMacroNode).toHaveBeenCalledWith("bp-1", expect.objectContaining({ title: "Login" }));
  });

  it("sends a message via send_message action", async () => {
    const { createAutopilotMessage } = await import("../plan-db.js");
    await executeMessageAction("bp-1", {
      action: "send_message",
      params: { content: "Got it!" },
    });
    expect(createAutopilotMessage).toHaveBeenCalledWith("bp-1", "assistant", "Got it!");
  });

  it("calls splitNodeInternal for split_node action", async () => {
    const { splitNodeInternal } = await import("../plan-operations.js");
    await executeMessageAction("bp-1", {
      action: "split_node",
      params: { nodeId: "n-1" },
    });
    expect(splitNodeInternal).toHaveBeenCalledWith("bp-1", "n-1");
  });
});
```

**Step 5: Write `handleUserMessage` integration test**

```typescript
describe("handleUserMessage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("processes messages, executes actions, and acknowledges", async () => {
    const { getBlueprint, getUnacknowledgedMessages, acknowledgeMessage } = await import("../plan-db.js");
    const { callAgentForDecision } = await import("../autopilot.js");

    vi.mocked(getBlueprint).mockReturnValue({
      id: "bp-1", title: "Test", description: "", status: "approved",
      nodes: [], projectCwd: "/tmp", executionMode: "fsd",
    } as any);

    vi.mocked(getUnacknowledgedMessages).mockReturnValue([
      { id: "m1", blueprintId: "bp-1", role: "user", content: "Add tests", acknowledged: false, createdAt: "2024-01-01" },
    ]);

    vi.mocked(callAgentForDecision).mockResolvedValue({
      reasoning: "Creating test node",
      action: "create_node",
      params: { title: "Add tests", description: "Write unit tests" },
    });

    await handleUserMessage("bp-1");

    expect(callAgentForDecision).toHaveBeenCalled();
    expect(acknowledgeMessage).toHaveBeenCalledWith("m1");
  });

  it("returns early when no unacknowledged messages", async () => {
    const { getUnacknowledgedMessages } = await import("../plan-db.js");
    const { callAgentForDecision } = await import("../autopilot.js");

    vi.mocked(getUnacknowledgedMessages).mockReturnValue([]);

    await handleUserMessage("bp-1");

    expect(callAgentForDecision).not.toHaveBeenCalled();
  });

  it("does not acknowledge on LLM failure, creates error message", async () => {
    const { getBlueprint, getUnacknowledgedMessages, acknowledgeMessage, createAutopilotMessage } = await import("../plan-db.js");
    const { callAgentForDecision } = await import("../autopilot.js");

    vi.mocked(getBlueprint).mockReturnValue({
      id: "bp-1", title: "Test", description: "", status: "approved",
      nodes: [], projectCwd: "/tmp", executionMode: "fsd",
    } as any);

    vi.mocked(getUnacknowledgedMessages).mockReturnValue([
      { id: "m1", blueprintId: "bp-1", role: "user", content: "Do stuff", acknowledged: false, createdAt: "2024-01-01" },
    ]);

    vi.mocked(callAgentForDecision).mockRejectedValue(new Error("LLM failed"));

    await handleUserMessage("bp-1");

    expect(acknowledgeMessage).not.toHaveBeenCalled();
    expect(createAutopilotMessage).toHaveBeenCalledWith("bp-1", "assistant", expect.stringContaining("Failed"));
  });
});
```

**Step 6: Run tests**

Run: `cd backend && npx vitest run src/__tests__/message-handler.test.ts`
Expected: All tests pass

**Step 7: Commit**

```bash
git add backend/src/__tests__/message-handler.test.ts
git commit -m "test: add message-handler unit and integration tests"
```

---

### Task 6: Update autopilot tests

**Files:**
- Modify: `backend/src/__tests__/autopilot.test.ts`
- Modify: `backend/src/__tests__/autopilot-integration.test.ts`

**Step 1: Update `buildAutopilotPrompt` unit tests**

In `autopilot.test.ts`, find the `buildAutopilotPrompt user message injection` describe block (around line 1389). These tests are no longer relevant since the prompt no longer accepts `userMessages`. Replace with:

```typescript
describe("buildAutopilotPrompt simplified (no user messages)", () => {
  it("does not contain user message section", () => {
    const prompt = buildAutopilotPrompt(baseState, 1, 50);
    expect(prompt).not.toContain("User Messages");
    expect(prompt).not.toContain("acknowledge_message");
  });

  it("does not contain read_user_messages tool", () => {
    const prompt = buildAutopilotPrompt(baseState, 1, 50);
    expect(prompt).not.toContain("read_user_messages");
  });
});
```

**Step 2: Update integration tests for message lifecycle**

In `autopilot-integration.test.ts`, find the message lifecycle tests. These need to be updated because the FSD loop no longer processes messages directly. The key changes:

- Remove or update the "full message lifecycle" test — messages are now handled by `handleUserMessage`, not the FSD loop
- Update the "autopilot loop processes user messages" test — the loop should now yield when it detects unacknowledged messages
- Add a new test verifying yield behavior: FSD loop breaks when unacknowledged messages exist

```typescript
it("FSD loop yields when unacknowledged messages exist", async () => {
  const bp = setupFsd("Yield Test");
  db.createMacroNode(bp.id, { title: "Node A", order: 1 });

  // Create an unacknowledged message before loop starts
  createAutopilotMessage(bp.id, "user", "Please do something");

  // The loop should yield immediately (before running any nodes)
  await ap.runAutopilotLoop(bp.id);

  // Node A should still be pending (loop yielded before executing)
  const node = db.getBlueprint(bp.id)!.nodes[0];
  expect(node.status).toBe("pending");
});
```

**Step 3: Remove tests that reference removed features**

Search for and remove/update tests that reference:
- `messageGraceIterations`
- `WORK_ACTIONS` / `isWorkAction`
- auto-acknowledge behavior in the loop
- `recentLog` / iteration history
- `pendingMessages` in exit condition (now just `allNodesDone`)

**Step 4: Run all tests**

Run: `cd backend && npx vitest run`
Expected: All tests pass

**Step 5: Commit**

```bash
git add backend/src/__tests__/autopilot.test.ts backend/src/__tests__/autopilot-integration.test.ts
git commit -m "test: update autopilot tests for FSD-only loop (no message handling)"
```

---

### Task 7: Update plan-routes tests

**Files:**
- Modify: `backend/src/__tests__/plan-routes.test.ts`

**Step 1: Update mocks**

Add mock for `message-handler.js`:

```typescript
vi.mock("../message-handler.js", () => ({
  triggerMessageHandler: vi.fn(),
}));
```

Update the autopilot mock to include `triggerFsdLoopIfNeeded`:

```typescript
vi.mock("../autopilot.js", () => ({
  runAutopilotLoop: vi.fn(),
  triggerFsdLoopIfNeeded: vi.fn(),
}));
```

**Step 2: Update POST /messages test**

Find the test for `POST /api/blueprints/:id/messages` (around line 3054-3078). Update it to verify `triggerMessageHandler` is called instead of `triggerAutopilotIfNeeded` / `enqueueBlueprintTask`:

```typescript
it("triggers message handler in FSD mode", async () => {
  const { triggerMessageHandler } = await import("../message-handler.js");
  // ... setup FSD blueprint mock ...
  const res = await request(app)
    .post("/api/blueprints/bp-1/messages")
    .send({ content: "Do something" });
  expect(res.status).toBe(200);
  expect(triggerMessageHandler).toHaveBeenCalledWith("bp-1");
});
```

**Step 3: Update any other tests that reference `triggerAutopilotIfNeeded`**

Search for `triggerAutopilotIfNeeded` in the test file and update references.

**Step 4: Run tests**

Run: `cd backend && npx vitest run src/__tests__/plan-routes.test.ts`
Expected: All tests pass

**Step 5: Commit**

```bash
git add backend/src/__tests__/plan-routes.test.ts
git commit -m "test: update plan-routes tests for triggerMessageHandler"
```

---

### Task 8: Full integration test and typecheck

**Files:** None (verification only)

**Step 1: Run full typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: 0 errors

**Step 2: Run all backend tests**

Run: `cd backend && npx vitest run`
Expected: All tests pass (count may differ slightly from 1207 due to added/removed tests)

**Step 3: Run frontend tests (sanity check)**

Run: `cd frontend && npx vitest run`
Expected: All tests pass (no frontend changes, but verify nothing is broken)

**Step 4: Run frontend typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: 0 errors

**Step 5: Commit (if any fixes were needed)**

Only if steps 1-4 revealed issues that required fixes.

---

### Task 9: Update CLAUDE.md gotchas

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Update the autopilot gotchas**

Find and update these gotchas:
- **"Autopilot tool palette"** — Update to describe two separate palettes (Message Handler tools vs FSD Loop tools)
- **"triggerAutopilotIfNeeded helper"** — Replace with description of `triggerMessageHandler` and `triggerFsdLoopIfNeeded`
- **"Autopilot pause/resume flow"** — Update to reference `runFsdLoop` path
- Remove mentions of auto-acknowledge, `messageGraceIterations`, etc.
- Add new gotcha: **"Message Handler vs FSD Loop"** — `message-handler.ts` handles user messages (enqueued via `triggerMessageHandler`), `autopilot.ts` handles node execution (enqueued via `triggerFsdLoopIfNeeded`). FSD loop yields when unacknowledged messages exist. Never trigger FSD loop directly for user messages.

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md gotchas for two-layer autopilot architecture"
```

---

Plan complete and saved to `docs/plans/2026-03-08-autopilot-two-layer-split.md`. Two execution options:

**1. Subagent-Driven (this session)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** — Open new session with executing-plans, batch execution with checkpoints

Which approach?