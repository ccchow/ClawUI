# FSD Retrospective Implementation Plan

**Goal:** Replace per-node evaluation callbacks with FSD-driven retrospective. The FSD loop reviews completed nodes itself using tools.

**Design doc:** `docs/plans/2026-03-08-fsd-retrospective-design.md`

---

### Task 1: Add retrospective tools to FSD palette

Add three new tools for creating insights and suggestions. Wire them into `executeDecision`.

**Files:**
- Modify: `backend/src/autopilot.ts`

**Steps:**

1. Add imports for `createSuggestion`, `createBlueprintSuggestion`, `createInsight`, `clearBlueprintSuggestions` (some already imported)

2. Add tool descriptions to `TOOL_DESCRIPTIONS`:
```
- **create_insight(severity, message, sourceNodeId?)** — Create a blueprint-level insight. severity: "info"|"warning"|"critical". sourceNodeId is optional (links insight to a specific node).
- **create_node_suggestion(nodeId, title, description)** — Create a follow-up suggestion for a specific node.
- **create_blueprint_suggestion(title, description)** — Create a blueprint-level suggestion for what the user could do next.
- **clear_blueprint_suggestions()** — Clear all existing blueprint suggestions before generating new ones.
```

3. Add cases to `executeDecision`:
```typescript
case "create_insight": {
  const severity = p.severity as InsightSeverity;
  const message = p.message as string;
  const sourceNodeId = (p.sourceNodeId as string) || null;
  if (!["info", "warning", "critical"].includes(severity)) {
    return { success: false, message: "Invalid severity", error: "invalid_params" };
  }
  createInsight(blueprintId, sourceNodeId, "autopilot", severity, message);
  return { success: true, message: `Created ${severity} insight` };
}

case "create_node_suggestion": {
  const nodeId = p.nodeId as string;
  const title = p.title as string;
  const description = p.description as string;
  createSuggestion(blueprintId, nodeId, title, description);
  return { success: true, message: `Created suggestion for node ${nodeId}` };
}

case "create_blueprint_suggestion": {
  const title = p.title as string;
  const description = p.description as string;
  createBlueprintSuggestion(blueprintId, title, description);
  return { success: true, message: `Created blueprint suggestion` };
}

case "clear_blueprint_suggestions": {
  clearBlueprintSuggestions(blueprintId);
  return { success: true, message: "Cleared all blueprint suggestions" };
}
```

4. Add these action names to the valid actions set (remove from unknown_action check)

5. Run: `cd backend && npx tsc --noEmit` — pass

6. Commit: `feat: add retrospective tools to FSD palette (create_insight, create_node_suggestion, create_blueprint_suggestion)`

---

### Task 2: Track completedThisRound in FSD loop

Track which nodes completed during this loop run. Include in state snapshot.

**Files:**
- Modify: `backend/src/autopilot.ts`

**Steps:**

1. Add `completedThisRound: string[]` local variable in `runAutopilotLoop`, initialized to `[]`

2. In the `run_node` case of `executeDecision`, after successful execution, push the nodeId:
   - Find where `run_node` returns success
   - After success, push `nodeId` to `completedThisRound`
   - Problem: `executeDecision` doesn't have access to `completedThisRound` (it's a standalone function)
   - Solution: Pass `completedThisRound` as parameter to `executeDecision`, or return info about completed nodes in the result and track in the loop

3. Simpler approach: Track in the loop itself. After `executeDecision` returns for a `run_node` action, check if the node status changed to "done" and add to list. Actually simplest: check the decision result — if `run_node` succeeded, the node is done.

4. In `buildAutopilotPrompt`, add `completedThisRound` parameter. Include in the state section:
```
## Nodes Completed This Round
${completedThisRound.length > 0 ? completedThisRound.map(id => `- ${id}`).join("\n") : "(none yet)"}
```
Use node seq/title for readability (look up from blueprint).

5. Run: `cd backend && npx tsc --noEmit` — pass

6. Commit: `feat: track completedThisRound in FSD loop and include in prompt`

---

### Task 3: Skip evaluateNodeCompletion in FSD/autopilot mode

The FSD loop handles retrospective itself. Keep evaluation for manual mode.

**Files:**
- Modify: `backend/src/plan-executor.ts`

**Steps:**

