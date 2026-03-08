# Autopilot Two-Layer Split Design

**Date**: 2026-03-08
**Status**: Approved

## Problem

The current autopilot loop (`runAutopilotLoop` in `autopilot.ts`) uses a single LLM call per iteration to handle two fundamentally different responsibilities:

1. **Understanding user intent** — processing messages from BlueprintChat (create features, split nodes, answer questions)
2. **Executing the FSD loop** — running nodes, evaluating, coordinating, managing the blueprint lifecycle

This causes:
- **Repetitive loops**: The LLM sees unacknowledged user messages in every iteration, repeatedly creating duplicate nodes or sending duplicate replies instead of acknowledging and moving on.
- **Priority confusion**: The LLM can't decide whether to respond to the user or execute nodes, leading to `send_message` loops where it announces plans but never acts.
- **Bloated prompts**: A single prompt must contain user message handling instructions, FSD execution strategy, tool descriptions for both domains, safeguard rules, memory, and workflow guidelines.

## Solution

Split into two independent components with separate LLM calls, prompts, and tool palettes:

- **Message Handler** (`message-handler.ts`) — processes user messages, translates intent into actions
- **FSD Loop** (`autopilot.ts`, simplified) — pure node execution engine

## Architecture

### Control Flow

```
User sends message (BlueprintChat / API button)
  │
  ▼
plan-routes.ts: POST /api/blueprints/:id/messages
  │  createAutopilotMessage(blueprintId, "user", content)
  │  triggerMessageHandler(blueprintId)
  │
  ▼
workspace queue: handleUserMessage(blueprintId)     ← message-handler.ts
  │  1. Read all unacknowledged messages
  │  2. Build Message Handler prompt (messages + blueprint state + MH tools)
  │  3. callAgentForDecision → LLM returns action(s)
  │  4. Execute actions (create_node / run_direct / split / enrich / send_message)
  │  5. Acknowledge all processed messages
  │  6. triggerFsdLoopIfNeeded(blueprintId)
  │
  ▼
workspace queue: runFsdLoop(blueprintId)            ← autopilot.ts (simplified)
  │  while (has pending nodes) {
  │    Check unacknowledged messages → if any, break (yield)
  │    Pick next node → run_node → evaluate
  │  }
  │  If yielded → Message Handler processes messages, then re-triggers FSD loop
  │  If all nodes done → loop ends normally
```

### Key Principles

- **User message entry points only trigger Message Handler**, never FSD Loop directly
- **FSD Loop is triggered by Message Handler** after creating/modifying nodes
- **Yield is just `break`** — no signal mechanism needed, workspace queue serializes naturally
- **Both share the workspace queue** — no cross-queue coordination needed

## Message Handler (`message-handler.ts`)

### Prompt

Small and focused. Contains only:
- User message content (may be multiple)
- Current blueprint state (title, description, all nodes with id/seq/title/status)
- Available tools list

Does NOT contain: FSD execution strategy, workflow rhythm, safeguard rules, reflection, memory.

### Tool Palette

```
Structural operations:
  create_node(title, description, dependsOn?, roles?)
  batch_create_nodes([...])
  update_node(nodeId, {title?, description?, prompt?})
  skip_node(nodeId, reason)

Direct execution:
  run_direct(prompt)        — simple tasks executed directly

AI Operations (user-triggered):
  split_node(nodeId)        — calls existing splitNodeInternal
  enrich_node(nodeId)       — calls existing enrichNodeInternal
  smart_deps(nodeId)        — calls existing smartDepsInternal
  reevaluate_all()          — calls existing reevaluateAllInternal

Communication:
  send_message(content)     — reply to user

Context:
  get_node_titles()         — understand current plan structure
  get_node_details(nodeId)  — understand specific node info
```

### Decision Format

Supports both single action and action arrays:

```json
// Single action
{
  "reasoning": "User wants a login feature, need 3 nodes",
  "action": "batch_create_nodes",
  "params": { "nodes": [...] }
}

// Multiple actions (reply + operate in one LLM call)
{
  "reasoning": "...",
  "actions": [
    { "action": "send_message", "params": { "content": "Got it, creating nodes..." } },
    { "action": "batch_create_nodes", "params": { "nodes": [...] } }
  ]
}
```

### Execution Logic

```typescript
export async function handleUserMessage(blueprintId: string): Promise<void> {
  const messages = getUnacknowledgedMessages(blueprintId);
  if (messages.length === 0) return;  // idempotent

  const state = buildMessageHandlerState(blueprintId);
  const prompt = buildMessageHandlerPrompt(state, messages);
  const decision = await callAgentForDecision(prompt, projectCwd);

  const actions = normalizeActions(decision);  // support single/multi action
  for (const action of actions) {
    await executeMessageAction(blueprintId, action);
  }

  for (const msg of messages) {
    acknowledgeMessage(msg.id);
  }

  triggerFsdLoopIfNeeded(blueprintId);
}
```

