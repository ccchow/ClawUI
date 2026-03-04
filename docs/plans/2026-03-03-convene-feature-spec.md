# Convene Feature — Product Requirements Document

**Version:** 1.0 (Finalized)
**Date:** 2026-03-03
**Authors:** PM / UXD
**Target Release:** ClawUI 0.5.0

---

## 1. Overview

**Convene** is a blueprint-level multi-role discussion system. Users pose a topic or decision point; the system orchestrates a structured, round-robin conversation among the blueprint's enabled roles (SDE, QA, PM, UXD). After all rounds complete, the system synthesizes the discussion into actionable nodes that can be approved directly into the blueprint.

### 1.1 Problem Statement

Currently, role perspectives are applied per-node at execution time. There is no mechanism for roles to deliberate together *before* work begins. Cross-cutting decisions (architecture trade-offs, scope prioritization, UX/engineering feasibility) happen implicitly or not at all. Convene makes these discussions explicit and traceable.

### 1.2 Success Metrics

- Users can initiate a convene session from any blueprint with 2+ enabled roles
- Discussion threads are fully persisted and browsable
- Synthesis output produces valid `batch-create`-compatible nodes
- Approve-to-create flow requires ≤2 clicks from synthesis review

---

## 2. Data Model

Two new tables, following the existing incremental migration pattern (`sqlite_master` check for new tables in `plan-db.ts`).

### 2.1 `convene_sessions`

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | TEXT | PK | UUID via `randomUUID()` |
| `blueprint_id` | TEXT | FK → blueprints (CASCADE), NOT NULL | |
| `topic` | TEXT | NOT NULL | The question or decision point posed by the user |
| `context_node_ids` | TEXT | nullable | JSON array of `macro_nodes.id` values — nodes referenced as discussion context |
| `participating_roles` | TEXT | NOT NULL | JSON array of role IDs (e.g., `["pm","sde","uxd"]`) |
| `max_rounds` | INTEGER | DEFAULT 3 | User-configurable; 1 round = each role speaks once |
| `status` | TEXT | NOT NULL, DEFAULT 'active' | One of: `active`, `synthesizing`, `completed`, `cancelled` |
| `synthesis_result` | TEXT | nullable | JSON array matching `batch-create` body: `[{title, description, dependencies?, roles?}]` |
| `created_at` | TEXT | NOT NULL | ISO timestamp |
| `completed_at` | TEXT | nullable | Set when status → `completed` or `cancelled` |

**PM Decision:** `max_rounds` caps at 5 (UI enforces 1–5 range). Default 3 gives enough depth without runaway token cost. Each "round" means every participating role speaks once; the synthesis turn runs after all rounds complete and is not counted as a round.

**PM Decision:** `status` transitions are strictly: `active → synthesizing → completed` or `active → cancelled` / `synthesizing → cancelled`. No backward transitions.

### 2.2 `convene_messages`

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | TEXT | PK | UUID |
| `session_id` | TEXT | FK → convene_sessions (CASCADE), NOT NULL | |
| `role_id` | TEXT | NOT NULL | Matches `role-registry.ts` role IDs (e.g., `"sde"`, `"pm"`) |
| `round` | INTEGER | NOT NULL | 1-indexed round number; synthesis uses `max_rounds + 1` |
| `content` | TEXT | NOT NULL | The role agent's markdown analysis/recommendation |
| `message_type` | TEXT | NOT NULL, DEFAULT 'contribution' | `contribution` or `synthesis` |
| `created_at` | TEXT | NOT NULL | ISO timestamp |

**PM Decision:** The `round` field for the synthesis message is `max_rounds + 1` rather than a separate sentinel value. This keeps ordering natural (ORDER BY round ASC, created_at ASC) and avoids special-case logic.

### 2.3 Batch Loading Integration

Follow the `getNodesForBlueprint()` pattern: when fetching a blueprint, include `convene_session_count` (COUNT of non-cancelled convene sessions) to avoid N+1 queries. This count is used in the "Discussions" section header badge.

### 2.4 Frontend Type Mirrors (`frontend/src/lib/api.ts`)

