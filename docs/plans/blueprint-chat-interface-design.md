# Blueprint Chat Interface & Interaction States

**Status:** Design Spec
**Date:** 2026-03-06
**Role:** UXD (Design Spec for SDE implementation)

## Overview

The `BlueprintChat` component replaces the old generator dialog and subsumes `PauseBanner` and `AutopilotLog` into a single unified chat timeline. This document specifies the visual design, component structure, interaction states, accessibility requirements, and responsive behavior for the chat-driven blueprint interface.

**Reference implementation:** `frontend/src/components/BlueprintChat.tsx` (current state serves as the baseline).

---

## 1. Layout & Positioning

### Container placement

The chat container sits below the node list section on the blueprint detail page (`/blueprints/[id]`). It replaces the standalone `AutopilotLog` and `PauseBanner` that previously occupied this space.

### Container structure

```
+------------------------------------------------------------------+
|  Header bar (sticky top)                                         |
|  [chat icon] Blueprint Chat    [Reevaluate btn]   [status dot]   |
+------------------------------------------------------------------+
|                                                                  |
|  Scrollable message area                                         |
|  (min-h: 200px, max-h: 400px)                                   |
|                                                                  |
|  - User messages (right-aligned)                                 |
|  - System messages (centered)                                    |
|  - Log entries (left-aligned)                                    |
|  - Pause alerts (centered, full-width)                           |
|                                                                  |
+------------------------------------------------------------------+
|  [Manual mode note - conditional]                                |
+------------------------------------------------------------------+
|  Input area (fixed at bottom of chat container)                  |
|  [status dot] [textarea                        ] [send button]   |
+------------------------------------------------------------------+
```

### Container classes

```
rounded-xl border border-border-primary bg-bg-primary overflow-hidden flex flex-col
```

- **Outer shape:** `rounded-xl` for consistency with card components (`MacroNodeCard`, `AutopilotLog`)
- **Background:** `bg-bg-primary` (white in light / near-black in dark)
- **Border:** `border border-border-primary` (slate-200 in light / slate-800 in dark)
- **Overflow:** `overflow-hidden` on outer container; internal scroll on message area

### Responsive widths

| Breakpoint | Container behavior |
|---|---|
| Below `sm` (< 640px) | Full-width, no horizontal margin, reduced internal padding (`px-3`) |
| `sm` to `lg` (640px - 1023px) | Full-width within page content area, standard padding (`px-4`) |
| `lg` and above (>= 1024px) | Full-width within page content area (page itself is `max-w-5xl mx-auto`) |

**Note:** The chat does NOT independently constrain to `max-w-4xl` — it fills the page content column, which is already width-constrained by the parent layout. This matches the existing pattern where `MacroNodeCard` and other blueprint page components fill the available width.

---

## 2. Header Bar

### Structure

```tsx
<div className="flex items-center justify-between px-4 py-2.5 border-b border-border-primary bg-bg-secondary">
  {/* Left: icon + title + quick actions */}
  {/* Right: status indicator */}
</div>
```

### Left side

- **Chat icon:** 16x16 SVG speech bubble, `text-text-muted`, `stroke="currentColor"`
- **Title:** `text-sm font-medium text-text-primary` — "Blueprint Chat"
- **Reevaluate button** (conditional: shown when `hasNodes`):
  - Classes: `inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-accent-amber text-[11px] font-medium hover:bg-accent-amber/10 transition-all active:scale-[0.97] disabled:opacity-disabled disabled:cursor-not-allowed`
  - Color follows gesture semantics: `accent-amber` = Review/Reconsider
  - Disabled states with `title` tooltip explaining why (per FRONTEND-PATTERNS.md)

### Right side — Status indicator

| State | Dot class | Label |
|---|---|---|
| Autopilot active | `w-1.5 h-1.5 rounded-full bg-accent-green animate-pulse` | "Autopilot active" |
| Paused | `w-1.5 h-1.5 rounded-full bg-accent-amber` | "Autopilot paused" |
| Manual mode | `w-1.5 h-1.5 rounded-full bg-text-muted` | "Manual mode" |

