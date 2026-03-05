# Autopilot Queue Deadlock Fix — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix the deadlock where autopilot's `executeDecision` enqueues tasks into the same workspace queue that it's waiting on, causing tasks to never execute.

**Architecture:** Move `runAutopilotLoop` itself into the workspace queue via `enqueueBlueprintTask`, so it owns the queue slot for its entire lifetime. Inside the loop, call internal/direct versions of functions (`executeNodeDirect`, `evaluateNodeCompletion`, `resumeNodeSession`, `coordinateBlueprint`) that do NOT re-enqueue. Remove `waitForTaskCompletion` polling since all work happens synchronously within the queue task. Callers (`plan-routes.ts`, recovery in `plan-executor.ts`) wrap `runAutopilotLoop` in `enqueueBlueprintTask` instead of calling it directly.

**Tech Stack:** TypeScript, Vitest, better-sqlite3

---

## Summary of Changes

| File | Change |
|------|--------|
| `backend/src/plan-executor.ts` | Export `executeNodeDirect()` (extract from `executeNode`) |
| `backend/src/autopilot.ts` | Rewrite `executeDecision` to call direct functions; remove `waitForTaskCompletion`; add `addPendingTask("autopilot")` for queue visibility |
| `backend/src/plan-routes.ts` | Wrap `runAutopilotLoop` in `enqueueBlueprintTask` at all 3 call sites |
| `backend/src/plan-executor.ts` | Wrap recovery `runAutopilotLoop` in `enqueueBlueprintTask` |
| `backend/src/__tests__/autopilot.test.ts` | Update unit tests for new direct-call signatures |
| `backend/src/__tests__/autopilot-integration.test.ts` | Update integration tests — remove `enqueueBlueprintTask` mock passthrough |

---

### Task 1: Export `executeNodeDirect` from `plan-executor.ts`

Extract the queue-bypass version of `executeNode` so autopilot can call it directly while already inside the queue.

**Files:**
- Modify: `backend/src/plan-executor.ts:1094-1122`

**Step 1: Create `executeNodeDirect` by extracting the inner logic of `executeNode`**

The current `executeNode` does two things: (1) marks node as queued + adds pending task, (2) wraps `executeNodeInternal` in `enqueueBlueprintTask`. We need a public function that does (1) + calls `executeNodeInternal` directly (no enqueue).

In `plan-executor.ts`, add this function right before the existing `executeNode`:

```typescript
/**
 * Execute a node directly without going through the workspace queue.
 * Used by autopilot (which already owns the queue slot).
 * Handles status marking, pending task tracking, and error recovery.
 */
export async function executeNodeDirect(
  blueprintId: string,
  nodeId: string,
): Promise<NodeExecution> {
  const bp = getBlueprint(blueprintId);
  const existing = bp?.nodes.find((n) => n.id === nodeId);
  if (!existing || existing.status !== "queued") {
    updateMacroNode(blueprintId, nodeId, { status: "queued" });
    addPendingTask(blueprintId, { type: "run", nodeId, queuedAt: new Date().toISOString() });
  }
  removePendingTask(blueprintId, nodeId, "run");
  try {
    return await executeNodeInternal(blueprintId, nodeId);
  } catch (err) {
    const current = getBlueprint(blueprintId)?.nodes.find((n) => n.id === nodeId);
    if (current && current.status === "queued") {
      updateMacroNode(blueprintId, nodeId, { status: "pending" });
      log.warn(`Node ${nodeId.slice(0, 8)} reset to pending after pre-execution failure: ${err instanceof Error ? err.message : String(err)}`);
    }
    throw err;
  }
}
```

**Step 2: Verify existing `executeNode` is unchanged**

`executeNode` remains as-is — it's still used by manual mode routes. `executeNodeDirect` is the new alternative for autopilot.

**Step 3: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS (no new errors)

**Step 4: Commit**

```
feat: export executeNodeDirect for queue-bypass node execution
```

---

### Task 2: Rewrite `executeDecision` in `autopilot.ts` to use direct calls

Replace all `enqueueBlueprintTask` wrappers with direct function calls. Since the autopilot loop will itself run inside the queue, these functions execute synchronously within that queue slot.

**Files:**
- Modify: `backend/src/autopilot.ts` — `executeDecision` function and imports

**Step 1: Update imports**