```typescript
// New types to add:
export type ConveneSessionStatus = "active" | "synthesizing" | "completed" | "cancelled";

export interface ConveneSession {
  id: string;
  blueprintId: string;
  topic: string;
  contextNodeIds: string[] | null;
  participatingRoles: string[];
  maxRounds: number;
  status: ConveneSessionStatus;
  synthesisResult: BatchCreateNode[] | null;
  messageCount: number;
  createdAt: string;
  completedAt: string | null;
}

export interface ConveneMessage {
  id: string;
  sessionId: string;
  roleId: string;
  round: number;
  content: string;
  messageType: "contribution" | "synthesis";
  createdAt: string;
}

// Reuse existing batch-create shape:
export interface BatchCreateNode {
  title: string;
  description: string;
  dependencies?: (string | number)[];
  roles?: string[];
}
```

---

## 3. Backend API Endpoints

All endpoints live in `plan-routes.ts` following existing conventions (safeError, session ID validation where applicable).

### 3.1 `POST /api/blueprints/:id/convene`

**Start a convene session.**

Request body:
```json
{
  "topic": "string (required)",
  "roleIds": ["pm", "sde", "uxd"],
  "contextNodeIds": ["node-uuid-1", "node-uuid-2"],
  "maxRounds": 3
}
```

Validation:
- Blueprint must exist and not be archived
- `roleIds` must be a subset of `blueprint.enabledRoles` (reject roles not enabled on the blueprint)
- `roleIds.length >= 2` (convene requires multi-role discussion)
- `maxRounds` clamped to 1–5, default 3
- `contextNodeIds` (optional): each must exist in the blueprint's nodes

Response: `{ status: "queued", sessionId: "uuid" }`

Side effects:
- Creates `convene_sessions` row with status `active`
- Adds `PendingTask` with `type: "convene"` and `nodeId: undefined`
- Enqueues orchestration task via `enqueueBlueprintTask()`

**PM Decision:** No blueprint status gate — convene can run even on `draft` or `paused` blueprints. Discussions are useful at any stage. However, if the blueprint's workspace queue already has a running task, convene is queued behind it (shared serial queue per `projectCwd`).

### 3.2 `GET /api/blueprints/:id/convene-sessions`

**List all convene sessions for a blueprint.**

Response: Array of `ConveneSession` objects (without full messages), ordered by `created_at DESC`. Includes `messageCount` derived from a COUNT join.

### 3.3 `GET /api/blueprints/:id/convene-sessions/:sessionId`

**Full session with all messages.**

Response: `ConveneSession` + `messages: ConveneMessage[]` ordered by `(round ASC, created_at ASC)`.

### 3.4 `POST /api/blueprints/:id/convene-sessions/:sessionId/approve`

**Approve synthesis → create nodes.**

Validation:
- Session must be in `synthesizing` status
- `synthesis_result` must be non-null and parseable

Behavior:
- Reuses the existing `batch-create` logic (dependency-index resolution pattern from `plan-routes.ts`)
- If `roles` field is present on synthesized nodes, applies via `updateMacroNode()` after creation (same workaround as existing batch-create)
- Sets session status → `completed`, sets `completed_at`

Response: `{ status: "completed", createdNodeIds: ["uuid1", "uuid2", ...] }`

### 3.5 `POST /api/blueprints/:id/convene-sessions/:sessionId/cancel`

**Cancel a session.**

- Sets status → `cancelled`, sets `completed_at`
- Removes associated `PendingTask` (if still queued/running)
- If agent is mid-execution (checked via session lock), attempts graceful termination

Response: `{ status: "cancelled" }`

### 3.6 Backend Type Changes

**`plan-executor.ts`** — Add `"convene"` to the `PendingTask.type` union:
```typescript
export interface PendingTask {
  type: "run" | "reevaluate" | "enrich" | "generate" | "split" | "smart_deps" | "evaluate" | "coordinate" | "convene";
  // ...
}
```

---

## 4. Orchestration Logic

New function: `executeConveneSession()` — either in `plan-executor.ts` or a dedicated `convene-executor.ts` (SDE decision). Module must include all role and agent runtime side-effect imports.

