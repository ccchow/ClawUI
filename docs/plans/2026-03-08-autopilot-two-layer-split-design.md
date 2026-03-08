# Autopilot Two-Layer Split Design

**Date**: 2026-03-08
**Status**: Draft (v2)

## Problem

The current autopilot loop (`runAutopilotLoop` in `autopilot.ts`) uses a single LLM call per iteration to handle two fundamentally different responsibilities:

1. **Understanding user intent** — processing messages from BlueprintChat (create features, split nodes, answer questions)
2. **Executing the FSD loop** — running nodes, evaluating, coordinating, managing the blueprint lifecycle

This causes:
- **Repetitive loops**: The LLM sees unacknowledged user messages in every iteration, repeatedly creating duplicate nodes or sending duplicate replies instead of acknowledging and moving on.
- **Priority confusion**: The LLM can't decide whether to respond to the user or execute nodes, leading to `send_message` loops where it announces plans but never acts.
- **Bloated prompts**: A single prompt must contain user message handling instructions, FSD execution strategy, tool descriptions for both domains, safeguard rules, memory, and workflow guidelines.

## Solution

Split into two independent components:

- **User Agent** (`user-agent.ts`) — A Claude CLI session that acts as a ClawUI power user, translating user intent into API operations
- **FSD Loop** (`autopilot.ts`, simplified) — Pure node execution engine

### Core Principle

The User Agent is **equivalent to a human user operating the ClawUI web UI**. It calls the same REST API endpoints as the frontend. It can:
- Create/modify/delete nodes
- Trigger AI operations (enrich, split, smart-deps)
- Observe blueprint progress and queue status
- Control the FSD loop (pause, resume, mode switch)
- Answer questions about the codebase or blueprint

## Architecture

### Control Flow

```
User sends message (BlueprintChat / API button)
  │
  ▼
plan-routes.ts: POST /api/blueprints/:id/messages
  │  createAutopilotMessage(blueprintId, "user", content)
  │  triggerUserAgent(blueprintId)
  │
  ▼
workspace queue: handleUserMessage(blueprintId)     ← user-agent.ts
  │  1. Read all unacknowledged messages
  │  2. Build User Agent prompt (messages + blueprint context + API docs)
  │  3. runSession(prompt, projectCwd) → Claude CLI session
  │     - Claude reads codebase files for Q&A (built-in tools)
  │     - Claude calls ClawUI REST API via bash/curl for operations
  │     - Session ends when Claude is done (no managed loop)
  │  4. Acknowledge all processed messages
  │  5. triggerFsdLoopIfNeeded(blueprintId)
  │
  ▼
workspace queue: runFsdLoop(blueprintId)            ← autopilot.ts (simplified)
  │  while (has pending nodes) {
  │    Check unacknowledged messages → if any, break (yield)
  │    Pick next node → run_node → evaluate
  │  }
  │  If yielded → User Agent processes messages, then re-triggers FSD loop
  │  If all nodes done → loop ends normally
```

### Key Principles

- **User Agent = API consumer** — it calls the same REST endpoints as the frontend, never internal functions directly
- **User message entry points only trigger User Agent**, never FSD Loop directly
- **FSD Loop is triggered by User Agent** after creating/modifying nodes
- **Yield is just `break`** — no signal mechanism needed, workspace queue serializes naturally
- **Both share the workspace queue** — no cross-queue coordination needed
- **Q&A is built-in** — Claude's native file reading/search handles codebase questions without API calls

## User Agent (`user-agent.ts`)

### Concept

A full Claude CLI session (via `runSession`) that runs with:
1. **ClawUI API access** — endpoint documentation + auth token in prompt; Claude calls them via bash/curl
2. **Codebase access** — Claude's built-in tools (read, search, bash) for Q&A about the workspace
3. **Single session** — no outer loop; Claude handles multi-step operations internally within one session

This follows the existing pattern: node execution already uses curl for API callbacks (report-status, report-blocker, task-summary). The User Agent extends this to all blueprint operations.

### Prompt Structure

