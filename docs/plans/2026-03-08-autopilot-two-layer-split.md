# Autopilot Two-Layer Split Implementation Plan

**Goal:** Split the autopilot into a User Agent (user intent via API) and FSD Loop (node execution) to eliminate repetitive loops.

**Architecture:** New `user-agent.ts` runs a Claude CLI session that calls ClawUI REST API endpoints (same as frontend). Existing `autopilot.ts` is simplified to a pure FSD loop that yields when user messages arrive. Both share the workspace queue.

**Tech Stack:** TypeScript, Express, SQLite (better-sqlite3), Vitest

**Design doc:** `docs/plans/2026-03-08-autopilot-two-layer-split-design.md`

---

### Task 1: Rollback session-local patches from autopilot.ts

Remove all temporary fixes added during the debugging session before starting the refactor: `recentLog` parameter, `WORK_ACTIONS`/`isWorkAction`, auto-acknowledge logic, `messageGraceIterations`, 2-step cycle detection, and prompt changes.

**Files:**
- Modify: `backend/src/autopilot.ts`
- Modify: `backend/src/__tests__/autopilot.test.ts`
- Modify: `backend/src/__tests__/autopilot-integration.test.ts`

**Steps:**

1. Revert `buildAutopilotPrompt` signature — remove `recentLog` parameter
2. Remove `historySection` from prompt builder and its injection into the template
3. Revert user messages section in prompt — restore original `[${m.id}]` format, undo "auto-acknowledged" changes
4. Revert `TOOL_DESCRIPTIONS` — restore `acknowledge_message` and `read_user_messages` to original text
5. Revert workflow section — restore "Check user messages first" as step 1
6. Revert guidelines section — restore original "process them first" text
7. Remove `WORK_ACTIONS`, `isWorkAction`, and the work action classification section entirely
8. Revert `checkSameActionRepeat` to original 3-action check (remove 2-step cycle detection)
9. Remove `messageGraceIterations` from loop — remove declaration, grace period decrement, exit condition change; restore exit to `allNodesDone && pendingMessages.length === 0`
10. Remove auto-acknowledge block from loop (lines ~1547-1560)
11. Remove `recentLogEntries` fetch from loop — remove `getAutopilotLog` call and `recentLog` argument from `buildAutopilotPrompt` call
12. Revert test files — restore assertions to match original format (`[m1]`, `acknowledge_message(messageId)`, etc.)
13. Run tests: `cd backend && npx tsc --noEmit && npx vitest run` — all tests pass
14. Commit: `revert: remove session-local autopilot patches before two-layer refactor`

---

### Task 2: Create `user-agent.ts`

The core new file. Much simpler than v1 design — just a prompt builder + `runSession` wrapper.

**Files:**
- Create: `backend/src/user-agent.ts`

**Steps:**

1. Create file with imports:
```typescript
import { getBlueprint, getUnacknowledgedMessages, acknowledgeMessage, createAutopilotMessage } from "./plan-db.js";
import type { AutopilotMessage } from "./plan-db.js";
import { enqueueBlueprintTask, addPendingTask, removePendingTask } from "./plan-executor.js";
import { getActiveRuntime } from "./agent-runtime.js";
import { getApiBaseUrl, getAuthParam } from "./plan-generator.js";
import { createLogger } from "./logger.js";

// Side-effect imports: ensure all runtimes are registered
import "./agent-claude.js";
import "./agent-pimono.js";
import "./agent-openclaw.js";
import "./agent-codex.js";

const log = createLogger("user-agent");
```

Note: No imports from `autopilot.ts` or `plan-operations.ts` — the User Agent calls API endpoints, not internal functions. Only `triggerFsdLoopIfNeeded` is imported from `autopilot.ts` (added in Task 3).

2. Implement `buildUserAgentPrompt(blueprintId, messages)`:
- Include: role description, blueprint context, node summary, user messages, API base URL + auth, endpoint documentation, behavioral instructions
- See design doc for full prompt template
- Endpoints are hardcoded in the prompt with the actual `blueprintId` interpolated so Claude can copy-paste curl commands