### 4.1 Round-Robin Execution

```
For round = 1 to maxRounds:
  For each roleId in participating_roles (in array order):
    1. Resolve role via getRole(roleId)
    2. Build prompt:
       - role.prompts.persona (role identity)
       - Blueprint context: title, description
       - Context nodes: title + description summaries for each contextNodeId
       - Prior messages: all convene_messages for this session so far
       - Instruction: "Contribute your perspective as {role.label} on: {topic}.
         Reference prior messages where relevant. Be specific and actionable.
         Respond in markdown."
    3. Run agent via runAgentInteractive(prompt, projectCwd)
       - Wrap with runWithRelatedSessionDetection() for frontend live-polling
    4. Store response as convene_messages row (message_type: "contribution")
```

### 4.2 Synthesis Turn

After the final round completes:

```
1. Set session status → "synthesizing"
2. Build synthesis prompt:
   - All messages from the session as context
   - Instruction: "You are synthesizing a multi-role discussion into action items.
     Read all contributions above. Produce a JSON array of concrete tasks.
     Each task: {title: string, description: string, roles?: string[], dependencies?: number[]}.
     Dependencies use 0-indexed references within this array.
     Output ONLY the JSON array, no markdown fencing."
3. Run agent via runAgentInteractive(prompt, projectCwd)
4. Parse JSON from output using depth-counting brace extraction
   (same extractTitleDescJson pattern — handle CLI echo)
5. Store synthesis as convene_messages (message_type: "synthesis", round: maxRounds + 1)
6. Update convene_sessions: synthesis_result = parsed JSON, status remains "synthesizing"
7. Remove PendingTask
```

**PM Decision:** The synthesis prompt asks for raw JSON (no markdown fencing) to simplify extraction. If extraction fails, mark session status as `synthesizing` anyway (no auto-retry) and store the raw output as the synthesis message content. The user can read the raw output and manually create nodes, or cancel and re-try.

### 4.3 Error Handling

- If any agent call fails mid-session, log the error and continue to the next role/round. Store an error message as the contribution content: `"[Agent error: {message}]"`.
- If the synthesis call fails entirely, set status → `synthesizing` with `synthesis_result = null`. Frontend shows a "Synthesis failed — review messages and create nodes manually" state.
- Agent timeouts: reuse existing `withTimeout()` pattern.

---

## 5. Frontend — UI Components & Flows

### 5.1 Convene Trigger Button (Blueprint Detail Page)

**Location:** Blueprint header action bar, after the existing Coordinate button.

**Button spec:**
```
<button>
  className="inline-flex items-center gap-2 px-3 py-1.5 sm:py-1 rounded-lg border text-sm font-medium
    bg-accent-purple/15 text-accent-purple border-accent-purple/30
    hover:bg-accent-purple/25 active:scale-[0.98] transition-all
    disabled:opacity-40 disabled:cursor-not-allowed"
  title={disabled reason or "Start a multi-role discussion"}
>
  <ConveneIcon /> {/* 16x16 SVG: chat-bubble-group or discussion icon */}
  Convene
</button>
```

**UXD Decision — Color rationale:** Purple (`accent-purple`) is used because Convene is fundamentally a *collaborative/deliberation* activity. Purple is the PM role color, and PM-driven cross-functional alignment is the core use case. This is consistent with how agent colors map to function (Claude = purple). The purple also visually distinguishes Convene from execution actions (blue = Run, green = Approve).

**Disabled states (with `title` tooltip):**
| Condition | Tooltip text |
|-----------|-------------|
| `blueprint.status === "running"` | "Cannot convene while blueprint is executing" |
| `blueprintBusy` (any pending task) | "Wait for current operation to complete" |
| `(blueprint.enabledRoles?.length ?? 0) < 2` | "Enable at least 2 roles to start a discussion" |

**UXD Decision:** We gate on `blueprintBusy` (any pending task) rather than just checking for running tasks, because convene uses the same serial workspace queue — starting a convene while another task is queued would just append to the queue, which might confuse users who expect an immediate discussion.