Replace import of `executeNode` with `executeNodeDirect`. Also keep `enqueueBlueprintTask` in imports since it's still referenced by `addPendingTask` usage pattern, but the function is no longer called from `executeDecision`.

Change the import block from `plan-executor.js`:

```typescript
import {
  getQueueInfo,
  executeNodeDirect,
  resumeNodeSession,
  evaluateNodeCompletion,
  enqueueBlueprintTask,
  addPendingTask,
  removePendingTask,
} from "./plan-executor.js";
```

Note: `executeNode` replaced by `executeNodeDirect`. `enqueueBlueprintTask` is kept but only used in the new `runAutopilotLoop` wrapper (Task 4) — actually we'll remove it from this file entirely in Task 4. For now, remove it from the import.

Actually, clean up: remove `enqueueBlueprintTask` from autopilot imports entirely. It won't be needed after this change — the callers in `plan-routes.ts` will handle enqueuing.

```typescript
import {
  getQueueInfo,
  executeNodeDirect,
  resumeNodeSession,
  evaluateNodeCompletion,
  addPendingTask,
  removePendingTask,
} from "./plan-executor.js";
```

**Step 2: Rewrite `executeDecision` — async tool cases**

For each case that previously used `enqueueBlueprintTask` + fire-and-forget:

**`run_node`**: Replace `enqueueBlueprintTask(blueprintId, async () => { await executeNode(...) })` with:
```typescript
case "run_node": {
  const nodeId = p.nodeId as string;
  updateMacroNode(blueprintId, nodeId, { status: "queued" });
  addPendingTask(blueprintId, { type: "run", nodeId, queuedAt: new Date().toISOString() });
  try {
    await executeNodeDirect(blueprintId, nodeId);
  } catch (err) {
    log.error(`Autopilot run_node ${nodeId} failed: ${err instanceof Error ? err.message : err}`);
  } finally {
    removePendingTask(blueprintId, nodeId, "run");
  }
  return { success: true, message: `Executed node ${nodeId}` };
}
```

**`resume_node`**: Replace enqueue with direct call:
```typescript
case "resume_node": {
  const nodeId = p.nodeId as string;
  const feedback = p.feedback as string | undefined;
  const executions = getExecutionsForNode(nodeId);
  const latestWithSession = executions
    .filter((e) => e.sessionId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  if (!latestWithSession) {
    return { success: false, message: `No resumable session found for node ${nodeId}`, error: "no_session" };
  }
  incrementResumeCount(blueprintId, nodeId);
  if (feedback) {
    updateMacroNode(blueprintId, nodeId, { prompt: feedback });
  }
  addPendingTask(blueprintId, { type: "run", nodeId, queuedAt: new Date().toISOString() });
  updateMacroNode(blueprintId, nodeId, { status: "queued" });
  try {
    await resumeNodeSession(blueprintId, nodeId, latestWithSession.id);
  } catch (err) {
    log.error(`Autopilot resume_node ${nodeId} failed: ${err instanceof Error ? err.message : err}`);
  } finally {
    removePendingTask(blueprintId, nodeId, "run");
  }
  return { success: true, message: `Resumed node ${nodeId}` };
}
```

**`evaluate_node`**: Direct call:
```typescript
case "evaluate_node": {
  const nodeId = p.nodeId as string;
  addPendingTask(blueprintId, { type: "evaluate", nodeId, queuedAt: new Date().toISOString() });
  try {
    await evaluateNodeCompletion(blueprintId, nodeId);
  } catch (err) {
    log.error(`Autopilot evaluate_node ${nodeId} failed: ${err instanceof Error ? err.message : err}`);
  } finally {
    removePendingTask(blueprintId, nodeId, "evaluate");
  }
  return { success: true, message: `Evaluated node ${nodeId}` };
}
```

**`reevaluate_node`**: Same pattern:
```typescript
case "reevaluate_node": {
  const nodeId = p.nodeId as string;
  addPendingTask(blueprintId, { type: "reevaluate", nodeId, queuedAt: new Date().toISOString() });
  try {
    await evaluateNodeCompletion(blueprintId, nodeId);
  } catch (err) {
    log.error(`Autopilot reevaluate_node ${nodeId} failed: ${err instanceof Error ? err.message : err}`);
  } finally {
    removePendingTask(blueprintId, nodeId, "reevaluate");
  }
  return { success: true, message: `Reevaluated node ${nodeId}` };
}
```