### Error Handling

On failure: don't acknowledge messages (preserved for retry), create an assistant message informing the user.

## FSD Loop Simplification (`autopilot.ts`)

### Removed

- User message injection (`userMessages` parameter, `userMessageSection`)
- `acknowledge_message` / `read_user_messages` / `send_message` tools
- Auto-acknowledge logic, `messageGraceIterations`, `WORK_ACTIONS`
- `recentLog` history injection
- All prompt guidance about "how to handle user messages"

### Retained

- Node execution: `run_node`, `resume_node`, `evaluate_node`
- Node CRUD (FSD autonomous): `create_node`, `update_node`, `skip_node`, `batch_create_nodes`, `reorder_nodes`
- AI Operations (FSD autonomous): `coordinate`, `convene`
- Context: `get_node_titles`, `get_node_details`, `get_node_handoff`
- Insight/Suggestion management
- Safeguards (same-action repeat, no-progress, resume cap)
- Reflection + memory
- `pause` / `complete`

### Yield Check

Added at the top of each iteration, after exit check:

```typescript
// Exit: all done
if (state.allNodesDone) {
  break;
}

// Yield: pending user messages — let Message Handler process them
const pendingMessages = getUnacknowledgedMessages(blueprintId);
if (pendingMessages.length > 0) {
  log.info(`FSD loop yielding: ${pendingMessages.length} pending message(s)`);
  break;
}
```

Exit condition simplified: `allNodesDone` only (no `pendingMessages` check needed).

## Route Layer Changes (`plan-routes.ts`)

### Two Trigger Functions

| Function | Defined in | Purpose |
|----------|-----------|---------|
| `triggerMessageHandler(blueprintId)` | `message-handler.ts` | Enqueue Message Handler for user/system messages |
| `triggerFsdLoopIfNeeded(blueprintId)` | `autopilot.ts` | Enqueue FSD Loop if nodes need execution |

### Call Site Mapping

| Scenario | Old | New |
|----------|-----|-----|
| POST /messages (user sends message) | `triggerAutopilotIfNeeded` | `triggerMessageHandler` |
| Enrich / Split / SmartDeps / Reevaluate (API button in autopilot mode) | `triggerAutopilotIfNeeded` | `triggerMessageHandler` |
| Generate nodes (API button in autopilot mode) | `triggerAutopilotIfNeeded` | `triggerMessageHandler` |
| Resume from pause | `runAutopilotLoop` | `runFsdLoop` |
| Mode switch to autopilot/FSD | `runAutopilotLoop` | `runFsdLoop` |

## Edge Cases

### FSD Loop running when user sends message

FSD Loop is in `run_node` (60s). User sends message → `triggerMessageHandler` → enqueue. Node finishes → next iteration detects unacknowledged messages → yield. Queue runs Message Handler → processes message → `triggerFsdLoopIfNeeded`. New FSD Loop starts. User waits at most one node execution.

### User sends multiple messages quickly

First `handleUserMessage` reads all unacknowledged messages (e.g. 2) and processes them in one LLM call. Second `handleUserMessage` finds no unacknowledged messages → returns immediately. Naturally idempotent.

### Message Handler fails

Messages are not acknowledged → preserved for retry on next trigger. An assistant message is created to inform the user.

### Manual mode

`triggerMessageHandler` checks `executionMode`, returns early if not autopilot/FSD. Messages stay in DB, processed when mode switches.

## File Changes

```
New:
  backend/src/message-handler.ts
  backend/src/__tests__/message-handler.test.ts

Modified:
  backend/src/autopilot.ts              — remove message handling, simplify to FSD Loop
  backend/src/plan-routes.ts            — replace triggerAutopilotIfNeeded
  backend/src/__tests__/autopilot.test.ts
  backend/src/__tests__/autopilot-integration.test.ts
  backend/src/__tests__/plan-routes.test.ts

Unchanged:
  frontend/                             — no changes, API contract preserved
  plan-db.ts                            — no schema changes
  plan-executor.ts                      — no changes
```

## Rollback

All temporary fixes from the current session should be removed during implementation:
- `recentLog` parameter and history injection
- `WORK_ACTIONS` / `isWorkAction` / auto-acknowledge logic
- `messageGraceIterations` grace period
- `send_message` prompt restrictions
- 2-step cycle detection safeguard (keep original 3-same-action check)
