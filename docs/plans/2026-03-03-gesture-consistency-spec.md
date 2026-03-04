# Gesture Consistency — Unified Design Specification

**Date:** 2026-03-03
**Version:** 0.5.0 Planning
**Status:** Draft — for review and SDE implementation

---

## 1. Overview

ClawUI has 18 distinct AI-powered "gestures" — fire-and-forget actions on nodes and blueprints. They've accumulated organically, resulting in inconsistent trigger styles, spotty toast coverage, muddled color semantics, and unpredictable confirmation patterns. This spec provides a unified design language for all gestures.

---

## 2. Gesture Taxonomy

### 2A. Complete Inventory

| # | Gesture | Scope | Risk | AI? | Current Color | Target Color |
|---|---------|-------|------|-----|---------------|-------------|
| 1 | **Generate** | blueprint | moderate | yes | `accent-purple` | `accent-purple` |
| 2 | **Reevaluate All** | blueprint | moderate | yes | `text-muted` / `accent-blue` strip | `accent-amber` |
| 3 | **Run All** | blueprint | moderate | yes | `accent-green` | `accent-green` |
| 4 | **Approve** | blueprint | safe | no | `accent-blue` | `accent-blue` |
| 5 | **Coordinate** | blueprint | moderate | yes | `accent-purple` | `accent-purple` |
| 6 | **Smart Create** | blueprint | safe | yes | `text-muted` | `accent-purple` |
| 7 | **Run Node** | node | moderate | yes | `accent-green/20` (card) / `accent-green` solid (detail) | `accent-green` (see §5E) |
| 8 | **Smart Enrich** | node | safe | yes | `accent-purple` | `accent-purple` |
| 9 | **Re-evaluate** (card) | node | safe | yes | `text-muted` / `accent-amber` | `accent-amber` |
| 10 | **Re-evaluate** (detail) | node | safe | yes | `text-muted` / `accent-amber` | `accent-amber` |
| 11 | **Split** | node | moderate | yes | `accent-purple` | `accent-amber` |
| 12 | **Smart Deps** | node | safe | yes | `accent-purple` badge | `accent-purple` |
| 13 | **Unqueue** | node | safe | no | `accent-amber` | `accent-amber` |
| 14 | **Delete** | node | destructive | no | `accent-red` | `accent-red` |
| 15 | **Resume Session** | node | moderate | yes | `accent-green` | `accent-green` |
| 16 | **Retry** | node | moderate | yes | `accent-amber` | `accent-amber` |
| 17 | **Mark Done** | node | safe | no | `accent-green` | `accent-green` |
| 18 | **Skip/Unskip** | node | safe | no | `text-secondary` | `text-secondary` |

### 2B. Classification Axes

**Risk levels:**
- **Safe** — Idempotent or cheap; easily undone (Re-evaluate, Enrich, Smart Deps, Approve, Mark Done, Skip, Unqueue, Smart Create)
- **Moderate** — Expensive AI call or affects node state significantly (Generate, Run, Run All, Resume, Retry, Split, Reevaluate All, Coordinate)
- **Destructive** — Data loss or irreversible status change (Delete)

**AI involvement:**
- **AI-driven** — Calls an agent runtime (Generate, Run, Run All, Resume, Retry, Enrich, Re-evaluate, Reevaluate All, Split, Smart Deps, Smart Create, Coordinate)
- **Mechanical** — Status toggle or simple DB mutation (Approve, Mark Done, Skip, Unqueue, Delete)

---

## 3. Color Semantic Rules

### 3A. Category Definitions

| Color Token | Semantic Category | Gestures |
|-------------|-------------------|----------|
| `accent-green` | **Execution** — "go" actions that run agent code | Run, Run All, Resume, Mark Done |
| `accent-purple` | **AI Enrichment/Creation** — AI enhances or generates content | Generate, Enrich, Smart Create, Smart Deps, Coordinate |
| `accent-amber` | **Review/Reconsider** — re-evaluation, caution, retry | Re-evaluate, Reevaluate All, Retry, Split, Unqueue, all confirmation strips |
| `accent-red` | **Destructive** — permanent data loss | Delete |
| `accent-blue` | **State Transition** — status or role changes | Approve |
| `text-secondary` | **Neutral** — low-risk mechanical toggles | Skip/Unskip |

### 3B. Changes from Current

