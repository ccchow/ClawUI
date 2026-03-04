# MarkdownContent.tsx → react-markdown Migration Audit

## 1. Current Implementation Catalog

`MarkdownContent.tsx` is a **zero-dependency** custom markdown renderer (~387 LOC) with two main layers:

### Block-Level Parser (`parseBlocks`)
| Feature | Implementation | Lines |
|---------|---------------|-------|
| Fenced code blocks | ` ```lang ... ``` ` detection, collects inner lines | 29–39 |
| Headings (h1–h6) | `^(#{1,6})\s+(.+)$` regex | 43–52 |
| Unordered lists | `^(\s*)[*\-+]\s+(.*)$`, collects consecutive | 55–69 |
| Ordered lists | `^(\s*)\d+[.)]\s+(.*)$`, collects consecutive | 56–69 |
| Horizontal rules | `^[-*_]{3,}\s*$` | 73–77 |
| Blockquotes | `^>\s?` prefix stripping, multiline | 80–88 |
| Paragraphs | Everything else, consecutive non-special lines | 97–118 |
| CRLF normalization | `text.replace(/\r/g, "")` before parsing | 21 |

### Inline Parser (`renderInline`)
| Feature | Implementation |
|---------|---------------|
| Inline code | `` `code` `` → `<code>` with accent-blue styling |
| Bold | `**bold**` → `<strong>` |
| Images | `![alt](url)` → `<img>` with `resolveImageUrl()` |
| Strikethrough | `~~text~~` → `<del>` |
| Italic | `*italic*` → `<em>` |
| Links | `[text](url)` → `<a>` with URL sanitization (protocol whitelist) |

### ClawUI-Specific Features
| Feature | Description | Complexity |
|---------|-------------|------------|
| **Image URL resolution** | `resolveImageUrl()` — prefixes `/api/` paths with `protocol://hostname:PORT` | Low |
| **Link URL sanitization** | Whitelist: `https?://`, `/`, `#`, `mailto:` — unsafe → `#` | Low |
| **Code block copy button** | `CodeBlock` component with clipboard copy + animated checkmark | Medium |
| **Copy-all button** | Top-right floating button for entire content (≥50 chars) | Medium |
| **maxHeight prop** | Scrollable container with configurable max-height or "none" | Low |
| **Tailwind design tokens** | Uses `bg-bg-tertiary`, `text-text-primary`, `accent-blue` etc. | Medium |
| **Space-y override pattern** | Consumer CSS: `[&_.space-y-3]:space-y-1.5 [&_.space-y-3]:text-xs` | Low |

### What It Does NOT Support
- Tables
- Nested lists
- Task lists / checkboxes
- Footnotes
- Definition lists
- HTML passthrough
- Syntax highlighting in code blocks
- Auto-linking (bare URLs)
- Nested inline formatting (e.g., `**bold *italic***`)

## 2. react-markdown Plugin Mapping

### Direct Mappings (react-markdown built-in)
| Current Feature | react-markdown Equivalent | Notes |
|----------------|--------------------------|-------|
| Headings | Built-in `h1`–`h6` components | Custom className via component override |
| Paragraphs | Built-in `p` component | Custom className via component override |
| Bold/Italic | Built-in `strong`/`em` | Styling via component override |
| Links | Built-in `a` component | Need custom component for sanitization |
| Images | Built-in `img` component | Need custom component for `resolveImageUrl()` |
| Inline code | Built-in `code` component | Styling via component override |
| Code blocks | Built-in `pre`/`code` component | Need custom for copy button |
| Lists (ul/ol) | Built-in `ul`/`ol`/`li` | Styling via component override |
| Blockquotes | Built-in `blockquote` | Styling via component override |
| Horizontal rules | Built-in `hr` | Styling via component override |

### Plugin Requirements
| Feature | Plugin | Package |
|---------|--------|---------|
| Strikethrough | `remark-gfm` | `remark-gfm` |
| Tables (new) | `remark-gfm` | `remark-gfm` (bonus) |
| Task lists (new) | `remark-gfm` | `remark-gfm` (bonus) |
| Auto-linking (new) | `remark-gfm` | `remark-gfm` (bonus) |
| Syntax highlighting | `rehype-highlight` or `rehype-prism-plus` | Adds ~50-200KB |
| HTML sanitization | `rehype-sanitize` | `rehype-sanitize` |

### Custom Component Overrides Required
```tsx
const components: Components = {
  // Link sanitization
  a: ({ href, children }) => {
    const isSafe = /^(https?:\/\/|\/|#|mailto:)/i.test(href ?? "");
    return <a href={isSafe ? href : "#"} target="_blank" rel="noopener noreferrer" className="text-accent-blue hover:underline">{children}</a>;
  },
  // Image URL resolution
  img: ({ src, alt }) => {
    const resolved = resolveImageUrl(src ?? "");
    return <img src={resolved} alt={alt ?? ""} className="max-w-full rounded-lg border border-border-primary my-1 max-h-[400px] object-contain" />;
  },
  // Code block with copy button
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  code: ({ inline, className, children }) => {
    if (inline) return <code className="px-1.5 py-0.5 rounded bg-bg-tertiary text-accent-blue text-[13px] font-mono">{children}</code>;
    return <code className={className}>{children}</code>;
  },
  // All block elements with Tailwind design tokens
  h1: (p) => <h1 className="text-lg font-bold">{p.children}</h1>,
  h2: (p) => <h2 className="text-base font-bold">{p.children}</h2>,
  h3: (p) => <h3 className="text-sm font-semibold">{p.children}</h3>,
  h4: (p) => <h4 className="text-sm font-medium text-text-secondary">{p.children}</h4>,
  // ... etc for ul, ol, li, blockquote, hr, p
};
```

