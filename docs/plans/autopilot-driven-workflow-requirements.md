# Product Requirements: Autopilot-Driven Blueprint Workflow

**Status:** Draft
**Date:** 2026-03-06
**Spec reference:** `docs/plans/autopilot-centric-refactor.md`

---

## 1. Overview

This document defines user journeys, acceptance criteria, and testable requirements for the autopilot-centric refactor described in `autopilot-centric-refactor.md`. The refactor replaces the dual-path architecture (manual sub-agents vs. autopilot loop) with a unified model where the autopilot is the central orchestrator in autopilot/FSD modes, steered by a message queue and chat UI.

### Goals

1. Enable real-time user-to-autopilot communication via a chat interface
2. Reduce per-iteration token usage by replacing monolithic state snapshots with on-demand context reads
3. Eliminate duplicate AI operation code paths (sub-agent tools removed from autopilot palette)
4. Preserve full backward compatibility for manual-mode users

### Non-Goals

- Multi-user/multi-agent collaboration (future work)
- Voice or multimedia input to autopilot
- Custom tool palette configuration by users
- Changing the underlying Claude CLI execution model

---

## 2. User Personas

### P1 — Power User (Daily FSD User)

- Uses ClawUI daily for multi-node blueprint execution
- Prefers FSD (Full Speed Drive) mode — no safeguard pauses
- Wants to steer execution mid-flight: reprioritize nodes, skip tasks, add new requirements
- Expects chat-style interaction that feels like pair programming with the autopilot
- Monitors progress via the autopilot log; intervenes when something drifts off course

### P2 — New User (First Blueprint)

- Creating their first blueprint in ClawUI
- Unsure what the chat can do — needs visible affordances and guidance
- Likely starts in manual mode, may switch to autopilot after initial comfort
- Needs clear feedback when actions are queued vs. immediately executed
- Benefits from placeholder text and contextual hints in the chat input

### P3 — Manual-Mode User (Explicit Control)

- Prefers clicking Enrich, Split, Reevaluate buttons directly
- Uses the node detail view to inspect and edit descriptions manually
- May occasionally read the chat log for context but rarely types messages
- Must not see any regression in button behavior or response time
- Does not want to be forced into using the chat interface for operations they already use buttons for

---

## 3. User Journeys

### UJ-1: Chat-Driven Blueprint Creation

**Persona:** P1, P2
**Precondition:** User has created a new blueprint (draft status), approved it, and is on the blueprint detail page. No nodes exist yet.

**Flow:**

1. User sees the chat input at the bottom of the blueprint detail page with placeholder text: *"Describe what you want to build..."*
2. User types: "Create a REST API with auth, CRUD endpoints, and tests"
3. Message appears immediately in the chat (optimistic update) with a "sending" indicator
4. If in autopilot/FSD mode: the autopilot loop starts (or picks up the message on next iteration), generates nodes, and logs each `create_node` action
5. If in manual mode: the message is stored but triggers `generatePlan` directly (existing behavior)
6. User sees nodes appear in the node list as the autopilot creates them (via TanStack Query polling)
7. User types: "Add rate limiting to the API layer"
8. Autopilot reads existing nodes via `get_node_titles()`, decides where to add rate-limiting nodes, creates them with appropriate dependencies

**Acceptance Criteria:**

| ID | Criterion | Testable? |
|---|---|---|
| AC-1.1 | Chat input is visible and enabled for approved blueprints in all execution modes | Yes — UI test |
| AC-1.2 | Chat input is disabled for draft (unapproved) blueprints with a visible "Approve blueprint to start" hint | Yes — UI test |
| AC-1.3 | Sending a message in autopilot/FSD mode creates an `autopilot_messages` row with `role="user"` | Yes — API + DB test |
| AC-1.4 | Sending a message when autopilot loop is not running triggers `runAutopilotLoop` via `enqueueBlueprintTask` | Yes — integration test |
| AC-1.5 | Sending a message when autopilot loop IS running does NOT start a second loop | Yes — integration test |
| AC-1.6 | Nodes created by autopilot appear in the frontend within 4 seconds (2 polling cycles at 2s interval) | Yes — E2E test |
| AC-1.7 | Optimistic update shows the user's message immediately before server confirmation | Yes — UI test |
| AC-1.8 | For blueprints with no nodes, the first chat message triggers node generation (equivalent to existing generate flow) | Yes — integration test |