### 5.2 Convene Modal

Opens as a modal overlay (not a drawer) following the existing overlay pattern (`role="dialog"`, `aria-modal="true"`, `aria-label="Start convene discussion"`, Escape to close, focus trap).

**Layout:**
```
┌──────────────────────────────────────────┐
│  Start a Discussion                   ✕  │
│──────────────────────────────────────────│
│                                          │
│  Topic *                                 │
│  ┌──────────────────────────────────────┐│
│  │ What decision or trade-off should    ││
│  │ the roles discuss?                   ││
│  └──────────────────────────────────────┘│
│                                          │
│  Participating Roles                     │
│  [● PM] [● SDE] [● QA] [○ UXD]         │
│  (min 2 required)                        │
│                                          │
│  Context Nodes (optional)                │
│  ┌──────────────────────────────────────┐│
│  │ Search nodes...                      ││
│  │ ☐ #1 Set up project scaffolding     ││
│  │ ☑ #3 Design API endpoints           ││
│  │ ☑ #5 Define data model              ││
│  └──────────────────────────────────────┘│
│                                          │
│  Rounds   [3 ▾]  (1-5)                  │
│                                          │
│  ┌──────────────────────────────────────┐│
│  │  Start Discussion                    ││
│  └──────────────────────────────────────┘│
└──────────────────────────────────────────┘
```

**Component details:**

- **Topic textarea:** Required. `min-h-[80px]`, `resize-y`. Border: `border-border-primary focus:border-accent-purple`. Placeholder: `"What decision or trade-off should the roles discuss?"`
- **Participating Roles:** Reuse `<RoleSelector>` component, pre-filled with `blueprint.enabledRoles`. Custom `minSelected={2}` enforcement — when `value.length <= 2`, the two remaining selected buttons show a subtle shake animation on click attempt and tooltip "Minimum 2 roles required".
- **Context Nodes:** Scrollable checkbox list with search filter. Each row: `node.seq` badge (small `bg-bg-tertiary rounded px-1.5 text-xs font-mono text-text-secondary`) + title (truncated). Max height `max-h-[200px] overflow-y-auto`. Skipped nodes excluded.
- **Rounds:** Number input (`type="number"`, `min=1`, `max=5`, `defaultValue=3`). Small inline input, `w-16`, same border/focus pattern.
- **Start Discussion button:** Full width. `bg-accent-purple text-white hover:bg-accent-purple/90 active:scale-[0.98]`. Disabled when topic is empty or fewer than 2 roles selected. Uses `<AISparkle>` on loading state (since it triggers AI orchestration).

**UXD Decision — Modal vs drawer:** Modal chosen over drawer because convene setup is a focused, form-like interaction (not a side-panel browse). The modal forces user attention on the configuration before committing. Drawer pattern is reserved for reference panels (insights, session history).

### 5.3 Active Convene Indicator

When `pendingTasks.some(t => t.type === "convene")` is true, display an inline status banner below the blueprint header:

```
className="flex items-center gap-2 px-4 py-2 rounded-lg
  bg-accent-purple/10 border border-accent-purple/20
  text-sm text-accent-purple"
```

Content: Pulsing dot (`w-2 h-2 rounded-full bg-accent-purple animate-pulse`) + "Role discussion in progress" + truncated topic text in `text-text-secondary`.

Completion toast (via existing `useEffect` watching `pendingTasks` transitions):
- Success: `showToast("Discussion complete — review synthesis")`
- Failure: `showToast("Discussion encountered an error", "error")`

### 5.4 Discussions Section (Blueprint Detail Page)

Collapsible section below the insights panel. Section header: "Discussions" + count badge (e.g., "3") using `bg-accent-purple/15 text-accent-purple text-xs rounded-full px-2 py-0.5`.

**UXD Decision:** Collapsible section (not a tab) because convene sessions are supplementary to the primary node list view. Tabs would imply equal weight with nodes. The section uses `aria-expanded` toggle with chevron rotation (existing pattern).

Data fetched via `GET /api/blueprints/:id/convene-sessions` added to the blueprint detail page's `Promise.all` poll cycle.

