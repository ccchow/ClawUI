# Plan System — Task Orchestration Layer

## Conceptual Model

```
Plan (Blueprint)
  ├── Node 1: "Set up project skeleton"       ⚪ pending
  │     └── Session: null (not yet executed)
  ├── Node 2: "Implement data model"          🔵 running
  │     └── Session: abc-123.jsonl (linked to existing session)
  ├── Node 3: "Build API endpoints"           ⚪ pending
  │     └── depends_on: [Node 2]
  └── Node 4: "Frontend UI"                   ⚪ pending
        └── depends_on: [Node 3]
```

**Plan** = A structured decomposition of a high-level task, containing multiple ordered **Nodes** with dependencies.
**Node** = An independently executable subtask. Execution creates a Claude Code session.
**Artifact** = A handoff summary generated after a node completes, passed as context to downstream nodes.

## Relationship with the Four-Layer Model

```
Existing four layers                Plan system extension
─────────────────                   ─────────────────────
Layer 4 — App State                 + activePlanId, planViewMode
Layer 3 — Enrichment                + session↔node association
Layer 2 — Index (SQLite)            + plans, plan_nodes tables
Layer 1 — Raw (JSONL)               Unchanged (read-only)
```

### Design Principles

1. **Plans are a Layer 2 extension**, not a new layer — Plan data is stored in the same SQLite database
2. **Sessions remain the execution unit** — Node execution creates standard Claude Code sessions
3. **Bidirectional optional association** — Existing sessions can belong to no plan (backward compatible)
4. **Plans are source of truth** — Unlike session indexes (derived from JSONL), plan data is user-created original data
5. **Artifacts are context pipelines** — They solve cross-node/session state transfer

## Data Model

### New SQLite Tables

```sql
-- Plan / Blueprint
CREATE TABLE plans (
  id           TEXT PRIMARY KEY,   -- UUID
  title        TEXT NOT NULL,
  description  TEXT,               -- Original task description
  status       TEXT DEFAULT 'draft', -- draft | approved | running | completed | failed
  project_id   TEXT,               -- Associated project (optional)
  cwd          TEXT,               -- Working directory
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- Plan Node (Macro Node)
CREATE TABLE plan_nodes (
  id           TEXT PRIMARY KEY,   -- UUID
  plan_id      TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,   -- Execution order
  title        TEXT NOT NULL,
  description  TEXT,               -- Detailed task description (basis for the prompt)
  status       TEXT DEFAULT 'pending', -- pending | running | done | failed | blocked | skipped
  session_id   TEXT,               -- Associated Claude Code session (filled after execution)
  depends_on   TEXT,               -- JSON array of node IDs: ["node-uuid-1", "node-uuid-2"]
  prompt       TEXT,               -- Actual prompt sent to Claude (may differ from description)
  artifact     TEXT,               -- Handoff summary after completion (Artifact)
  error        TEXT,               -- Failure reason
  started_at   TEXT,
  completed_at TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX idx_plan_nodes_plan ON plan_nodes(plan_id, seq);
CREATE INDEX idx_plan_nodes_session ON plan_nodes(session_id);
```

### TypeScript Types

```typescript
interface Plan {
  id: string;
  title: string;
  description: string;
  status: 'draft' | 'approved' | 'running' | 'completed' | 'failed';
  projectId?: string;
  cwd?: string;
  nodes: PlanNode[];
  createdAt: string;
  updatedAt: string;
}

interface PlanNode {
  id: string;
  planId: string;
  seq: number;
  title: string;
  description: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'blocked' | 'skipped';
  sessionId?: string;        // Associated Claude Code session
  dependsOn: string[];       // Prerequisite dependency node IDs
  prompt?: string;           // Custom prompt (overrides description)
  artifact?: string;         // Handoff summary after completion
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

interface Artifact {
  nodeId: string;
  summary: string;           // <200 words concise handoff document
  keyOutputs: string[];      // Key outputs (file paths, APIs, etc.)
  decisions: string[];       // Important decisions
}
```

## API Design

### Plan CRUD
```
POST   /api/plans                  — Create a plan (optional: auto-generate nodes)
GET    /api/plans                  — List all plans
GET    /api/plans/:id              — Get plan details (with nodes)
PUT    /api/plans/:id              — Update plan metadata
DELETE /api/plans/:id              — Delete plan
```

### Plan Lifecycle
```
POST   /api/plans/:id/generate     — AI-generate plan nodes (from description)
POST   /api/plans/:id/approve      — Approve plan (draft → approved)
POST   /api/plans/:id/run          — Execute next pending node
POST   /api/plans/:id/run-all      — Execute all pending nodes in sequence
POST   /api/plans/:id/cancel       — Cancel execution
```

