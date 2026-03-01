# Multi-Role Mechanism Design

**Date:** 2026-03-01
**Status:** Approved
**MVP Scope:** SDE + QA + PM (3 built-in roles)

## Problem

All prompts in ClawUI's plan system (execution, evaluation, generation, enrichment, reevaluation, split, smart-deps) are hardcoded around the SDE (Software Development Engineer) role. There is no concept of "role" in the data model — every prompt assumes the agent writes code, runs typecheck/lint/build/test, and produces file diffs.

This makes it impossible to use the blueprint/plan system for non-coding tasks such as QA test planning, product requirement definition, or delivery management.

## Solution: Role as Prompt Module (Approach A)

A Role is a **modular prompt package** — a set of prompt fragments, evaluation criteria, and artifact types that can be plugged into the plan system. Blueprints enable a set of roles; nodes specify which roles they involve.

### Design Principles

- **Modular and pluggable** — enable/disable roles at any time on a blueprint
- **Full-spectrum influence** — roles affect persona, decomposition, evaluation, and artifacts
- **Hybrid storage** — built-in roles in code, custom roles in DB (Phase 2)
- **Multi-role nodes** — a single node can involve multiple roles
- **Backward compatible** — no role config = pure SDE mode, identical behavior to today

## 1. RoleDefinition Data Structure

```typescript
// backend/src/roles/role-registry.ts

interface RolePrompts {
  /** "You are a senior software engineer..." */
  persona: string;
  /** "implement" | "test" | "define requirements" */
  workVerb: string;
  /** Execution-time guidance appended to buildNodePrompt() */
  executionGuidance: string;
  /** Handoff artifact format template (replaces ARTIFACT_PROMPT) */
  artifactFormat: string;
  /** Examples for NEEDS_REFINEMENT in evaluation */
  evaluationExamples: string;
  /** How plan-generator decomposes tasks for this role */
  decompositionHeuristic: string;
  /** JSON example for plan-generator few-shot learning */
  decompositionExample: string;
  /** "mention file paths, function names..." — specificity guidance */
  specificityGuidance: string;
  /** Smart-deps consideration (replaces "Code dependencies: ...") */
  dependencyConsiderations: string;
  /** "run typecheck, lint, build, tests" — post-completion checks */
  verificationSteps: string;
  /** Suggestion categories for evaluation follow-ups */
  suggestionsTemplate: string;
  /** Reevaluate-all: how to verify completion */
  reevaluationVerification: string;
}

interface RoleDefinition {
  id: string;                    // "sde" | "qa" | "pm" | custom
  label: string;                 // "Software Engineer"
  description: string;           // Short description for UI
  icon?: string;                 // Emoji or icon identifier
  builtin: boolean;              // true for SDE/QA/PM, false for custom

  prompts: RolePrompts;

  /** Artifact types this role typically produces */
  artifactTypes: string[];

  /** Blocker types relevant to this role */
  blockerTypes: string[];

  /** MCP tool hints shown in execution prompt */
  toolHints?: string;
}
```

### Built-in Roles Prompt Summary

| Prompt field | SDE | QA | PM |
|---|---|---|---|
| persona | senior software engineer | senior QA engineer | senior product manager |
| workVerb | implement | test and validate | define and clarify requirements |
| executionGuidance | Write code directly. Run typecheck/lint/build/test... | Write test cases and execute them. Verify coverage and edge cases... | Write clear requirements, acceptance criteria, and user stories... |
| artifactFormat | Files changed + Decisions | Test cases written + Coverage + Bugs found | Requirements defined + Acceptance criteria + Open questions |
| evaluationExamples | missing validation, incomplete error handling, untested edge case | insufficient test coverage, missing edge case tests, no regression tests | ambiguous requirements, missing acceptance criteria, unstated assumptions |
| decompositionHeuristic | Split by architectural layer (backend, frontend, integration) | Split by test scope (unit, integration, e2e) | Split by user journey or feature area |
| specificityGuidance | mention file paths, function names, API endpoints | mention test file paths, assertion types, coverage targets | mention user personas, business rules, success metrics |
| dependencyConsiderations | Code dependencies: Does this node modify code that another node creates? | Test dependencies: Does this node test functionality created by another node? | Requirement dependencies: Does this node define requirements consumed by another node? |
| verificationSteps | run typecheck, lint, build, tests | run test suite, check coverage report | review against stakeholder requirements |
| suggestionsTemplate | testing, documentation, performance improvements, related features | regression testing, load testing, security testing, accessibility | stakeholder review, edge case analysis, metric definition |
| reevaluationVerification | Read the relevant source files to verify implementation status | Read test files and coverage reports to verify testing status | Review requirement documents and acceptance criteria for completeness |
| artifactTypes | file_diff, test_report | test_plan, bug_report | requirement_doc, acceptance_criteria |
| blockerTypes | missing_dependency, unclear_requirement, access_issue, technical_limitation | missing_test_data, environment_issue, flaky_dependency, access_issue | missing_stakeholder_input, unclear_business_rule, scope_ambiguity |
| toolHints | Playwright for browser testing, Serena for semantic code analysis, Context7 for library docs | Playwright for e2e testing, Serena for code analysis to identify test targets | Linear for issue tracking, Firecrawl for competitor research |