```
1. Role description — "You are a User Agent for ClawUI..."
2. Current context — blueprint title, description, status, node summary
3. User messages — the unacknowledged message(s) to process
4. API documentation — relevant endpoints with method, path, params
5. API access — base URL + auth token for curl commands
6. Instructions — behavioral guidelines
```

Does NOT contain: FSD execution strategy, workflow rhythm, safeguard rules, reflection, memory.

### API Endpoints Available

The User Agent sees documentation for these endpoints (called via `curl -s -X METHOD 'http://localhost:{PORT}/api/...' -H 'Content-Type: application/json' -d '{...}'`):

**Read (understand state):**
| Endpoint | Description |
|----------|-------------|
| `GET /api/blueprints/:id` | Get blueprint with all nodes |
| `GET /api/blueprints/:id/nodes/summary` | Lightweight node overview |
| `GET /api/blueprints/:id/nodes/:nodeId/context` | Node context with deps/handoff |
| `GET /api/blueprints/:id/messages` | Message history |
| `GET /api/blueprints/:id/queue` | Queue status |
| `GET /api/blueprints/:id/progress` | Node status counts |

**Node operations:**
| Endpoint | Description |
|----------|-------------|
| `POST /api/blueprints/:id/nodes` | Create node (`{title, description, dependencies?, roles?}`) |
| `POST /api/blueprints/:id/nodes/batch-create` | Batch create nodes |
| `PUT /api/blueprints/:id/nodes/:nodeId` | Update node |
| `DELETE /api/blueprints/:id/nodes/:nodeId` | Delete node |
| `POST /api/blueprints/:id/nodes/reorder` | Reorder nodes |

**AI operations:**
| Endpoint | Description |
|----------|-------------|
| `POST /api/blueprints/:id/enrich-node` | Smart create / enrich node |
| `POST /api/blueprints/:id/nodes/:nodeId/split` | Split node into sub-nodes |
| `POST /api/blueprints/:id/nodes/:nodeId/smart-dependencies` | Auto-detect dependencies |
| `POST /api/blueprints/:id/reevaluate-all` | Re-evaluate all non-done nodes |

**Execution control:**
| Endpoint | Description |
|----------|-------------|
| `POST /api/blueprints/:id/nodes/:nodeId/run` | Queue node for execution |
| `POST /api/blueprints/:id/run-all` | Start autopilot / run all nodes |
| `PUT /api/blueprints/:id` | Update blueprint (executionMode, status, etc.) |

**Communication:**
| Endpoint | Description |
|----------|-------------|
| `POST /api/blueprints/:id/messages` | Send reply to user (`{content}`) |

All endpoints accept auth via query parameter: `?auth={TOKEN}`.

### Execution Logic