| Gesture | Current Color | New Color | Rationale |
|---------|--------------|-----------|-----------|
| **Reevaluate All** | `text-muted` btn + `accent-blue` confirm strip | `accent-amber` (matches single-node Re-evaluate) | Unified re-evaluation = amber |
| **Split** | `accent-purple` | `accent-amber` | Restructuring action, closer to re-evaluation than creation |
| **Smart Create** | `text-muted` | `accent-purple` | Consistent with AI enrichment family |
| **Reevaluate All confirm strip** | `accent-blue` | `accent-amber` | Standardize: all confirm strips use `accent-amber` |

### 3C. No Changes Needed

Run/Run All/Resume (`accent-green`), Enrich (`accent-purple`), Re-evaluate (`accent-amber`), Delete (`accent-red`), Approve (`accent-blue`), Smart Deps (`accent-purple`), Retry (`accent-amber`), Coordinate (`accent-purple`), Unqueue (`accent-amber`), Mark Done (`accent-green`), Skip (`text-secondary`).

### 3D. Button Weight Consistency Rule

**Same gesture = same visual weight everywhere.** No exceptions.

| Issue | Current | Target |
|-------|---------|--------|
| Run Node (card) | `bg-accent-green/20 text-accent-green` (outline) | Keep — card context is intentionally lighter |
| Run Node (detail) | `bg-accent-green text-white` (solid) | Keep — detail page is the primary interaction surface |

**Rationale for keeping the card/detail difference:** The card is compact and shows among many peers — lighter weight avoids visual noise. The detail page is a focused single-node view where the primary action should have the most visual weight. This is a deliberate information-density distinction, not an inconsistency.

### 3E. WCAG AA Compliance

All accent tokens are verified in `globals.css` against their respective backgrounds:
- Dark: accent colors are bright against `bg-primary` (10 10 15) — all pass 4.5:1+
- Light: accent colors are darkened (`--accent-blue: 37 99 235`, `--accent-amber: 180 83 9`, etc.) — all pass 4.5:1+ against white and `bg-tertiary`
- `text-white` on solid accent buttons: passes AA for large text (buttons use ≥11px bold which qualifies)
- `text-muted` on `bg-primary`: ~4.9:1 dark, ~5.2:1 light — passes AA

---

## 4. Confirmation Pattern Standard

### 4A. Decision Matrix

| Confirmation Type | When to Use | Mechanism |
|-------------------|-------------|-----------|
| **No confirmation** | Safe or idempotent gestures where the operation is cheap to redo | Direct fire on click |
| **Inline strip** | Moderate-risk operations that affect multiple items or are expensive but reversible | `confirmingX` state → Yes/No button pair with `animate-fade-in` |
| **Inline panel** | Destructive operations with explicit warning text | `showXConfirm` state → panel with warning text + Confirm/Cancel |

### 4B. Complete Assignment

| # | Gesture | Confirmation Type | Rationale |
|---|---------|-------------------|-----------|
| 1 | Generate (first time) | None | No existing data to lose |
| 1b | Regenerate (has nodes) | Inline strip (`accent-purple`) | Potentially replaces existing nodes |
| 2 | Reevaluate All | Inline strip (`accent-amber`) | Expensive; affects all nodes (already implemented) |
| 3 | **Run All** | **Inline strip (`accent-amber`)** | **NEW — expensive; queues every pending node** |
| 4 | Approve | None | Simple status toggle; easily undone via UI |
| 5 | Coordinate | None | Analysis-only; produces insights, doesn't mutate nodes directly |
| 6 | Smart Create | None | User just typed the title — clear intent |
| 7 | Run Node | None | Single node; user is looking at it |
| 8 | Smart Enrich | None | Edit mode = implicit intent gate |
| 9 | Re-evaluate (card) | None | Idempotent; cheap |
| 10 | Re-evaluate (detail) | None | Same |
| 11 | Split | Inline panel (`accent-amber`) | Marks original as skipped; restructures blueprint |
| 12 | Smart Deps | None | Idempotent; auto-selects dependencies |
| 13 | Unqueue | Inline strip (`accent-amber`) | Already implemented correctly |
| 14 | Delete | Inline panel (`accent-red`) | Permanent data loss — already implemented |
| 15 | Resume Session | None | User already sees the failed execution context |
| 16 | Retry | None | Same node, fresh attempt |
| 17 | Mark Done | None | Easily undone |
| 18 | Skip/Unskip | None | Toggle — reversible |

### 4C. Changes from Current