**Session card layout:**
```
┌────────────────────────────────────────────────────┐
│ ● "Should we use GraphQL or REST for the API?"     │
│ ┌──────┐ ┌──────┐ ┌──────┐   5 messages  · 2m ago │
│ │● PM  │ │● SDE │ │● UXD │                        │
│ └──────┘ └──────┘ └──────┘                         │
└────────────────────────────────────────────────────┘
```

- Status dot via `<StatusIndicator>` — requires new status mappings (see §5.6)
- Role badges via `<RoleBadge size="xs">` for each participating role
- Message count + relative timestamp in `text-text-muted text-xs`
- Click → expand inline to show message thread (no separate page navigation)
- Card uses `hover:bg-bg-hover cursor-pointer active:scale-[0.995] transition-all`

### 5.5 Message Thread UI (Expanded Session)

Vertical chat-like layout within the expanded card:

**Round divider:**
```
className="flex items-center gap-3 my-3"
```
Line: `flex-1 h-px bg-border-primary`
Label: `text-text-muted text-xs font-medium whitespace-nowrap` → "Round 1"

**Message bubble:**
```
┌─────────────────────────────────────────┐
│ ┌──────┐                                │
│ │● SDE │  Round 1                       │
│ └──────┘                                │
│                                         │
│ For the API layer, I recommend REST     │
│ because our existing infrastructure...  │
│                                         │
└─────────────────────────────────────────┘
```

- Container: `pl-4 border-l-2` with role-specific border color from `ROLE_COLORS[roleId].border` (e.g., SDE = `border-accent-blue/30`)
- Header: `<RoleBadge roleId={msg.roleId} size="xs">` + round label `text-text-muted text-xs`
- Content: rendered via `<MarkdownContent content={msg.content} />`
- Messages within a round separated by `gap-3`

**Synthesis message (distinguished):**
```
className="bg-accent-purple/10 border-l-2 border-accent-purple
  rounded-r-lg p-4 mt-4"
```
- Header: "Synthesis" label in `text-accent-purple font-medium text-sm` + sparkle icon
- Content: `<MarkdownContent>` for the textual synthesis
- Below: preview of proposed nodes as mini cards:

**Proposed node preview card:**
```
className="flex items-start gap-3 p-3 rounded-lg
  bg-bg-secondary border border-border-primary"
```
- Title in `font-medium text-sm text-text-primary`
- Description truncated to 2 lines via `line-clamp-2 text-text-secondary text-xs`
- Role badges if `roles` field present

**Action buttons (below synthesis):**
```
<div className="flex gap-3 mt-4">
  <button className="... bg-accent-green/15 text-accent-green border-accent-green/30 hover:bg-accent-green/25">
    Approve & Create Nodes
  </button>
  <button className="... bg-accent-red/15 text-accent-red border-accent-red/30 hover:bg-accent-red/25">
    Discard
  </button>
</div>
```

- **Approve:** Calls `POST .../approve`. On success: `showToast("{N} nodes created from discussion")`. Session card collapses, status updates to `completed`.
- **Discard:** Inline confirmation pattern (no `window.confirm()`). First click reveals "Are you sure?" + "Yes, discard" / "Cancel" pair with `animate-fade-in`. Calls `POST .../cancel`.
- Both buttons disabled when session status is not `synthesizing`

**UXD Decision — Inline expand vs separate page:** Inline expand keeps the user in the blueprint context and allows quick review of multiple sessions. A separate page would require navigation and lose context. The thread is rendered inside a `max-h-[500px] overflow-y-auto` container with the custom scrollbar styling.

### 5.6 StatusIndicator Extensions

Add convene-specific status mappings to `StatusIndicator.tsx`:

```typescript
// Add to statusColors:
active: "bg-accent-purple animate-pulse",
synthesizing: "bg-accent-amber animate-pulse",
// completed and cancelled already map to "done"/"skipped" equivalents

// Add to statusLabels:
active: "Discussion active",
synthesizing: "Awaiting review",
```