**`enrich_node`**: Direct call:
```typescript
case "enrich_node": {
  const nodeId = p.nodeId as string;
  addPendingTask(blueprintId, { type: "enrich", nodeId, queuedAt: new Date().toISOString() });
  try {
    await evaluateNodeCompletion(blueprintId, nodeId);
  } catch (err) {
    log.error(`Autopilot enrich_node ${nodeId} failed: ${err instanceof Error ? err.message : err}`);
  } finally {
    removePendingTask(blueprintId, nodeId, "enrich");
  }
  return { success: true, message: `Enriched node ${nodeId}` };
}
```

**`split_node`**: Direct call:
```typescript
case "split_node": {
  const nodeId = p.nodeId as string;
  addPendingTask(blueprintId, { type: "split", nodeId, queuedAt: new Date().toISOString() });
  try {
    await evaluateNodeCompletion(blueprintId, nodeId);
  } catch (err) {
    log.error(`Autopilot split_node ${nodeId} failed: ${err instanceof Error ? err.message : err}`);
  } finally {
    removePendingTask(blueprintId, nodeId, "split");
  }
  return { success: true, message: `Split node ${nodeId}` };
}
```

**`smart_dependencies`**: Direct call:
```typescript
case "smart_dependencies": {
  const nodeId = p.nodeId as string;
  addPendingTask(blueprintId, { type: "smart_deps", nodeId, queuedAt: new Date().toISOString() });
  try {
    await evaluateNodeCompletion(blueprintId, nodeId);
  } catch (err) {
    log.error(`Autopilot smart_dependencies ${nodeId} failed: ${err instanceof Error ? err.message : err}`);
  } finally {
    removePendingTask(blueprintId, nodeId, "smart_deps");
  }
  return { success: true, message: `Computed dependencies for node ${nodeId}` };
}
```

**`coordinate`**: Direct call:
```typescript
case "coordinate": {
  addPendingTask(blueprintId, { type: "coordinate", queuedAt: new Date().toISOString() });
  try {
    await coordinateBlueprint(blueprintId);
  } catch (err) {
    log.error(`Autopilot coordinate failed: ${err instanceof Error ? err.message : err}`);
  } finally {
    removePendingTask(blueprintId, undefined, "coordinate");
  }
  return { success: true, message: "Coordination complete" };
}
```

**`convene`**: Direct call (keep dynamic import for convene):
```typescript
case "convene": {
  addPendingTask(blueprintId, { type: "convene", queuedAt: new Date().toISOString() });
  try {
    const { createConveneSession } = await import("./plan-db.js");
    const { executeConveneSession } = await import("./plan-convene.js");
    const topic = p.topic as string;
    const roleIds = p.roleIds as string[];
    const session = createConveneSession(blueprintId, topic, roleIds);
    await executeConveneSession(session.id);
  } catch (err) {
    log.error(`Autopilot convene failed: ${err instanceof Error ? err.message : err}`);
  } finally {
    removePendingTask(blueprintId, undefined, "convene");
  }
  return { success: true, message: "Convene session complete" };
}
```

**`reevaluate_all`**: Direct sequential call:
```typescript
case "reevaluate_all": {
  const blueprint = getBlueprint(blueprintId);
  if (!blueprint) return { success: false, message: "Blueprint not found", error: "not_found" };
  const completedNodes = blueprint.nodes.filter((n) => n.status === "done");
  if (completedNodes.length === 0) {
    return { success: false, message: "No completed nodes to reevaluate", error: "no_nodes" };
  }
  for (const n of completedNodes) {
    addPendingTask(blueprintId, { type: "reevaluate", nodeId: n.id, queuedAt: new Date().toISOString() });
  }
  try {
    for (const n of completedNodes) {
      await evaluateNodeCompletion(blueprintId, n.id);
    }
  } catch (err) {
    log.error(`Autopilot reevaluate_all failed: ${err instanceof Error ? err.message : err}`);
  } finally {
    for (const n of completedNodes) {
      removePendingTask(blueprintId, n.id, "reevaluate");
    }
  }
  return { success: true, message: `Reevaluated ${completedNodes.length} nodes` };
}
```

**Step 3: Remove `waitForCompletion` from all return values**

All `ExecutionResult` returns no longer need `waitForCompletion: true`. Remove this field from all returns. The `waitForCompletion` field on `ExecutionResult` interface can be kept for backward compat but is no longer set.

**Step 4: Remove `waitForTaskCompletion` function entirely**