## 2. Data Model Changes

### Blueprint table — new columns

```sql
ALTER TABLE blueprints ADD COLUMN enabled_roles TEXT DEFAULT '["sde"]';
ALTER TABLE blueprints ADD COLUMN default_role TEXT DEFAULT 'sde';
```

- `enabled_roles`: JSON array of role IDs enabled for this blueprint
- `default_role`: Fallback role for nodes that don't specify roles

### MacroNode table — new column

```sql
ALTER TABLE macro_nodes ADD COLUMN roles TEXT DEFAULT NULL;
```

- `roles`: JSON array of role IDs. `NULL` = inherit blueprint's `default_role`
- Example: `'["sde","qa"]'` means this node involves both SDE and QA

### ArtifactType expansion

Current fixed union: `"handoff_summary" | "file_diff" | "test_report" | "custom"`

Change to open string with role conventions:
- Keep `"handoff_summary"` and `"custom"` as universal types
- Add role-specific types: `"test_plan"`, `"bug_report"`, `"requirement_doc"`, `"acceptance_criteria"`, `"review_notes"`
- DB `artifacts.type` column is already TEXT — no schema change needed
- TypeScript type changes from union to `string`, with exported constant sets for UI

### Custom Roles table (Phase 2, not in MVP)

```sql
CREATE TABLE IF NOT EXISTS custom_roles (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  description TEXT,
  icon TEXT,
  prompts_json TEXT NOT NULL,
  artifact_types TEXT,
  blocker_types TEXT,
  tool_hints TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
```

## 3. Role Registry Pattern

Reuses the agent runtime registration pattern: side-effect import + global registry.

### File structure

```
backend/src/roles/
  role-registry.ts      — RoleDefinition interface + registry Map + get/list helpers
  role-sde.ts           — SDE role definition, self-registers
  role-qa.ts            — QA role definition, self-registers
  role-pm.ts            — PM role definition, self-registers
```

### Registry API

```typescript
// role-registry.ts
const roleRegistry = new Map<string, RoleDefinition>();

export function registerRole(role: RoleDefinition): void {
  roleRegistry.set(role.id, role);
}

export function getRole(id: string): RoleDefinition | undefined {
  return roleRegistry.get(id);
}

export function getAllRoles(): RoleDefinition[] {
  return Array.from(roleRegistry.values());
}

export function getBuiltinRoles(): RoleDefinition[] {
  return getAllRoles().filter(r => r.builtin);
}
```

### Side-effect import locations

Same pattern as agent runtimes. Add to `plan-executor.ts`, `plan-generator.ts`, `plan-routes.ts`, `routes.ts`:

```typescript
import "./roles/role-sde.js";
import "./roles/role-qa.js";
import "./roles/role-pm.js";
```

## 4. Prompt Assembly Logic

### Resolving node roles

```typescript
function resolveNodeRoles(node: MacroNode, blueprint: Blueprint): string[] {
  if (node.roles && node.roles.length > 0) return node.roles;
  return [blueprint.defaultRole ?? "sde"];
}
```

### Single-role node (most common)

Direct template substitution — role's prompt fragments replace hardcoded strings:

```typescript
function buildSingleRolePrompt(roleId: string, node: MacroNode, blueprint: Blueprint): string {
  const role = getRole(roleId)!;
  return `
${role.prompts.persona}