**UXD Decision:** `active` uses purple (matches convene branding); `synthesizing` uses amber (signals "needs attention" — consistent with how `queued` and `blocked` use amber). `completed` and `cancelled` reuse the existing `done` (green) and `skipped` (muted) tokens — no new entries needed since the component falls back to `statusLabels[status] ?? status`.

**PM Decision:** We add these to the shared `StatusIndicator` rather than creating a separate component. The `context` prop could be extended with `"convene"` if label overrides are needed later, but for MVP the default labels are sufficient.

### 5.7 Cross-Tab Broadcast

Add `"convene"` to `BroadcastOpType` in `useBlueprintBroadcast.ts`:

```typescript
export type BroadcastOpType =
  | "run" | "enrich" | "reevaluate" | "split" | "smart_deps"
  | "generate" | "run_all" | "reevaluate_all" | "resume"
  | "coordinate" | "convene";
```

After `POST /api/blueprints/:id/convene` resolves, call `broadcastOperation("convene")`.

---

## 6. Integration Points

### 6.1 Side-Effect Imports

The convene executor module (wherever it lives) must import:
- All agent runtime modules (`agent-claude.js`, `agent-pimono.js`, `agent-openclaw.js`, `agent-codex.js`)
- All role modules (`roles/role-sde.js`, `roles/role-qa.js`, `roles/role-pm.js`, `roles/role-uxd.js`)

Test files must add corresponding `vi.mock()` blocks.

### 6.2 PendingTask Sync

- Backend: `"convene"` added to `PendingTask.type` union in `plan-executor.ts`
- Frontend: mirrored in `api.ts` `PendingTask` type
- Blueprint detail page: `conveneQueued` derived boolean + fire-and-forget loading pattern (optimistic flag + `pendingTasks.some(t => t.type === "convene")`)
- `NodeDetailPage` `hasRelatedOps` check updated to include `"convene"`

### 6.3 Insights → Convene Suggestion (Stretch Goal)

When `blueprint_insights` with `severity: "warning"` or `"critical"` reach ≥ 2 unread, the insights panel shows a "Discuss with roles" action button. Clicking:
- Opens the convene modal
- Pre-fills topic with a concatenation of the insight summaries
- Pre-fills participating roles from the blueprint's enabled roles

**PM Decision:** This is a stretch goal for 0.5.0. Define the hook point (a callback prop on the insights panel that opens the convene modal with pre-filled data) but don't block MVP on it.

### 6.4 Blueprint `convene_session_count` Field

Add `conveneSessionCount?: number` to the frontend `Blueprint` type. Backend includes this in `getBlueprint()` / `listBlueprints()` responses via a COUNT join (non-cancelled sessions only). Used for the Discussions section header badge.

---

## 7. Accessibility Requirements

| Element | Requirement |
|---------|-------------|
| Convene button | `aria-label="Start a multi-role discussion"` when enabled; dynamic tooltip on disabled |
| Convene modal | `role="dialog"`, `aria-modal="true"`, `aria-label="Start convene discussion"`, focus trap, Escape to close |
| Topic textarea | `aria-required="true"`, `aria-label="Discussion topic"` |
| Context nodes list | Checkbox inputs with `aria-label="Include {node title} as context"` |
| Discussions section | `aria-expanded` on toggle, `aria-controls` linking to section content |
| Message thread | Ordered list (`role="list"`) with `role="listitem"` per message |
| Approve/Discard buttons | `aria-label` with action + outcome ("Approve synthesis and create N nodes") |
| Inline confirmation | `aria-live="polite"` on confirmation region for screen reader announcement |
| Status dots | Via existing `StatusIndicator` with `role="img"` and `aria-label` |

---

## 8. Mobile Responsiveness

| Element | Desktop | Mobile (< 640px) |
|---------|---------|-------------------|
| Convene button | Full label "Convene" | Icon-only with `aria-label`, in overflow menu if action bar has > 4 buttons |
| Modal | Centered, `max-w-lg` | Full-width bottom sheet with `animate-slide-up`, `rounded-t-2xl` |
| Role selector | Horizontal flex wrap | Same (buttons are already touch-friendly at 44px) |
| Context nodes list | `max-h-[200px]` | `max-h-[150px]` (smaller viewport budget) |
| Message thread | `max-h-[500px]` | `max-h-[60vh]` (viewport-relative) |
| Action buttons | Side by side | Stacked full-width |