Delete the `waitForTaskCompletion` function and its constants (`POLL_INTERVAL_MS`, `TASK_TIMEOUT_MS`).

**Step 5: Remove `waitForCompletion` usage in `runAutopilotLoop`**

In `runAutopilotLoop`, remove the block at line ~1008-1011:
```typescript
// DELETE THIS:
if (result.waitForCompletion) {
  await waitForTaskCompletion(blueprintId);
}
```

Since all async operations in `executeDecision` now `await` directly, the decision is fully complete when `executeDecision` returns.

**Step 6: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 7: Commit**

```
fix: autopilot executeDecision uses direct calls instead of enqueueing

Eliminates deadlock where autopilot enqueued tasks into the same
workspace queue it was waiting on. All async operations now execute
directly within the autopilot's queue slot.
```

---

### Task 3: Wrap `runAutopilotLoop` in `enqueueBlueprintTask` at all call sites

The autopilot loop must run inside the workspace queue so it has exclusive access to the workspace. All 4 call sites need updating.

**Files:**
- Modify: `backend/src/plan-routes.ts:345, 2163, 2543`
- Modify: `backend/src/plan-executor.ts:1946-1951`

**Step 1: Update `plan-routes.ts` — autopilot toggle (PUT /api/blueprints/:id)**

At line ~344, change:
```typescript
// BEFORE:
if (switchingToAutopilot) {
  runAutopilotLoop(req.params.id).catch((err) => {
    log.error(`Autopilot loop failed for ${req.params.id}: ${err instanceof Error ? err.message : err}`);
  });
}

// AFTER:
if (switchingToAutopilot) {
  enqueueBlueprintTask(req.params.id, () => runAutopilotLoop(req.params.id)).catch((err) => {
    log.error(`Autopilot loop failed for ${req.params.id}: ${err instanceof Error ? err.message : err}`);
  });
}
```

Add `enqueueBlueprintTask` to the import from `./plan-executor.js` if not already present (it likely is — verify).

**Step 2: Update `plan-routes.ts` — POST /api/blueprints/:id/run-all**

At line ~2162, change:
```typescript
// BEFORE:
if (blueprint.executionMode === "autopilot") {
  runAutopilotLoop(req.params.id).catch((err) => {
    log.error(`Autopilot loop failed for ${req.params.id}: ${err instanceof Error ? err.message : err}`);
  });
}

// AFTER:
if (blueprint.executionMode === "autopilot") {
  enqueueBlueprintTask(req.params.id, () => runAutopilotLoop(req.params.id)).catch((err) => {
    log.error(`Autopilot loop failed for ${req.params.id}: ${err instanceof Error ? err.message : err}`);
  });
}
```

**Step 3: Update `plan-routes.ts` — POST /api/plans/:id/run-all (legacy)**

At line ~2542, same pattern:
```typescript
if (blueprint.executionMode === "autopilot") {
  enqueueBlueprintTask(req.params.id, () => runAutopilotLoop(req.params.id)).catch((err) => {
    log.error(`Autopilot loop failed for ${req.params.id}: ${err instanceof Error ? err.message : err}`);
  });
}
```

**Step 4: Update `plan-executor.ts` — startup recovery**

At line ~1946, change:
```typescript
// BEFORE:
import("./autopilot.js").then(({ runAutopilotLoop }) => {
  for (const bp of autopilotBlueprints) {
    recoveryLog.info(`Re-entering autopilot loop for blueprint ${bp.id.slice(0, 8)} after recovery`);
    runAutopilotLoop(bp.id).catch((err) => {
      recoveryLog.error(`Autopilot recovery failed for ${bp.id.slice(0, 8)}: ${err instanceof Error ? err.message : err}`);
    });
  }
})

// AFTER:
import("./autopilot.js").then(({ runAutopilotLoop }) => {
  for (const bp of autopilotBlueprints) {
    recoveryLog.info(`Re-entering autopilot loop for blueprint ${bp.id.slice(0, 8)} after recovery`);
    enqueueBlueprintTask(bp.id, () => runAutopilotLoop(bp.id)).catch((err) => {
      recoveryLog.error(`Autopilot recovery failed for ${bp.id.slice(0, 8)}: ${err instanceof Error ? err.message : err}`);
    });
  }
})
```

**Step 5: Add `addPendingTask` for autopilot visibility in `runAutopilotLoop`**