You are executing step #${node.seq} of a plan: "${blueprint.title}"

## Plan Description
${blueprint.description}

## Context from previous steps:
${buildDependencyContext(node, blueprint)}

## Your Task (Step #${node.seq}): ${node.title}
${node.description}
${node.prompt ?? ""}

## Working Directory: ${blueprint.projectCwd}

## Instructions
${role.prompts.executionGuidance}

${role.prompts.toolHints
  ? "- You have access to MCP tools (e.g. " + role.prompts.toolHints + "). Use ToolSearch to discover them."
  : ""}

${buildBlockerInstructions(node, blueprint, role)}
${buildReportInstructions(node, blueprint)}
`;
}
```

### Multi-role node

When `roles.length > 1`, composition strategy:

1. **Persona** — merged: "You are executing this task wearing multiple hats: Software Engineer and QA Engineer."
2. **Execution guidance** — listed per role under separate headings to avoid conflicting instructions
3. **Verification steps** — accumulated from all roles
4. **Artifact format** — combined sections from all roles

```typescript
function buildMultiRolePrompt(roleIds: string[], node: MacroNode, blueprint: Blueprint): string {
  const roles = roleIds.map(id => getRole(id)!);
  const roleLabels = roles.map(r => r.label).join(" and ");

  const persona = `You are executing this task wearing multiple hats: ${roleLabels}.
You must address the responsibilities of each role.`;

  const guidanceSections = roles.map(r =>
    `### As ${r.label}:\n${r.prompts.executionGuidance}`
  ).join("\n\n");

  const verificationSteps = roles.map(r =>
    `- ${r.label}: ${r.prompts.verificationSteps}`
  ).join("\n");

  // ... assemble full prompt with merged sections
}
```

### Evaluation prompt role-awareness

```typescript
function buildEvaluationPrompt(node: MacroNode, blueprint: Blueprint): string {
  const roles = resolveNodeRoles(node, blueprint);

  const examples = roles.map(id => {
    const r = getRole(id)!;
    return `- ${r.label}: ${r.prompts.evaluationExamples}`;
  }).join("\n");

  const suggestions = roles.map(id => {
    const r = getRole(id)!;
    return `- ${r.label}: ${r.prompts.suggestionsTemplate}`;
  }).join("\n");

  // Use in NEEDS_REFINEMENT section and follow-up suggestions
}
```

### Plan Generator role-awareness

`plan-generator.ts` adjusts based on blueprint's `enabledRoles`:

- Persona becomes "You are an expert planner coordinating work across: {role labels}"
- Decomposition heuristics: merged from all enabled roles
- Example nodes: sampled from each role's `decompositionExample`
- Generated nodes include a `roles` field — generator prompt instructs the agent to tag each node

### Other prompts (enrich, reevaluate, split, smart-deps)

All operation prompts in `plan-routes.ts` follow the same pattern:
1. Resolve the target node's roles
2. Replace hardcoded SDE language with role-specific fragments
3. For blueprint-level operations (reevaluate-all), use the blueprint's `enabledRoles`

## 5. API Changes

### Blueprint endpoints

**`POST /api/blueprints`** — new optional fields:
```typescript
{
  title: string;
  description: string;
  projectCwd?: string;
  agentType?: string;
  enabledRoles?: string[];    // default ["sde"]
  defaultRole?: string;       // default "sde"
}
```

**`PATCH /api/blueprints/:id`** — same fields updatable.

**`GET /api/blueprints/:id`** — response includes `enabledRoles` and `defaultRole`.

### Node endpoints

**`PATCH /api/blueprints/:id/nodes/:nodeId`** — patch adds `roles`:
```typescript
{ ...existing fields..., roles?: string[] }
```

**`POST /api/blueprints/:id/nodes/batch-create`** — node object adds optional `roles`:
```typescript
{ title, description, dependencies, roles?: string[] }
```

### Role endpoints (new)

```
GET  /api/roles          — list all available roles (built-in + custom)
GET  /api/roles/:id      — get single role details
```

Read-only in MVP. CRUD for custom roles in Phase 2.

## 6. Frontend Changes

### Type updates (`lib/api.ts`)

```typescript
interface Blueprint {
  ...existing...
  enabledRoles?: string[];
  defaultRole?: string;
}

interface MacroNode {
  ...existing...
  roles?: string[];
}