```typescript
import { getActiveRuntime } from "./agent-runtime.js";
import { getUnacknowledgedMessages, acknowledgeMessage, getBlueprint } from "./plan-db.js";
import { enqueueBlueprintTask, addPendingTask, removePendingTask } from "./plan-executor.js";
import { triggerFsdLoopIfNeeded } from "./autopilot.js";
import { getApiBaseUrl, getAuthParam } from "./plan-generator.js";

export async function handleUserMessage(blueprintId: string): Promise<void> {
  const messages = getUnacknowledgedMessages(blueprintId);
  if (messages.length === 0) return;  // idempotent

  const blueprint = getBlueprint(blueprintId);
  if (!blueprint) return;

  addPendingTask(blueprintId, { type: "autopilot", queuedAt: new Date().toISOString() });

  try {
    const prompt = buildUserAgentPrompt(blueprintId, messages);
    const runtime = getActiveRuntime();
    const output = await runtime.runSession(prompt, blueprint.projectCwd);

    log.info(`User agent session completed (${output.length} chars)`);

    // Acknowledge all messages after session completes
    for (const msg of messages) {
      acknowledgeMessage(msg.id);
    }
  } catch (err) {
    log.error(`User agent failed for ${blueprintId}: ${err instanceof Error ? err.message : err}`);
    createAutopilotMessage(blueprintId, "assistant",
      "Failed to process your message. Please try again or switch to manual mode.");
  } finally {
    removePendingTask(blueprintId, undefined, "autopilot");
  }

  // Trigger FSD loop if there are nodes to execute
  triggerFsdLoopIfNeeded(blueprintId);
}

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

### Prompt Builder

```typescript
export function buildUserAgentPrompt(
  blueprintId: string,
  messages: AutopilotMessage[],
): string {
  const blueprint = getBlueprint(blueprintId);
  const baseUrl = getApiBaseUrl();
  const authParam = getAuthParam();
  const messageList = messages.map((m) => `- ${m.content}`).join("\n");

  // Build lightweight node summary
  const nodeSummary = blueprint.nodes.map((n) =>
    `  - [${n.seq}] ${n.title} (${n.status})${n.dependencies.length ? ` deps: ${n.dependencies.join(", ")}` : ""}`
  ).join("\n");

  return `You are a User Agent for ClawUI, a blueprint-based task management system. You act as an expert user, translating the user's natural language requests into ClawUI operations.

You are equivalent to a human user on the ClawUI web interface. You operate by calling the ClawUI REST API.

## Current Blueprint
- ID: ${blueprintId}
- Title: ${blueprint.title}
- Description: ${blueprint.description}
- Status: ${blueprint.status}
- Execution Mode: ${blueprint.executionMode}

## Current Nodes
${nodeSummary || "  (no nodes yet)"}

## User Messages
${messageList}

## API Access
Base URL: ${baseUrl}
Auth: append \`?${authParam}\` to all API calls.
Content-Type: application/json

Example:
\`\`\`bash
curl -s -X POST '${baseUrl}/api/blueprints/${blueprintId}/nodes?${authParam}' \\
  -H 'Content-Type: application/json' \\
  -d '{"title": "Example Node", "description": "..."}'
\`\`\`

## Available API Endpoints

### Node Operations
- POST /api/blueprints/${blueprintId}/nodes — Create node: \`{"title", "description", "dependencies?": ["nodeId"], "roles?": ["roleId"]}\`
- POST /api/blueprints/${blueprintId}/nodes/batch-create — Batch create: \`[{"title", "description", ...}]\`
- PUT /api/blueprints/${blueprintId}/nodes/{nodeId} — Update node: \`{"title?", "description?", "status?", "dependencies?"}\`
- DELETE /api/blueprints/${blueprintId}/nodes/{nodeId} — Delete node
- POST /api/blueprints/${blueprintId}/nodes/reorder — Reorder: \`[{"id", "order"}]\`

### AI Operations
- POST /api/blueprints/${blueprintId}/enrich-node — Smart create/enrich: \`{"title", "description?", "nodeId?"}\`
- POST /api/blueprints/${blueprintId}/nodes/{nodeId}/split — Split node into sub-nodes
- POST /api/blueprints/${blueprintId}/nodes/{nodeId}/smart-dependencies — Auto-detect deps
- POST /api/blueprints/${blueprintId}/reevaluate-all — Re-evaluate all non-done nodes

### Execution Control
- POST /api/blueprints/${blueprintId}/nodes/{nodeId}/run — Queue node for execution
- POST /api/blueprints/${blueprintId}/run-all — Start autopilot / run all
- PUT /api/blueprints/${blueprintId} — Update blueprint: \`{"executionMode?", "status?", "title?", "description?"}\`

### Read State
- GET /api/blueprints/${blueprintId} — Full blueprint with nodes
- GET /api/blueprints/${blueprintId}/nodes/summary — Lightweight node overview
- GET /api/blueprints/${blueprintId}/nodes/{nodeId}/context — Node context with deps/handoff
- GET /api/blueprints/${blueprintId}/progress — Node status counts
- GET /api/blueprints/${blueprintId}/queue — Queue status

### Communication
- POST /api/blueprints/${blueprintId}/messages — Send reply: \`{"content": "..."}\`

## Instructions
1. Understand what the user wants from their message(s).
2. For **codebase Q&A** (questions about the project, code, architecture): read files and search the codebase directly to answer. No API calls needed.
3. For **blueprint Q&A** (questions about node status, progress, errors): use the Read State API endpoints to get details, then reply via the messages endpoint.
4. For **simple tasks** (git commit, run tests, quick file edits): execute directly using bash, then reply with the result via the messages endpoint.
5. For **complex tasks** (new features, refactors, multi-step work): decompose into nodes using the Node Operations API. Create nodes with appropriate dependencies. Reply to confirm your plan.
6. For **AI operations** the user requests (split, enrich, smart-deps): call the corresponding AI endpoint.
7. Always reply to the user via \`POST /api/blueprints/${blueprintId}/messages\` to confirm what you did.
8. Check existing nodes before creating new ones to avoid duplicates.`;
}
```

### Error Handling

On failure: don't acknowledge messages (preserved for retry), create an assistant message informing the user.

### Q&A Capability

The User Agent naturally supports Q&A because it's a full Claude CLI session:
- **Codebase questions** ("What database does this project use?"): Claude reads files directly using built-in tools
- **Blueprint questions** ("Why did node 3 fail?"): Claude calls read-state API endpoints, then replies
- **Mixed** ("Can you check if the login module already exists before creating nodes?"): Claude reads code + creates nodes as needed

No special Q&A handling is needed — it's an emergent capability of running a full Claude session.

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

// Yield: pending user messages — let User Agent process them
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
| `triggerUserAgent(blueprintId)` | `user-agent.ts` | Enqueue User Agent session for user messages |
| `triggerFsdLoopIfNeeded(blueprintId)` | `autopilot.ts` | Enqueue FSD Loop if nodes need execution |

### Call Site Mapping

| Scenario | Old | New |
|----------|-----|-----|
| POST /messages (user sends message) | `triggerAutopilotIfNeeded` | `triggerUserAgent` |
| Enrich / Split / SmartDeps / Reevaluate (API button in autopilot mode) | `triggerAutopilotIfNeeded` | `triggerUserAgent` |
| Generate nodes (API button in autopilot mode) | `triggerAutopilotIfNeeded` | `triggerUserAgent` |
| Resume from pause | `runAutopilotLoop` | `runFsdLoop` (direct) |
| Mode switch to autopilot/FSD | `runAutopilotLoop` | `runFsdLoop` (direct) |

## Edge Cases

### FSD Loop running when user sends message

FSD Loop is in `run_node` (60s). User sends message → `triggerUserAgent` → enqueue. Node finishes → next iteration detects unacknowledged messages → yield. Queue runs User Agent → processes message → `triggerFsdLoopIfNeeded`. New FSD Loop starts. User waits at most one node execution.

### User sends multiple messages quickly

First `handleUserMessage` reads all unacknowledged messages (e.g. 2) and processes them in one session. Second `handleUserMessage` finds no unacknowledged messages → returns immediately. Naturally idempotent.

### User Agent fails

Messages are not acknowledged → preserved for retry on next trigger. An assistant message is created to inform the user.

### Manual mode

`triggerUserAgent` checks `executionMode`, returns early if not autopilot/FSD. Messages stay in DB, processed when mode switches.

### User Agent calls API that triggers autopilot

Some endpoints (e.g. enrich in autopilot mode) internally call `triggerUserAgent`. Since the User Agent is already running and holding the workspace queue, this enqueue will wait. After the User Agent session ends, the re-triggered handler finds no unacknowledged messages and returns immediately. No conflict.

## File Changes

```
New:
  backend/src/user-agent.ts
  backend/src/__tests__/user-agent.test.ts

Modified:
  backend/src/autopilot.ts              — remove message handling, simplify to FSD Loop
  backend/src/plan-routes.ts            — replace triggerAutopilotIfNeeded with triggerUserAgent
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

## Comparison with Previous Design (v1 → v2)

| Aspect | v1 (Message Handler) | v2 (User Agent) |
|--------|---------------------|-----------------|
| Execution | `callAgentForDecision` loop (max 10 iterations) | `runSession` single session |
| Tool palette | Custom internal functions | REST API endpoints (same as frontend) |
| Tool execution | `executeMessageAction` switch/case | Claude calls curl directly |
| Q&A | Not supported | Built-in (Claude reads files) |
| FSD observation | Not supported | Can call read-state endpoints |
| FSD control | Not supported | Can call execution control endpoints |
| Complexity | High (custom loop + action executor) | Low (session wrapper + prompt) |
| Equivalence | Internal operator | Human user equivalent |