---

## 9. Error States & Edge Cases

| Scenario | Behavior |
|----------|----------|
| All agent calls fail in a round | Messages stored as `"[Agent error: {msg}]"`, round continues to next role, session completes with degraded quality |
| Synthesis JSON extraction fails | Status stays `synthesizing`, `synthesis_result` = null. UI shows "Synthesis could not be parsed — review the discussion and create nodes manually" with a link to manual batch-create |
| User cancels during active round | Status → `cancelled`. In-flight agent call completes (fire-and-forget), but its message is still stored (for audit). Frontend stops polling immediately |
| Blueprint deleted while convene is active | CASCADE delete removes session and messages. Pending task removal handled by queue cleanup |
| Role removed from `enabledRoles` after session starts | No impact — `participating_roles` is snapshotted at session creation. The discussion completes with the originally selected roles |
| Queue contention (another task queued first) | Convene waits in the serial queue. Frontend shows "Waiting in queue" via standard `pendingTasks` display |
| User starts a second convene while first is active | Allowed — both are independent sessions. They serialize via the workspace queue. UI shows both in the Discussions section |

---

## 10. Acceptance Criteria

1. **Start session:** User can start a convene session from the blueprint detail page with 2+ enabled roles, a topic, and optional context nodes
2. **Round-robin execution:** Backend orchestrates sequential role turns (each role speaks once per round, for `maxRounds` rounds), storing each message in `convene_messages`
3. **Synthesis:** After all rounds, a synthesis turn produces `batch-create`-compatible JSON payload stored as `synthesis_result`
4. **Approve flow:** User can review the synthesis output and approve (creating nodes automatically) or discard (cancelling the session)
5. **History browsable:** Convene sessions are listed on the blueprint page with full message history viewable inline
6. **Role color coding:** Messages use `role-colors.ts` tokens (SDE=`accent-blue`, QA=`accent-green`, PM=`accent-purple`, UXD=`accent-amber`)
7. **Cross-tab sync:** `BroadcastChannel` notifies other tabs when convene starts
8. **Fire-and-forget:** API returns `{status: "queued"}` immediately; frontend polls via `pendingTasks`
9. **Status transitions:** `active → synthesizing → completed` (or `cancelled` at any point)
10. **Incremental migration:** New DB tables use `sqlite_master` check pattern (no schema version bump)
11. **Error resilience:** Individual agent failures don't crash the session; synthesis parse failures leave the session in a reviewable state
12. **Accessibility:** All interactive elements meet WCAG AA contrast ratios and have proper ARIA attributes
13. **Mobile:** Modal renders as bottom sheet on mobile; message thread is scrollable within viewport constraints

---

## 11. Out of Scope (for MVP)

- Real-time streaming of messages (polling is sufficient; SSE/WebSocket is a future enhancement)
- Editing or re-running individual messages within a session
- Forking a completed session to continue discussion
- Automatic convene suggestions based on node conflict detection
- Voice/audio contributions from roles
- Convene session templates (pre-defined topics)

---

## 12. Implementation Sequencing Recommendation

For SDE node planning:

1. **DB tables + CRUD** (`plan-db.ts`) — new tables, row helpers, batch-loading integration
2. **API endpoints** (`plan-routes.ts`) — CRUD routes, approve/cancel
3. **Orchestration** (`convene-executor.ts` or `plan-executor.ts`) — round-robin + synthesis
4. **Frontend types** (`api.ts`) — type mirrors + API client functions
5. **Convene modal** — trigger button + form modal
6. **Active indicator + polling** — `pendingTasks` integration, broadcast
7. **Discussions section** — session list, message thread, approve/discard
8. **StatusIndicator extensions** — new status mappings
9. **Tests** — backend unit tests + frontend component tests
10. **Stretch: Insights → Convene hook** — pre-fill integration

---

*End of specification.*
