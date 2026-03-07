# Smart Auto-Triage — Design Specification

**Date:** 2026-03-04
**Status:** Archived (superseded by Autopilot Mode — agent handles triage decisions directly)
**Target Release:** ~~ClawUI 0.6.0~~
**Dependencies:** None (standalone, builds on existing evaluation + insights + coordinator)
**Superseded By:** [Autopilot Mode](./2026-03-04-autopilot-mode-design.md) — the Autopilot AI agent handles suggestion triage as part of its decision loop, making a separate classification system unnecessary.

---

## 1. Problem Statement

After node execution, the evaluation loop produces **suggestions** (`node_suggestions` table) and **insights** (`blueprint_insights` table). The Coordinator can read insights and create nodes, but it lacks **prioritization logic** — all items are treated equally, requiring the user to manually triage every suggestion and insight into actionable, ordered work.

For a blueprint with 10 nodes, a typical evaluation cycle produces 3–8 suggestions per node. The user must:
1. Read each suggestion
2. Decide whether to act on it (create a node) or dismiss it
3. Determine where it fits in the dependency graph
4. Set the right priority/order

This is the single biggest bottleneck in the blueprint workflow today.

### Success Criteria

- Blocking items (compilation errors, type errors, critical bugs) are auto-resolved without user intervention
- Important items (test coverage, error handling, lint) are batched for one-click approval
- Optional items (refactoring, documentation, optimization) are parked without cluttering the active view
- User triage effort reduced by ~80% (from per-item review to per-batch approval)

---

## 2. Triage Priority Model

Three priority levels, determined by AI classification:

| Priority | Label | Color | Auto-Action | User Action Required |
|----------|-------|-------|-------------|---------------------|
| `critical` | Critical | `accent-red` | Auto-create node, insert into dependency chain, auto-execute | None (notification only) |
| `important` | Important | `accent-amber` | Auto-create node draft in Triage Queue | Batch approve/dismiss |
| `optional` | Optional | `accent-blue` | Store in backlog | Browse when convenient |

### Classification Heuristics (Prompt Guidance)

The triage prompt instructs the AI to classify based on:

**Critical** (would prevent downstream nodes from succeeding):
- Compilation/type errors in output files
- Missing exports or broken imports that downstream nodes depend on
- Critical runtime errors (crashes, data corruption)
- Failed build/test that downstream nodes rely on