| Change | Details |
|--------|---------|
| **Run All gains confirmation** | New inline strip: "Run all pending nodes?" → Yes / No. Color: `accent-amber`. Prevents accidental expensive runs |
| **Split panel changes color** | `accent-purple` → `accent-amber`. Panel background: `bg-accent-amber/10 border-accent-amber/30` |
| **Regenerate strip stays `accent-purple`** | Exception: regeneration is a creation gesture, keeping purple for the strip color is correct since it matches the generate button family |

### 4D. Inline Strip Standard Component

```
<div className="flex items-center gap-1.5 px-2 py-0.5 rounded-lg border border-accent-amber/30 bg-accent-amber/10 animate-fade-in">
  <span className="text-xs text-accent-amber whitespace-nowrap">{question}?</span>
  <button className="px-2 py-0.5 rounded-md bg-accent-amber text-white text-xs font-medium hover:bg-accent-amber/90 active:scale-[0.97] transition-all disabled:opacity-40">
    Yes
  </button>
  <button className="px-2 py-0.5 rounded-md text-text-muted text-xs hover:text-text-secondary transition-colors">
    No
  </button>
</div>
```

Colors adjust per gesture:
- Default/caution: `accent-amber` (Reevaluate All, Run All, Unqueue)
- Creation: `accent-purple` (Regenerate)

### 4E. Inline Panel Standard Component

```
<div className="mt-3 p-3 rounded-lg bg-{color}/10 border border-{color}/30 animate-fade-in">
  <p className="text-sm text-{color} mb-2">{warning message}</p>
  <div className="flex gap-2">
    <button className="px-3 py-1 rounded-md bg-{color} text-white text-xs font-medium hover:bg-{color}/90 transition-colors disabled:opacity-50">
      {confirm label}
    </button>
    <button className="px-3 py-1 rounded-md border border-border-primary text-text-secondary text-xs hover:bg-bg-tertiary transition-colors">
      Cancel
    </button>
  </div>
</div>
```

Where `{color}` = `accent-red` for Delete, `accent-amber` for Split.

---

## 5. Toast/Feedback Standard

### 5A. Core Principle

**Every fire-and-forget AI gesture MUST show a completion toast.** Users should never wonder "did it finish?"

### 5B. Implementation Pattern

All AI gestures follow the proven `prevXxxQueuedRef` → `useEffect` queue-exit pattern already used by Enrich, Re-evaluate, Smart Deps, and Coordinate. Pattern:

```typescript
const prevXxxQueuedRef = useRef(false);
useEffect(() => {
  const wasQueued = prevXxxQueuedRef.current;
  prevXxxQueuedRef.current = xxxQueued;
  if (wasQueued && !xxxQueued) {
    showToast(`{Message}`);
  }
}, [xxxQueued, showToast]);
```

### 5C. Complete Toast Message Table

| # | Gesture | Toast Message | Toast Type | Currently Has Toast? |
|---|---------|---------------|------------|---------------------|
| 1 | Generate | `"Generation complete — {N} nodes created"` | success | **NO → ADD** |
| 2 | Reevaluate All | `"Reevaluation complete for all nodes"` | success | **NO → ADD** |
| 3 | Run All | `"All executions complete"` | success | **NO → ADD** |
| 4 | Approve | — (instant; no async) | — | N/A |
| 5 | Coordinate | `"Coordinator finished analyzing insights"` | success | YES |
| 6 | Smart Create | `"Node created and enriched"` | success | **NO → ADD** |
| 7 | Run Node | `"Execution complete for #{node.seq}"` | success | **NO → ADD** |
| 8 | Smart Enrich | `"Enrichment complete for #{node.seq}"` | success | YES |
| 9 | Re-evaluate (card) | `"Re-evaluation complete for #{node.seq}"` | success | YES |
| 10 | Re-evaluate (detail) | `"Re-evaluation complete for #{node.seq}"` | success | YES |
| 11 | Split | `"Split complete — {N} sub-tasks created"` | success | **NO → ADD** |
| 12 | Smart Deps | `"Smart dependencies complete for #{node.seq}"` | success | YES |
| 13 | Unqueue | — (instant feedback via status change) | — | N/A |
| 14 | Delete | — (navigates away) | — | N/A |
| 15 | Resume | `"Session resumed for #{node.seq}"` | success | **NO → ADD** |
| 16 | Retry | `"Retry complete for #{node.seq}"` | success | **NO → ADD** |
| 17 | Mark Done | — (instant) | — | N/A |
| 18 | Skip/Unskip | — (instant) | — | N/A |