---

### UJ-2: Contextual Enrichment via Chat

**Persona:** P1, P2
**Precondition:** Blueprint is approved and has nodes. User is in autopilot or FSD mode.

**Flow:**

1. User sees a vague node (e.g., "#3: Handle authentication") in the node list
2. **Path A — Chat:** User types "Make node #3 more specific" in chat
3. **Path B — Button:** User clicks the Enrich button on node #3
4. In both paths (autopilot/FSD mode): a message is created in `autopilot_messages` (Path A: user's text; Path B: structured `"[enrich] Node #3: Handle authentication"`)
5. Autopilot picks up the message, calls `get_node_details(nodeId)` to understand the node, reads dependency handoffs if available, then calls `update_node(nodeId, { title, description })` with improved content
6. User sees the updated node title/description in the node list
7. Autopilot calls `acknowledge_message(messageId)` to mark the request handled

**Acceptance Criteria:**

| ID | Criterion | Testable? |
|---|---|---|
| AC-2.1 | Free-text enrichment requests in chat (e.g., "improve node #3") are stored as user messages and processed by autopilot | Yes — integration test |
| AC-2.2 | Clicking the Enrich button in autopilot/FSD mode creates a structured `[enrich]` message instead of launching a sub-agent | Yes — API test |
| AC-2.3 | Clicking the Enrich button in manual mode launches `enrichNodeInternal` directly (existing behavior, no message queue) | Yes — API test |
| AC-2.4 | Autopilot uses `get_node_details()` to gather context before enriching (verified via autopilot log showing the tool call) | Yes — log inspection |
| AC-2.5 | Enriched node title and description are updated within 3 autopilot iterations (~10-15 seconds) | Yes — timing test |
| AC-2.6 | The enrichment button returns `{ status: "queued-as-message" }` in autopilot/FSD mode (not the enriched node data) | Yes — API test |

---

### UJ-3: Feedback Loop During Execution

**Persona:** P1
**Precondition:** Blueprint is running in autopilot or FSD mode. Multiple nodes are in progress or queued.

**Flow:**

1. Autopilot is executing nodes sequentially. User watches progress in the chat log (interleaved `run_node` actions and status updates)
2. User notices the autopilot is working on auth nodes but wants database work done first
3. User types: "Stop working on auth, focus on the database layer first"
4. Message appears in chat immediately (optimistic update)
5. On the next autopilot iteration, the message is injected into the prompt via `buildAutopilotPrompt`
6. Autopilot reads the message, acknowledges it, and adjusts its next action (e.g., skips auth node, runs database node instead)
7. User sees the acknowledgment and adjusted behavior in the autopilot log within 1-2 iterations

**Acceptance Criteria:**

| ID | Criterion | Testable? |
|---|---|---|
| AC-3.1 | Unacknowledged user messages are injected into the autopilot prompt at each iteration | Yes — unit test on `buildAutopilotPrompt` |
| AC-3.2 | Autopilot acknowledges and acts on user feedback within 2 iterations of receiving it | Yes — integration test |
| AC-3.3 | Acknowledged messages are not re-injected into subsequent prompts | Yes — unit test |
| AC-3.4 | Multiple unacknowledged messages are presented in chronological order in the prompt | Yes — unit test |
| AC-3.5 | Sending a message while the autopilot loop is running does not interrupt the current iteration — it is picked up at the start of the next one | Yes — concurrency test |

---

### UJ-4: Manual Mode Backward Compatibility

**Persona:** P3
**Precondition:** Blueprint is in manual execution mode.

**Flow:**

1. User views the blueprint detail page. Chat component is visible at the bottom
2. User clicks the Enrich button on a node
3. `enrichNodeInternal` is called directly (sub-agent spawned), same as before the refactor
4. Node is updated when the sub-agent completes. No message is created in `autopilot_messages`
5. User can type messages in the chat — they are stored in the DB but no autopilot loop is triggered
6. All existing button actions (Split, Reevaluate, Smart Deps, Generate) work identically to pre-refactor behavior

**Acceptance Criteria:**

| ID | Criterion | Testable? |
|---|---|---|
| AC-4.1 | In manual mode, Enrich/Split/Reevaluate/Smart-Deps buttons call `plan-operations.ts` functions directly | Yes — API test |
| AC-4.2 | In manual mode, no `autopilot_messages` rows are created by button actions | Yes — DB test |
| AC-4.3 | In manual mode, clicking buttons returns the same response shape as pre-refactor | Yes — API regression test |
| AC-4.4 | In manual mode, chat input is available and stores messages, but does not trigger `runAutopilotLoop` | Yes — integration test |
| AC-4.5 | Switching from manual to autopilot mode mid-session works correctly — queued messages are picked up | Yes — integration test |
| AC-4.6 | Switching from autopilot to manual mode stops the autopilot loop; pending messages remain in DB but are not processed until autopilot resumes | Yes — integration test |

---

### UJ-5: Pause and Resume via Chat

**Persona:** P1
**Precondition:** Blueprint is running in autopilot mode (not FSD). A safeguard pause has been triggered.

**Flow:**

1. Autopilot hits a safeguard condition and pauses. The chat shows an inline pause message: "Paused: [reason]" with a Resume button
2. User reads the pause reason in context of the surrounding chat log
3. User clicks Resume — the pause state is cleared (`pauseReason` nulled, `status: "running"`), and `runAutopilotLoop` re-enqueues
4. Alternatively, user types a message before resuming (e.g., "Skip that node and continue") — the message is stored. When the user then clicks Resume, the autopilot picks up both the resume and the pending message

**Acceptance Criteria:**

| ID | Criterion | Testable? |
|---|---|---|
| AC-5.1 | Safeguard pause reasons appear inline in the chat timeline, not as a separate banner | Yes — UI test |
| AC-5.2 | Resume button in the chat clears `pauseReason` and sets `status: "running"` | Yes — API test |
| AC-5.3 | Messages sent during a paused state are stored but do not auto-start the autopilot loop | Yes — integration test |
| AC-5.4 | After Resume, pending messages sent during pause are picked up on the next autopilot iteration | Yes — integration test |
| AC-5.5 | FSD mode never triggers safeguard pauses (existing behavior preserved) | Yes — integration test |

---

### UJ-6: Chat History and Persistence

**Persona:** P1, P2, P3
**Precondition:** User has been interacting with a blueprint and navigates away, then returns.

**Flow:**

1. User sends several messages and sees autopilot log entries in the chat
2. User navigates to a different page (e.g., session list)
3. User returns to the blueprint detail page
4. Chat shows the full history — user messages, system messages, and autopilot log entries — in chronological order, with the most recent at the bottom
5. Chat auto-scrolls to the bottom on load
6. User can scroll up to see older messages; scrolling up disables auto-scroll; new messages show a "scroll to bottom" indicator

**Acceptance Criteria:**

| ID | Criterion | Testable? |
|---|---|---|
| AC-6.1 | Message history is persisted in `autopilot_messages` SQLite table and survives page reloads | Yes — DB + UI test |
| AC-6.2 | `GET /api/blueprints/:id/messages` returns paginated message history (default 50, newest first) | Yes — API test |
| AC-6.3 | Chat view merges user messages, system messages, and autopilot log entries into a single chronological timeline | Yes — UI test |
| AC-6.4 | Chat auto-scrolls to the bottom on initial load and when new messages arrive (if user is already at bottom) | Yes — UI test |
| AC-6.5 | Scrolling up disables auto-scroll; a "scroll to bottom" indicator appears when new messages arrive while scrolled up | Yes — UI test |
| AC-6.6 | Messages display relative timestamps (e.g., "2m ago") that update over time | Yes — UI test |

---

## 4. Functional Requirements

### FR-1: Message Queue (Backend)

| ID | Requirement |
|---|---|
| FR-1.1 | New `autopilot_messages` SQLite table with columns: `id`, `blueprint_id`, `role`, `content`, `acknowledged`, `created_at` |
| FR-1.2 | CRUD helpers: `createAutopilotMessage`, `getUnacknowledgedMessages`, `acknowledgeMessage`, `getMessageHistory` |
| FR-1.3 | Index on `(blueprint_id, acknowledged, created_at)` for efficient unacknowledged message lookup |
| FR-1.4 | Incremental migration — table created in `initPlanTables()` if not exists (no schema version bump) |
| FR-1.5 | Messages cascade-delete when parent blueprint is deleted |

### FR-2: Lightweight Read Endpoints

| ID | Requirement |
|---|---|
| FR-2.1 | `GET /api/blueprints/:id/nodes/summary` — returns compact node array (id, seq, title, status, roles, dependencies) |
| FR-2.2 | `GET /api/blueprints/:id/nodes/:nodeId/context` — returns full node details with resolved dependency titles and latest handoff |
| FR-2.3 | `GET /api/blueprints/:id/progress` — returns aggregate status counts (total, done, failed, pending, skipped, running, queued) |
| FR-2.4 | All three endpoints respond in <50ms (synchronous SQLite reads, no AI calls) |

### FR-3: Autopilot Tool Palette

| ID | Requirement |
|---|---|
| FR-3.1 | Add read tools: `get_node_titles`, `get_node_details`, `get_node_handoff` |
| FR-3.2 | Add message tools: `read_user_messages`, `acknowledge_message` |
| FR-3.3 | Remove sub-agent tools: `enrich_node`, `split_node`, `smart_dependencies`, `reevaluate_node`, `reevaluate_all` |
| FR-3.4 | Expand `update_node` to accept `dependencies` parameter |
| FR-3.5 | `buildStateSnapshot` slimmed to metadata + counts only (no node descriptions, suggestions, or insight bodies) |
| FR-3.6 | Unacknowledged user messages injected into autopilot prompt via `buildAutopilotPrompt` |

### FR-4: AI Operation Routing

| ID | Requirement |
|---|---|
| FR-4.1 | In autopilot/FSD mode: Enrich, Split, Reevaluate, Smart-Deps, Generate, Reevaluate-All endpoints create `autopilot_messages` instead of spawning sub-agents |
| FR-4.2 | In autopilot/FSD mode: these endpoints return `{ status: "queued-as-message" }` |
| FR-4.3 | In autopilot/FSD mode: these endpoints call `triggerAutopilotIfNeeded` to wake the loop if not running |
| FR-4.4 | In manual mode: all six endpoints retain existing sub-agent behavior unchanged |
| FR-4.5 | `POST /api/blueprints/:id/messages` endpoint for direct user messaging |
| FR-4.6 | `GET /api/blueprints/:id/messages` endpoint with pagination (`limit`, `offset` query params) |

### FR-5: Chat UI (Frontend)

| ID | Requirement |
|---|---|
| FR-5.1 | `BlueprintChat` component renders at the bottom of the blueprint detail page |
| FR-5.2 | Chat interleaves user messages, system messages, and autopilot log entries chronologically |
| FR-5.3 | Chat input sends messages via `POST /api/blueprints/:id/messages` |
| FR-5.4 | Chat input is disabled for draft blueprints with a visible hint |
| FR-5.5 | Optimistic updates: user messages appear immediately on send |
| FR-5.6 | Polling interval: 2s when autopilot is running, 10s when idle |
| FR-5.7 | Pause reasons display inline in the chat timeline with a Resume button |
| FR-5.8 | Chat replaces the old generator textarea and action buttons for node generation |
| FR-5.9 | Node references in chat/log entries (e.g., "Node #3") are clickable and scroll to the node in the node list |

---

## 5. Non-Functional Requirements

| ID | Requirement |
|---|---|
| NFR-1 | **Token efficiency:** State snapshot token usage reduced by at least 40% for blueprints with 10+ nodes compared to pre-refactor baseline |
| NFR-2 | **Latency:** New read endpoints respond in <50ms. Message creation responds in <100ms |
| NFR-3 | **Concurrency safety:** No duplicate autopilot loops can run for the same blueprint — `triggerAutopilotIfNeeded` must check `workspacePendingTasks` before enqueuing |
| NFR-4 | **Data integrity:** Messages must be persisted before returning the API response (no fire-and-forget for message storage) |
| NFR-5 | **Scalability:** Message table should perform well with up to 10,000 messages per blueprint (covered by the index on `blueprint_id, acknowledged, created_at`) |
| NFR-6 | **Accessibility:** Chat input supports keyboard submission (Enter to send, Shift+Enter for newline) |
| NFR-7 | **Theme support:** Chat UI uses semantic color tokens (`bg-bg-primary`, `accent-amber`, etc.) and works in both light and dark themes |

---

## 6. Migration & Rollout

### Phase Ordering

The implementation follows the 4-phase strategy from the design doc:

1. **Phase 1 — Message Queue + Read Endpoints** (additive, zero risk)
2. **Phase 2 — Read Tools in Autopilot Palette** (additive, low risk — old tools coexist)
3. **Phase 3 — Route AI Ops Through Messages** (behavioral change for autopilot/FSD mode)
4. **Phase 4 — Frontend Chat UI** (frontend-only, backend already ready)

### Rollout Criteria Per Phase

| Phase | Gate to proceed |
|---|---|
| 1 → 2 | Unit tests pass for CRUD helpers; new endpoints return correct data verified via curl |
| 2 → 3 | Autopilot successfully uses read tools on a test blueprint; no regression in existing tool usage |
| 3 → 4 | Integration test confirms: message sent → autopilot picks up → acts → acknowledges. Manual mode regression suite passes |
| 4 → Done | E2E test confirms chat-driven blueprint creation and enrichment. Token usage measurement shows ≥40% reduction |

### Backward Compatibility Matrix

| Scenario | Expected behavior |
|---|---|
| Manual mode + Enrich button | Direct sub-agent call (unchanged) |
| Manual mode + chat message | Message stored, no autopilot triggered |
| Autopilot mode + Enrich button | Message queued, autopilot handles |
| Autopilot mode + chat message | Message queued, autopilot handles |
| FSD mode + Enrich button | Message queued, autopilot handles (no safeguards) |
| FSD mode + chat message | Message queued, autopilot handles (no safeguards) |
| Existing autopilot log entries | Merged into chat timeline (no data loss) |
| Mode switch: manual → autopilot | Stored messages picked up by autopilot on next iteration |
| Mode switch: autopilot → manual | Loop stops; pending messages remain; buttons revert to direct calls |

---

## 7. Edge Cases and Error Handling

| Scenario | Expected behavior |
|---|---|
| User sends message to a deleted blueprint | API returns 404; frontend shows error toast |
| User sends empty message | Frontend validates and prevents submission; API returns 400 if bypass |
| Autopilot loop crashes mid-iteration with unacknowledged messages | Messages remain unacknowledged; next loop restart re-injects them |
| User sends message while blueprint is paused | Message stored but loop not auto-started; picked up on manual Resume |
| User sends rapid-fire messages (>5 in 2 seconds) | All messages stored; autopilot sees all unacknowledged messages on next iteration |
| `get_node_details` called with invalid node ID | Returns `{ success: false, error: "not_found" }`; autopilot handles gracefully |
| Network failure during message send | Optimistic update rolled back; error toast shown; user can retry |
| Browser tab inactive during autopilot execution | Polling continues at reduced rate (visibility API); messages accumulate and render on tab focus |
| Very long message content (>10,000 chars) | API accepts and stores; autopilot prompt may truncate if combined context exceeds limits |
| Concurrent mode switch and message send | Mode switch takes precedence; message routing follows the mode active at time of API call |

---

## 8. Success Metrics

| Metric | Target | Measurement method |
|---|---|---|
| Token usage per autopilot iteration | ≥40% reduction for 10+ node blueprints | Compare `buildStateSnapshot` token counts before/after Phase 3 |
| User message → autopilot action latency | ≤15 seconds (3 iterations × ~5s each) | Timestamp diff: message `created_at` vs. corresponding `acknowledge_message` log entry |
| Manual mode regression | 0 behavioral changes | Existing test suite + manual regression testing |
| Chat adoption | ≥60% of autopilot/FSD sessions have ≥1 user message within 30 days of launch | Query `autopilot_messages` table |
| Duplicate loop prevention | 0 instances of concurrent loops for same blueprint | Monitor `workspacePendingTasks` in logs |

---

## 9. Open Questions

| # | Question | Impact | Proposed resolution |
|---|---|---|---|
| 1 | Should chat messages support markdown formatting? | UX polish for P1 | Yes — render with a lightweight markdown renderer for consistency with node descriptions |
| 2 | Should there be a character limit on chat messages? | Prompt size management | Soft limit of 2,000 chars with a counter; no hard rejection |
| 3 | Should autopilot system messages (tool call results, status updates) be stored in `autopilot_messages` or only in the autopilot log? | Data model complexity vs. chat richness | Keep them in autopilot log only; chat merges both sources client-side. Avoids duplicating data |
| 4 | Should the chat show a "typing..." indicator while autopilot is processing a message? | UX clarity for P2 | Yes — show when a user message is unacknowledged and autopilot loop is running |
| 5 | How should the chat handle the transition from "no nodes" to "nodes generated"? | UX for first-time blueprint creation | After generation completes, show a system message summarizing the created nodes (e.g., "Created 7 nodes for your REST API blueprint") |
