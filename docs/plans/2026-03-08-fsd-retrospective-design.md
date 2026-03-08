# FSD Retrospective: Replace Per-Node Callbacks with FSD-Driven Review

## Problem

After each node execution, the system spawns a separate Claude CLI session (`evaluateNodeCompletion`) that makes 3 callback API calls:
- `evaluation-callback` — assess completion quality, apply graph mutations
- `suggestions-callback` — generate per-node follow-up suggestions
- `insights-callback` — generate blueprint-level insights

For N nodes completing in a round, this costs 3N extra LLM calls. The FSD loop is already capable enough to handle this work itself — it can call endpoints to read node details and create insights/suggestions via tools.

## Design

### Core Change

Remove automated per-node evaluation from FSD/autopilot execution. Instead, the FSD loop tracks which nodes completed during the current round and handles retrospective itself using its tool palette.

### Flow

```
Before:
  run_node → report-status (done) → evaluateNodeCompletion → 3 callbacks
  run_node → report-status (done) → evaluateNodeCompletion → 3 callbacks
  loop exit → reflection + generateBlueprintSuggestions + globalMemory

After:
  run_node → report-status (done) → track in completedThisRound
  run_node → report-status (done) → track in completedThisRound
  FSD decides: retrospective phase → get_node_details → create insights/suggestions
  loop exit → reflection + globalMemory
```

### What the FSD LLM Handles in Retrospective

1. **Quality check**: Read completed node details via `get_node_details`, assess if work is complete
2. **Graph mutations**: If work is incomplete, create follow-up nodes via `create_node`
3. **Per-node suggestions**: Create suggestions for specific nodes via `create_node_suggestion`
4. **Insights**: Create blueprint-level observations via `create_insight`
5. **Blueprint suggestions**: Create overall next-step suggestions via `create_blueprint_suggestion`

### Tracking `completedThisRound`

- Local `string[]` in `runAutopilotLoop`
- Pushed to when `run_node` returns success (node status transitions to "done")
- Included in state snapshot via `buildAutopilotPrompt` so LLM sees which nodes to review
- Reset: not needed (loop-scoped variable)

### Manual Mode

`evaluateNodeCompletion` is kept for manual mode — when a user clicks "Run" on a single node, the automated evaluation is still valuable since there's no FSD loop to handle it.

### New FSD Tools

```
create_insight(severity, title, detail, sourceNodeId?)
  → calls createInsight() from plan-db

create_node_suggestion(nodeId, title, description)
  → calls createSuggestion() from plan-db

create_blueprint_suggestion(title, description)
  → calls createBlueprintSuggestion() from plan-db
```

### Removed from FSD

- `evaluate_node` tool (replaced by FSD reading + creating insights/suggestions directly)
- `generateBlueprintSuggestions` at loop exit (FSD handles this)
- `clearBlueprintSuggestions` at loop start (old suggestions stay until FSD replaces them)

### Prompt Guidance

Add retrospective instructions to the FSD prompt:

```
After completing nodes, review your work:
- Use get_node_details to read outcomes of completed nodes
- Create insights for important observations (create_insight)
- Create suggestions for follow-up work (create_node_suggestion)
- Create blueprint-level suggestions (create_blueprint_suggestion)
- If work is incomplete, create follow-up nodes (create_node)

Completed this round: [list of node IDs/titles]
```

The LLM decides when to do retrospective — it's not forced. Natural checkpoint: when all runnable nodes are done and before the loop exits.