3. Implement `handleUserMessage(blueprintId)`:
```typescript
export async function handleUserMessage(blueprintId: string): Promise<void> {
  const messages = getUnacknowledgedMessages(blueprintId);
  if (messages.length === 0) return;

  const blueprint = getBlueprint(blueprintId);
  if (!blueprint) return;

  addPendingTask(blueprintId, { type: "autopilot", queuedAt: new Date().toISOString() });

  try {
    const prompt = buildUserAgentPrompt(blueprintId, messages);
    const runtime = getActiveRuntime();
    const output = await runtime.runSession(prompt, blueprint.projectCwd);
    log.info(`User agent session completed (${output.length} chars)`);

    for (const msg of messages) {
      acknowledgeMessage(msg.id);
    }
  } catch (err) {
    log.error(`User agent failed: ${err instanceof Error ? err.message : err}`);
    createAutopilotMessage(blueprintId, "assistant",
      "Failed to process your message. Please try again or switch to manual mode.");
  } finally {
    removePendingTask(blueprintId, undefined, "autopilot");
  }

  // Dynamic import to avoid circular dependency
  const { triggerFsdLoopIfNeeded } = await import("./autopilot.js");
  triggerFsdLoopIfNeeded(blueprintId);
}
```

4. Implement `triggerUserAgent(blueprintId)`:
```typescript
export function triggerUserAgent(blueprintId: string): void {
  const bp = getBlueprint(blueprintId);
  if (!bp) return;
  const isAutopilot = bp.executionMode === "autopilot" || bp.executionMode === "fsd";
  if (!isAutopilot) return;

  enqueueBlueprintTask(blueprintId, () => handleUserMessage(blueprintId)).catch((err) => {
    log.error(`User agent trigger failed: ${err instanceof Error ? err.message : err}`);
  });
}
```

5. Run typecheck: `cd backend && npx tsc --noEmit` — may have import errors for `triggerFsdLoopIfNeeded` if using static import (use dynamic import to avoid). Verify no syntax errors.

6. Commit: `feat: add user-agent.ts — User Agent layer for translating user intent to API operations`

---

### Task 3: Simplify autopilot.ts to pure FSD Loop

**Files:**
- Modify: `backend/src/autopilot.ts`

**Steps:**

1. Add `triggerFsdLoopIfNeeded` export:
```typescript
export function triggerFsdLoopIfNeeded(blueprintId: string): void {
  const bp = getBlueprint(blueprintId);
  if (!bp) return;
  const isAutopilot = bp.executionMode === "autopilot" || bp.executionMode === "fsd";
  if (!isAutopilot) return;
  const queueInfo = getQueueInfo(blueprintId);
  const hasLoopTask = queueInfo.pendingTasks.some((t) => t.type === "autopilot");
  if (!hasLoopTask && !queueInfo.running) {
    enqueueBlueprintTask(blueprintId, () => runAutopilotLoop(blueprintId)).catch((err) => {
      log.error(`FSD loop failed: ${err instanceof Error ? err.message : err}`);
    });
  }
}
```

2. Remove `userMessages` parameter from `buildAutopilotPrompt` — remove param, `userMessageSection` variable, and `${userMessageSection}` from template

3. Remove user message tools from `TOOL_DESCRIPTIONS`: `acknowledge_message`, `read_user_messages`, `send_message`

4. Remove user-message guidance from workflow and guidelines sections

5. Simplify exit condition and add yield check in `runAutopilotLoop`:
```typescript
if (state.allNodesDone) {
  logAutopilot(blueprintId, iteration, state.summary, "All nodes complete", "loop_exit");
  break;
}

const pendingMessages = getUnacknowledgedMessages(blueprintId);
if (pendingMessages.length > 0) {
  logAutopilot(blueprintId, iteration, state.summary, "yield", "Pending user messages");
  log.info(`FSD loop yielding: ${pendingMessages.length} pending message(s)`);
  break;
}
```

6. Remove `pendingMessages` from `buildAutopilotPrompt` call

7. Run typecheck: `cd backend && npx tsc --noEmit` — pass

8. Commit: `refactor: simplify autopilot.ts to pure FSD loop with yield`

---

### Task 4: Update plan-routes.ts to use new trigger functions

**Files:**
- Modify: `backend/src/plan-routes.ts`

**Steps:**

1. Update imports — add `triggerFsdLoopIfNeeded` from `autopilot.js`, add `triggerUserAgent` from `user-agent.js`

2. Remove `triggerAutopilotIfNeeded` function

3. Replace all `triggerAutopilotIfNeeded` call sites with `triggerUserAgent`:
   - POST /messages
   - Enrich endpoint
   - Split endpoint
   - Smart-deps endpoint
   - Reevaluate-all endpoint
   - Generate nodes endpoint

4. Verify mode-switch and resume paths still use `runAutopilotLoop` directly (no change needed)

5. Run typecheck: `cd backend && npx tsc --noEmit` — pass

6. Commit: `refactor: replace triggerAutopilotIfNeeded with triggerUserAgent`

---

### Task 5: Write user-agent tests

**Files:**
- Create: `backend/src/__tests__/user-agent.test.ts`

**Tests to write:**

