# Project Dashboard — Design Specification

**Date:** 2026-03-04
**Status:** Draft
**Target Release:** ClawUI 0.6.0
**Dependencies:** Autopilot Mode (for pause/running state and autopilot log)

---

## 1. Problem Statement

Users managing multiple blueprints across multiple projects must navigate into each blueprint individually to check status, review suggestions/insights, and monitor progress. With Autopilot running across several blueprints simultaneously, the need for a single aggregated view becomes critical.

Currently:
- NavBar links to `/blueprints` (list view) and `/sessions` — neither provides cross-project aggregation
- `GET /api/global-status` returns queue info but not blueprint progress or autopilot state
- Users context-switch between blueprint detail pages to monitor parallel work

### Success Criteria

- One page shows all active work across all projects
- Items needing human attention surface to the top
- User can perform common actions (resume autopilot, review issues) without navigating away
- Page loads in <500ms (lightweight aggregate queries, no heavy JSONL parsing)

---

## 2. Dashboard Information Architecture

### 2.1 Sections (top to bottom)

```
┌─────────────────────────────────────────────────────┐
│  Dashboard                                          │
│─────────────────────────────────────────────────────│
│                                                     │
│  1. NEEDS ATTENTION                                 │
│     Paused autopilots, failed nodes, critical insights│
│                                                     │
│  2. IN PROGRESS                                     │
│     Running/autopilot blueprints with progress       │
│                                                     │
│  3. RECENTLY COMPLETED                              │
│     Blueprints completed in the last 7 days         │
│                                                     │
│  4. RECENT ACTIVITY                                 │
│     Timeline of events across all blueprints        │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### 2.2 Priority: Attention-First Design

The dashboard is not a status report — it's an **attention inbox**. The "Needs Attention" section is always first, always visible, and uses strong visual signals. If nothing needs attention, it collapses to a single line: "All clear — no items need attention."

---

## 3. Backend API

### 3.1 `GET /api/dashboard`

Single aggregate endpoint. Returns all data needed to render the dashboard in one request.

Response:

```typescript
interface DashboardResponse {
  needsAttention: AttentionItem[];
  inProgress: BlueprintProgress[];
  recentlyCompleted: BlueprintSummary[];
  recentActivity: ActivityEvent[];
  stats: DashboardStats;
}

interface AttentionItem {
  type: "autopilot_paused" | "failed_node" | "critical_insight" | "unused_suggestions";
  blueprintId: string;
  blueprintTitle: string;
  projectName?: string;
  nodeId?: string;
  nodeTitle?: string;
  nodeSeq?: number;
  message: string;           // Human-readable summary
  severity: "critical" | "warning";
  count?: number;            // For unused_suggestions: number of items
  createdAt: string;
}

interface BlueprintProgress {
  id: string;
  title: string;
  projectName?: string;
  status: BlueprintStatus;
  executionMode?: ExecutionMode;
  totalNodes: number;
  doneNodes: number;
  failedNodes: number;
  runningNodeId?: string;
  runningNodeTitle?: string;
  runningNodeSeq?: number;
  unusedSuggestionCount: number; // Suggestions not yet acted on
  startedAt?: string;        // When execution began
  estimatedCompletion?: string; // Based on avg node time (stretch)
}

interface BlueprintSummary {
  id: string;
  title: string;
  projectName?: string;
  status: BlueprintStatus;
  totalNodes: number;
  completedAt: string;
}

interface ActivityEvent {
  type: "node_completed" | "node_failed" | "autopilot_paused"
    | "autopilot_resumed" | "blueprint_completed"
    | "insight_created" | "convene_completed";
  blueprintId: string;
  blueprintTitle: string;
  nodeId?: string;
  nodeTitle?: string;
  nodeSeq?: number;
  message: string;
  timestamp: string;
}

