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
- **Button press feedback**: All interactive buttons use `active:scale-[0.98] transition-all` (smaller elements use `0.97`, card-level items use `0.995`). Disabled buttons use `disabled:opacity-40 disabled:cursor-not-allowed` consistently.

## Interaction Patterns

- **Inline confirmation**: Never use `window.confirm()` — it breaks the dark theme. Use inline confirmation with state toggle: `confirmingX` state shows a `Yes`/`Cancel` button pair with `animate-fade-in` (see blueprints/[id]/page.tsx for reference).
- **SVG over emoji icons**: Use inline SVGs instead of emoji for interactive icons (stars, bookmarks, archive, sort, refresh, chevrons). Chevrons use a rotating SVG (`transition-transform rotate-90`) instead of swapping characters.
- **Hover popover gap**: For dropdown popovers positioned below a trigger with a visual gap, use `pt-*` (padding) on the outer positioned wrapper instead of `mt-*` (margin) — padding is part of the element's hit area. Combine with a 200ms delayed hide (`setTimeout` in `onMouseLeave`, cleared in `onMouseEnter`). See NavBar global activity popover.

## Accessibility

- **ARIA labels on icon-only buttons**: Every `<button>` with only an icon must have `aria-label`. Dynamic labels for toggles (e.g., `aria-label={starred ? "Unstar session" : "Star session"}`).
- **`aria-expanded` on collapse controls**: All expand/collapse toggles must include `aria-expanded={isExpanded}`.
- **Focus trapping in overlays**: Modal overlays use `role="dialog"` + `aria-modal="true"` + `aria-label`. A `useEffect` traps Tab key within the dialog and closes on Escape, returning focus to the trigger button via a ref.
- **`focus-visible` global styles**: `globals.css` provides `*:focus-visible { outline: 2px solid rgb(var(--accent-blue)); outline-offset: 2px; }` for keyboard navigation. No `:focus` styles — only `:focus-visible`.
- **StatusIndicator**: Uses `role="img"` and `aria-label={label}` with full status label mapping (Pending, Running, Completed, Failed, Blocked, Skipped, Waiting in queue, Draft, Approved, Paused).

## State Patterns

- **Filter state persistence**: Blueprint pages persist filter state to URL search params via `window.history.replaceState` (no history pollution) + `sessionStorage` for cross-page back links. Blueprints list: `?status=running&archived=1` (key: `clawui:blueprints-filters`). Blueprint detail: `?filter=failed&sort=manual&order=oldest` (key: `clawui:blueprint-${id}-filters`). Default values are omitted from URL params.
- **Skipped node filtering**: After a node is split, its status becomes `skipped`. Dependency picker excludes skipped nodes unless already selected (shown dimmed with "(split)" label). Node switcher overlay excludes skipped nodes entirely.
- **Fire-and-forget button loading state**: AI-triggered buttons that use `enqueueBlueprintTask` must NOT use promise-based `finally { setLoading(false) }` — the API returns immediately so loading clears before work starts. Instead, use an optimistic flag (`setOptimistic(true)` on click) combined with a derived loading state from `pendingTasks` polling (e.g., `const loading = optimistic || pendingTasks.some(t => t.type === "my_type")`). Clear optimistic flag once polling confirms the task exists. Call `loadData()` after the API call to trigger immediate polling.
