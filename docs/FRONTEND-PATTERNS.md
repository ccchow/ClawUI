# Frontend Patterns

Detailed frontend UI conventions for ClawUI. Referenced from [CLAUDE.md](../CLAUDE.md).

## CSS Variable Theming

- Color tokens use CSS custom properties (`globals.css`) with RGB channel format (`--bg-primary: 10 10 15`) so Tailwind opacity modifiers (`bg-bg-secondary/50`) work.
- `:root` = light theme, `.dark` = dark theme.
- `tailwind.config.ts` references them as `rgb(var(--bg-primary) / <alpha-value>)`.
- `globals.css` uses `rgb(var(--bg-primary))` for direct CSS usage (body, scrollbars, code blocks, focus rings).
- Theme switching managed by `next-themes` (`ThemeProvider.tsx`): `attribute='class'`, `defaultTheme='dark'`, `storageKey='clawui-theme'`, syncs to backend via `updateAppState({ ui: { theme } })`.
- `<html>` tag has `suppressHydrationWarning` (required by next-themes).
- Never use hardcoded dark-mode colors like `bg-[#0a0a0f]` — use semantic tokens (`bg-bg-primary`) that respond to theme.
- `html` element has `color-scheme: light` (`:root`) and `color-scheme: dark` (`.dark`) for native scrollbar/form control theming.

## Semantic Color Tokens