interface DashboardStats {
  activeBlueprints: number;
  totalNodesInProgress: number;
  nodesCompletedToday: number;
  attentionItemCount: number;
}
```

### 3.2 Implementation Strategy

All data sourced from existing SQLite tables — no new tables needed.

```typescript
// backend/src/dashboard.ts

export function getDashboardData(): DashboardResponse {
  // 1. Needs Attention
  //    - Blueprints with status "paused" and pauseReason
  //    - Blueprints with many unused suggestions (COUNT node_suggestions WHERE used = 0)
  //    - Nodes with status "failed" in running/approved blueprints
  //    - Unread critical insights

  // 2. In Progress
  //    - Blueprints with status "running" or "approved" with queued nodes
  //    - JOIN to get node counts by status
  //    - Include unused suggestion count per blueprint

  // 3. Recently Completed
  //    - Blueprints with status "done", ordered by updated_at DESC, limit 10

  // 4. Recent Activity
  //    - Union query from:
  //      - node_executions (completed_at in last 24h)
  //      - blueprint_insights (created_at in last 24h)
  //      - convene_sessions (completed_at in last 24h)
  //    - ORDER BY timestamp DESC, LIMIT 20

  // 5. Stats
  //    - Aggregate counts from above queries
}
```

Performance target: <50ms for typical usage (10-20 active blueprints, hundreds of nodes). All queries use existing indexes.

### 3.3 Route Registration

```typescript
// plan-routes.ts
router.get("/api/dashboard", requireAuth, (req, res) => {
  const data = getDashboardData();
  res.json(data);
});
```

---

## 4. Frontend — Dashboard Page

### 4.1 Route

New route: `/dashboard`

NavBar update: Add "Dashboard" as the first navigation item (before Blueprints and Sessions).

```
[Dashboard]  [Blueprints]  [Sessions]
```

### 4.2 Data Fetching

```typescript
// useDashboardQuery hook
const { data, isLoading } = useQuery({
  queryKey: ["dashboard"],
  queryFn: fetchDashboard,
  refetchInterval: (query) => {
    const data = query.state.data;
    // Fast poll when there's active work
    if (data?.inProgress.length > 0) return 5000;
    // Slow poll when idle
    return 30000;
  },
});
```

### 4.3 Page Layout

#### Header

```
┌─────────────────────────────────────────────────┐
│  Dashboard                                       │
│                                                  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐        │
│  │ 3 active │ │ 12 nodes │ │ 5 done   │        │
│  │blueprints│ │in progres│ │  today   │        │
│  └──────────┘ └──────────┘ └──────────┘        │
└─────────────────────────────────────────────────┘
```

Stats cards: `bg-bg-secondary rounded-lg p-4 text-center`
- Number: `text-2xl font-bold text-text-primary`
- Label: `text-xs text-text-muted mt-1`

#### Needs Attention Section

```
┌─────────────────────────────────────────────────────────┐
│  ⚡ Needs Attention (2)                                  │
│─────────────────────────────────────────────────────────│
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │ 🔴 ClawUI / "API Refactor"                        │  │
│  │    Autopilot paused: test failure in Node #4       │  │
│  │    "Build auth system"                             │  │
│  │                           [Review]  [Resume]       │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │ 🟡 MyApp / "Auth System"                          │  │
│  │    8 unused suggestions awaiting review             │  │
│  │                       [Review]  [Approve All]      │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

**Attention card styling:**

Critical (autopilot paused, failed nodes):
```
className="border-l-4 border-accent-red bg-accent-red/5
  rounded-r-lg p-4"
```

Warning (unused suggestions, non-critical insights):
```
className="border-l-4 border-accent-amber bg-accent-amber/5
  rounded-r-lg p-4"
```

**Action buttons on attention cards:**
- **Review:** `text-accent-blue text-sm hover:underline` — navigates to blueprint/node detail
- **Resume:** `bg-accent-green/15 text-accent-green text-sm px-3 py-1 rounded-lg` — calls resume API inline
- **Enable Autopilot:** `bg-accent-green/15 text-accent-green text-sm px-3 py-1 rounded-lg` — enables autopilot mode to auto-handle suggestions