1. `buildUserAgentPrompt`:
   - Includes user message content
   - Includes blueprint state (node titles, status)
   - Includes API base URL and auth param
   - Includes API endpoint documentation (POST /nodes, etc.)
   - Does NOT include FSD-specific tools (run_node, evaluate_node, coordinate)

2. `handleUserMessage`:
   - Returns early when no unacknowledged messages (idempotent)
   - Calls `runSession` with prompt and `projectCwd`
   - Acknowledges all messages after session completes
   - On `runSession` failure: does NOT acknowledge, creates error message
   - Calls `triggerFsdLoopIfNeeded` after completion

3. `triggerUserAgent`:
   - Enqueues task in autopilot/FSD mode
   - Returns early in manual mode
   - Returns early if blueprint not found

**Mocks needed:**
```typescript
vi.mock("../plan-db.js", () => ({ ... }));
vi.mock("../plan-executor.js", () => ({ enqueueBlueprintTask: vi.fn((_, task) => task()), ... }));
vi.mock("../agent-runtime.js", () => ({ getActiveRuntime: vi.fn(() => ({ runSession: vi.fn(async () => "output") })) }));
vi.mock("../plan-generator.js", () => ({ getApiBaseUrl: vi.fn(() => "http://localhost:3001"), getAuthParam: vi.fn(() => "auth=test-token") }));
vi.mock("../autopilot.js", () => ({ triggerFsdLoopIfNeeded: vi.fn() }));
// Side-effect mocks
vi.mock("../agent-claude.js", () => ({}));
vi.mock("../agent-pimono.js", () => ({}));
vi.mock("../agent-openclaw.js", () => ({}));
vi.mock("../agent-codex.js", () => ({}));
```

Run: `cd backend && npx vitest run src/__tests__/user-agent.test.ts` — all pass

Commit: `test: add user-agent unit tests`

---

### Task 6: Update autopilot tests

**Files:**
- Modify: `backend/src/__tests__/autopilot.test.ts`
- Modify: `backend/src/__tests__/autopilot-integration.test.ts`

**Steps:**

1. Update `buildAutopilotPrompt` tests:
   - Remove tests for user message injection (no longer exists)
   - Add test: prompt does NOT contain user message section
   - Add test: prompt does NOT contain `acknowledge_message` / `read_user_messages` / `send_message`

2. Update integration tests:
   - Remove/update message lifecycle test (FSD loop no longer processes messages)
   - Add test: FSD loop yields when unacknowledged messages exist
   - Remove references to `messageGraceIterations`, `WORK_ACTIONS`, auto-acknowledge

3. Run: `cd backend && npx vitest run` — all pass

4. Commit: `test: update autopilot tests for FSD-only loop`

---

### Task 7: Update plan-routes tests

**Files:**
- Modify: `backend/src/__tests__/plan-routes.test.ts`

**Steps:**

1. Add mock for `user-agent.js`: `vi.mock("../user-agent.js", () => ({ triggerUserAgent: vi.fn() }))`
2. Update autopilot mock to include `triggerFsdLoopIfNeeded`
3. Update POST /messages test to verify `triggerUserAgent` is called
4. Update any other tests referencing `triggerAutopilotIfNeeded`

Run: `cd backend && npx vitest run src/__tests__/plan-routes.test.ts` — all pass

Commit: `test: update plan-routes tests for triggerUserAgent`

---

### Task 8: Full integration test and typecheck

**Files:** None (verification only)

1. `cd backend && npx tsc --noEmit` — 0 errors
2. `cd backend && npx vitest run` — all pass
3. `cd frontend && npx vitest run` — all pass (sanity check)
4. `cd frontend && npx tsc --noEmit` — 0 errors

Commit only if fixes were needed.

---

### Task 9: Update CLAUDE.md gotchas

**Files:**
- Modify: `CLAUDE.md`

**Steps:**

1. Replace "Autopilot tool palette" gotcha with two-layer description:
   - User Agent (`user-agent.ts`): Claude CLI session calling REST API endpoints, handles user messages
   - FSD Loop (`autopilot.ts`): internal node execution, yields on unacknowledged messages

2. Replace `triggerAutopilotIfNeeded` gotcha with:
   - `triggerUserAgent` (user messages, AI ops buttons) → `user-agent.ts`
   - `triggerFsdLoopIfNeeded` (node execution) → `autopilot.ts`
   - Resume/mode-switch → `runAutopilotLoop` directly

3. Add gotcha: "User Agent calls REST API, not internal functions" — the User Agent is equivalent to a human user on the web UI; it calls the same endpoints as the frontend via bash/curl

4. Remove mentions of auto-acknowledge, `messageGraceIterations`, `WORK_ACTIONS`

5. Commit: `docs: update CLAUDE.md gotchas for two-layer autopilot architecture`