At the start of `runAutopilotLoop`, after `updateBlueprint(blueprintId, { status: "running" })`, add a pending task so the frontend can see that autopilot is active:

```typescript
addPendingTask(blueprintId, { type: "autopilot" as PendingTask["type"], queuedAt: new Date().toISOString() });
```

And at every exit point of the loop (all `break` paths + natural end), remove it:
```typescript
removePendingTask(blueprintId, undefined, "autopilot");
```

This requires adding `"autopilot"` to the `PendingTask.type` union in `plan-executor.ts`.

**Step 6: Add `"autopilot"` to `PendingTask.type` union**

In `plan-executor.ts`, update:
```typescript
// BEFORE:
export interface PendingTask {
  type: "run" | "reevaluate" | "enrich" | "generate" | "split"
    | "smart_deps" | "evaluate" | "coordinate" | "convene";
  ...
}

// AFTER:
export interface PendingTask {
  type: "run" | "reevaluate" | "enrich" | "generate" | "split"
    | "smart_deps" | "evaluate" | "coordinate" | "convene"
    | "autopilot";
  ...
}
```

**Step 7: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 8: Commit**

```
fix: wrap runAutopilotLoop in enqueueBlueprintTask at all call sites

Autopilot loop now owns the workspace queue slot for its entire
lifetime, preventing concurrent agent sessions on the same workspace.
```

---

### Task 4: Update unit tests (`autopilot.test.ts`)

The unit tests mock `enqueueBlueprintTask` and `executeNode`. After the refactor, `executeDecision` no longer calls `enqueueBlueprintTask` or `executeNode` — it calls `executeNodeDirect`, `evaluateNodeCompletion`, `resumeNodeSession`, etc. directly.

**Files:**
- Modify: `backend/src/__tests__/autopilot.test.ts`

**Step 1: Update the `plan-executor.js` mock**

