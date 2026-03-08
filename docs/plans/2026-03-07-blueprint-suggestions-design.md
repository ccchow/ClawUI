# Blueprint-Level Suggestions Architecture

**Date**: 2026-03-07
**Status**: Draft
**Scope**: After each autopilot/FSD loop exit, generate 3 contextual blueprint-level suggestions displayed in BlueprintChat as clickable actions.

---

## 1. Overview

Node-level suggestions (stored in `node_suggestions`) are scoped to a single completed node. Blueprint-level suggestions are scoped to the entire blueprint and generated when the autopilot/FSD loop exits (pauses or completes). Clicking a suggestion sends it as a blueprint message, which can re-trigger the autopilot loop via `triggerAutopilotIfNeeded`.

### Flow Summary

```
autopilot loop exits
  → final reflection runs (existing)
  → generateBlueprintSuggestions() runs (new)
    → builds context prompt from blueprint state
    → calls runtime.runSession() to get 3 suggestions
    → upserts into blueprint_suggestions table
  → frontend polls and renders suggestions in BlueprintChat
  → user clicks suggestion
    → sendBlueprintMessage(content) + markBlueprintSuggestionUsed(id)
    → triggerAutopilotIfNeeded re-starts loop
```

---

## 2. Data Model

### New table: `blueprint_suggestions`

Mirrors `node_suggestions` but without `node_id`. Created via incremental migration (no schema version bump).

```sql
CREATE TABLE IF NOT EXISTS blueprint_suggestions (
  id            TEXT PRIMARY KEY,
  blueprint_id  TEXT NOT NULL REFERENCES blueprints(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL,
  used          INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blueprint_suggestions_bp
  ON blueprint_suggestions(blueprint_id, used);
```

**File**: `backend/src/plan-db.ts`
- Add table creation in `initializeDatabase()` after `node_suggestions` block (~line 322)
- No incremental migration needed — it's a new table, add to initial DDL block

### TypeScript interface

```typescript
// backend/src/plan-db.ts
export interface BlueprintSuggestion {
  id: string;
  blueprintId: string;
  title: string;
  description: string;
  used: boolean;
  createdAt: string;
}
```

### CRUD functions in `plan-db.ts`

```typescript
export function getBlueprintSuggestions(blueprintId: string): BlueprintSuggestion[]
export function createBlueprintSuggestion(blueprintId: string, title: string, description: string): BlueprintSuggestion
export function markBlueprintSuggestionUsed(blueprintId: string, suggestionId: string): BlueprintSuggestion
export function deleteBlueprintSuggestion(suggestionId: string): void
export function clearBlueprintSuggestions(blueprintId: string): void
```

Pattern follows existing `createSuggestion`/`getSuggestionsForNode`/`markSuggestionUsed`/`deleteSuggestion` (lines 1811-1845).

### Frontend mirror type

```typescript
// frontend/src/lib/api.ts
export interface BlueprintSuggestion {
  id: string;
  blueprintId: string;
  title: string;
  description: string;
  used: boolean;
  createdAt: string;
}
```

---

## 3. API Endpoints

All endpoints in `backend/src/plan-routes.ts`.

### GET `/api/blueprints/:blueprintId/suggestions`

Returns unused blueprint-level suggestions.

```typescript
planRouter.get("/api/blueprints/:blueprintId/suggestions", (req, res) => {
  const suggestions = getBlueprintSuggestions(req.params.blueprintId);
  res.json(suggestions.filter(s => !s.used));
});
```

### POST `/api/blueprints/:blueprintId/suggestions/:suggestionId/use`

Marks a suggestion as used, sends its content as a user message, and triggers autopilot.