1. Find `evaluateNodeCompletion` call sites in `executeNodeInternal` (2 locations: ~line 1320 and ~line 1488)

2. Add execution mode check before each call:
```typescript
// Skip automated evaluation in FSD/autopilot mode — the FSD loop handles retrospective
const bp = getBlueprint(blueprintId);
const skipEval = bp && (bp.executionMode === "autopilot" || bp.executionMode === "fsd");
if (!skipEval) {
  await evaluateNodeCompletion(blueprintId, nodeId);
}
```

3. Keep the `evaluateNodeCompletion` function itself intact (used by manual mode and the plan-routes.ts manual evaluation endpoint)

4. Run: `cd backend && npx tsc --noEmit && npx vitest run` — pass

5. Commit: `refactor: skip per-node evaluation in FSD/autopilot mode`

---

### Task 4: Remove evaluate_node tool and generateBlueprintSuggestions from loop

Clean up: remove things the FSD replaces.

**Files:**
- Modify: `backend/src/autopilot.ts`

**Steps:**

1. Remove `evaluate_node` case from `executeDecision` — add to unknown_action list or just remove

2. Remove `evaluate_node` from `TOOL_DESCRIPTIONS`

3. Remove `generateBlueprintSuggestions` call at loop exit (line ~1579)

4. Remove `clearBlueprintSuggestions` call at loop start (line ~1410) — the FSD uses `clear_blueprint_suggestions` tool when it wants to refresh

5. Remove `generateBlueprintSuggestions` function entirely (it's only used at loop exit)

6. Clean up unused imports

7. Run: `cd backend && npx tsc --noEmit` — pass

8. Commit: `refactor: remove evaluate_node tool and generateBlueprintSuggestions from FSD loop`

---

### Task 5: Update FSD prompt with retrospective guidance

Update the prompt to guide the FSD on when and how to do retrospective.

**Files:**
- Modify: `backend/src/autopilot.ts`

**Steps:**

1. Add retrospective section to `TOOL_DESCRIPTIONS` or workflow guidance:
```
### Retrospective (after completing nodes)
After running nodes, review your work before moving on:
- Use **get_node_details(nodeId)** to read the outcome and handoff of completed nodes
- **create_insight(severity, message, sourceNodeId?)** — surface important observations (info/warning/critical)
- **create_node_suggestion(nodeId, title, description)** — suggest follow-up work for a node
- **create_blueprint_suggestion(title, description)** — suggest next steps for the blueprint overall
- **clear_blueprint_suggestions()** — clear old blueprint suggestions before generating new ones
- If a node's work is incomplete, create a follow-up node with **create_node**

Don't review every node exhaustively — focus on nodes where the outcome matters for downstream work or where you notice issues.
```

2. Update workflow section to mention retrospective as a natural phase

3. Run: `cd backend && npx tsc --noEmit` — pass

4. Commit: `feat: add retrospective guidance to FSD prompt`

---

### Task 6: Update tests

Update autopilot tests for new tools and removed features.

**Files:**
- Modify: `backend/src/__tests__/autopilot.test.ts`
- Modify: `backend/src/__tests__/autopilot-integration.test.ts`

**Steps:**

1. Add tests for new `executeDecision` cases:
   - `create_insight` with valid severity
   - `create_insight` with invalid severity returns error
   - `create_node_suggestion` creates suggestion
   - `create_blueprint_suggestion` creates suggestion
   - `clear_blueprint_suggestions` clears suggestions

2. Remove `evaluate_node` tests (or update to expect unknown_action)

3. Update integration tests:
   - Remove expectations for `evaluateNodeCompletion` being called after node execution in FSD mode
   - Add test: `completedThisRound` is included in prompt after node completes

4. Update prompt content tests:
   - Verify retrospective guidance is in prompt
   - Verify `evaluate_node` is NOT in tool descriptions

5. Run: `cd backend && npx vitest run` — all pass

6. Commit: `test: update autopilot tests for FSD retrospective`

---

### Task 7: Verify and clean up

**Files:** None (verification only)

1. `cd backend && npx tsc --noEmit` — 0 errors
2. `cd backend && npx vitest run` — all pass
3. Build and deploy: `npm run build:backend && bash scripts/deploy-stable.sh && bash scripts/start-stable.sh`

Commit only if fixes needed.
