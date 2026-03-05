# Testing Gotchas

Testing-specific gotchas for ClawUI. Referenced from [CLAUDE.md](../CLAUDE.md).

## Vitest Mocking

- **New exports need mock updates**: All `vi.mock()` blocks must include new exports or Vitest throws "[vitest] No 'exportName' export is defined on the mock". NavBar.test.tsx mocks `@/lib/api` — add new API exports there (e.g. `getUnreadInsightCount`). When adding new modules imported by `plan-routes.ts`, also add a `vi.mock()` block in `plan-routes.test.ts` (e.g. `plan-coordinator.js`).
- **`vi.mock` hoisting requires `vi.hoisted` for shared variables**: `vi.mock()` factories are hoisted above all code, so referenced variables must use `vi.hoisted(() => ({ fn: vi.fn() }))`. Type annotations on return values are required to avoid `never[]` inference from empty arrays (e.g., `(): Promise<Blueprint[]> => Promise.resolve([])`).
- **`vi.mock` factory objects are reused after `resetModules`**: The mock object is created once and reused on re-import. For dynamic mock values that change between tests, use getters: `vi.mock("./mod.js", () => ({ get PROP() { return mutableRef.value; } }))`.
- **Role auto-loading test mocks**: `vi.mock("../roles/load-all-roles.js", () => ({}))` — single line replaces per-role mocks. Still need `registerRole: vi.fn()` in the `role-registry.js` mock.
- **`vi.importActual("@/lib/api")` OOM with TanStack Query pages**: Tests for pages using TanStack Query custom hooks (e.g., `useBlueprintListQuery`) will OOM if `vi.importActual("@/lib/api")` is used — the import chain pulls in the entire TanStack Query dep tree in the worker. Instead, mock the custom hook directly: `vi.mock("@/lib/useBlueprintListQuery", () => ({ useBlueprintListQuery: vi.fn(() => hookState) }))` with `vi.hoisted` state, and mock `@/lib/api` with only the directly-used functions (no `vi.importActual`). See `blueprints/page.test.tsx` for the pattern.

## Frontend Test Patterns

- **Shared test utilities**: `test-utils.tsx` provides `renderWithProviders` (QueryClientProvider + ToastProvider wrapper), mock factories (`makeMockBlueprint`, `makeMockNode`, `makeMockExecution`, `makeMockInsight`), and `mockAllApiDefaults()`. `test-setup.ts` includes a global `BroadcastChannel` mock (jsdom doesn't provide one).
- **TanStack Query in tests**: Components using TanStack Query hooks need `QueryClientProvider` with `retry: false` and `refetchOnWindowFocus: false`. `renderWithProviders` includes this. For page-level tests that mock `@/lib/api`, TanStack Query calls the mocked functions transparently — no need to mock the query hooks themselves. Create a fresh `QueryClient` per test to avoid cache leakage.
- **BroadcastChannel mock override for hook tests**: The global mock in `test-setup.ts` is no-op (can't track instances). Tests for `useBlueprintBroadcast`/`useSessionBroadcast` must override `globalThis.BroadcastChannel` in `beforeEach` with a `class`-based mock that pushes to a `channelInstances` array. Arrow functions in `vi.fn()` can't be used as constructors — Vitest requires `class` or `function` keyword.
- **`useTheme()` mock in tests**: Components importing `useTheme` from `next-themes` (e.g., `MarkdownContent` for theme-aware syntax highlighting) need `vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }))` in their test files.

## DOM Query Gotchas

- **Page tests: duplicate text in DOM**: Page components render the same text in multiple places (e.g., node title in breadcrumb `<span>` + `<h1>`, session alias in header + info panel, tags in compact view + editable view). Use `getAllByText`, `getByRole("heading")`, or `getByTitle()` instead of `getByText` to avoid "Found multiple elements" errors.
- **Page tests: buttons with SVG icons**: Buttons containing `<><svg/>Text</>` fragments can't be reliably found with `getByText`. Use `getByTitle()` with the button's `title` attribute instead.
- **Confirmation gate breaks existing tests**: When adding `ConfirmationStrip` to existing buttons (e.g., Run All), tests must be updated to include the confirmation step — click button, wait for confirmation strip, then click "Yes".

## Backend Test Gotchas

- **plan-db tests share real DB**: Tests use `.clawui/index.db` (not isolated). Use unique `projectCwd` / session IDs (`randomUUID()`) in tests to avoid collisions and N+1 query timeouts from `listBlueprints()` scanning all rows.
- **Adding fields to `RolePrompts`**: Also update `makePrompts()` helper in `role-registry.test.ts` — it constructs a complete `RolePrompts` object and will fail typecheck if new required fields are missing.
- **Adding new role tests**: Use `assertRoleRegistration(roleId, expectedShape)` helper in `role-registry.test.ts`. Each role test is a single `describe` block with `clearRoles()` + dynamic import + one `assertRoleRegistration` call. The helper validates registration, metadata, artifactTypes, blockerTypes, workVerb, prompt substrings (via `promptContains`), and toolHints.

## Type & Mock Gotchas

- **`SessionMeta` required fields in tests**: Can't use partial `as SessionMeta` casts — TS rejects insufficient overlap. Must include `sessionId`, `projectId`, `projectName`, `timestamp`, `nodeCount` in all mock `SessionMeta` objects.
- **`TimelineNode.type` valid values**: `"user" | "assistant" | "tool_use" | "tool_result" | "error" | "system"` — no `"tool"` shorthand.
- **Test path strings on Windows**: Use `join()` (not template literals with `/`) for mock file paths compared with `===`. `join()` uses `\` on Windows; hardcoded `/` won't match.
- **Mocking `process.platform` doesn't change native APIs**: `os.homedir()`, `path.join()`, `path.sep` always use the real OS regardless of `Object.defineProperty(process, "platform", ...)`. Mocked-platform tests must not assert on native path separators or home dir format — use flexible assertions or guard with `describe.runIf(process.platform === "win32")`. `windows-real-platform.test.ts` validates real Windows behavior; mocked tests validate branching logic only.

## Component-Specific Test Notes

- **NodeDetailPage edit mode layout**: Smart Enrich and Save buttons are inside edit mode (as `MarkdownEditor` `actions` prop). The Re-evaluate button is in the **non-editing** description view (below `MarkdownContent`). Don't enter edit mode to click Re-evaluate.