**Inline confirmation for dashboard actions:**
Same `ConfirmationStrip` pattern used elsewhere. "Are you sure?" → "Yes, resume" / "Cancel".

**Empty state:**
```
className="text-center py-6 text-text-muted text-sm"
```
Text: "All clear — nothing needs your attention"
Icon: checkmark circle in `text-accent-green`

#### In Progress Section

```
┌─────────────────────────────────────────────────────────┐
│  ▶ In Progress (3)                                       │
│─────────────────────────────────────────────────────────│
│                                                          │
│  ClawUI / "Frontend Polish"  [Autopilot ●]              │
│  ████████████░░░░░  4/7 nodes  · Node #5 running        │
│                                                          │
│  DataPipe / "Pipeline V2"    [Manual]                    │
│  ██░░░░░░░░░░░░░░░  2/12 nodes · waiting                │
│                                                          │
│  MyApp / "Onboarding Flow"   [Autopilot ●]              │
│  █████████████████  6/6 nodes  · completing...           │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

**Progress bar:**
```
className="w-full h-2 rounded-full bg-bg-tertiary overflow-hidden"
```
- Done portion: `bg-accent-green`
- Running portion: `bg-accent-blue animate-pulse`
- Failed portion: `bg-accent-red`
- Remaining: `bg-bg-tertiary`

**Blueprint row:**
- Title as link: `text-text-primary font-medium hover:text-accent-blue` → navigates to blueprint detail
- Project name prefix: `text-text-muted text-sm`
- Mode badge: `Autopilot ●` in green or `Manual` in muted
- Progress: `text-sm text-text-secondary`
- Current node: `text-xs text-text-muted`

Clicking a row navigates to `/blueprints/[id]`.

#### Recently Completed Section

```
┌─────────────────────────────────────────────────────────┐
│  ✓ Recently Completed                                    │
│─────────────────────────────────────────────────────────│
│                                                          │
│  MyApp / "Auth System"        6/6 nodes   2 hours ago   │
│  ClawUI / "Bug Fixes"        3/3 nodes   yesterday     │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

Compact rows, minimal styling. `text-text-secondary text-sm`. Relative timestamps via existing date formatting.

Collapsible, collapsed by default if >5 items.

#### Recent Activity Section