```typescript
planRouter.post("/api/blueprints/:blueprintId/suggestions/:suggestionId/use", (req, res) => {
  const suggestion = markBlueprintSuggestionUsed(req.params.blueprintId, req.params.suggestionId);
  // Send suggestion title + description as a user message
  const content = `${suggestion.title}: ${suggestion.description}`;
  createAutopilotMessage(req.params.blueprintId, "user", content);
  triggerAutopilotIfNeeded(req.params.blueprintId);
  res.json(suggestion);
});
```

**Design choice**: The `/use` endpoint both marks the suggestion used AND sends the message. This avoids a race condition where the frontend would need to call two endpoints (`mark-used` + `sendMessage`) and ensures atomicity. The frontend does NOT need to call `sendBlueprintMessage` separately.

### POST `/api/blueprints/:blueprintId/suggestions/dismiss`

Clears all unused suggestions (user wants to dismiss them).

```typescript
planRouter.post("/api/blueprints/:blueprintId/suggestions/dismiss", (req, res) => {
  clearBlueprintSuggestions(req.params.blueprintId);
  res.json({ ok: true });
});
```

### Frontend API client additions

```typescript
// frontend/src/lib/api.ts
export function getBlueprintSuggestions(blueprintId: string): Promise<BlueprintSuggestion[]>
export function useBlueprintSuggestion(blueprintId: string, suggestionId: string): Promise<BlueprintSuggestion>
export function dismissBlueprintSuggestions(blueprintId: string): Promise<{ ok: boolean }>
```

---

## 4. Generation Flow

### When to generate

After the autopilot loop exits in `runAutopilotLoop()` (`backend/src/autopilot.ts`, line ~1599), right after `reflectAndUpdateMemory` and before the `finally` block.

```typescript
// After line 1608 (global memory update), before line 1610 (max iterations check)
await generateBlueprintSuggestions(blueprintId, iteration, blueprintMemory);
```

### Generation function

New exported function in `backend/src/autopilot.ts`:

```typescript
export async function generateBlueprintSuggestions(
  blueprintId: string,
  iteration: number,
  memory: string | null,
): Promise<void> {
  try {
    const blueprint = getBlueprint(blueprintId);
    if (!blueprint) return;

    // Don't generate suggestions if blueprint is fully done
    const allDone = blueprint.nodes.every(n => n.status === "done" || n.status === "skipped");
    if (allDone && blueprint.status === "done") return;

    // Build context
    const nodesSummary = blueprint.nodes.map(n =>
      `- #${n.seq} "${n.title}" [${n.status}]`
    ).join("\n");

    const recentLog = getAutopilotLog(blueprintId, 10, 0);
    const logSummary = recentLog.map(e =>
      `  iter ${e.iteration}: ${e.action} → ${e.result?.slice(0, 60) || "ok"}`
    ).join("\n");

    const prompt = `You are analyzing a blueprint after an autopilot run paused or completed an iteration cycle.

## Blueprint
Title: ${blueprint.title}
Description: ${blueprint.description || "(none)"}
Status: ${blueprint.status}
Execution mode: ${blueprint.executionMode || "manual"}
Pause reason: ${blueprint.pauseReason || "(none)"}

## Nodes
${nodesSummary}

## Recent Actions (last 10)
${logSummary || "(none)"}

## Memory
${memory || "(none)"}

## Task
Generate exactly 3 actionable suggestions for what the user could do next with this blueprint.
Each suggestion should be specific and contextual — not generic advice.

Consider:
- Nodes that failed or are blocked (retry, unblock, skip?)
- Work remaining (continue executing, reorder priorities?)
- Quality gates (review completed work, run tests?)
- Architectural pivots (split large nodes, add missing dependencies?)
- Completion actions (mark blueprint done, generate summary?)

Respond with ONLY a JSON array of 3 objects, each with "title" (short, action-oriented, <60 chars) and "description" (1-2 sentences explaining the action). No markdown fences, no preamble.

Example format:
[
  {"title": "Resume failed node #3", "description": "Node #3 failed due to a type error. Resume it after the dependency fix in node #2 lands."},
  {"title": "Skip blocked node #7", "description": "Node #7 is blocked on external API access. Skip it to unblock downstream work."},
  {"title": "Review completed authentication flow", "description": "Nodes #1-#4 are done. Review the auth implementation before continuing to the dashboard nodes."}
]`;

    const runtime = getActiveRuntime();
    const raw = await runtime.runSession(prompt, blueprint.projectCwd);

    // Parse response
    const parsed = JSON.parse(raw.trim());
    if (!Array.isArray(parsed)) return;

    // Clear old suggestions, insert new ones (max 3)
    clearBlueprintSuggestions(blueprintId);
    for (const item of parsed.slice(0, 3)) {
      if (item.title && item.description) {
        createBlueprintSuggestion(blueprintId, item.title, item.description);
      }
    }
  } catch (err) {
    log.warn("Blueprint suggestions generation failed: %s", err);
    // Non-fatal — suggestions are optional
  }
}
```

### Why `runtime.runSession` instead of a callback

Node-level suggestions use a callback pattern (the evaluation agent calls a POST endpoint). Blueprint suggestions are simpler — they don't need the agent to have tool access or execute code. A single prompt → JSON response is sufficient, matching the pattern used by `reflectAndUpdateMemory` (line 274).

### Clearing stale suggestions

Suggestions are replaced wholesale each time (clear + insert). This is simpler than diff-based updates (used for node suggestions) because:
1. Blueprint context changes significantly between loop exits
2. There's no stable identity to diff against (no `node_id` anchor)
3. The set is small (always exactly 3)

Old suggestions from previous loop exits are deleted when new ones are generated, or when a user dismisses them.

---

## 5. Frontend Integration

### Where suggestions appear in BlueprintChat

Suggestions render at the **top** of the chat (newest-first ordering means top = most recent). They appear as a sticky/floating group above the message timeline, visible when the autopilot is paused or idle.

**Rendering location**: `frontend/src/components/BlueprintChat.tsx`, between the scroll container and the input area — or as a pinned section at the top of the chat.

### New component: `BlueprintSuggestions`

```typescript
// frontend/src/components/BlueprintSuggestions.tsx