**Important** (quality/correctness issues that should be fixed but don't block):
- Missing test coverage for new code
- Error handling gaps
- Lint/style violations
- Edge cases not handled
- Security concerns (input validation, etc.)

**Optional** (improvements that are nice-to-have):
- Code refactoring / cleanup
- Documentation additions
- Performance optimization
- Alternative implementation approaches

---

## 3. Data Model Changes

### 3.1 `node_suggestions` Table — New Column

Add `triage_priority` column via incremental migration:

```sql
ALTER TABLE node_suggestions ADD COLUMN triage_priority TEXT DEFAULT NULL;
-- Values: 'critical' | 'important' | 'optional' | NULL (untriaged / legacy)
```

Migration pattern: `PRAGMA table_info(node_suggestions)` check in `initPlanTables()`, same as existing incremental migrations.

### 3.2 `blueprints` Table — New Column

Add `execution_mode` column (used by Autopilot feature but schema added here):

```sql
ALTER TABLE blueprints ADD COLUMN execution_mode TEXT DEFAULT 'manual';
-- Values: 'manual' | 'autopilot'
```

### 3.3 Backend Type Changes

```typescript
// plan-db.ts — extend NodeSuggestion
export interface NodeSuggestion {
  id: string;
  nodeId: string;
  blueprintId: string;
  title: string;
  description: string;
  used: boolean;
  roles?: string[];
  triagePriority?: TriagePriority;  // NEW
  createdAt: string;
}

export type TriagePriority = "critical" | "important" | "optional";
```

```typescript
// plan-db.ts — extend Blueprint
export interface Blueprint {
  // ... existing fields ...
  executionMode?: ExecutionMode;  // NEW
}

export type ExecutionMode = "manual" | "autopilot";
```

### 3.4 Frontend Type Mirrors (`frontend/src/lib/api.ts`)

```typescript
export type TriagePriority = "critical" | "important" | "optional";
export type ExecutionMode = "manual" | "autopilot";

// Extend existing NodeSuggestion
export interface NodeSuggestion {
  // ... existing fields ...
  triagePriority?: TriagePriority;
}

// Extend existing Blueprint
export interface Blueprint {
  // ... existing fields ...
  executionMode?: ExecutionMode;
}
```

---

## 4. Backend — Triage Engine

### 4.1 New Function: `triageSuggestions()`

**Location:** New file `backend/src/plan-triage.ts` or within `plan-executor.ts`.

```typescript
export async function triageSuggestions(
  blueprintId: string,
  nodeId: string,
): Promise<TriageResult>
```

**When called:** Automatically after `evaluateNodeCompletion()` produces suggestions, or manually via API.

**Flow:**

```
1. Fetch untriaged suggestions for the node:
   getSuggestionsForNode(nodeId).filter(s => !s.triagePriority)

2. If none → return early

3. Build triage prompt:
   - Blueprint context (title, description, enabled roles)
   - Current node context (title, description, artifact output)
   - Downstream nodes (what depends on this node)
   - List of suggestions to classify

4. Run agent via runAgentInteractive(prompt, projectCwd)

5. Parse response: expect JSON array
   [{suggestionId, priority: "critical"|"important"|"optional", reason}]

6. Update each suggestion: SET triage_priority = priority

7. Auto-handle critical items (MANUAL MODE ONLY):
   Skip this step if blueprint.executionMode === 'autopilot'
   (in autopilot mode, the Autopilot agent sees triaged results and decides actions itself)

   For each critical suggestion:
     a. Create new MacroNode from suggestion (title, description, roles)
     b. Set depends_on = [nodeId] (fixes the issue in the completed node's output)
     c. Rewire: downstream nodes that depended on nodeId now depend on the new fix node
     d. Mark suggestion as used

8. Return { critical: [...], important: [...], optional: [...] }
```

### 4.2 Triage Prompt Template

```
You are triaging suggestions from a code evaluation.

## Blueprint: "{blueprint.title}"
{blueprint.description}

## Completed Node: #{node.seq} "{node.title}"
{node.description}

## Node Output Summary:
{artifact or execution summary}

## Downstream Nodes (depend on this node):
{dependents list with titles and descriptions}

## Suggestions to Triage:
{suggestions as numbered list with title + description}

Classify each suggestion into one of three priorities:
- "critical": Would cause downstream nodes to fail (compilation errors, missing exports, broken APIs, critical bugs)
- "important": Quality issues that should be fixed but won't block downstream work (tests, error handling, lint, security)
- "optional": Nice-to-have improvements (refactoring, docs, optimization)

Respond with ONLY a JSON array:
[{"suggestionId": "...", "priority": "critical"|"important"|"optional", "reason": "brief explanation"}]
```

### 4.3 Integration with Evaluation Flow

Modify `evaluateNodeCompletion()` in `plan-executor.ts`:

```
After evaluation callback completes:
  1. (existing) Auto-trigger coordinator for critical insights
  2. (NEW) Auto-trigger triage for any untriaged suggestions:
     if (getSuggestionsForNode(nodeId).some(s => !s.triagePriority)):
       enqueueBlueprintTask(blueprintId, () => triageSuggestions(blueprintId, nodeId))
```

This adds triage as a follow-up task in the serial queue, ensuring it doesn't conflict with other operations.

---

## 5. Backend API

### 5.1 `GET /api/blueprints/:id/triage-queue`

Returns all untriaged + important suggestions for a blueprint, grouped by node.

Response:
```json
{
  "critical": [],
  "important": [
    {
      "nodeId": "...",
      "nodeTitle": "...",
      "nodeSeq": 3,
      "suggestions": [
        {"id": "...", "title": "...", "description": "...", "triagePriority": "important", "roles": ["sde"]}
      ]
    }
  ],
  "optional": [
    // same structure
  ],
  "stats": {
    "totalUntriaged": 0,
    "totalBlocking": 2,
    "totalImportant": 5,
    "totalOptional": 7
  }
}
```

### 5.2 `POST /api/blueprints/:id/triage-queue/approve`

Batch-approve important suggestions → create nodes.

Request body:
```json
{
  "suggestionIds": ["id1", "id2", "id3"],
  "insertAfterNodeId": "optional — if omitted, append at end"
}
```

Behavior:
- Creates MacroNode for each approved suggestion
- Sets appropriate `depends_on` based on source node
- Marks suggestions as `used`
- Returns created node IDs

### 5.3 `POST /api/blueprints/:id/triage-queue/dismiss`

Batch-dismiss suggestions (mark as optional or delete).

Request body:
```json
{
  "suggestionIds": ["id1", "id2"],
  "action": "dismiss"
}
```

### 5.4 `POST /api/blueprints/:id/triage-queue/retriage`

Re-run triage on all untriaged suggestions (manual trigger).

### 5.5 Existing Endpoint Changes

`GET /api/blueprints/:id/nodes/:nodeId/suggestions` — add `triagePriority` field to response items.

---

## 6. Frontend — Triage Queue Panel

### 6.1 Location

New collapsible section on the Blueprint detail page, positioned **above the Insights panel** (higher priority for user attention).

Section header: **"Triage Queue"** + count badge showing `important` count.

```
className="flex items-center gap-2 text-sm font-medium text-text-primary cursor-pointer"
```

Badge: `bg-accent-amber/15 text-accent-amber text-xs rounded-full px-2 py-0.5`

### 6.2 Triage Queue Layout

```
+----------------------------------------------------------+
| Triage Queue (5)                                    [v]  |
|----------------------------------------------------------|
|                                                          |
| From Node #3 "Implement API endpoints"                   |
| +------------------------------------------------------+ |
| | [ ] Add input validation for POST /api/users         | |
| |     Missing request body validation could cause...   | |
| |     [SDE]                             important      | |
| +------------------------------------------------------+ |
| | [ ] Add rate limiting middleware                      | |
| |     API endpoints have no rate limiting...           | |
| |     [SDE]                             important      | |
| +------------------------------------------------------+ |
|                                                          |
| From Node #5 "Build auth system"                         |
| +------------------------------------------------------+ |
| | [ ] Add token expiry handling                        | |
| |     JWT tokens never expire, which is a security...  | |
| |     [SDE] [QA]                        important      | |
| +------------------------------------------------------+ |
|                                                          |
| [Approve Selected (3)]  [Dismiss Selected]  [Select All] |
+----------------------------------------------------------+
```

### 6.3 Component Details

**Suggestion card:**
- Checkbox for batch selection
- Title in `font-medium text-sm text-text-primary`
- Description truncated to 2 lines (`line-clamp-2 text-text-secondary text-xs`)
- Role badges via `<RoleBadge size="xs">`
- Priority badge: `important` in `text-accent-amber text-xs`, `optional` in `text-accent-blue text-xs`
- `hover:bg-bg-hover` on card

**Group header (per source node):**
- `text-text-secondary text-xs font-medium`
- Node seq badge + title

**Action buttons:**
- **Approve Selected:** `bg-accent-green/15 text-accent-green border-accent-green/30` — creates nodes from selected suggestions
- **Dismiss Selected:** `bg-bg-tertiary text-text-secondary` — moves to optional/dismissed
- **Select All:** text button, toggles all checkboxes

**Empty state:**
- When no important items: "All caught up — no items need attention"
- `text-text-muted text-sm text-center py-6`

### 6.4 Auto-Handled Blocking Items Notification

When critical items are auto-handled, show a toast:
- `showToast("2 critical issues auto-fixed — new nodes #8, #9 created")`

Additionally, the Triage Queue panel shows a collapsed "Auto-resolved" section listing critical items that were automatically handled, with links to the created nodes. Uses `text-accent-green` styling to indicate resolution.

### 6.5 Backlog View (Optional Items)

Below the Triage Queue, a secondary collapsible section: **"Backlog"** with optional item count. Collapsed by default. Same card layout but without checkboxes — items can be individually promoted to "important" via a context action.

### 6.6 Data Fetching

Add to the blueprint detail page's `useBlueprintDetailQueries` hook:
- New query: `useQuery({ queryKey: blueprintKeys.triageQueue(id), queryFn: fetchTriageQueue })`
- Polled alongside existing blueprint/queue/insights queries
- Dynamic polling: 2s when triage is in progress, 10s otherwise

---

## 7. Integration with Existing Systems

### 7.1 Coordinator Enhancement

The existing Coordinator (`plan-coordinator.ts`) currently reads unread insights and instructs the agent to create/update nodes or dismiss. With Smart Triage, the flow changes:

- Coordinator continues to handle **insights** (blueprint-level observations)
- Smart Triage handles **suggestions** (node-level actionable items)
- They complement each other: Coordinator for strategic decisions, Triage for tactical task management

No changes to Coordinator needed in this feature.

### 7.2 Relationship with Autopilot Mode

Smart Triage operates as **two layers** with mode-dependent behavior:

| Layer | Responsibility | Manual Mode | Autopilot Mode |
|-------|---------------|-------------|----------------|
| **Classification** | AI triages suggestions into critical/important/optional | Runs automatically after evaluation | Runs automatically after evaluation (same) |
| **Auto-Action** | Creates fix nodes for critical items, queues important items | Active — critical items auto-create nodes | **Skipped** — Autopilot agent sees triaged results in its state snapshot and decides actions itself |

**Why this split matters:**
- In manual mode, users need automation help — they shouldn't have to manually handle critical issues that can be auto-fixed
- In autopilot mode, the AI agent is the decision-maker. It sees the `triagePriority` on each suggestion and can make richer decisions: approve, dismiss, split the source node instead, or start a convene discussion about the issue
- The Triage Queue UI works identically in both modes — it's where important items surface for review (by user in manual mode, or by the agent in autopilot mode)

**Implementation note:** The mode check in `triageSuggestions()` step 7 is a simple conditional:
```typescript
if (blueprint.executionMode !== "autopilot") {
  // Auto-handle critical items (create fix nodes)
}
```

### 7.3 PendingTask Integration


Add `"triage"` to `PendingTask.type` union:

```typescript
export interface PendingTask {
  type: "run" | "reevaluate" | "enrich" | "generate" | "split"
    | "smart_deps" | "evaluate" | "coordinate" | "convene"
    | "triage";  // NEW
  nodeId?: string;
  blueprintId: string;
  queuedAt: string;
}
```

Frontend: `triageQueued` derived boolean for loading state.

### 7.4 Cross-Tab Broadcast

Add `"triage"` to `BroadcastOpType`.

### 7.5 Side-Effect Imports

The triage module must import all agent runtime modules and role modules (same pattern as coordinator and convene executor).

---

## 8. Backward Compatibility

- `triage_priority = NULL` means untriaged (legacy suggestions are treated as untriaged)
- `execution_mode = 'manual'` is the default — existing blueprints behave identically
- No schema version bump — uses `PRAGMA table_info()` incremental migration
- Existing suggestion UI on NodeDetailPage continues to work; triage priority is shown as an additional badge

---

## 9. Error Handling

| Scenario | Behavior |
|----------|----------|
| Triage AI call fails | Suggestions remain untriaged (`triage_priority = NULL`); no critical auto-action. Log error, removePendingTask |
| Triage JSON parse fails | Same as above — suggestions stay untriaged for manual review |
| Auto-created critical fix node fails execution (manual mode) | Treated as a normal node failure. Max 2 auto-fix cycles per source node to prevent infinite loops |
| Suggestion references deleted node | Skip the suggestion, log warning |

---

## 10. Acceptance Criteria

1. After evaluation, suggestions are automatically triaged into critical/important/optional
2. In manual mode, critical suggestions auto-create nodes with correct dependency wiring; in autopilot mode, classification only (no auto-action)
3. Important suggestions appear in the Triage Queue panel for batch approval
4. Optional suggestions are stored in backlog, accessible but not intrusive
5. Batch approve creates nodes and marks suggestions as used
6. Batch dismiss removes items from the active queue
7. Toast notification when critical items are auto-resolved
8. Triage Queue shows in blueprint detail page with count badge
9. `triage_priority` field visible on NodeDetailPage suggestion cards
10. Cross-tab broadcast on triage operations
11. Incremental DB migration (no schema version bump)
12. Backward compatible — existing blueprints with NULL triage_priority work as before

---

## 11. Implementation Sequencing

1. **DB migration** — `triage_priority` column on `node_suggestions`, `execution_mode` on `blueprints`
2. **Triage engine** — `triageSuggestions()` function with prompt and JSON parsing
3. **Evaluation integration** — auto-trigger triage after evaluation
4. **API endpoints** — triage-queue, approve, dismiss, retriage
5. **Frontend types** — `TriagePriority`, `ExecutionMode` in `api.ts`
6. **Triage Queue panel** — UI component with batch actions
7. **Auto-resolve flow** — critical items auto-create nodes
8. **Tests** — backend triage logic + frontend Triage Queue component

---

*End of specification.*