- Always use semantic tokens (`accent-amber`, `accent-green`, `accent-blue`, etc.) for UI elements.
- Raw Tailwind colors (`yellow-400`, `green-600`, `amber-400`) are only acceptable for contextual data visualization (e.g., failure reason color coding in node detail, tool badge colors in `TimelineNode.tsx`).
- Data visualization text colors at the `-400` level lack contrast on light backgrounds — use `dark:` variants: `text-emerald-700 dark:text-emerald-400`.
- Semi-transparent backgrounds (`bg-emerald-500/15`) work on both themes without variants.
- SVG `stroke` attributes should use `currentColor` + a `text-*` class instead of hardcoded hex (e.g., `stroke="currentColor" className="text-accent-green"` instead of `stroke="#22c55e"`).
- Hardcoded hex in `DependencyGraph.tsx` is acceptable (SVG canvas rendering context where CSS variables can't be used).

## Color Contrast

- `text-muted` dark value is `112 128 150` (~#708096) for ~4.9:1 against dark `bg-primary`. Light value is `95 110 132` for ~5.2:1 against white and ~4.7:1 against `bg-tertiary`, meeting WCAG AA.
- Light-mode accent colors are darkened vs dark theme for text contrast: blue `37 99 235` (5.2:1), purple `124 58 237` (5.7:1), green `21 128 61` (5.0:1), amber `180 83 9` (5.0:1), red `220 38 38` (4.8:1) — all pass AA on white.
- Dark theme keeps brighter accent values for visibility on dark backgrounds.
- `text-white` on accent button backgrounds is acceptable (buttons use large enough text); for loading spinners inside buttons, use `border-current` instead of `border-white` to inherit the button's text color.

## Layout Patterns

- **Flex truncation**: For `truncate` to work in nested flex containers, every flex item in the chain needs `min-w-0`. Card containers wrapping truncated text also need `overflow-hidden`. Title links (`<a>`) need `block` display.
- **Page fade-in**: All main page root `<div>` elements use `animate-fade-in` class for subtle 0.2s opacity transition on navigation.

## Mobile Patterns

- **Bottom nav**: Fixed bottom navigation bars use `fixed bottom-0 left-0 right-0 z-40 sm:hidden` with `bg-bg-secondary/95 backdrop-blur-md`. Parent content needs `pb-16 sm:pb-0` to prevent overlap.
- **Touch targets**: Interactive elements need 44px minimum touch area on mobile (WCAG 2.5.5). Use responsive padding `py-2.5 sm:py-1.5` to enlarge on mobile while keeping compact desktop sizes. For small inline buttons (star, archive), use invisible tap expansion: `p-2 -m-1 rounded-lg`.
- **Overflow menu**: When desktop shows multiple icon buttons (`hidden sm:block`), provide a three-dot `...` menu on mobile (`sm:hidden`) with `useRef` + click-outside `useEffect` to close. Dropdown uses `absolute right-0 top-full z-50` positioning.
- **Touch-friendly hover**: Elements using `opacity-0 group-hover:opacity-100` are invisible on touch devices. Use `opacity-40 sm:opacity-0 sm:group-hover:opacity-100` to show at reduced opacity on mobile.
- **Responsive list truncation**: When a list is `hidden sm:flex`, show the first item on mobile with a `+N` count badge instead of hiding everything. Use separate mobile (`sm:hidden`) and desktop (`hidden sm:flex`) containers.

## Animation Patterns

- **AI loading indicators**: AI-triggered buttons (Run, Reevaluate, Smart Enrich, Generate Nodes) use `<AISparkle>` component with `animate-ai-sparkle` (pulse+rotate). Non-AI loading states keep standard `animate-spin` spinners. Custom keyframes in `globals.css`.
- **Overlay/modal animations**: `globals.css` provides `animate-fade-in` (opacity transition) and `animate-slide-up` (bottom-sheet entrance). Node switcher: bottom sheet on mobile (`rounded-t-2xl`, `animate-slide-up`), centered modal on desktop (`sm:rounded-2xl`, `sm:animate-fade-in`).
- **Button press feedback**: All interactive buttons use `active:scale-[0.98] transition-all` (smaller elements use `0.97`, card-level items use `0.995`). Disabled buttons use `disabled:opacity-disabled disabled:cursor-not-allowed` consistently (`opacity-disabled` = 0.4, defined in `tailwind.config.ts`). For conditional disabled styling (non-`disabled:` prefix), use `opacity-disabled cursor-not-allowed`.

## Interaction Patterns

- **Inline confirmation**: Never use `window.confirm()` — it breaks the dark theme. Use inline confirmation with state toggle: `confirmingX` state shows a `Yes`/`Cancel` button pair with `animate-fade-in` (see blueprints/[id]/page.tsx for reference).
- **SVG over emoji icons**: Use inline SVGs instead of emoji for interactive icons (stars, bookmarks, archive, sort, refresh, chevrons). Chevrons use a rotating SVG (`transition-transform rotate-90`) instead of swapping characters.
- **Hover popover gap**: For dropdown popovers positioned below a trigger with a visual gap, use `pt-*` (padding) on the outer positioned wrapper instead of `mt-*` (margin) — padding is part of the element's hit area. Combine with a 200ms delayed hide (`setTimeout` in `onMouseLeave`, cleared in `onMouseEnter`). See NavBar global activity popover.
- **Disabled button tooltips**: Every disabled button must have a `title` attribute explaining WHY it's disabled. Use conditional `title` with priority: in-progress action (`"Saving..."`), then missing data (`"Enter a title first"`), then blocking operation (`"Cannot save while AI operation is in progress"`), then normal enabled tooltip. For buttons only disabled during a transient action, use `title={disabled ? "reason" : undefined}`.
- **Line-clamp overflow toggle**: For truncated text previews (e.g., `line-clamp-2`), use `useRef` + `useEffect` comparing `scrollHeight > clientHeight` to detect overflow and conditionally show a "Show more"/"Show less" toggle. When expanded inline, render full content via `<MarkdownContent>` instead of `stripMarkdown()` plain text. Inline expand/collapse state should be independent of any parent card expand/collapse.

## Accessibility

- **ARIA labels on icon-only buttons**: Every `<button>` with only an icon must have `aria-label`. Dynamic labels for toggles (e.g., `aria-label={starred ? "Unstar session" : "Star session"}`).
- **`aria-expanded` on collapse controls**: All expand/collapse toggles must include `aria-expanded={isExpanded}`.
- **`aria-pressed` on toggle buttons**: Toggle buttons (e.g., AutopilotToggle) must include `aria-pressed={active}` to convey on/off state.
- **Alert banners**: Dynamic alert components (e.g., PauseBanner) use `role="alert"` + `aria-live="assertive"` for screen reader announcements.
- **Focus trapping in overlays**: Modal overlays use `role="dialog"` + `aria-modal="true"` + `aria-label`. A `useEffect` traps Tab key within the dialog and closes on Escape, returning focus to the trigger button via a ref.
- **`focus-visible` global styles**: `globals.css` provides `*:focus-visible { outline: 2px solid rgb(var(--accent-blue)); outline-offset: 2px; }` for keyboard navigation. No `:focus` styles — only `:focus-visible`.
- **StatusIndicator**: Uses `role="img"` and `aria-label={label}` with full status label mapping (Pending, Running, Completed, Failed, Blocked, Skipped, Waiting in queue, Draft, Approved, Paused).

## Gesture Color Semantics

Fire-and-forget gesture buttons follow a strict color taxonomy:

| Color Token | Semantic Category | Gestures |
|-------------|-------------------|----------|
| `accent-green` | **Execution** — "go" actions that run agent code | Run, Run All, Resume, Mark Done |
| `accent-purple` | **AI Enrichment/Creation** — AI enhances or generates content | Generate, Enrich, Smart Create, Smart Deps, Coordinate, Convene |
| `accent-amber` | **Review/Reconsider** — re-evaluation, caution, retry | Re-evaluate, Reevaluate All, Retry, Split, Unqueue, all confirmation strips |
| `accent-red` | **Destructive** — permanent data loss | Delete |
| `accent-blue` | **State Transition** — status or role changes | Approve |
| `text-secondary` | **Neutral** — low-risk mechanical toggles | Skip/Unskip |

**Rules:**
- Same gesture = same color everywhere (card, detail page, blueprint page).
- Confirmation strips default to `accent-amber` (caution). Exception: Regenerate strip uses `accent-purple` (creation family).
- Every fire-and-forget AI gesture must show a completion toast using the `prevXxxQueuedRef` → `useEffect` queue-exit pattern.
- Button weight varies by context: cards use lighter outlines (`bg-accent-*/20`), detail pages use solid fills for primary actions.

**Keyboard shortcuts** (NodeDetailPage, not in input/textarea/contentEditable):
- `r` Run node, `e` Toggle edit, `Shift+E` Smart Enrich (edit mode), `Shift+R` Re-evaluate, `d` Toggle deps
- `Escape` cascades: cancel confirmation → close edit → close switcher
- `Cmd/Ctrl+Shift+R` Reevaluate All (BlueprintDetailPage)

## Color & Role Conventions

- **Available accent tokens**: Only `accent-blue`, `accent-purple`, `accent-green`, `accent-amber`, `accent-red` exist. No `accent-yellow`, `accent-orange`, or `accent-cyan` — use `accent-amber` as the closest warm alternative. Exception: `BADGE_COLOR` in `TimelineNode.tsx` uses Tailwind defaults with `dark:` variants for tool-type differentiation (14+ tool types exceed the 5-accent palette).
- **Role color convention**: SDE=accent-blue, QA=accent-green, PM=accent-purple, UXD=accent-amber, SA=accent-red, MLE=accent-amber, unknown=accent-amber (fallback). Defined in `role-colors.ts` (single source of truth), imported by `RoleBadge.tsx` and `RoleSelector.tsx`.
- **Blueprint vs node status labels**: Blueprint-level "running" displays as "In Progress" in the UI; node-level "running" displays as "Running". `StatusIndicator` accepts `context?: "blueprint" | "node"` prop.
- **Agent-neutral UI language**: Frontend user-facing text uses "agent" (not "Claude Code") since multiple agent runtimes are supported. Tooltips say "using the selected agent", empty states say "use an agent", etc.

## Inline Confirmation

- **ConfirmationStrip component**: Use `ConfirmationStrip` (not hand-rolled markup) for all Yes/No confirmation prompts. Accepts `variant` (amber/red/blue/purple/green) matching gesture color semantics, `confirmLabel`, `onConfirm`, `onCancel`. Use `inline` prop for span wrapper, `stopPropagation` for nested click contexts. Built-in keyboard accessibility: Escape dismisses the strip, confirm button auto-focuses on mount, focus returns to trigger element on cancel. Consumers manage their own show/hide state via `useState`.

## Agent UI Patterns

- **Agent color convention**: Claude=`accent-purple`, OpenClaw=`accent-green`, Pi Mono=`accent-blue`. `AGENT_COLORS` and `AGENT_LABELS` maps in `AgentSelector.tsx`. `AgentBadge` shows colored pill; `AgentSelector` auto-hides when only one agent has sessions. Non-Claude badges shown conditionally: `{agentType && agentType !== "claude" && <AgentBadge ... />}`. `MacroNodeCard` accepts `blueprintAgentType` prop to show override badges only when node agent differs from blueprint default.
- **Multi-agent tool badge mapping**: `TimelineNode.tsx` `BADGE_COLOR` map includes OpenClaw tools (`skill_call`, `thinking`) and Pi Mono tools (`bash_execution`, `file_read`, `file_write`, `file_edit`). `toolInputSummary()` extracts summaries for these tool types.
- **Node numbering**: Always use `node.order + 1` (DB `order` field) for display numbers — in `MacroNodeCard`, dependency picker chips, node switcher, and bottom nav. Never use array index for numbering.

## State Patterns

- **Filter state persistence**: Blueprint pages persist filter state to URL search params via `window.history.replaceState` (no history pollution) + `sessionStorage` for cross-page back links. Blueprints list: `?status=running&archived=1` (key: `clawui:blueprints-filters`). Blueprint detail: `?filter=failed&sort=manual&order=oldest` (key: `clawui:blueprint-${id}-filters`). Default values are omitted from URL params.
- **Skipped node filtering**: After a node is split, its status becomes `skipped`. Dependency picker excludes skipped nodes unless already selected (shown dimmed with "(split)" label). Node switcher overlay excludes skipped nodes entirely.
- **Fire-and-forget button loading state**: AI-triggered buttons that use `enqueueBlueprintTask` must NOT use promise-based `finally { setLoading(false) }` — the API returns immediately so loading clears before work starts. Instead, use an optimistic flag (`setOptimistic(true)` on click) combined with a derived loading state from `pendingTasks` polling (e.g., `const loading = optimistic || pendingTasks.some(t => t.type === "my_type")`). Clear optimistic flag once polling confirms the task exists. Call `loadData()` after the API call to trigger immediate polling.