**9 new toasts** to add across 3 surfaces.

### 5D. Error Feedback Standard

Currently, only Run buttons show a `⚠` warning icon for errors. Standardize:

- **All AI gestures**: On catch, set a `warning` state string and display `⚠ {message}` below the action bar
- **Pattern**: `text-accent-amber` with warning triangle icon, `text-xs`, inline below action bar
- **Already implemented on**: NodeDetailPage (Run), MacroNodeCard (Run)
- **Missing on**: Generate, Reevaluate All, Run All, Coordinate, Smart Create (blueprint page gestures show `{error}` in a red banner instead — standardize to amber warning for non-fatal errors, red for fatal)

### 5E. Toast Infrastructure Assessment

`Toast.tsx` is well-designed with:
- Three types: `success`, `error`, `info`
- Auto-dismiss at 3s with progress bar
- Stacking support (multiple concurrent toasts)
- Exit animation
- Memoized context value (no unnecessary re-renders)

**No infrastructure changes needed** — just new `showToast()` calls at the right queue-exit transitions.

---

## 6. Unified Action Bar Component Spec

### 6A. Design Principles

1. **All buttons use text+icon** — no icon-only gesture buttons (except mobile overflow)
2. **Consistent sizing** — `px-2.5 py-1 rounded-lg text-xs font-medium`
3. **Responsive** — `sm:` breakpoint for inline vs overflow
4. **Touch targets** — minimum `py-2 px-3` on mobile (achieved via `py-2.5 sm:py-1`)

### 6B. MacroNodeCard Action Bar

**Current issues:**
- Re-evaluate: icon-only, `hidden sm:block` — desktop only
- Smart Deps: not on card (only on detail page)
- Edit/Skip/Delete: icon-only, `hidden sm:block`

**Target layout:**

```
Desktop (≥640px):
┌──────────────────────────────────────────────────────┐
│ [▶ Run]  [↻ Re-evaluate]  [⋯ More]  [⌄ expand]     │
└──────────────────────────────────────────────────────┘

Mobile (<640px):
┌──────────────────────────────────────────────────────┐
│ [▶ Run]                            [⋯ More] [⌄]     │
└──────────────────────────────────────────────────────┘
```

**Card button slot rules:**
- Slot 1 (primary): Run button (when `canRun`) OR Queued badge (when queued)
- Slot 2 (secondary): Re-evaluate button (text+icon, visible on desktop, in overflow on mobile) — **promote from icon-only to text+icon**
- Slot 3: Overflow menu `⋯` — contains Edit, Skip, Delete, Re-evaluate (on mobile)
- Slot 4: Expand chevron

**Re-evaluate button on card — current → target:**
```
Current:  p-1.5 rounded-md text-text-muted hidden sm:block (icon-only)
Target:   inline-flex items-center gap-1 px-2.5 py-1 rounded-lg
          text-text-muted hover:bg-accent-amber/10 hover:text-accent-amber
          text-xs font-medium hidden sm:inline-flex
          (text+icon: "↻ Re-eval")
```

### 6C. NodeDetailPage Action Bar

**Current:** `grid grid-cols-2 sm:flex sm:flex-wrap gap-1.5` — good layout.

**Standardize all buttons to:**
```
px-2.5 py-1 rounded-lg text-xs font-medium
active:scale-[0.98] transition-all
disabled:opacity-50 disabled:cursor-not-allowed
flex items-center justify-center gap-1.5
```

Border style varies by semantic category:
- Execution: `bg-accent-green text-white` (solid)
- AI enrichment: `border border-accent-purple/30 text-accent-purple` (outline)
- Review: `border border-accent-amber/50 text-accent-amber` (outline)
- Destructive: `border border-accent-red/30 text-accent-red` (outline)
- State: `bg-accent-blue/15 text-accent-blue` (tinted)
- Neutral: `border border-border-primary text-text-secondary` (muted outline)

**Smart Deps button — current → target:**
```
Current:  px-1.5 py-0.5 rounded-md text-[10px] (tiny badge next to Dependencies label)
Target:   Keep in current location (functionally correct as a deps-section action).
          Increase to: px-2 py-0.5 rounded-lg text-xs font-medium
          (matches other action buttons' text size)
```

### 6D. BlueprintDetailPage Action Bar

**Current layout:** Input textarea + bottom action strip with Generate (right) and Reevaluate (left).