## 3. Gap Analysis

### Fully Replaceable via react-markdown
- All block-level parsing (headings, paragraphs, lists, blockquotes, hr, code blocks)
- All inline formatting (bold, italic, strikethrough, inline code, links, images)
- CRLF normalization (react-markdown handles this)

### Require Custom Wrappers (NOT react-markdown concerns)
| Feature | Migration Path |
|---------|---------------|
| Copy-all button | Stays as wrapper around `<ReactMarkdown>` — no change needed |
| maxHeight scrolling | Stays as wrapper div — no change needed |
| `resolveImageUrl()` | Move to `img` component override |
| Link sanitization | Move to `a` component override (or use `rehype-sanitize`) |
| Code block copy button | Reuse existing `CodeBlock` as `pre` component override |

### True Gaps (Cannot Replicate)
**None.** All ClawUI customizations map cleanly to react-markdown's component override system. The custom features are all at the rendering layer, not the parsing layer.

## 4. Bundle Size Impact

| Package | Gzipped Size | Notes |
|---------|-------------|-------|
| `react-markdown` | ~10KB | Core renderer |
| `remark-parse` | ~28KB | Already a dep of react-markdown |
| `remark-gfm` | ~3KB | GFM extensions |
| `rehype-sanitize` | ~5KB | Optional, if HTML passthrough needed |
| `rehype-highlight` | ~2KB + language grammars | Optional syntax highlighting |
| **Total minimum** | **~13KB** | react-markdown + remark-gfm |
| **Current custom** | **~3KB** | Zero deps, 387 LOC |

**Delta: +10KB gzipped** for the core migration. Syntax highlighting adds significantly more.

## 5. Usage Inventory

| File | Count | Props Used |
|------|-------|-----------|
| `TimelineNode.tsx` | 3 | `content`, `maxHeight="500px"/"600px"` |
| `MacroNodeCard.tsx` | 4 | `content`, `maxHeight="none"` |
| `NodeDetailPage` | 5 | `content`, `maxHeight="none"` |
| `BlueprintDetailPage` | 2 | `content`, `maxHeight="200px"` |
| `SessionDetailPage` | 1 | `content`, `maxHeight="200px"` |
| `MarkdownEditor.tsx` | 1 | `content`, `maxHeight="none"` |
| **Total** | **16** | Only `content`, `maxHeight`, `className` |

All 16 call sites use only the public API (`content`, `maxHeight`, `className`). The external interface would remain identical after migration.

## 6. Test Coverage Assessment

`MarkdownContent.test.tsx` has 17 tests covering:
- Plain text, headings (h1-h3, multiple), bold, italic, inline code
- Links (safe + unsafe URL sanitization), code blocks, lists (ul/ol)
- Empty content, multiple paragraphs, copy button, blockquotes, hr, strikethrough
- maxHeight prop behavior, aria-labels

All tests assert on DOM output (tag names, text content, attributes) — **all would remain valid** after migration since the rendered HTML would be equivalent.

## 7. Recommendation: Do NOT Migrate

### Reasons to Keep Custom Implementation

1. **Zero dependencies** — The current component adds 0KB to the bundle. react-markdown adds ~13KB minimum. The project currently has only 4 production dependencies (next, next-themes, react, react-dom). This minimalism is a design strength.

2. **No feature gaps that react-markdown would solve** — The component handles everything ClawUI needs. The missing features (tables, nested lists, syntax highlighting) are not used anywhere in the codebase. Blueprint descriptions, node descriptions, convene messages, and session notes don't need table rendering.

3. **All customizations require component overrides anyway** — Even with react-markdown, you'd need 10+ component overrides to maintain the current Tailwind design token styling. The "simplification" is minimal; you're trading a custom parser for a custom component map of similar complexity.

4. **Performance** — The custom parser is faster for typical content (short descriptions, markdown notes) because it doesn't need the full unified/remark/rehype AST pipeline. For the typical 1-20 line markdown strings in ClawUI, this matters.

5. **Maintenance is low** — The component has been stable. The parser is ~120 LOC and easy to extend (adding a table parser would be ~40 LOC if ever needed).

6. **Test suite is comprehensive** — 17 tests cover all features. Migration would require revalidating all of these.

### When Migration Would Become Worthwhile

- If ClawUI needs **tables** in markdown content (e.g., structured artifact data)
- If **syntax highlighting** becomes a requirement for code blocks
- If **nested lists** or **task lists** are needed for blueprint descriptions
- If the parser needs to handle **complex edge cases** that the regex-based approach can't handle

### Recommended Incremental Improvements (Instead of Migration)

If the component needs enhancement, add features incrementally:

1. **Table support** — Add a table block parser (~40 LOC) if needed
2. **Syntax highlighting** — Add `highlight.js` as a code block enhancement (modular, ~5KB per language)
3. **Nested list support** — Enhance the list parser to track indentation levels (~20 LOC)

These targeted additions keep the zero-external-dependency advantage while filling specific gaps.

## 8. Risk Assessment Summary

| Aspect | Keep Custom | Migrate to react-markdown |
|--------|------------|--------------------------|
| Bundle size | 0KB added | +13KB minimum |
| Dependency count | 0 new | 2-4 new packages |
| Migration effort | N/A | Medium (2-3 days) |
| Risk of regressions | None | Medium (16 call sites, 17 tests) |
| Feature parity | Full | Full (with component overrides) |
| Future extensibility | Manual | Plugin ecosystem |
| Performance | Better for short content | Slightly slower (AST pipeline) |

**Verdict: Keep the custom implementation.** The migration cost exceeds the benefit for ClawUI's current and foreseeable needs. Revisit if table or syntax highlighting requirements emerge.