### Node Operations
```
PUT    /api/plans/:planId/nodes/:nodeId          — Edit node
POST   /api/plans/:planId/nodes                  — Add node
DELETE /api/plans/:planId/nodes/:nodeId           — Delete node
POST   /api/plans/:planId/nodes/:nodeId/run      — Execute single node
POST   /api/plans/:planId/nodes/:nodeId/retry     — Retry failed node
POST   /api/plans/:planId/nodes/reorder           — Reorder [{id, seq}]
```

## Execution Flow

### Node Execution (Core)

```
1. Check that all prerequisite dependencies are done
2. Collect artifacts from prerequisite nodes as inputContext
3. Build prompt:
   - System context: plan title + description
   - Input artifacts: handoff summaries from prerequisite nodes
   - Task: node description (or custom prompt)
   - Working directory: plan.cwd
4. Call claude -p "..." (new session, not --resume)
5. Capture output, update node status
6. Auto-generate artifact (call Claude for summarization)
7. Check if downstream nodes can now be executed
```

### Prompt Template

```
You are executing step {seq}/{total} of a plan: "{plan.title}"

## Context from previous steps:
{artifacts from depends_on nodes, joined}

## Your task:
{node.description or node.prompt}

## Working directory: {plan.cwd}

Complete this step. Be thorough but focused on THIS step only.
```

### Artifact Generation Template

```
Summarize what was accomplished in the previous coding step.
Start your response with exactly "**What was done:**" and include ONLY completed work.
Format:

**What was done:**
<2-3 sentences summarizing completed work>

**Files changed:**
<list of file paths created or modified>

**Decisions:**
<key decisions made, if any>

Keep it under 200 words. Be specific and factual. Do NOT include plans, next steps, or things still to do.
```

Post-processing: strip everything before the `**What was done:**` marker to remove echoed prompt/preamble.

## Data Migration

### Migration from Existing System (Zero Cost)

**No migration needed** — The Plan system is purely additive:

1. Existing `sessions` and `timeline_nodes` tables remain unchanged
2. New `plans` and `plan_nodes` tables are added
3. Association via optional foreign key `plan_nodes.session_id`
4. Sessions without a plan continue to work normally
5. Frontend adds `/plans` routes; existing `/` and `/session/[id]` are unchanged

### Layer 3 Extension

`enrichments.json` adds a `plans` field:

```json
{
  "version": 2,
  "sessions": { ... },
  "nodes": { ... },
  "tags": [...],
  "plans": {
    "<plan-id>": {
      "starred": true,
      "tags": ["sprint-1"],
      "notes": "Phase 1 of the MVP"
    }
  }
}
```

### Layer 4 Extension

`app-state.json` adds:

```json
{
  "version": 2,
  "ui": {
    "activePlanId": "...",
    "planViewMode": "list",
    ...
  }
}
```

## Frontend Routes

```
/                           — Existing session list (unchanged)
/session/[id]               — Existing session timeline (unchanged)
/blueprints                 — Blueprint list (new)
/blueprints/new             — Create blueprint (new)
/blueprints/[id]            — Blueprint detail: macro node chain + status indicators (new)
/blueprints/[id]/nodes/[nodeId]  — Node micro timeline (reuses session timeline)
```

## Implementation Phases

### Phase A — Plan Data Layer (Backend)
1. `backend/src/plan-db.ts` — SQLite tables + CRUD
2. `backend/src/plan-routes.ts` — REST API
3. Unit tests: create plan → add/delete nodes → update status

### Phase B — Plan Generation + Execution Engine
1. `backend/src/plan-generator.ts` — Call Claude to generate plan nodes
2. `backend/src/plan-executor.ts` — Node execution + artifact generation
3. Prompt templates + context assembly

### Phase C — Frontend Visualization
1. Plan list page + creation page
2. Plan detail: macro node chain + status indicators
3. Node expand → reuses Timeline component
4. Approval flow: Approve + Run All + single-step execution

### Phase D — Editing + Advanced Features
1. Node add/edit/delete
2. Dependency relationship editing
3. Drag-and-drop reordering
4. Parallel execution (nodes without dependencies run concurrently)

## File Structure (New Files)

```
backend/src/
├── plan-db.ts              # Plan SQLite CRUD
├── plan-routes.ts          # Plan REST API
├── plan-generator.ts       # AI task decomposition
└── plan-executor.ts        # Node execution + artifact generation

frontend/src/
├── app/blueprints/
│   ├── page.tsx            # Blueprint list
│   ├── new/page.tsx        # Create blueprint
│   └── [id]/
│       ├── page.tsx        # Blueprint detail (macro node chain)
│       └── nodes/[nodeId]/page.tsx  # Node timeline
├── components/
│   ├── MacroNodeCard.tsx   # Single macro node card
│   ├── DependencyGraph.tsx # Node dependency visualization
│   └── StatusIndicator.tsx # Status indicator lights
└── lib/
    └── api.ts              # API client (includes blueprint endpoints)
```