interface RoleInfo {
  id: string;
  label: string;
  description: string;
  icon?: string;
  builtin: boolean;
}
```

`ArtifactType` changes from strict union to `string`.

### Blueprint create/edit pages

Add **Role Selector** component to `/blueprints/new` and `/blueprints/[id]`:

- Multi-select toggle component (similar to `AgentSelector`)
- Fetches available roles from `GET /api/roles`
- Each role shows icon + label + description
- Toggle enable/disable per role
- SDE enabled by default

### Node display and editing

**MacroNodeCard** and **NodeDetailPage** additions:

- **Role Badge(s)** — displays the node's associated roles (similar styling to `AgentBadge`)
- Editable: click to open role selector (limited to blueprint's enabled roles subset)
- When unset, shows faded "inherits: {defaultRole}" indicator

### Role Badge colors

Reuse existing accent token system:

| Role | Token |
|---|---|
| SDE | `accent-blue` |
| QA | `accent-green` |
| PM | `accent-purple` |
| Custom | `accent-amber` |

## 7. Migration Strategy

### DB migration (incremental, no version bump)

```typescript
// In plan-db.ts ensurePlanTables()
const bpCols = db.pragma("table_info(blueprints)").map(c => c.name);
if (!bpCols.includes("enabled_roles")) {
  db.exec("ALTER TABLE blueprints ADD COLUMN enabled_roles TEXT DEFAULT '[\"sde\"]'");
}
if (!bpCols.includes("default_role")) {
  db.exec("ALTER TABLE blueprints ADD COLUMN default_role TEXT DEFAULT 'sde'");
}

const nodeCols = db.pragma("table_info(macro_nodes)").map(c => c.name);
if (!nodeCols.includes("roles")) {
  db.exec("ALTER TABLE macro_nodes ADD COLUMN roles TEXT DEFAULT NULL");
}
```

### Prompt migration

Extract all current hardcoded prompt strings into `role-sde.ts` verbatim. After migration, `buildNodePrompt()` output must be byte-for-byte identical to current behavior when role is SDE. Verified by test.

### API compatibility

All new fields are optional with SDE defaults. Existing API clients work without changes.

### Frontend compatibility

Role UI components are hidden or minimized when `enabledRoles` is `["sde"]` only (the default). Existing blueprints look and behave identically.

## 8. Out of Scope (Phase 2+)

Explicitly excluded from MVP to avoid scope creep:

- **Custom role CRUD UI** — create/edit/delete custom roles via frontend
- **Role-specific MCP tool auto-loading** — auto-enable MCP servers based on role
- **Role-based permissions/access control** — restrict who can assign roles
- **Role collaboration protocols** — automatic artifact handoff between roles (dependency mechanism handles this naturally)
- **Per-role agent type override** — "PM uses GPT-5, SDE uses Claude" (existing per-node `agentType` already supports this)
- **Custom roles table** — DB table defined but not used in MVP

## 9. Affected Files Summary

### Backend — new files
- `backend/src/roles/role-registry.ts`
- `backend/src/roles/role-sde.ts`
- `backend/src/roles/role-qa.ts`
- `backend/src/roles/role-pm.ts`

### Backend — modified files
- `plan-db.ts` — schema migration, `rowToBlueprint()`, `rowToMacroNode()`, CRUD helpers
- `plan-executor.ts` — `buildNodePrompt()`, `buildEvaluationPrompt()`, `ARTIFACT_PROMPT`, side-effect imports
- `plan-generator.ts` — generation prompt, side-effect imports
- `plan-routes.ts` — enrich/reevaluate/split/smart-deps/reevaluate-all prompts, side-effect imports
- `routes.ts` — new `GET /api/roles` endpoints, side-effect imports

### Frontend — modified files
- `lib/api.ts` — types + new API functions (`fetchRoles`, updated `createBlueprint`, `updateMacroNode`)
- `app/blueprints/new/page.tsx` — Role Selector in create form
- `app/blueprints/[id]/page.tsx` — Role Selector in edit view
- `app/blueprints/[id]/nodes/[nodeId]/page.tsx` — Role Badges + role editing
- `components/MacroNodeCard.tsx` — Role Badges display

### Frontend — new files
- `components/RoleSelector.tsx` — multi-select role toggle component
- `components/RoleBadge.tsx` — role indicator badge component