interface BlueprintSuggestionsProps {
  blueprintId: string;
  onSuggestionUsed: () => void; // trigger message refetch
}

function BlueprintSuggestions({ blueprintId, onSuggestionUsed }: BlueprintSuggestionsProps) {
  const { data: suggestions } = useQuery({
    queryKey: ["blueprint-suggestions", blueprintId],
    queryFn: () => getBlueprintSuggestions(blueprintId),
    refetchInterval: 5000, // poll while visible
  });

  const useMutation = useMutation({
    mutationFn: (id: string) => useBlueprintSuggestion(blueprintId, id),
    onSuccess: () => {
      queryClient.invalidateQueries(["blueprint-suggestions", blueprintId]);
      queryClient.invalidateQueries(["blueprint-messages", blueprintId]);
      onSuggestionUsed();
    },
  });

  if (!suggestions?.length) return null;

  return (
    <div className="flex flex-wrap gap-2 px-4 py-2">
      {suggestions.map(s => (
        <button
          key={s.id}
          onClick={() => useMutation.mutate(s.id)}
          className="text-left px-3 py-2 rounded-lg border border-border-secondary
                     bg-bg-secondary hover:bg-bg-tertiary transition-colors text-sm"
          title={s.description}
        >
          <span className="font-medium text-text-primary">{s.title}</span>
        </button>
      ))}
    </div>
  );
}
```

### Integration in BlueprintChat

```tsx
// In BlueprintChat.tsx, above the input area (below the scroll container)
{(blueprint.executionMode === "autopilot" || blueprint.executionMode === "fsd") && (
  <BlueprintSuggestions
    blueprintId={blueprint.id}
    onSuggestionUsed={() => refetchMessages()}
  />
)}
{/* existing input area */}
```

### Visibility rules

- Show suggestions only when autopilot/FSD is paused or between runs (no active autopilot task pending)
- Hide when autopilot loop is actively running (suggestions would be stale)
- Clear suggestions on the frontend when autopilot starts (or let the backend clear them at loop start)

### Auto-clear on loop start

In `runAutopilotLoop`, at the top of the function (around line 1405), add:
```typescript
clearBlueprintSuggestions(blueprintId);
```

This ensures stale suggestions from the previous loop exit are removed when a new loop begins.

---

## 6. Timing & Performance

### LLM call cost

One additional `runtime.runSession` call at loop exit. This is the same cost as `reflectAndUpdateMemory`. Since it only runs when the loop exits (not every iteration), the overhead is minimal.

### Ordering of post-loop operations

```
1. reflectAndUpdateMemory()     — existing, always runs
2. updateGlobalMemory()         — existing, runs if all nodes done
3. generateBlueprintSuggestions() — NEW
4. max iterations check         — existing
5. finally: removePendingTask   — existing
```

`generateBlueprintSuggestions` uses the already-updated `blueprintMemory` from step 1, giving it the freshest context.

### Frontend polling

TanStack Query with 5s refetch interval on the suggestions endpoint. This is lightweight (single DB query, small response). Polling stops when the component unmounts (user navigates away).

---

## 7. Trade-offs

| Decision | Alternative | Why chosen |
|----------|-------------|------------|
| New table `blueprint_suggestions` | Reuse `node_suggestions` with `node_id = NULL` | Clean separation, no nullable FK, clearer semantics |
| Replace-all on generation | Diff-based update (like node suggestions) | Simpler, no stable identity to diff against, always 3 items |
| Direct `runSession` | Callback pattern (like node evaluation) | Simpler for single prompt→JSON, no tools needed |
| `/use` endpoint sends message | Frontend sends message separately | Atomic operation, avoids race condition |
| Suggestions at loop exit only | Generate on-demand via API | Loop exit is the natural point; on-demand would need a separate trigger |
| Clear on loop start | Clear when user clicks suggestion | Prevents showing stale suggestions during active run |
| 5s polling | WebSocket/SSE | Consistent with existing polling patterns in BlueprintChat |

---

## 8. Files to Modify

| File | Change |
|------|--------|
| `backend/src/plan-db.ts` | Add `blueprint_suggestions` table, `BlueprintSuggestion` interface, CRUD functions |
| `backend/src/autopilot.ts` | Add `generateBlueprintSuggestions()`, call it in post-loop, add `clearBlueprintSuggestions` call at loop start |
| `backend/src/plan-routes.ts` | Add 3 new endpoints (GET suggestions, POST use, POST dismiss) |
| `frontend/src/lib/api.ts` | Add `BlueprintSuggestion` type, API client functions |
| `frontend/src/components/BlueprintSuggestions.tsx` | New component (suggestion buttons) |
| `frontend/src/components/BlueprintChat.tsx` | Import and render `BlueprintSuggestions` above input area |

### No changes needed to

- `plan-executor.ts` — node evaluation is unchanged
- `plan-operations.ts` — AI operations are unchanged
- Schema version — new table, no version bump needed
- Existing node suggestion logic — fully independent

---

## 9. Test Strategy

### Backend unit tests

- `autopilot.test.ts`: Mock `runtime.runSession` to return valid/invalid JSON for `generateBlueprintSuggestions`. Verify suggestions are created/cleared correctly.
- `plan-db` tests: CRUD operations for `blueprint_suggestions` table.

### Frontend tests

- `BlueprintSuggestions.test.tsx`: Render with mock suggestions, verify click handler calls API, verify empty state renders nothing.
- `BlueprintChat.test.tsx`: Verify `BlueprintSuggestions` renders when in autopilot mode.

### Integration

- Run autopilot loop to completion/pause → verify suggestions appear in DB.
- Click suggestion → verify message created and autopilot re-triggered.