```
┌─────────────────────────────────────────────────────────┐
│  ● Recent Activity                                       │
│─────────────────────────────────────────────────────────│
│                                                          │
│  2m ago  ✓ Node #3 completed — "API Refactor"           │
│  5m ago  ⚠ Insight: missing tests — "Auth System"       │
│  8m ago  ▶ Node #2 started — "Pipeline V2"              │
│  12m ago ✓ Discussion completed — "Frontend Polish"      │
│                                                          │
│  [Show more...]                                          │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

**Event row styling:**
- Timestamp: `text-text-muted text-xs w-16 flex-shrink-0`
- Icon: event-type specific (✓ green, ⚠ amber, ▶ blue, ✕ red)
- Message: `text-sm text-text-primary` with blueprint title in `text-text-secondary`

Default: show 10 events. "Show more" loads 20 more (paginated via `offset` param).

---

## 5. NavBar Changes

### 5.1 Dashboard Link

Add "Dashboard" as the first nav item:

```typescript
const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: DashboardIcon },
  { href: "/blueprints", label: "Blueprints", /* existing */ },
  { href: "/sessions", label: "Sessions", /* existing */ },
];
```

### 5.2 Attention Badge on Dashboard Link

When `attentionItemCount > 0`, show a red dot badge on the Dashboard nav link (same pattern as existing Blueprints insight badge):

```
className="w-2 h-2 rounded-full bg-accent-red absolute -top-0.5 -right-0.5"
```

Data source: `GET /api/dashboard` stats, polled alongside existing `getGlobalStatus()` in NavBar.

### 5.3 Default Route

Change the root route `/` redirect from `/blueprints` to `/dashboard`:

```typescript
// frontend/src/app/page.tsx
redirect("/dashboard");
```

---

## 6. Responsive Design

| Element | Desktop (>1024px) | Tablet (640-1024px) | Mobile (<640px) |
|---------|-------------------|---------------------|-----------------|
| Stats cards | 3-column row | 3-column row | Stacked |
| Attention cards | Full width | Full width | Full width |
| Progress rows | Single line | Single line | Two lines (progress bar wraps) |
| Activity feed | Inline timestamps | Inline timestamps | Stacked (timestamp above) |
| Action buttons | Inline | Inline | Full width below card |

---

## 7. Performance Considerations

### 7.1 Query Optimization

All dashboard queries use existing SQLite indexes:
- `idx_plan_nodes_plan` for node counts by blueprint
- Blueprint `status` for filtering active/completed
- Execution `completed_at` for recent activity
- Insight `read` + `severity` for attention items

### 7.2 Caching

The dashboard endpoint does not add server-side caching — SQLite queries are fast enough (<50ms). Frontend TanStack Query handles client-side caching with the polling intervals defined in §4.2.

### 7.3 Data Volume

Expected volume for dashboard:
- Attention items: 0-10 (filtered to actionable)
- In progress: 0-20 active blueprints
- Recently completed: 10 (capped)
- Recent activity: 20 events (paginated)

Total response size: <10KB typical.

---

## 8. Accessibility

| Element | Requirement |
|---------|-------------|
| Stats cards | `role="status"`, `aria-label="3 active blueprints"` |
| Attention section | `aria-label="Items needing attention"`, `aria-live="polite"` for count updates |
| Progress bars | `role="progressbar"`, `aria-valuenow`, `aria-valuemin=0`, `aria-valuemax={totalNodes}`, `aria-label="4 of 7 nodes completed"` |
| Action buttons | Clear `aria-label` describing the action + target |
| Activity feed | `role="log"`, `aria-label="Recent blueprint activity"` |
| Navigation | Dashboard link has `aria-current="page"` when active |

---

## 9. Error Handling

| Scenario | Behavior |
|----------|----------|
| Dashboard API fails | Show error state with retry button. Other nav items still work |
| No blueprints exist | Show empty state: "No blueprints yet. Create one to get started." with link to `/blueprints/new` |
| No active work | Attention: "All clear". Progress: empty. Activity: may show recent completions |
| Inline action fails (resume, approve) | Toast error message. Card remains in current state |

---

## 10. Acceptance Criteria

1. `/dashboard` route exists and is accessible from NavBar
2. Default route `/` redirects to `/dashboard`
3. "Needs Attention" section surfaces paused autopilots, failed nodes, critical insights, unused suggestions
4. "In Progress" section shows all running/approved blueprints with progress bars
5. "Recently Completed" section shows last 10 completed blueprints
6. "Recent Activity" shows a cross-blueprint event timeline
7. Stats cards show aggregate counts
8. Inline actions (Resume, Approve All) work without navigation
9. Attention badge on NavBar Dashboard link when items need attention
10. Responsive layout works on mobile
11. Page loads in <500ms (no heavy queries)
12. Polling: 5s during active work, 30s when idle
13. Accessibility requirements met (progress bars, ARIA labels)

---

## 11. Implementation Sequencing

1. **`getDashboardData()` function** — aggregate SQLite queries in `backend/src/dashboard.ts`
2. **API endpoint** — `GET /api/dashboard` in `plan-routes.ts`
3. **Frontend types** — Dashboard interfaces in `api.ts`
4. **Dashboard page** — `/dashboard` route with all sections
5. **NavBar update** — Dashboard link + attention badge
6. **Root redirect** — `/` → `/dashboard`
7. **Inline actions** — Resume, Approve All with confirmation strips
8. **Responsive layout** — Mobile/tablet breakpoints
9. **Tests** — backend aggregate queries + frontend dashboard component

---

*End of specification.*