- Label: `text-xs text-text-muted`
- Accessibility: the status dot + label combination is sufficient for screen readers. The dot is decorative (no separate `aria-label` needed since the adjacent text label conveys the state).

---

## 3. Message Bubbles

### 3.1 User messages (right-aligned)

```tsx
<div className="flex justify-end">
  <div className="max-w-[85%] lg:max-w-[70%]">
    <div className="rounded-xl bg-accent-blue/10 border border-accent-blue/20 px-3 py-2">
      <p className="text-sm text-text-primary whitespace-pre-wrap break-words">{content}</p>
    </div>
    <span className="text-[10px] text-text-muted mr-3 mt-0.5 block text-right"
          title={absoluteTime}>
      {relativeTime}
    </span>
  </div>
</div>
```

**Design rationale:**
- `bg-accent-blue/10` provides a subtle blue tint that distinguishes user messages from system content
- `border-accent-blue/20` adds a faint border for definition without being heavy
- `rounded-xl` (not `rounded-br-sm`) — uniform rounding matches the card-based visual language; chat bubble "tails" are omitted for cleaner aesthetics
- `max-w-[85%]` on mobile, `lg:max-w-[70%]` on desktop — prevents messages from spanning the full width

**Contrast verification (WCAG AA):**
- Dark mode: `text-text-primary` (226 232 240, ~#e2e8f0) on `bg-accent-blue/10` (59 130 246 at 10% over 10 10 15) = effective bg ~#101a2a → contrast ratio ~11:1 (passes AAA)
- Light mode: `text-text-primary` (15 23 42, ~#0f172a) on `bg-accent-blue/10` (37 99 235 at 10% over 255 255 255) = effective bg ~#e8f0fe → contrast ratio ~16:1 (passes AAA)

### 3.2 System messages (centered)

```tsx
<div className="flex justify-center">
  <div className="max-w-[85%]">
    <div className="rounded-lg bg-bg-tertiary/50 border border-border-primary px-3 py-1.5 text-center">
      <p className="text-xs text-text-secondary">{content}</p>
    </div>
    <span className="text-[10px] text-text-muted mt-0.5 block text-center"
          title={absoluteTime}>
      {relativeTime}
    </span>
  </div>
</div>
```

**Design rationale:**
- Centered alignment + smaller text (`text-xs`) visually distinguishes system messages from conversational content
- `bg-bg-tertiary/50` is deliberately semi-transparent to feel lighter than user/log bubbles
- `rounded-lg` (smaller than `rounded-xl` on user messages) creates visual hierarchy

**Contrast verification:**
- Dark mode: `text-text-secondary` (148 163 184, ~#94a3b8) on `bg-bg-tertiary/50` (26 26 46 at 50% over 10 10 15) = effective bg ~#121220 → contrast ratio ~8:1 (passes AA)
- Light mode: `text-text-secondary` (71 85 105, ~#475569) on `bg-bg-tertiary/50` (241 245 249 at 50% over 255 255 255) = effective bg ~#f8fafc → contrast ratio ~6:1 (passes AA)

### 3.3 Autopilot log entries (left-aligned)

```tsx
<div className="flex justify-start">
  <div className="max-w-[85%] lg:max-w-[70%]">
    <div className="flex items-start gap-2 rounded-xl bg-bg-secondary border border-border-primary px-3 py-2">
      <span className={`${statusColor} text-sm flex-shrink-0 pt-0.5`}>{statusIcon}</span>
      <div className="flex-1 min-w-0">
        <span className="font-medium text-sm text-text-primary block truncate">{action}</span>
        {decision && (
          <p className={`text-text-secondary text-xs mt-0.5 ${expanded ? "" : "line-clamp-2"}`}>
            {decision}
          </p>
        )}
      </div>
    </div>
    <span className="text-[10px] text-text-muted ml-3 mt-0.5 block"
          title={absoluteTime}>
      {relativeTime}
    </span>
  </div>
</div>
```

**Status icon color mapping** (reuses `statusIcon` helper):

| Result pattern | Icon | Color token |
|---|---|---|
| Success (default) | checkmark | `text-accent-green` |
| Error/fail | cross | `text-accent-red` |
| Retry/resume/continuation | refresh | `text-accent-blue` |
| Warn/pause/skip | warning | `text-accent-amber` |

**Design rationale:**
- Left-aligned to visually group with "system-side" content (distinct from right-aligned user messages)
- `bg-bg-secondary` (slightly darker than primary) distinguishes log entries from system messages
- `line-clamp-2` on decision text with click-to-expand prevents long reasoning from dominating the chat view
- `min-w-0` on the flex child enables text truncation (per FRONTEND-PATTERNS.md flex truncation rule)

### 3.4 Pause alert (centered, full-width)

```tsx
<div className="flex justify-center" role="alert" aria-live="assertive">
  <div className="max-w-[90%] lg:max-w-[75%] w-full">
    <div className="rounded-lg bg-accent-amber/10 border border-accent-amber/30 px-4 py-3">
      <div className="flex items-start gap-2 mb-2">
        <svg className="w-4 h-4 text-accent-amber flex-shrink-0 mt-0.5">
          {/* Warning triangle icon */}
        </svg>
        <div>
          <p className="text-sm font-medium text-text-primary">{modeLabel} Paused</p>
          <p className="text-xs text-text-secondary mt-1">{pauseReason}</p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        {relevantNodeId && (
          <button className="text-xs text-accent-blue hover:text-accent-blue/80 transition-colors">
            Review Issue
          </button>
        )}
        <button className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-accent-green/15 text-accent-green border border-accent-green/30 text-xs font-medium hover:bg-accent-green/25 transition-all active:scale-[0.97] disabled:opacity-disabled disabled:cursor-not-allowed">
          Resume {modeLabel}
        </button>
      </div>
    </div>
  </div>
</div>
```

**Design rationale:**
- `role="alert" aria-live="assertive"` for immediate screen reader announcement (per FRONTEND-PATTERNS.md alert banners pattern)
- `bg-accent-amber/10` + `border-accent-amber/30` follows the amber = caution convention
- Resume button uses `accent-green` (execution family) per gesture color semantics
- "Review Issue" link uses `accent-blue` for navigation actions
- Wider `max-w-[90%]` than regular messages to emphasize importance
- Warning triangle SVG icon (not emoji) per FRONTEND-PATTERNS.md SVG-over-emoji rule

**Contrast verification:**
- Dark mode: `text-accent-green` (34 197 94, ~#22c55e) on `bg-accent-green/15` = effective bg ~#0d1f14 → contrast ratio ~7:1 (passes AA)
- Light mode: `text-accent-green` (21 128 61, ~#15803d) on `bg-accent-green/15` = effective bg ~#e8f5ed → contrast ratio ~5.0:1 (passes AA)

---

## 4. Timestamps

All message types use the same timestamp pattern:

- **Class:** `text-[10px] text-text-muted`
- **Position:** Below the message bubble, offset `mt-0.5`
- **Alignment:** Matches message alignment (right for user, center for system/pause, left for log entries)
- **Format:** Relative time via `relativeTime()` helper — "3s ago", "5m ago", "2h ago", "1d ago"
- **Hover:** `title` attribute with absolute time via `absoluteTime()` — "2026-03-06 14:23:45"

**Note:** The task description references `text-text-tertiary` — this token does NOT exist in the design system. The correct token is `text-text-muted` (WCAG AA compliant at ~4.9:1 on dark bg, ~4.7:1 on light bg-tertiary).

---

## 5. Chat Input Area

### Structure

```tsx
<div className="border-t border-border-primary px-4 py-3 bg-bg-secondary">
  <div className="flex items-end gap-2">
    <textarea
      className="flex-1 px-3 py-2 rounded-lg bg-bg-tertiary text-text-primary text-sm placeholder:text-text-muted border border-border-primary focus:border-accent-blue/60 focus:outline-none resize-none max-h-24 overflow-y-auto disabled:opacity-disabled disabled:cursor-not-allowed"
      rows={1}
      aria-label="Send message to autopilot"
    />
    <button
      className="p-2 rounded-lg bg-accent-blue text-white hover:bg-accent-blue/90 transition-all active:scale-[0.97] disabled:opacity-disabled disabled:cursor-not-allowed flex-shrink-0"
      aria-label="Send message"
    >
      {/* Send arrow SVG icon */}
    </button>
  </div>
</div>
```

### Textarea behavior

- **Auto-grow:** Starts at `rows={1}`, grows up to `max-h-24` (96px, ~4 lines)
- **Submit:** Enter sends; Shift+Enter inserts newline
- **Scroll:** `overflow-y-auto` when content exceeds max height
- **Disabled states:**
  - Draft blueprint: `disabled` with placeholder "Approve the blueprint first to send messages..."
  - While sending: `disabled` (prevents double-submit)

### Send button

- **Icon:** Paper plane SVG, 16x16, `stroke="currentColor"` (inherits `text-white`)
- **Normal:** `bg-accent-blue text-white` — solid blue fill
- **Hover:** `bg-accent-blue/90` — slight transparency
- **Disabled:** `opacity-disabled cursor-not-allowed` — when input is empty, sending, or blueprint is draft
- **Press feedback:** `active:scale-[0.97]`
- **Disabled tooltip** (via `title`): Explains why — "Approve the blueprint first" / "Sending..."

### Manual mode note

When in manual mode (non-draft), a note bar appears between messages and input:

```tsx
<div className="px-4 py-1.5 bg-bg-tertiary/50 border-t border-border-primary">
  <p className="text-xs text-text-muted text-center">
    Manual mode — messages will be processed when autopilot is enabled
  </p>
</div>
```

---

## 6. Interaction States

### 6.1 Sending a message

1. User types text and clicks send (or presses Enter)
2. Textarea clears immediately (optimistic)
3. `setSending(true)` — send button shows disabled state
4. API call: `sendBlueprintMessage(blueprintId, text)`
5. On success: refetch messages, trigger invalidation
6. On failure: non-blocking (message was already sent to queue)
7. `setSending(false)` in `finally` block

**Note:** No spinner on the send button — the operation is fast enough that the disabled state suffices. The optimistic text clear provides immediate feedback.

### 6.2 Autopilot processing indicator

When autopilot is actively running (`isAutopilotActive`):
- Status dot in header pulses green (`animate-pulse`)
- Polling intervals tighten to 5s for both log entries and messages
- New items auto-scroll into view (if user was at bottom of scroll)

**Auto-scroll logic:**
- `IntersectionObserver` on a sentinel `<div ref={bottomRef}>` tracks whether user is at the scroll bottom
- New items only trigger `scrollIntoView({ behavior: "smooth" })` if the sentinel was visible (user hadn't scrolled up)
- Guard: `typeof IntersectionObserver === "undefined"` for jsdom test environments

### 6.3 Paused state

- Pause message appears as a synthetic `ChatItem` with `kind: "pause"`
- Injected at current time, sorted chronologically with other items
- Contains "Review Issue" link (if pause reason references a node ID) and "Resume" button
- Resume flow: `updateBlueprint` (clear pause) → `runAllNodes` (with safeguard grace) → broadcast → invalidate

### 6.4 Draft blueprint

- Textarea is `disabled` with explanatory placeholder
- Send button is `disabled` with `title="Approve the blueprint first"`
- Messages area shows empty state text appropriate to mode

### 6.5 Empty state

```tsx
<div className="text-center py-8 text-text-muted text-sm">
  {isAutopilot
    ? "Send a message to interact with autopilot. Log entries and responses will appear here."
    : "Send messages to queue instructions. They will be processed when autopilot is enabled."}
</div>
```

### 6.6 Error handling

- Send failures are non-blocking (fire-and-forget to message queue)
- Fetch failures handled by TanStack Query's built-in retry/error states
- No inline error messages needed for the MVP — the message queue is resilient

---

## 7. Unified Timeline Merging

The chat displays three data sources merged into a single chronological timeline:

| Source | API | `ChatItem.kind` |
|---|---|---|
| User/system messages | `getBlueprintMessages()` | `"user-message"` / `"system-message"` |
| Autopilot log entries | `fetchAutopilotLog()` | `"log-entry"` |
| Pause state | Derived from props | `"pause"` (synthetic) |

### Merge algorithm

1. Map messages to `ChatItem[]` based on `msg.role`
2. Map log entries to `ChatItem[]` with `kind: "log-entry"`
3. If paused, inject synthetic pause item with `createdAt: new Date().toISOString()`
4. Sort all items ascending by `createdAt` (oldest first, newest at bottom)
5. Deduplicate by `id` prefix (`msg-{id}`, `log-{id}`, `pause-current`)

### Polling intervals

| State | Log interval | Message interval |
|---|---|---|
| Autopilot active | 5,000ms | 5,000ms |
| Autopilot not active (but mode set) | 15,000ms | 10,000ms |
| Manual mode | Disabled (false) | 10,000ms |

Intervals use `usePollingInterval` hook for dynamic adjustment.

---

## 8. Dark/Light Theme Compliance

All colors use semantic tokens from `tailwind.config.ts` — no hardcoded hex values anywhere.

### Token usage summary

| Element | Token(s) |
|---|---|
| Container bg | `bg-bg-primary` |
| Header/input bg | `bg-bg-secondary` |
| User message bg | `bg-accent-blue/10` |
| User message border | `border-accent-blue/20` |
| System message bg | `bg-bg-tertiary/50` |
| Log entry bg | `bg-bg-secondary` |
| Pause banner bg | `bg-accent-amber/10` |
| Pause banner border | `border-accent-amber/30` |
| Resume button | `bg-accent-green/15 text-accent-green border-accent-green/30` |
| Send button | `bg-accent-blue text-white` |
| Input bg | `bg-bg-tertiary` |
| All borders | `border-border-primary` |
| Primary text | `text-text-primary` |
| Secondary text | `text-text-secondary` |
| Timestamps/muted | `text-text-muted` |
| Disabled state | `opacity-disabled` (0.4) |

### Tokens NOT available (corrections from task description)

| Task mentions | Correct token | Reason |
|---|---|---|
| `text-text-tertiary` | `text-text-muted` | No `tertiary` text token exists |
| `border-border-secondary` | `border-border-primary` | No `secondary` border token exists |
| `bg-bg-secondary` for system bubbles | `bg-bg-tertiary/50` | Matches existing implementation; secondary is used for header/input areas |

### Semi-transparent backgrounds

Backgrounds using alpha values (`/10`, `/15`, `/20`, `/30`, `/50`) work correctly on both themes without `dark:` variants because the alpha composites over the parent's themed background. This is consistent with the FRONTEND-PATTERNS.md guidance.

---

## 9. Accessibility

### ARIA attributes

| Element | Attribute | Value |
|---|---|---|
| Textarea | `aria-label` | `"Send message to autopilot"` |
| Send button | `aria-label` | `"Send message"` |
| Pause alert | `role` | `"alert"` |
| Pause alert | `aria-live` | `"assertive"` |
| Log entry expand toggle | `role` | `"button"` |
| Log entry expand toggle | `tabIndex` | `0` |
| Log entry expand toggle | `onKeyDown` | Enter/Space triggers toggle |

### Message list semantics

The scrollable message area does not use `role="log"` in the current implementation. For the next iteration, consider adding:

```tsx
<div role="log" aria-live="polite" aria-label="Blueprint chat messages">
```

**Trade-off:** `aria-live="polite"` will announce new messages without interrupting — appropriate for a chat log. However, this may be noisy when autopilot is actively running and producing many log entries. The implementation should add `aria-live="polite"` only when polling is slow (manual mode / paused), and omit it during active autopilot to avoid screen reader overload.

### Keyboard navigation

- **Enter** submits the message (textarea)
- **Shift+Enter** inserts a newline
- **Tab** navigates through focusable elements (textarea, send button, resume button, etc.)
- **Focus ring:** Global `*:focus-visible` style applies (2px solid `accent-blue`, 2px offset)

### Touch targets

- Send button: `p-2` = 40x40px (close to 44px minimum). Acceptable for an icon button adjacent to the textarea — the textarea itself provides a large touch target for the primary interaction.
- Resume button: `px-2.5 py-1` — text label provides sufficient target width; vertical padding could be increased on mobile via `py-2.5 sm:py-1` if needed (per FRONTEND-PATTERNS.md mobile touch targets pattern).

---

## 10. Responsive Behavior

### Mobile (< 640px / below `sm`)

- Container: full-width, `px-3` internal padding
- Message bubbles: `max-w-[85%]` (already responsive)
- Pause alerts: `max-w-[90%]`
- Input area: `px-3` padding
- Header: stack title and status on separate lines if needed (current layout works at narrow widths)

### Tablet (640px - 1023px / `sm` to `lg`)

- Container: full-width within page padding
- Message bubbles: `max-w-[85%]`
- No layout changes from mobile other than page-level padding

### Desktop (>= 1024px / `lg` and above)

- Container: fills page content area (parent constrains width)
- Message bubbles: `max-w-[70%]` via `lg:max-w-[70%]`
- Pause alerts: `max-w-[75%]` via `lg:max-w-[75%]`
- More whitespace around messages improves readability

---

## 11. Component Interface

```typescript
interface BlueprintChatProps {
  blueprintId: string;
  executionMode: ExecutionMode | undefined;
  blueprintStatus: BlueprintStatus;
  pauseReason?: string;
  isReevaluating: boolean;
  isRunning: boolean;
  hasNodes: boolean;
  onReevaluateAll: () => void;
  onUpdate: (patch: { executionMode?: ExecutionMode; status?: string }) => void;
  onInvalidate: () => void;
  onBroadcast: (type: string) => void;
  onScrollToNode?: (nodeId: string) => void;
}
```

### Prop responsibilities

| Prop | Purpose |
|---|---|
| `blueprintId` | API calls for messages/log |
| `executionMode` | Determines polling intervals, status indicator, pause display |
| `blueprintStatus` | Controls input disabled state, pause detection |
| `pauseReason` | Content for pause message bubble |
| `isReevaluating` | Disables reevaluate button, shows loading text |
| `isRunning` | Disables reevaluate button |
| `hasNodes` | Controls visibility of reevaluate button |
| `onReevaluateAll` | Handler for reevaluate quick action |
| `onUpdate` | Optimistic state updates to parent |
| `onInvalidate` | Triggers data refetch in parent |
| `onBroadcast` | Emits events (e.g., `"autopilot_resume"`) to sibling components |
| `onScrollToNode` | Scrolls to a node card when "Review Issue" is clicked |

---

## 12. Relationship to Legacy Components

| Component | Status | Notes |
|---|---|---|
| `BlueprintChat.tsx` | **Active** — primary chat interface | Rendered on blueprint detail page |
| `AutopilotLog.tsx` | **Retained** — not rendered on blueprint detail page | Available for reuse in other contexts; log entries are now interleaved in BlueprintChat |
| `PauseBanner.tsx` | **Retained** — not rendered on blueprint detail page | Pause UI is now inline within BlueprintChat as `PauseMessage` sub-component |

The standalone components are kept to avoid breaking potential imports but are no longer mounted in the blueprint detail page. The `BlueprintChat` component internalizes equivalent functionality with unified styling.

---

## 13. Future Considerations (Out of Scope)

These items are documented for awareness but are NOT part of the current implementation:

- **Typing indicator animation** (three bouncing dots): Would show when autopilot is processing between log entries. Deferred until the message queue provides explicit "processing" state signals.
- **Message reactions/acknowledgments**: Visual indication that autopilot has read a user message. Depends on `acknowledged` field from the message queue schema.
- **Rich message content**: Markdown rendering in user messages, code blocks in system responses. Current implementation uses plain text which is sufficient for the initial release.
- **Message retry**: Resending failed messages. Not needed because the fire-and-forget message queue is reliable.