**Target: Add gesture group above node chain:**
```
┌─ Header ──────────────────────────────────────────────┐
│ ★ ● Blueprint Title        [Approve] [▶ Run All] [⊞] │
├─ Input Area ──────────────────────────────────────────┤
│ [textarea]                                             │
│ [↻ Reevaluate] [Analyze]           [✈ Generate]       │
├─ Node Chain ──────────────────────────────────────────┤
```

**No structural changes needed** — current layout is already well-organized. Changes:
- Reevaluate All button: change to `accent-amber` family (currently `text-muted`)
- Reevaluate All confirm strip: change to `accent-amber` (currently `accent-blue`)
- Run All: add confirmation strip (see §4C)

---

## 7. Keyboard Shortcuts

### 7A. Existing Bindings (conflict check)

| Key | Current Binding | Context |
|-----|----------------|---------|
| `ArrowLeft` | Previous node | NodeDetailPage (not in input/textarea) |
| `ArrowRight` | Next node | NodeDetailPage (not in input/textarea) |
| `Escape` | Close node switcher | NodeDetailPage |
| `Cmd/Ctrl+Enter` | Generate nodes | BlueprintDetailPage textarea |

### 7B. Proposed New Bindings

| Key | Action | Context | Conflict Check |
|-----|--------|---------|---------------|
| `r` | Run node | NodeDetailPage (not in input/textarea/contentEditable) | No conflict |
| `e` | Toggle edit mode | NodeDetailPage (not in input/textarea/contentEditable) | No conflict |
| `Shift+E` | Smart Enrich | NodeDetailPage, when in edit mode | No conflict |
| `Shift+R` | Re-evaluate | NodeDetailPage (not in input/textarea/contentEditable) | No conflict |
| `d` | Toggle dependency picker expand | NodeDetailPage (not in input/textarea/contentEditable) | No conflict |
| `Escape` | Cancel confirmation / close edit / close switcher | NodeDetailPage (already partially implemented) | Extended, not conflicting |
| `Cmd/Ctrl+Shift+R` | Reevaluate All | BlueprintDetailPage (not in textarea) | No conflict (browser refresh is `Cmd+R`, not `Cmd+Shift+R`) |

### 7C. Implementation Notes

- Guard all shortcuts with `if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (e.target as HTMLElement).isContentEditable) return;` — pattern already used in NodeDetailPage
- `Shift+E` should only fire when `editing === true` (edit mode active)
- Shortcuts should be disabled when the node is in `running` or `queued` status
- Consider adding a keyboard shortcut hint overlay (future scope — not in v0.5.0)

---

## 8. Mobile Experience

### 8A. Current Gaps

| Issue | Component | Impact |
|-------|-----------|--------|
| Re-evaluate (card): `hidden sm:block` icon-only | `MacroNodeCard.tsx:486-503` | Not discoverable on mobile |
| Smart Deps: `text-[10px]` badge | `NodeDetailPage:1197` | Tiny touch target |
| Edit/Skip/Delete: `hidden sm:block` | `MacroNodeCard.tsx:446-483` | Only in overflow menu |

### 8B. Solutions

1. **Re-evaluate on card mobile:** Already in overflow menu — add text label "Re-evaluate" (not "Re-eval"). Currently correct behavior.

2. **Smart Deps sizing:** Increase from `text-[10px]` to `text-xs` and from `px-1.5 py-0.5` to `px-2 py-1` on mobile. Use responsive: `px-2 py-1 sm:px-1.5 sm:py-0.5 text-xs sm:text-[10px]`. Or simply use `text-xs` universally for readability.

3. **Mobile overflow menu standardization:** All overflow menu items should be:
   ```
   w-full text-left px-3 py-2.5 text-xs text-text-secondary
   hover:bg-bg-tertiary transition-colors disabled:opacity-50
   ```
   Touch target: `py-2.5` = 10px padding + ~16px text = ~36px+ (close to 44px with line-height). Acceptable for menu items.

---

## 9. Implementation Priority

### Phase 1: Quick Wins (touches existing code only)

1. **Toast additions** — Add 9 missing toasts using the proven `prevXxxQueuedRef` pattern
   - Files: `MacroNodeCard.tsx`, `NodeDetailPage/page.tsx`, `BlueprintDetailPage/page.tsx`
   - Effort: Low — copy existing pattern, change message strings

