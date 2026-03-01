# Multi-Role Mechanism Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a modular, pluggable role system (SDE, QA, PM) to the blueprint/plan system so prompts, evaluation, and artifacts are role-aware instead of SDE-hardcoded.

**Architecture:** Roles are prompt modules registered via side-effect imports (same pattern as agent runtimes). Blueprint enables roles; nodes specify which roles they involve. All prompts assembled from role fragments. Backward compatible — no role config = pure SDE mode.

**Tech Stack:** TypeScript, Express, SQLite (better-sqlite3), Next.js 14, React 18, Tailwind CSS 3

**Design Doc:** `docs/plans/2026-03-01-multi-role-mechanism-design.md`

---

## Task 1: Create Role Registry

**Files:**
- Create: `backend/src/roles/role-registry.ts`
- Create: `backend/src/__tests__/role-registry.test.ts`

**Step 1: Write the failing test**

Create `backend/src/__tests__/role-registry.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";

describe("role-registry", () => {
  beforeEach(async () => {
    const mod = await import("../roles/role-registry.js");
    mod.clearRoles();
  });

  it("registers and retrieves a role", async () => {
    const { registerRole, getRole } = await import("../roles/role-registry.js");
    registerRole({
      id: "test-role",
      label: "Test Role",
      description: "A test role",
      builtin: true,
      prompts: {
        persona: "You are a test role.",
        workVerb: "test",
        executionGuidance: "Do testing.",
        artifactFormat: "**Results:**\n<results>",
        evaluationExamples: "missing tests",
        decompositionHeuristic: "Split by test type",
        decompositionExample: '[{"title":"Unit tests","description":"Write unit tests"}]',
        specificityGuidance: "mention test files",
        dependencyConsiderations: "Test deps: Does this test code from another node?",
        verificationSteps: "run tests",
        suggestionsTemplate: "more tests, coverage",
        reevaluationVerification: "Read test files to verify",
      },
      artifactTypes: ["test_plan"],
      blockerTypes: ["missing_test_data"],
    });
    const role = getRole("test-role");
    expect(role).toBeDefined();
    expect(role!.label).toBe("Test Role");
    expect(role!.prompts.persona).toBe("You are a test role.");
  });

  it("returns undefined for unknown role", async () => {
    const { getRole } = await import("../roles/role-registry.js");
    expect(getRole("nonexistent")).toBeUndefined();
  });

  it("lists all roles", async () => {
    const { registerRole, getAllRoles } = await import("../roles/role-registry.js");
    registerRole({ id: "a", label: "A", description: "", builtin: true, prompts: {} as any, artifactTypes: [], blockerTypes: [] });
    registerRole({ id: "b", label: "B", description: "", builtin: false, prompts: {} as any, artifactTypes: [], blockerTypes: [] });
    expect(getAllRoles()).toHaveLength(2);
  });

  it("filters builtin roles", async () => {
    const { registerRole, getBuiltinRoles } = await import("../roles/role-registry.js");
    registerRole({ id: "a", label: "A", description: "", builtin: true, prompts: {} as any, artifactTypes: [], blockerTypes: [] });
    registerRole({ id: "b", label: "B", description: "", builtin: false, prompts: {} as any, artifactTypes: [], blockerTypes: [] });
    const builtins = getBuiltinRoles();
    expect(builtins).toHaveLength(1);
    expect(builtins[0].id).toBe("a");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/__tests__/role-registry.test.ts`
Expected: FAIL -- module not found

**Step 3: Write the implementation**

Create `backend/src/roles/role-registry.ts`:

```typescript
export interface RolePrompts {
  persona: string;
  workVerb: string;
  executionGuidance: string;
  artifactFormat: string;
  evaluationExamples: string;
  decompositionHeuristic: string;
  decompositionExample: string;
  specificityGuidance: string;
  dependencyConsiderations: string;
  verificationSteps: string;
  suggestionsTemplate: string;
  reevaluationVerification: string;
}

export interface RoleDefinition {
  id: string;
  label: string;
  description: string;
  icon?: string;
  builtin: boolean;
  prompts: RolePrompts;
  artifactTypes: string[];
  blockerTypes: string[];
  toolHints?: string;
}

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
  return getAllRoles().filter((r) => r.builtin);
}

export function clearRoles(): void {
  roleRegistry.clear();
}
```

**Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run src/__tests__/role-registry.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add backend/src/roles/role-registry.ts backend/src/__tests__/role-registry.test.ts
git commit -m "feat: add role registry with RoleDefinition interface"
```

---

## Task 2: Create SDE Built-in Role

Extract all hardcoded SDE prompt strings from plan-executor.ts, plan-generator.ts, and plan-routes.ts into a role definition.

**Files:**
- Create: `backend/src/roles/role-sde.ts`
- Modify: `backend/src/__tests__/role-registry.test.ts`

**Reference locations for extraction:**
- Persona: `plan-executor.ts:451`
- Execution guidance: `plan-executor.ts:476-497` (Instructions block)
- Artifact format: `plan-executor.ts:500-513` (ARTIFACT_PROMPT)
- Evaluation examples: `plan-executor.ts:678-680`
- Decomposition heuristic: `plan-generator.ts:112-114`
- Decomposition example: `plan-generator.ts:106-109`
- Dependency considerations: `plan-routes.ts:726`
- Verification steps: `plan-executor.ts:484`
- Reevaluation verification: `plan-routes.ts:1745-1746`
- Tool hints: `plan-executor.ts:479`

**Step 1: Write the failing test**

Add to `backend/src/__tests__/role-registry.test.ts`:

```typescript
describe("built-in SDE role", () => {
  it("is registered after import", async () => {
    const { getRole, clearRoles } = await import("../roles/role-registry.js");
    clearRoles();
    await import("../roles/role-sde.js");
    const sde = getRole("sde");
    expect(sde).toBeDefined();
    expect(sde!.id).toBe("sde");
    expect(sde!.label).toBe("Software Engineer");
    expect(sde!.builtin).toBe(true);
    expect(sde!.prompts.persona).toContain("software engineer");
    expect(sde!.prompts.workVerb).toBe("implement");
    expect(sde!.artifactTypes).toContain("file_diff");
    expect(sde!.artifactTypes).toContain("test_report");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/__tests__/role-registry.test.ts`
Expected: FAIL

**Step 3: Write the implementation**

Create `backend/src/roles/role-sde.ts`:

```typescript
import { registerRole } from "./role-registry.js";

registerRole({
  id: "sde",
  label: "Software Engineer",
  description: "Writes and maintains production code, APIs, and infrastructure",
  icon: "code",
  builtin: true,
  prompts: {
    persona: "You are a senior software engineer executing a development task.",
    workVerb: "implement",
    executionGuidance: `- Complete this step thoroughly. Focus only on THIS step.
- DO NOT ask for confirmation or clarification. Just write the code directly.
- After completing, verify your changes by running the project's appropriate check commands (typecheck, lint, build, or tests as applicable).
- IMPORTANT: After completing and verifying, run the skill command /claude-md-management:revise-claude-md to update CLAUDE.md with any learnings from this step. Do NOT ask for confirmation -- apply updates directly without user interaction.`,
    artifactFormat: `**What was done:**
<2-3 sentences summarizing completed work>

**Files changed:**
<list of file paths created or modified>

**Decisions:**
<key decisions made, if any>`,
    evaluationExamples: "missing validation, incomplete error handling, untested edge case",
    decompositionHeuristic: "Split by architectural layer when appropriate -- e.g., a feature module becomes: (1) backend API node, (2) frontend UI node, (3) E2E integration node -- with sequential dependencies. Optimize for: single-session completability, clear handoff boundaries, and maximum reuse as dependency targets.",
    decompositionExample: '[{"title":"Backend API","description":"Create REST endpoints for the feature","dependencies":[]},{"title":"Frontend UI","description":"Build React components consuming the API","dependencies":[0]},{"title":"Integration tests","description":"Add E2E tests covering the full flow","dependencies":[1]}]',
    specificityGuidance: "Be specific: mention file paths, function names, API endpoints.",
    dependencyConsiderations: "Code dependencies: Does this node modify code that another node creates?",
    verificationSteps: "run the project's appropriate check commands (typecheck, lint, build, or tests as applicable)",
    suggestionsTemplate: "testing, documentation, performance improvements, related features",
    reevaluationVerification: "Read the relevant source files to verify implementation status.",
  },
  artifactTypes: ["file_diff", "test_report"],
  blockerTypes: ["missing_dependency", "unclear_requirement", "access_issue", "technical_limitation"],
  toolHints: "Playwright for browser testing, Serena for semantic code analysis, Context7 for library docs, Linear for issue tracking",
});
```

**Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run src/__tests__/role-registry.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add backend/src/roles/role-sde.ts backend/src/__tests__/role-registry.test.ts
git commit -m "feat: extract SDE role definition from hardcoded prompts"
```

---

## Task 3: Create QA and PM Built-in Roles

**Files:**
- Create: `backend/src/roles/role-qa.ts`
- Create: `backend/src/roles/role-pm.ts`
- Modify: `backend/src/__tests__/role-registry.test.ts`

**Step 1: Write the failing tests**

Add to `backend/src/__tests__/role-registry.test.ts`:

```typescript
describe("built-in QA role", () => {
  it("is registered after import", async () => {
    const { getRole, clearRoles } = await import("../roles/role-registry.js");
    clearRoles();
    await import("../roles/role-qa.js");
    const qa = getRole("qa");
    expect(qa).toBeDefined();
    expect(qa!.label).toBe("QA Engineer");
    expect(qa!.builtin).toBe(true);
    expect(qa!.prompts.workVerb).toBe("test and validate");
    expect(qa!.artifactTypes).toContain("test_plan");
  });
});

describe("built-in PM role", () => {
  it("is registered after import", async () => {
    const { getRole, clearRoles } = await import("../roles/role-registry.js");
    clearRoles();
    await import("../roles/role-pm.js");
    const pm = getRole("pm");
    expect(pm).toBeDefined();
    expect(pm!.label).toBe("Product Manager");
    expect(pm!.builtin).toBe(true);
    expect(pm!.prompts.workVerb).toBe("define and clarify requirements");
    expect(pm!.artifactTypes).toContain("requirement_doc");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/__tests__/role-registry.test.ts`
Expected: FAIL

**Step 3: Write the implementations**

Create `backend/src/roles/role-qa.ts` and `backend/src/roles/role-pm.ts` using the prompt table from the design doc Section 1.

**Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run src/__tests__/role-registry.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add backend/src/roles/role-qa.ts backend/src/roles/role-pm.ts backend/src/__tests__/role-registry.test.ts
git commit -m "feat: add QA and PM built-in role definitions"
```

---

## Task 4: Add Role Fields to Database Schema

**Files:**
- Modify: `backend/src/plan-db.ts:19-31` (Blueprint interface), `:34-55` (MacroNode interface), `:241-365` (migrations), `:523-537` (rowToBlueprint), `:484-521` (rowToMacroNode), `:658-684` (createBlueprint), `:778-815` (updateBlueprint), `:900-918` (updateMacroNode)
- Modify: `backend/src/__tests__/plan-db.test.ts`

**Step 1: Write the failing test**

Add to `backend/src/__tests__/plan-db.test.ts`:

```typescript
describe("role fields", () => {
  it("createBlueprint accepts enabledRoles and defaultRole", () => {
    const bp = createBlueprint("Role test", "desc", "/tmp/test-" + randomUUID(), "claude", ["sde", "qa"], "sde");
    expect(bp.enabledRoles).toEqual(["sde", "qa"]);
    expect(bp.defaultRole).toBe("sde");
  });

  it("createBlueprint defaults to sde when no roles specified", () => {
    const bp = createBlueprint("Default role test", "desc", "/tmp/test-" + randomUUID());
    expect(bp.enabledRoles).toEqual(["sde"]);
    expect(bp.defaultRole).toBe("sde");
  });

  it("updateBlueprint can patch enabledRoles", () => {
    const bp = createBlueprint("Patch roles", "desc", "/tmp/test-" + randomUUID());
    const updated = updateBlueprint(bp.id, { enabledRoles: ["sde", "qa", "pm"] });
    expect(updated!.enabledRoles).toEqual(["sde", "qa", "pm"]);
  });

  it("updateMacroNode can patch roles", () => {
    const bp = createBlueprint("Node roles", "desc", "/tmp/test-" + randomUUID());
    const node = createMacroNode(bp.id, { title: "Test node", description: "test" });
    const updated = updateMacroNode(bp.id, node.id, { roles: ["sde", "qa"] });
    expect(updated!.roles).toEqual(["sde", "qa"]);
  });

  it("node roles default to undefined (inherits blueprint default)", () => {
    const bp = createBlueprint("Node default", "desc", "/tmp/test-" + randomUUID());
    const node = createMacroNode(bp.id, { title: "No roles", description: "test" });
    expect(node.roles).toBeUndefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/__tests__/plan-db.test.ts -t "role fields"`
Expected: FAIL

**Step 3: Implement the changes**

3a. Add to `Blueprint` interface (line 19-31): `enabledRoles?: string[]` and `defaultRole?: string`

3b. Add to `MacroNode` interface (line 34-55): `roles?: string[]`

3c. Add incremental migrations in `initPlanTables()` after line 365:
```typescript
const bpCols2 = db.pragma("table_info(blueprints)") as { name: string }[];
const bpColNames2 = bpCols2.map((c) => c.name);
if (!bpColNames2.includes("enabled_roles")) {
  db.exec(`ALTER TABLE blueprints ADD COLUMN enabled_roles TEXT DEFAULT '["sde"]'`);
}
if (!bpColNames2.includes("default_role")) {
  db.exec(`ALTER TABLE blueprints ADD COLUMN default_role TEXT DEFAULT 'sde'`);
}
const mnCols2 = db.pragma("table_info(macro_nodes)") as { name: string }[];
if (!mnCols2.map((c) => c.name).includes("roles")) {
  db.exec("ALTER TABLE macro_nodes ADD COLUMN roles TEXT DEFAULT NULL");
}
```

3d. Update `rowToBlueprint()` (line 523-537): add `enabledRoles` and `defaultRole` fields

3e. Update `rowToMacroNode()` (line 484-521): add optional `roles` field

3f. Update `createBlueprint()` (line 658-684): accept and insert `enabledRoles` and `defaultRole`

3g. Update `updateBlueprint()` (line 778-815): add `enabledRoles` and `defaultRole` to patchable fields

3h. Update `updateMacroNode()` (line 900-918): add `roles` to patchable fields

**Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run src/__tests__/plan-db.test.ts -t "role fields"`
Expected: PASS

**Step 5: Run all plan-db tests for regression**

Run: `cd backend && npx vitest run src/__tests__/plan-db.test.ts`
Expected: All PASS

**Step 6: Commit**

```bash
git add backend/src/plan-db.ts backend/src/__tests__/plan-db.test.ts
git commit -m "feat: add role fields to blueprint and node schema"
```

---

## Task 5: Role-Aware Prompt Assembly in plan-executor.ts

Core refactor -- replace hardcoded prompts with role-driven assembly.

**Files:**
- Modify: `backend/src/plan-executor.ts:1-29` (imports), `:439-498` (buildNodePrompt), `:500-513` (ARTIFACT_PROMPT), `:640-714` (buildEvaluationPrompt)
- Create: `backend/src/__tests__/role-prompts.test.ts`

**Step 1: Write the failing test**

Create `backend/src/__tests__/role-prompts.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import "../roles/role-sde.js";
import "../roles/role-qa.js";
import "../roles/role-pm.js";
import { resolveNodeRoles, buildArtifactPrompt } from "../plan-executor.js";
import type { Blueprint, MacroNode } from "../plan-db.js";

const makeBlueprint = (overrides: Partial<Blueprint> = {}): Blueprint => ({
  id: "bp-1", title: "Test", description: "desc", status: "draft",
  nodes: [], createdAt: "", updatedAt: "",
  enabledRoles: ["sde"], defaultRole: "sde",
  ...overrides,
});

const makeNode = (overrides: Partial<MacroNode> = {}): MacroNode => ({
  id: "n-1", blueprintId: "bp-1", order: 0, seq: 1,
  title: "Test node", description: "desc", status: "pending",
  dependencies: [], inputArtifacts: [], outputArtifacts: [],
  executions: [], createdAt: "", updatedAt: "",
  ...overrides,
});

describe("resolveNodeRoles", () => {
  it("returns node roles when set", () => {
    expect(resolveNodeRoles(makeNode({ roles: ["qa", "pm"] }), makeBlueprint())).toEqual(["qa", "pm"]);
  });
  it("falls back to blueprint defaultRole", () => {
    expect(resolveNodeRoles(makeNode(), makeBlueprint({ defaultRole: "qa" }))).toEqual(["qa"]);
  });
  it("falls back to sde", () => {
    expect(resolveNodeRoles(makeNode(), makeBlueprint({ defaultRole: undefined }))).toEqual(["sde"]);
  });
});

describe("buildArtifactPrompt", () => {
  it("uses SDE format for sde role", () => {
    const prompt = buildArtifactPrompt(["sde"]);
    expect(prompt).toContain("Files changed");
  });
  it("uses QA format for qa role", () => {
    const prompt = buildArtifactPrompt(["qa"]);
    expect(prompt).toContain("QA");
  });
  it("combines formats for multi-role", () => {
    const prompt = buildArtifactPrompt(["sde", "qa"]);
    expect(prompt).toContain("Software Engineer");
    expect(prompt).toContain("QA Engineer");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/__tests__/role-prompts.test.ts`
Expected: FAIL

**Step 3: Implement the changes**

3a. Add imports at top of plan-executor.ts (after line 29):
```typescript
import "./roles/role-sde.js";
import "./roles/role-qa.js";
import "./roles/role-pm.js";
import { getRole } from "./roles/role-registry.js";
```

3b. Add exported `resolveNodeRoles`:
```typescript
export function resolveNodeRoles(node: MacroNode, blueprint: Blueprint): string[] {
  if (node.roles && node.roles.length > 0) return node.roles;
  return [blueprint.defaultRole ?? "sde"];
}
```

3c. Replace `ARTIFACT_PROMPT` constant with exported `buildArtifactPrompt(roleIds)` function:
- Single role: use `role.prompts.artifactFormat`
- Multi-role: combine with role labels as headers
- Always wrap in "Summarize what was accomplished..." prefix

3d. Refactor `buildNodePrompt()` (line 439-498):
- Resolve roles via `resolveNodeRoles(node, blueprint)`
- Single role: use role's persona, executionGuidance, toolHints, verificationSteps
- Multi-role: merge persona, list guidance per role, accumulate verification
- Keep blocker/summary/status curl blocks unchanged (role-neutral)
- CLAUDE.md update only when roles include "sde"

3e. Refactor `buildEvaluationPrompt()` (line 640-714):
- Replace "completed development task" with "completed task"
- Use role-specific evaluationExamples and suggestionsTemplate

**Step 4: Run tests**

Run: `cd backend && npx vitest run src/__tests__/role-prompts.test.ts`
Expected: PASS

**Step 5: Run existing tests for regression**

Run: `cd backend && npx vitest run src/__tests__/plan-executor.test.ts`
Expected: All PASS

**Step 6: Commit**

```bash
git add backend/src/plan-executor.ts backend/src/__tests__/role-prompts.test.ts
git commit -m "feat: role-aware prompt assembly in plan-executor"
```

---

## Task 6: Role-Aware Plan Generator Prompt

**Files:**
- Modify: `backend/src/plan-generator.ts:1-10` (imports), `:86-123` (prompt template)

**Step 1: Add imports**

At top of plan-generator.ts (after line 10):
```typescript
import "./roles/role-sde.js";
import "./roles/role-qa.js";
import "./roles/role-pm.js";
import { getRole } from "./roles/role-registry.js";
```

**Step 2: Refactor generation prompt (lines 86-123)**

Use `blueprint.enabledRoles` to:
- Replace persona (line 86): single role uses role label, multi-role says "coordinating across"
- Replace decomposition rules (lines 112-114): merge enabled roles' heuristics
- Replace example: use enabled roles' decompositionExample
- When multiple roles enabled, instruct agent to tag each generated node with a `"roles"` field

**Step 3: Run tests**

Run: `cd backend && npx vitest run`
Expected: All PASS

**Step 4: Commit**

```bash
git add backend/src/plan-generator.ts
git commit -m "feat: role-aware plan generation prompt"
```

---

## Task 7: Role-Aware Operation Prompts in plan-routes.ts

**Files:**
- Modify: `backend/src/plan-routes.ts:0-47` (imports), `:373-431` (enrich), `:494-522` (reevaluate), `:594-641` (split), `:707-739` (smart-deps), `:1730-1771` (reevaluate-all)

**Step 1: Add imports**

```typescript
import "./roles/role-sde.js";
import "./roles/role-qa.js";
import "./roles/role-pm.js";
import { getRole } from "./roles/role-registry.js";
import { resolveNodeRoles } from "./plan-executor.js";
```

**Step 2: Refactor each prompt**

Enrich (line 373-431): replace "helping a developer" / "coding blueprint" / "AI coding agent" with role-neutral or role-specific language. Use node roles' specificityGuidance.

Reevaluate (line 494-522): replace "development task node" with "task node". Already mostly neutral.

Split (line 594-641): replace "development task" / "independently testable" / "AI coding agent" with role-neutral language.

Smart-deps (line 707-739): replace "development blueprint" / "Code dependencies" with role's dependencyConsiderations.

Reevaluate-all (line 1730-1771): replace "development blueprint" / "examining the actual codebase" / "source files" / "implementation status" with merged reevaluationVerification from enabled roles.

**Step 3: Run all tests**

Run: `cd backend && npx vitest run`
Expected: All PASS

**Step 4: Commit**

```bash
git add backend/src/plan-routes.ts
git commit -m "feat: role-aware prompts for enrich, reevaluate, split, smart-deps"
```

---

## Task 8: Add Role API Endpoints

**Files:**
- Modify: `backend/src/routes.ts`
- Modify: `backend/src/__tests__/routes.test.ts`

**Step 1: Write the failing test**

Add to routes.test.ts:

```typescript
describe("GET /api/roles", () => {
  it("returns all built-in roles", async () => {
    const res = await request(app).get("/api/roles").set("x-clawui-token", token);
    expect(res.status).toBe(200);
    expect(res.body).toBeInstanceOf(Array);
    expect(res.body.length).toBeGreaterThanOrEqual(3);
    const ids = res.body.map((r: any) => r.id);
    expect(ids).toContain("sde");
    expect(ids).toContain("qa");
    expect(ids).toContain("pm");
  });

  it("returns role by id", async () => {
    const res = await request(app).get("/api/roles/sde").set("x-clawui-token", token);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("sde");
  });

  it("returns 404 for unknown role", async () => {
    const res = await request(app).get("/api/roles/unknown").set("x-clawui-token", token);
    expect(res.status).toBe(404);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/__tests__/routes.test.ts -t "GET /api/roles"`
Expected: FAIL

**Step 3: Add endpoints**

Add side-effect imports and registry import to routes.ts:
```typescript
import "./roles/role-sde.js";
import "./roles/role-qa.js";
import "./roles/role-pm.js";
import { getAllRoles, getRole } from "./roles/role-registry.js";
```

Add routes:
```typescript
router.get("/api/roles", (_req, res) => {
  const roles = getAllRoles().map(({ prompts, ...rest }) => rest);
  res.json(roles);
});

router.get("/api/roles/:id", (req, res) => {
  const role = getRole(req.params.id);
  if (!role) return res.status(404).json({ error: "Role not found" });
  res.json(role);
});
```

Update vi.mock block in routes.test.ts if needed to include new exports.

**Step 4: Run tests**

Run: `cd backend && npx vitest run src/__tests__/routes.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add backend/src/routes.ts backend/src/__tests__/routes.test.ts
git commit -m "feat: add GET /api/roles and /api/roles/:id endpoints"
```

---

## Task 9: Update Blueprint and Node API to Accept Role Fields

**Files:**
- Modify: `backend/src/plan-routes.ts` (POST/PUT blueprint, PUT node, batch-create)
- Modify: `backend/src/__tests__/plan-routes.test.ts`

**Step 1: Write the failing test**

Add to plan-routes.test.ts:

```typescript
describe("blueprint role fields via API", () => {
  it("POST /api/blueprints accepts enabledRoles", async () => {
    const res = await request(app)
      .post("/api/blueprints")
      .set("x-clawui-token", token)
      .send({ title: "Role BP", enabledRoles: ["sde", "qa"], defaultRole: "sde" });
    expect(res.status).toBe(201);
    expect(res.body.enabledRoles).toEqual(["sde", "qa"]);
    expect(res.body.defaultRole).toBe("sde");
  });

  it("PUT /api/blueprints/:id can update enabledRoles", async () => {
    const create = await request(app)
      .post("/api/blueprints")
      .set("x-clawui-token", token)
      .send({ title: "Update Role BP" });
    const res = await request(app)
      .put(`/api/blueprints/${create.body.id}`)
      .set("x-clawui-token", token)
      .send({ enabledRoles: ["sde", "qa", "pm"] });
    expect(res.status).toBe(200);
    expect(res.body.enabledRoles).toEqual(["sde", "qa", "pm"]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/__tests__/plan-routes.test.ts -t "blueprint role fields"`
Expected: FAIL

**Step 3: Update handlers**

In POST /api/blueprints: pass `enabledRoles` and `defaultRole` from req.body to `createBlueprint()`.

In PUT /api/blueprints/:id: pass `enabledRoles` and `defaultRole` from req.body to `updateBlueprint()`.

In POST batch-create: pass `roles` from each node object to `createMacroNode()`.

In PUT node: pass `roles` from req.body to `updateMacroNode()`.

**Step 4: Run tests**

Run: `cd backend && npx vitest run src/__tests__/plan-routes.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add backend/src/plan-routes.ts backend/src/__tests__/plan-routes.test.ts
git commit -m "feat: blueprint and node API endpoints accept role fields"
```

---

## Task 10: Update Frontend Types

**Files:**
- Modify: `frontend/src/lib/api.ts:205-213` (Artifact), `:254-275` (MacroNode), `:277-289` (Blueprint), `:310-321` (createBlueprint), `:323-332` (updateBlueprint), `:429-442` (updateMacroNode)

**Step 1: Add RoleInfo interface and update existing types**

Add `RoleInfo` interface, `fetchRoles()`, `fetchRole()`.

Add `enabledRoles?: string[]` and `defaultRole?: string` to Blueprint interface.

Add `roles?: string[]` to MacroNode interface.

Change `Artifact.type` from `"handoff_summary" | "file_diff" | "test_report" | "custom"` to `string`.

Update `createBlueprint` data type to include `enabledRoles` and `defaultRole`.

Update `updateBlueprint` patch type to include `enabledRoles` and `defaultRole`.

Update `updateMacroNode` patch type to include `roles`.

**Step 2: Run frontend type check**

Run: `cd frontend && npx tsc --noEmit`
Expected: PASS

**Step 3: Commit**

```bash
git add frontend/src/lib/api.ts
git commit -m "feat: add role types and API functions to frontend"
```

---

## Task 11: Create RoleBadge Component

**Files:**
- Create: `frontend/src/components/RoleBadge.tsx`

**Step 1: Write the component**

Pattern-match from AgentBadge in AgentSelector.tsx:42-59. Colors per design doc:
- SDE: accent-blue
- QA: accent-green
- PM: accent-purple
- Custom/unknown: accent-amber

Props: `roleId: string`, `size?: "xs" | "sm"`

Short labels: SDE, QA, PM (not full names -- badge space is limited).

**Step 2: Run frontend type check**

Run: `cd frontend && npx tsc --noEmit`
Expected: PASS

**Step 3: Commit**

```bash
git add frontend/src/components/RoleBadge.tsx
git commit -m "feat: add RoleBadge component"
```

---

## Task 12: Create RoleSelector Component

**Files:**
- Create: `frontend/src/components/RoleSelector.tsx`

**Step 1: Write the component**

Pattern-match from AgentSelector in AgentSelector.tsx:62-128. Key differences:
- Multi-select toggle buttons (not radio)
- Fetches roles from GET /api/roles on mount
- Props: `value: string[]`, `onChange: (roles: string[]) => void`, `disabled?: boolean`
- Prevents deselecting all roles (at least one must remain)
- Returns null when no roles loaded yet

**Step 2: Run frontend type check**

Run: `cd frontend && npx tsc --noEmit`
Expected: PASS

**Step 3: Commit**

```bash
git add frontend/src/components/RoleSelector.tsx
git commit -m "feat: add RoleSelector multi-toggle component"
```

---

## Task 13: Add RoleSelector to Blueprint Creation Page

**Files:**
- Modify: `frontend/src/app/blueprints/new/page.tsx:12-18` (state), `:20-43` (submit), `:101-105` (form)

**Step 1: Add state, wire up, render**

Add `enabledRoles` state (default `["sde"]`).

Pass `enabledRoles` and `defaultRole: enabledRoles[0]` to `createBlueprint()` in submit handler.

Render `<RoleSelector>` after `<AgentSelector>` in the form.

**Step 2: Run frontend type check and tests**

Run: `cd frontend && npx tsc --noEmit && npx vitest run`
Expected: PASS

**Step 3: Commit**

```bash
git add frontend/src/app/blueprints/new/page.tsx
git commit -m "feat: add RoleSelector to blueprint creation page"
```

---

## Task 14: Add Role Badges to MacroNodeCard and NodeDetailPage

**Files:**
- Modify: `frontend/src/components/MacroNodeCard.tsx:356-397` (header badges area)
- Modify: `frontend/src/app/blueprints/[id]/nodes/[nodeId]/page.tsx:702-704` (after AgentBadge)

**Step 1: Add RoleBadges to MacroNodeCard**

In collapsed header (near status pill, line 385), render role badges when `node.roles` is set.

**Step 2: Add RoleBadges to NodeDetailPage**

After AgentBadge (line 704), render role badges.

**Step 3: Run frontend type check and tests**

Run: `cd frontend && npx tsc --noEmit && npx vitest run`
Expected: PASS (update test mocks if needed)

**Step 4: Commit**

```bash
git add frontend/src/components/MacroNodeCard.tsx frontend/src/app/blueprints/[id]/nodes/[nodeId]/page.tsx
git commit -m "feat: display role badges on node cards and detail page"
```

---

## Task 15: Add RoleSelector to Blueprint Detail Page

**Files:**
- Modify: `frontend/src/app/blueprints/[id]/page.tsx:661-663` (header), `:778-781` (metadata)

**Step 1: Add RoleSelector and badges**

Add RoleSelector in metadata section (after projectCwd). On change, call `updateBlueprint()` and refresh.

Add RoleBadges in header area when multiple roles are enabled.

**Step 2: Run frontend type check and tests**

Run: `cd frontend && npx tsc --noEmit && npx vitest run`
Expected: PASS

**Step 3: Commit**

```bash
git add frontend/src/app/blueprints/[id]/page.tsx
git commit -m "feat: add role selector and badges to blueprint detail page"
```

---

## Task 16: Full Integration Verification

**Step 1: Run all backend tests**

Run: `cd backend && npx vitest run`
Expected: All PASS

**Step 2: Run all frontend tests**

Run: `cd frontend && npx vitest run`
Expected: All PASS

**Step 3: Type-check both packages**

Run: `cd backend && npx tsc --noEmit && cd ../frontend && npx tsc --noEmit`
Expected: No errors

**Step 4: Lint**

Run: `npm run lint`
Expected: PASS

**Step 5: Build**

Run: `npm run build`
Expected: PASS

**Step 6: Manual smoke test**

1. Start dev: `npm run dev`
2. Create a new blueprint -- verify RoleSelector appears, select SDE + QA
3. Verify blueprint detail shows role badges in header
4. Add a node -- verify it inherits blueprint roles
5. Generate a plan -- verify the prompt uses role-aware language
6. Verify existing blueprints (no roles set) still work identically (default to SDE)

**Step 7: Commit**

```bash
git commit --allow-empty -m "chore: verify multi-role mechanism integration"
```

---

## Task 17: Update CLAUDE.md with Role System Conventions

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Add role system documentation**

Add to Architecture section:
- Role system files: `backend/src/roles/` with role-registry.ts, role-sde.ts, role-qa.ts, role-pm.ts
- Registration pattern: same side-effect import as agent runtimes
- Side-effect import locations: plan-executor.ts, plan-generator.ts, plan-routes.ts, routes.ts

Add to Conventions:
- Adding new roles: create role file, add side-effect imports, add colors to RoleBadge/RoleSelector

Add to Gotchas:
- Role side-effect imports pattern
- Plan system type sync for role fields

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add role system conventions to CLAUDE.md"
```