Replace `executeNode` with `executeNodeDirect` in the mock. Remove `enqueueBlueprintTask` from the mock (it's no longer called by autopilot). Keep `addPendingTask`/`removePendingTask` since those are still called.

```typescript
vi.mock("../plan-executor.js", () => ({
  getQueueInfo: vi.fn(),
  executeNodeDirect: vi.fn(async () => {}),
  resumeNodeSession: vi.fn(async () => {}),
  evaluateNodeCompletion: vi.fn(async () => {}),
  addPendingTask: vi.fn(),
  removePendingTask: vi.fn(),
}));
```

Update the corresponding import:
```typescript
import {
  getQueueInfo,
  executeNodeDirect,
  resumeNodeSession,
  evaluateNodeCompletion,
  addPendingTask,
  removePendingTask,
} from "../plan-executor.js";
```

**Step 2: Update `run_node` test assertions**

The `run_node` test currently checks `enqueueBlueprintTask` was called. Update to check `executeNodeDirect` was called instead. Also: `waitForCompletion` is no longer returned.

```typescript
it("run_node: executes node directly", async () => {
  const decision: AutopilotDecision = {
    reasoning: "Node is ready",
    action: "run_node",
    params: { nodeId: "n1" },
  };
  const result = await executeDecision("bp-1", decision);

  expect(result.success).toBe(true);
  expect(addPendingTask).toHaveBeenCalledWith("bp-1", expect.objectContaining({ type: "run", nodeId: "n1" }));
  expect(updateMacroNode).toHaveBeenCalledWith("bp-1", "n1", { status: "queued" });
  expect(executeNodeDirect).toHaveBeenCalledWith("bp-1", "n1");
  expect(removePendingTask).toHaveBeenCalledWith("bp-1", "n1", "run");
});
```

**Step 3: Update `resume_node` test assertions**

No longer checks `enqueueBlueprintTask`. Checks `resumeNodeSession` called directly.

**Step 4: Update `evaluate_node`, `reevaluate_node`, `enrich_node`, `split_node`, `smart_dependencies` test assertions**

All should check `evaluateNodeCompletion` is called directly (no enqueue). Remove `waitForCompletion` assertions.

**Step 5: Update `coordinate` and `convene` test assertions**

Check direct calls to `coordinateBlueprint` / `createConveneSession` + `executeConveneSession`.

**Step 6: Update `reevaluate_all` test assertions**

Check that `evaluateNodeCompletion` is called N times directly, and `removePendingTask` is called for each.

**Step 7: Run unit tests**

Run: `npx vitest run src/__tests__/autopilot.test.ts`
Expected: All tests PASS

**Step 8: Commit**

```
test: update autopilot unit tests for direct-call architecture
```

---

### Task 5: Update integration tests (`autopilot-integration.test.ts`)

The integration tests mock `plan-executor.js` with `enqueueBlueprintTask: vi.fn(async (_bpId, task) => task())`. After the refactor, autopilot no longer calls `enqueueBlueprintTask`, so this mock is unused by autopilot. But `executeNodeDirect` needs to be mocked instead.

**Files:**
- Modify: `backend/src/__tests__/autopilot-integration.test.ts`

**Step 1: Update the `plan-executor.js` mock**

Add `executeNodeDirect` to the mock. The existing `executeNode` mock can remain for other tests but autopilot will now call `executeNodeDirect`:

```typescript
const mockExecuteNodeDirect = vi.fn();
vi.mock("../plan-executor.js", () => ({
  getQueueInfo: vi.fn(() => ({ running: false, queueLength: 0, pendingTasks: [] })),
  executeNode: mockExecuteNode,
  executeNodeDirect: mockExecuteNodeDirect,
  resumeNodeSession: mockResumeNodeSession,
  evaluateNodeCompletion: mockEvaluateNodeCompletion,
  enqueueBlueprintTask: vi.fn(async (_bpId: string, task: () => Promise<unknown>) => task()),
  addPendingTask: vi.fn(),
  removePendingTask: vi.fn(),
}));
```

**Step 2: Update `beforeEach` to reset and configure `mockExecuteNodeDirect`**

```typescript
beforeEach(() => {
  mockRunSession.mockReset();
  mockExecuteNode.mockReset();
  mockExecuteNodeDirect.mockReset();
  mockResumeNodeSession.mockReset();
  mockEvaluateNodeCompletion.mockReset();
  vi.clearAllMocks();

  // Default: executeNodeDirect marks node as done in real DB
  mockExecuteNodeDirect.mockImplementation(async (bpId: string, nodeId: string) => {
    db.updateMacroNode(bpId, nodeId, { status: "done" });
  });
  mockExecuteNode.mockImplementation(async (bpId: string, nodeId: string) => {
    db.updateMacroNode(bpId, nodeId, { status: "done" });
  });
  mockResumeNodeSession.mockImplementation(async (bpId: string, nodeId: string) => {
    db.updateMacroNode(bpId, nodeId, { status: "done" });
  });
  mockEvaluateNodeCompletion.mockImplementation(async () => {});
});
```

**Step 3: Run integration tests**

Run: `npx vitest run src/__tests__/autopilot-integration.test.ts`
Expected: All tests PASS

**Step 4: Commit**

```
test: update autopilot integration tests for direct-call architecture
```

---

### Task 6: Full verification

**Step 1: Run all backend tests**

Run: `npx vitest run`
Expected: All tests PASS

**Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 3: Run frontend type check**

Run: `cd ../frontend && npx tsc --noEmit`
Expected: PASS (the `PendingTask.type` union is mirrored in `frontend/src/lib/api.ts` — check if `"autopilot"` needs adding there)

**Step 4: If frontend type mirror needs updating**

In `frontend/src/lib/api.ts`, find the `PendingTask` interface and add `"autopilot"` to its `type` union to match backend.

**Step 5: Final commit**

```
fix: resolve autopilot workspace queue deadlock

The autopilot loop now runs inside the workspace queue via
enqueueBlueprintTask, owning the queue slot exclusively. Internal
operations (executeNodeDirect, evaluateNodeCompletion, etc.) run
directly without re-enqueuing, eliminating the deadlock where
queued tasks could never execute.
```

---

## Appendix: Why This Works

Before:
```
runAutopilotLoop()           [NOT in queue]
  ├── callAgentForDecision()   [spawns CLI - not in queue]
  ├── executeDecision()
  │   └── enqueueBlueprintTask(executeNode)  [enqueues into queue]
  └── waitForTaskCompletion()  [polls queue - but nobody drains it]
      DEADLOCK: autopilot waits for queue to drain,
                but queue won't drain until current task (nothing) finishes
```

After:
```
enqueueBlueprintTask(runAutopilotLoop)  [OWNS the queue slot]
  ├── callAgentForDecision()              [spawns CLI - within queue slot]
  ├── executeDecision()
  │   └── await executeNodeDirect()       [direct call - no enqueue]
  └── next iteration...                   [immediate - no polling needed]
```