2. **Color corrections** — Fix 3 color inconsistencies
   - Reevaluate All button: `text-muted` → `accent-amber` family
   - Reevaluate All confirm strip: `accent-blue` → `accent-amber`
   - Split confirm panel: `accent-purple` → `accent-amber`
   - Files: `BlueprintDetailPage/page.tsx`, `NodeDetailPage/page.tsx`
   - Effort: Low — CSS class swaps

3. **Smart Create color** — Promote to `accent-purple` family
   - File: `BlueprintDetailPage/page.tsx`
   - Effort: Low

### Phase 2: Moderate Changes

4. **Run All confirmation** — Add inline strip before `handleRunAll()`
   - File: `BlueprintDetailPage/page.tsx`
   - Effort: Low-medium — add `confirmingRunAll` state + strip UI

5. **Re-evaluate card button upgrade** — Icon-only → text+icon
   - File: `MacroNodeCard.tsx:486-503`
   - Change from icon-only `p-1.5` to `inline-flex items-center gap-1 px-2.5 py-1` with "Re-eval" text
   - Effort: Low

6. **Smart Deps sizing** — Increase touch target
   - File: `NodeDetailPage/page.tsx:1197`
   - Effort: Low

### Phase 3: New Features

7. **Keyboard shortcuts** — New keybindings on NodeDetailPage
   - File: `NodeDetailPage/page.tsx` (extend existing `useEffect` keydown handler)
   - Effort: Medium

8. **Keyboard shortcuts** — Reevaluate All keybinding
   - File: `BlueprintDetailPage/page.tsx`
   - Effort: Low

---

## 10. Component Reference

### Files Modified

| File | Changes |
|------|---------|
| `frontend/src/components/MacroNodeCard.tsx` | Re-evaluate button upgrade (§6B), Run toast (§5C), new toasts |
| `frontend/src/app/blueprints/[id]/nodes/[nodeId]/page.tsx` | Smart Deps sizing (§6C), Split color (§4C), keyboard shortcuts (§7), toasts |
| `frontend/src/app/blueprints/[id]/page.tsx` | Reevaluate All color (§3B), Run All confirm (§4C), Smart Create color (§3B), keyboard shortcut (§7), toasts |
| `frontend/src/components/Toast.tsx` | No changes needed |
| `frontend/src/components/AISparkle.tsx` | No changes needed |
| `frontend/src/components/StatusIndicator.tsx` | No changes needed |

### Design Tokens Used (all verified in `globals.css` + `tailwind.config.ts`)

| Token | Type | Light Value | Dark Value |
|-------|------|-------------|------------|
| `accent-green` | color | `21 128 61` | `34 197 94` |
| `accent-purple` | color | `124 58 237` | `139 92 246` |
| `accent-amber` | color | `180 83 9` | `245 158 11` |
| `accent-red` | color | `220 38 38` | `239 68 68` |
| `accent-blue` | color | `37 99 235` | `59 130 246` |
| `bg-primary` | background | `255 255 255` | `10 10 15` |
| `bg-secondary` | background | `248 250 252` | `18 18 26` |
| `bg-tertiary` | background | `241 245 249` | `26 26 46` |
| `text-primary` | text | `15 23 42` | `226 232 240` |
| `text-secondary` | text | `71 85 105` | `148 163 184` |
| `text-muted` | text | `95 110 132` | `112 128 150` |
| `border-primary` | border | `226 232 240` | `30 41 59` |

### Responsive Breakpoints

| Breakpoint | Usage |
|------------|-------|
| `sm:` (640px) | Card buttons inline vs overflow; mobile bottom nav hidden |
| `md:` (768px) | Not currently used for gestures |

---

## 11. Acceptance Criteria Checklist

- [x] **Taxonomy**: All 18 gestures classified by scope, risk, AI involvement (§2)
- [x] **Component spec**: Standard button sizes, colors, responsive breakpoints for MacroNodeCard (§6B), NodeDetailPage (§6C), BlueprintDetailPage (§6D)
- [x] **Confirmation matrix**: Every gesture mapped to confirmation type with rationale (§4B)
- [x] **Toast audit**: 9 missing toasts identified with exact message strings (§5C)
- [x] **Color mapping**: Each gesture assigned a semantic color; category violations resolved (§3)
- [x] **Keyboard shortcuts**: 7 new bindings with conflict check (§7)
- [x] **Implementable**: References actual component files, CSS tokens, Tailwind classes, and responsive breakpoints (§10)
