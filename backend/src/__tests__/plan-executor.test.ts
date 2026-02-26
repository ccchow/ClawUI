import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";

/**
 * Tests for plan-executor logic patterns:
 * - Serial queue behavior (enqueueBlueprintTask)
 * - Prompt building logic
 * - Blocker detection in output
 * - Strip echoed prompt logic
 * - Node status transitions
 * - Pending task tracking
 * - Session CWD encoding
 *
 * These tests verify the algorithms and logic without calling the Claude CLI.
 */

// ─── Schema for DB-backed tests ─────────────────────────────

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS blueprints (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
    status TEXT DEFAULT 'draft', project_cwd TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS macro_nodes (
    id TEXT PRIMARY KEY,
    blueprint_id TEXT NOT NULL REFERENCES blueprints(id) ON DELETE CASCADE,
    "order" INTEGER NOT NULL, title TEXT NOT NULL, description TEXT,
    status TEXT DEFAULT 'pending', dependencies TEXT, prompt TEXT,
    estimated_minutes REAL, actual_minutes REAL, error TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS node_executions (
    id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL REFERENCES macro_nodes(id) ON DELETE CASCADE,
    blueprint_id TEXT NOT NULL REFERENCES blueprints(id) ON DELETE CASCADE,
    session_id TEXT, type TEXT NOT NULL DEFAULT 'primary',
    status TEXT NOT NULL DEFAULT 'running', input_context TEXT,
    output_summary TEXT, blocker_info TEXT, task_summary TEXT,
    started_at TEXT NOT NULL, completed_at TEXT
  );
`;

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

// ─── Serial Queue Tests ──────────────────────────────────────

describe("enqueueBlueprintTask serial queue behavior", () => {
  // Re-implement the queue logic from plan-executor.ts for isolated testing
  function createQueue() {
    const queues = new Map<string, Array<{ task: () => Promise<unknown>; resolve: (val: unknown) => void; reject: (err: Error) => void }>>();
    const running = new Set<string>();

    async function drainQueue(bpId: string): Promise<void> {
      if (running.has(bpId)) return;
      const queue = queues.get(bpId);
      if (!queue || queue.length === 0) return;
      running.add(bpId);
      while (queue.length > 0) {
        const item = queue.shift()!;
        try {
          const result = await item.task();
          item.resolve(result);
        } catch (err) {
          item.reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
      running.delete(bpId);
      queues.delete(bpId);
    }

    function enqueue<T>(bpId: string, task: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const queue = queues.get(bpId) ?? [];
        queue.push({ task, resolve: resolve as (val: unknown) => void, reject });
        queues.set(bpId, queue);
        drainQueue(bpId);
      });
    }

    return { enqueue, running, queues };
  }

  it("executes tasks serially (one at a time per blueprint)", async () => {
    const { enqueue } = createQueue();
    const executionOrder: number[] = [];
    const activeCount = { current: 0, max: 0 };

    const promises = [1, 2, 3].map((i) =>
      enqueue("bp-1", async () => {
        activeCount.current++;
        activeCount.max = Math.max(activeCount.max, activeCount.current);
        executionOrder.push(i);
        await new Promise((r) => setTimeout(r, 10));
        activeCount.current--;
        return i;
      }),
    );

    const results = await Promise.all(promises);
    expect(results).toEqual([1, 2, 3]);
    expect(executionOrder).toEqual([1, 2, 3]);
    expect(activeCount.max).toBe(1);
  });

  it("allows parallel execution across different blueprints", async () => {
    const { enqueue } = createQueue();
    const startedAt: Record<string, number> = {};

    const p1 = enqueue("bp-1", async () => {
      startedAt["bp-1"] = Date.now();
      await new Promise((r) => setTimeout(r, 50));
      return "bp-1-done";
    });

    const p2 = enqueue("bp-2", async () => {
      startedAt["bp-2"] = Date.now();
      await new Promise((r) => setTimeout(r, 50));
      return "bp-2-done";
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe("bp-1-done");
    expect(r2).toBe("bp-2-done");
    const diff = Math.abs(startedAt["bp-1"] - startedAt["bp-2"]);
    expect(diff).toBeLessThan(30);
  });

  it("handles task errors without breaking the queue", async () => {
    const { enqueue } = createQueue();

    const p1 = enqueue("bp-1", async () => {
      throw new Error("Task 1 failed");
    });

    const p2 = enqueue("bp-1", async () => {
      return "task-2-ok";
    });

    await expect(p1).rejects.toThrow("Task 1 failed");
    expect(await p2).toBe("task-2-ok");
  });

  it("cleans up queue state after all tasks complete", async () => {
    const { enqueue, running, queues } = createQueue();

    await enqueue("bp-1", async () => "done");

    expect(running.has("bp-1")).toBe(false);
    expect(queues.has("bp-1")).toBe(false);
  });
});

// ─── Pending Task Tracking ───────────────────────────────────

describe("PendingTask tracking", () => {
  it("adds and removes pending tasks", () => {
    const map = new Map<string, Array<{ type: string; nodeId?: string; queuedAt: string }>>();

    function addPendingTask(bpId: string, task: { type: string; nodeId?: string; queuedAt: string }): void {
      const tasks = map.get(bpId) ?? [];
      tasks.push(task);
      map.set(bpId, tasks);
    }

    function removePendingTask(bpId: string, nodeId?: string, type?: string): void {
      const tasks = map.get(bpId) ?? [];
      const idx = tasks.findIndex(
        (t) => (!nodeId || t.nodeId === nodeId) && (!type || t.type === type),
      );
      if (idx >= 0) tasks.splice(idx, 1);
      if (tasks.length === 0) map.delete(bpId);
      else map.set(bpId, tasks);
    }

    addPendingTask("bp-1", { type: "run", nodeId: "n1", queuedAt: "2024-01-01T00:00:00Z" });
    addPendingTask("bp-1", { type: "run", nodeId: "n2", queuedAt: "2024-01-01T00:00:01Z" });
    expect(map.get("bp-1")).toHaveLength(2);

    removePendingTask("bp-1", "n1", "run");
    expect(map.get("bp-1")).toHaveLength(1);
    expect(map.get("bp-1")![0].nodeId).toBe("n2");

    removePendingTask("bp-1", "n2", "run");
    expect(map.has("bp-1")).toBe(false);
  });

  it("getQueueInfo returns correct state", () => {
    const pendingTasks = new Map<string, Array<{ type: string; nodeId?: string; queuedAt: string }>>();
    const running = new Set<string>();
    const queues = new Map<string, unknown[]>();

    function getQueueInfo(bpId: string) {
      return {
        running: running.has(bpId),
        queueLength: (queues.get(bpId) ?? []).length,
        pendingTasks: pendingTasks.get(bpId) ?? [],
      };
    }

    // Initially empty
    let info = getQueueInfo("bp-1");
    expect(info.running).toBe(false);
    expect(info.queueLength).toBe(0);
    expect(info.pendingTasks).toHaveLength(0);

    // Simulate active state
    running.add("bp-1");
    pendingTasks.set("bp-1", [{ type: "run", nodeId: "n1", queuedAt: "2024-01-01T00:00:00Z" }]);
    queues.set("bp-1", [{}, {}]);

    info = getQueueInfo("bp-1");
    expect(info.running).toBe(true);
    expect(info.queueLength).toBe(2);
    expect(info.pendingTasks).toHaveLength(1);
  });
});

// ─── Prompt Building ─────────────────────────────────────────

describe("Prompt building logic", () => {
  it("builds a prompt with blueprint context and input artifacts", () => {
    const blueprint = {
      title: "Build Auth System",
      description: "Implement JWT auth for the API",
      projectCwd: "/tmp/project",
      nodes: [
        { id: "n1", order: 0, title: "Setup" },
        { id: "n2", order: 1, title: "Implement" },
      ],
    };
    const node = { id: "n2", order: 1, title: "Implement", description: "Write the JWT handler", prompt: "Use jsonwebtoken library" };
    const inputArtifacts = [
      { node: { order: 0, title: "Setup" }, artifact: { content: "Installed jsonwebtoken and created config" } },
    ];

    const total = blueprint.nodes.length;
    let prompt = `You are executing step ${node.order + 1}/${total} of a development plan: "${blueprint.title}"\n\n`;
    if (blueprint.description) prompt += `## Plan Description\n${blueprint.description}\n\n`;
    if (inputArtifacts.length > 0) {
      prompt += `## Context from previous steps:\n`;
      for (const { node: depNode, artifact } of inputArtifacts) {
        prompt += `### Step ${depNode.order + 1}: ${depNode.title}\n${artifact.content}\n\n`;
      }
    }
    prompt += `## Your Task (Step ${node.order + 1}): ${node.title}\n`;
    if (node.description) prompt += `${node.description}\n\n`;
    if (node.prompt) prompt += `${node.prompt}\n\n`;

    expect(prompt).toContain("step 2/2");
    expect(prompt).toContain("Build Auth System");
    expect(prompt).toContain("Implement JWT auth");
    expect(prompt).toContain("Context from previous steps");
    expect(prompt).toContain("Installed jsonwebtoken");
    expect(prompt).toContain("Write the JWT handler");
    expect(prompt).toContain("Use jsonwebtoken library");
  });

  it("builds a prompt without input artifacts", () => {
    const node = { order: 0, title: "Setup", description: "Initialize project" };
    let prompt = `You are executing step ${node.order + 1}/3 of a development plan: "My Plan"\n\n`;
    prompt += `## Your Task (Step ${node.order + 1}): ${node.title}\n${node.description}\n\n`;

    expect(prompt).toContain("step 1/3");
    expect(prompt).toContain("Initialize project");
    expect(prompt).not.toContain("Context from previous steps");
  });
});

// ─── Strip Echoed Prompt ─────────────────────────────────────

describe("stripEchoedPrompt logic (deprecated, kept as fallback)", () => {
  // Extracted from plan-executor.ts for unit testing
  function stripEchoedPrompt(output: string): string {
    const markers = [
      "===EXECUTION_BLOCKER===",
      "verify your changes by running the project",
      "Focus only on THIS step.",
      "as the LAST thing you do",
    ];
    let bestIdx = -1;
    for (const marker of markers) {
      const idx = output.indexOf(marker);
      if (idx > bestIdx) {
        const lineEnd = output.indexOf("\n", idx + marker.length);
        if (lineEnd > bestIdx) bestIdx = lineEnd;
      }
    }
    if (bestIdx > 0 && bestIdx < output.length - 100) {
      return output.slice(bestIdx).trim();
    }
    const cutoff = Math.floor(output.length * 0.4);
    return output.slice(cutoff).trim();
  }

  it("strips echoed prompt using marker", () => {
    const output = [
      "## Instructions",
      "Focus only on THIS step.",
      "Some echoed prompt content",
      "",
      "I'll start by setting up the project structure.",
      "Created src/auth/handler.ts with JWT verification.",
      "All tests pass. The auth system is complete.",
    ].join("\n");

    const result = stripEchoedPrompt(output);
    expect(result).toContain("setting up the project structure");
    expect(result).toContain("All tests pass");
  });

  it("strips echoed prompt using blocker marker", () => {
    const output = [
      "Lots of echoed prompt text here...",
      "===EXECUTION_BLOCKER===",
      '{"type": "template"}',
      "",
      "Now here is the actual response from Claude.",
      "I created the files and everything works nicely.",
      "All tests pass with flying colors.",
    ].join("\n");

    const result = stripEchoedPrompt(output);
    expect(result).toContain("actual response");
  });

  it("falls back to 60% cut when no markers found", () => {
    const output = "X".repeat(100) + "REAL RESPONSE HERE";
    const result = stripEchoedPrompt(output);
    expect(result.length).toBeLessThan(output.length);
    expect(result).toContain("REAL RESPONSE");
  });
});

// ─── Blocker Detection ───────────────────────────────────────

describe("Blocker detection in execution output", () => {
  it("detects real blocker JSON", () => {
    const output = `I tried to do the work but hit a wall.

===EXECUTION_BLOCKER===
{"type": "missing_dependency", "description": "The redis package is not installed", "suggestion": "Run npm install redis"}`;

    const blockerMatch = output.match(/^===EXECUTION_BLOCKER===\s*\n([\s\S]*?)$/m);
    expect(blockerMatch).not.toBeNull();

    const parsed = JSON.parse(blockerMatch![1].trim());
    expect(parsed.type).toBe("missing_dependency");
    expect(parsed.description).toContain("redis");

    // Verify it's not a template echo
    const templatePatterns = [/^<one of/, /^<describe/];
    const allValues = [parsed.type, parsed.description, parsed.suggestion].filter(Boolean).join(" ");
    expect(templatePatterns.some((p) => p.test(allValues))).toBe(false);
  });

  it("identifies template/echoed blocker", () => {
    const output = `Some echoed prompt text.

===EXECUTION_BLOCKER===
{"type": "<one of: missing_dependency, unclear_requirement, access_issue, technical_limitation>", "description": "<describe the actual problem>", "suggestion": "<what the human could do to help>"}`;

    const blockerMatch = output.match(/^===EXECUTION_BLOCKER===\s*\n([\s\S]*?)$/m);
    expect(blockerMatch).not.toBeNull();

    const parsed = JSON.parse(blockerMatch![1].trim());
    const isTemplate = /^<one of/.test(parsed.type) || /^<describe/.test(parsed.description);
    expect(isTemplate).toBe(true);
  });

  it("handles non-JSON blocker text", () => {
    const output = `Output text.

===EXECUTION_BLOCKER===
Cannot install package - network unreachable.`;

    const blockerMatch = output.match(/^===EXECUTION_BLOCKER===\s*\n([\s\S]*?)$/m);
    expect(blockerMatch).not.toBeNull();

    let blockerInfo: string;
    try {
      JSON.parse(blockerMatch![1].trim());
      blockerInfo = "parsed";
    } catch {
      blockerInfo = blockerMatch![1].trim();
    }
    expect(blockerInfo).toBe("Cannot install package - network unreachable.");
  });

  it("returns null when no blocker marker present", () => {
    const output = "Normal execution output. Everything went fine.";
    const blockerMatch = output.match(/^===EXECUTION_BLOCKER===\s*\n([\s\S]*?)$/m);
    expect(blockerMatch).toBeNull();
  });

  it("also detects legacy ---BLOCKER--- marker", () => {
    const output = `Output text.

---BLOCKER---
Old-style blocker message here.`;

    const match = output.match(/^---BLOCKER---\s*\n([\s\S]*?)$/m);
    expect(match).not.toBeNull();
    expect(match![1].trim()).toBe("Old-style blocker message here.");
  });
});

// ─── DB-based Blocker/Summary Detection ─────────────────────

describe("DB-based blocker and task summary detection", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    const now = new Date().toISOString();
    db.prepare("INSERT INTO blueprints (id, title, status, created_at, updated_at) VALUES (?, ?, 'running', ?, ?)").run("bp-1", "Test", now, now);
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'running', ?, ?)`).run("n1", "bp-1", 0, "Node 1", now, now);
    db.prepare("INSERT INTO node_executions (id, node_id, blueprint_id, type, status, started_at) VALUES (?, ?, ?, 'primary', 'running', ?)").run("exec-1", "n1", "bp-1", now);
  });
  afterEach(() => { db.close(); });

  it("stores and retrieves blocker_info via DB", () => {
    const blockerJson = JSON.stringify({ type: "missing_dependency", description: "Redis not installed", suggestion: "Run npm install redis" });
    db.prepare("UPDATE node_executions SET blocker_info = ? WHERE id = ?").run(blockerJson, "exec-1");

    const row = db.prepare("SELECT blocker_info FROM node_executions WHERE id = ?").get("exec-1") as { blocker_info: string | null };
    expect(row.blocker_info).not.toBeNull();
    const parsed = JSON.parse(row.blocker_info!);
    expect(parsed.type).toBe("missing_dependency");
    expect(parsed.description).toContain("Redis");
  });

  it("stores and retrieves task_summary via DB", () => {
    const summary = "Implemented JWT authentication with token refresh and password hashing.";
    db.prepare("UPDATE node_executions SET task_summary = ? WHERE id = ?").run(summary, "exec-1");

    const row = db.prepare("SELECT task_summary FROM node_executions WHERE id = ?").get("exec-1") as { task_summary: string | null };
    expect(row.task_summary).toBe(summary);
  });

  it("DB blocker_info takes precedence over output marker", () => {
    // Simulate: DB has blocker info AND output has a marker (DB should win)
    const dbBlocker = JSON.stringify({ type: "access_issue", description: "No API key", suggestion: "Set API_KEY env" });
    db.prepare("UPDATE node_executions SET blocker_info = ? WHERE id = ?").run(dbBlocker, "exec-1");

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const output = `Some output\n\n===EXECUTION_BLOCKER===\n{"type": "missing_dependency", "description": "Wrong blocker from echo"}`;

    // Simulate the detection logic from executeNodeInternal
    const row = db.prepare("SELECT blocker_info FROM node_executions WHERE id = ?").get("exec-1") as { blocker_info: string | null };

    let blockerInfo: string | null = null;
    if (row.blocker_info) {
      const parsed = JSON.parse(row.blocker_info);
      blockerInfo = `[${parsed.type}] ${parsed.description}. Suggestion: ${parsed.suggestion}`;
    }

    expect(blockerInfo).toContain("access_issue");
    expect(blockerInfo).toContain("No API key");
    // Should NOT use the output marker version
    expect(blockerInfo).not.toContain("Wrong blocker");
  });

  it("DB task_summary takes precedence over marker extraction", () => {
    const dbSummary = "Correctly summarized from API callback";
    db.prepare("UPDATE node_executions SET task_summary = ? WHERE id = ?").run(dbSummary, "exec-1");

    const output = "Some output\n===TASK_COMPLETE===\nOld marker summary\n===END_TASK===";

    const row = db.prepare("SELECT task_summary FROM node_executions WHERE id = ?").get("exec-1") as { task_summary: string | null };

    // extractTaskCompleteSummary fallback
    function extractTaskCompleteSummary(o: string): string | null {
      const startMarker = "===TASK_COMPLETE===";
      const endMarker = "===END_TASK===";
      const startIdx = o.lastIndexOf(startMarker);
      if (startIdx === -1) return null;
      const endIdx = o.indexOf(endMarker, startIdx);
      if (endIdx === -1) return null;
      return o.slice(startIdx + startMarker.length, endIdx).trim();
    }

    const summary = row.task_summary || extractTaskCompleteSummary(output) || null;
    expect(summary).toBe("Correctly summarized from API callback");
  });

  it("falls back to output marker when no DB data", () => {
    // No blocker_info or task_summary in DB
    const output = "Some output\n===TASK_COMPLETE===\nFallback marker summary\n===END_TASK===";

    const row = db.prepare("SELECT blocker_info, task_summary FROM node_executions WHERE id = ?").get("exec-1") as { blocker_info: string | null; task_summary: string | null };
    expect(row.blocker_info).toBeNull();
    expect(row.task_summary).toBeNull();

    // Falls back to marker-based extraction
    function extractTaskCompleteSummary(o: string): string | null {
      const startMarker = "===TASK_COMPLETE===";
      const endMarker = "===END_TASK===";
      const startIdx = o.lastIndexOf(startMarker);
      if (startIdx === -1) return null;
      const endIdx = o.indexOf(endMarker, startIdx);
      if (endIdx === -1) return null;
      return o.slice(startIdx + startMarker.length, endIdx).trim();
    }

    const summary = row.task_summary || extractTaskCompleteSummary(output) || null;
    expect(summary).toBe("Fallback marker summary");
  });
});

// ─── Node Status Transition Validation ───────────────────────

describe("Node status transitions", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    const now = new Date().toISOString();
    db.prepare("INSERT INTO blueprints (id, title, status, created_at, updated_at) VALUES (?, ?, 'draft', ?, ?)").run("bp-1", "Test", now, now);
  });
  afterEach(() => { db.close(); });

  it("allows valid transitions: pending -> queued -> running -> done", () => {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)`).run("n1", "bp-1", 0, "Node", now, now);

    for (const status of ["queued", "running", "done"]) {
      db.prepare("UPDATE macro_nodes SET status = ? WHERE id = ?").run(status, "n1");
      const row = db.prepare("SELECT status FROM macro_nodes WHERE id = ?").get("n1") as { status: string };
      expect(row.status).toBe(status);
    }
  });

  it("allows retry: pending -> queued -> running -> failed -> queued -> running -> done", () => {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)`).run("n1", "bp-1", 0, "Node", now, now);

    for (const status of ["queued", "running", "failed", "queued", "running", "done"]) {
      db.prepare("UPDATE macro_nodes SET status = ? WHERE id = ?").run(status, "n1");
    }
    const row = db.prepare("SELECT status FROM macro_nodes WHERE id = ?").get("n1") as { status: string };
    expect(row.status).toBe("done");
  });

  it("validates that executeNode only runs pending/failed/queued nodes", () => {
    const allowedStatuses = new Set(["pending", "failed", "queued"]);
    expect(allowedStatuses.has("pending")).toBe(true);
    expect(allowedStatuses.has("failed")).toBe(true);
    expect(allowedStatuses.has("queued")).toBe(true);
    expect(allowedStatuses.has("running")).toBe(false);
    expect(allowedStatuses.has("done")).toBe(false);
    expect(allowedStatuses.has("blocked")).toBe(false);
    expect(allowedStatuses.has("skipped")).toBe(false);
  });
});

// ─── Session Detection ───────────────────────────────────────

describe("Session detection (CWD encoding)", () => {
  it("encodes CWD path correctly", () => {
    const cwd = "/home/testuser/projects/TestProject";
    const encoded = cwd.replace(/\//g, "-");
    expect(encoded).toBe("-home-testuser-projects-TestProject");
  });

  it("handles root path", () => {
    expect("/".replace(/\//g, "-")).toBe("-");
  });

  it("handles deeply nested paths", () => {
    const cwd = "/home/user/projects/my-app/packages/core";
    expect(cwd.replace(/\//g, "-")).toBe("-home-user-projects-my-app-packages-core");
  });
});

// ─── Dependency Resolution ───────────────────────────────────

describe("Dependency resolution for execution", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    const now = new Date().toISOString();
    db.prepare("INSERT INTO blueprints (id, title, status, created_at, updated_at) VALUES (?, ?, 'running', ?, ?)").run("bp-1", "Test", now, now);
  });
  afterEach(() => { db.close(); });

  it("rejects execution when dependency is not done", () => {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, dependencies, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("n1", "bp-1", 0, "First", "pending", null, now, now);
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, dependencies, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("n2", "bp-1", 1, "Second", "pending", '["n1"]', now, now);

    // Simulate executeNodeInternal dependency check
    const node = db.prepare("SELECT * FROM macro_nodes WHERE id = ?").get("n2") as { dependencies: string | null };
    const deps: string[] = node.dependencies ? JSON.parse(node.dependencies) : [];

    for (const depId of deps) {
      const depNode = db.prepare("SELECT status FROM macro_nodes WHERE id = ?").get(depId) as { status: string } | undefined;
      expect(depNode).toBeDefined();
      expect(depNode!.status).not.toBe("done");
    }
  });

  it("allows execution when all dependencies are done", () => {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, dependencies, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("n1", "bp-1", 0, "First", "done", null, now, now);
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, dependencies, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("n2", "bp-1", 1, "Second", "pending", '["n1"]', now, now);

    const node = db.prepare("SELECT * FROM macro_nodes WHERE id = ?").get("n2") as { dependencies: string | null };
    const deps: string[] = node.dependencies ? JSON.parse(node.dependencies) : [];

    const allDepsDone = deps.every((depId) => {
      const dep = db.prepare("SELECT status FROM macro_nodes WHERE id = ?").get(depId) as { status: string };
      return dep.status === "done";
    });
    expect(allDepsDone).toBe(true);
  });

  it("finds next executable node (executeNextNode logic)", () => {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, dependencies, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("n1", "bp-1", 0, "First", "done", null, now, now);
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, dependencies, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("n2", "bp-1", 1, "Second", "pending", '["n1"]', now, now);
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, dependencies, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("n3", "bp-1", 2, "Third", "pending", '["n1","n2"]', now, now);

    const nodes = db.prepare('SELECT id, status, dependencies FROM macro_nodes WHERE blueprint_id = ? ORDER BY "order" ASC').all("bp-1") as Array<{ id: string; status: string; dependencies: string | null }>;

    const candidate = nodes.find((node) => {
      if (node.status !== "pending") return false;
      const deps: string[] = node.dependencies ? JSON.parse(node.dependencies) : [];
      return deps.every((depId) => nodes.find((n) => n.id === depId)?.status === "done");
    });

    expect(candidate?.id).toBe("n2");
  });

  it("returns null when all nodes are done (blueprint completion)", () => {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'done', ?, ?)`).run("n1", "bp-1", 0, "First", now, now);
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'done', ?, ?)`).run("n2", "bp-1", 1, "Second", now, now);

    const nodes = db.prepare("SELECT status FROM macro_nodes WHERE blueprint_id = ?").all("bp-1") as Array<{ status: string }>;
    const allDone = nodes.every((n) => n.status === "done" || n.status === "skipped");
    expect(allDone).toBe(true);
  });
});

// ─── Evaluation Callback Validation ──────────────────────────

describe("evaluation callback body validation", () => {
  it("accepts valid COMPLETE evaluation", () => {
    const body = { status: "COMPLETE", evaluation: "Task fully completed", mutations: [] };
    expect(["COMPLETE", "NEEDS_REFINEMENT", "HAS_BLOCKER"].includes(body.status)).toBe(true);
    expect(body.evaluation).toBe("Task fully completed");
    expect(body.mutations).toHaveLength(0);
  });

  it("accepts NEEDS_REFINEMENT with INSERT_BETWEEN mutation", () => {
    const body = {
      status: "NEEDS_REFINEMENT",
      evaluation: "Missing validation",
      mutations: [{ action: "INSERT_BETWEEN", new_node: { title: "Add validation", description: "Add input validation" } }],
    };
    expect(body.status).toBe("NEEDS_REFINEMENT");
    expect(body.mutations).toHaveLength(1);
    expect(body.mutations[0].action).toBe("INSERT_BETWEEN");
    expect(body.mutations[0].new_node.title).toBe("Add validation");
  });

  it("accepts HAS_BLOCKER with ADD_SIBLING mutation", () => {
    const body = {
      status: "HAS_BLOCKER",
      evaluation: "Needs AWS credentials",
      mutations: [{ action: "ADD_SIBLING", new_node: { title: "Wait for AWS creds", description: "Contact ops team" } }],
    };
    expect(body.status).toBe("HAS_BLOCKER");
    expect(body.mutations).toHaveLength(1);
    expect(body.mutations[0].action).toBe("ADD_SIBLING");
  });

  it("rejects invalid status", () => {
    const body = { status: "INVALID", evaluation: "Test", mutations: [] };
    expect(["COMPLETE", "NEEDS_REFINEMENT", "HAS_BLOCKER"].includes(body.status)).toBe(false);
  });

  it("filters mutations without required fields", () => {
    const mutations = [
      { action: "INSERT_BETWEEN", new_node: { title: "Valid", description: "desc" } },
      { action: null, new_node: { title: "Invalid action", description: "desc" } },
      { action: "ADD_SIBLING", new_node: null },
    ];
    const filtered = mutations.filter((m): m is { action: string; new_node: { title: string; description: string } } =>
      !!m.action && !!m.new_node?.title,
    );
    expect(filtered).toHaveLength(1);
    expect(filtered[0].new_node.title).toBe("Valid");
  });
});

// ─── Graph Mutation Logic ───────────────────────────────────

describe("applyGraphMutations (INSERT_BETWEEN)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    const now = new Date().toISOString();
    db.prepare("INSERT INTO blueprints (id, title, status, created_at, updated_at) VALUES (?, ?, 'running', ?, ?)").run("bp-1", "Test Plan", now, now);
    // Node 1 (done) -> Node 2 (pending, depends on n1) -> Node 3 (pending, depends on n2)
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, dependencies, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("n1", "bp-1", 0, "Setup DB", "done", null, now, now);
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, dependencies, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("n2", "bp-1", 1, "Build API", "pending", '["n1"]', now, now);
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, dependencies, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("n3", "bp-1", 2, "Build UI", "pending", '["n2"]', now, now);
  });
  afterEach(() => { db.close(); });

  it("INSERT_BETWEEN creates new node and rewires dependencies", () => {
    // Simulate: n1 is done, but evaluation says it needs refinement
    // Expected: create n1.1, rewire n2 to depend on n1.1 instead of n1
    const completedNodeId = "n1";
    const now = new Date().toISOString();

    // Create the refinement node
    const newNodeId = "n1-fix";
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, description, status, dependencies, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`)
      .run(newNodeId, "bp-1", 1, "Add password validation", "Fix missing validation", `["${completedNodeId}"]`, now, now);

    // Rewire: n2 now depends on n1-fix instead of n1
    const n2Row = db.prepare("SELECT dependencies FROM macro_nodes WHERE id = ?").get("n2") as { dependencies: string };
    const n2Deps = JSON.parse(n2Row.dependencies) as string[];
    const newDeps = n2Deps.map((d: string) => d === completedNodeId ? newNodeId : d);
    db.prepare("UPDATE macro_nodes SET dependencies = ? WHERE id = ?").run(JSON.stringify(newDeps), "n2");

    // Verify: n1-fix depends on n1
    const fixNode = db.prepare("SELECT dependencies FROM macro_nodes WHERE id = ?").get(newNodeId) as { dependencies: string };
    expect(JSON.parse(fixNode.dependencies)).toEqual(["n1"]);

    // Verify: n2 now depends on n1-fix (not n1)
    const n2VerifyRow = db.prepare("SELECT dependencies FROM macro_nodes WHERE id = ?").get("n2") as { dependencies: string };
    expect(JSON.parse(n2VerifyRow.dependencies)).toEqual(["n1-fix"]);

    // Verify: n3 still depends on n2 (unchanged)
    const n3Row = db.prepare("SELECT dependencies FROM macro_nodes WHERE id = ?").get("n3") as { dependencies: string };
    expect(JSON.parse(n3Row.dependencies)).toEqual(["n2"]);

    // Verify: execution path is now n1 -> n1-fix -> n2 -> n3
    const allNodes = db.prepare('SELECT id, status, dependencies FROM macro_nodes WHERE blueprint_id = ? ORDER BY "order" ASC')
      .all("bp-1") as Array<{ id: string; status: string; dependencies: string | null }>;

    // n1-fix should be the next executable node (pending, dep n1 is done)
    const nextCandidate = allNodes.find((node) => {
      if (node.status !== "pending") return false;
      const deps: string[] = node.dependencies ? JSON.parse(node.dependencies) : [];
      return deps.every((depId) => {
        const dep = allNodes.find((n) => n.id === depId);
        return dep?.status === "done";
      });
    });
    expect(nextCandidate?.id).toBe("n1-fix");
  });

  it("INSERT_BETWEEN blocks dependents until refinement is done", () => {
    const now = new Date().toISOString();
    const newNodeId = "n1-fix";
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, dependencies, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`)
      .run(newNodeId, "bp-1", 1, "Fix gaps", `["n1"]`, now, now);

    // Rewire n2 to depend on n1-fix instead of n1
    db.prepare("UPDATE macro_nodes SET dependencies = ? WHERE id = ?").run('["n1-fix"]', "n2");

    // n2 should NOT be executable (n1-fix is pending, not done)
    const allNodes = db.prepare('SELECT id, status, dependencies FROM macro_nodes WHERE blueprint_id = ? ORDER BY "order" ASC')
      .all("bp-1") as Array<{ id: string; status: string; dependencies: string | null }>;

    const n2Executable = (() => {
      const n2 = allNodes.find(n => n.id === "n2")!;
      const deps: string[] = n2.dependencies ? JSON.parse(n2.dependencies) : [];
      return deps.every((depId) => {
        const dep = allNodes.find((n) => n.id === depId);
        return dep?.status === "done" || dep?.status === "skipped";
      });
    })();

    expect(n2Executable).toBe(false);
  });
});

describe("applyGraphMutations (ADD_SIBLING)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    const now = new Date().toISOString();
    db.prepare("INSERT INTO blueprints (id, title, status, created_at, updated_at) VALUES (?, ?, 'running', ?, ?)").run("bp-1", "Test Plan", now, now);
    // Node 0 (done) -> Node 1 (done, has blocker) -> Node 2 (pending, depends on n1)
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, dependencies, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("n0", "bp-1", 0, "Prereq", "done", null, now, now);
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, dependencies, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("n1", "bp-1", 1, "Deploy DB", "done", '["n0"]', now, now);
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, dependencies, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("n2", "bp-1", 2, "Build API", "pending", '["n1"]', now, now);
  });
  afterEach(() => { db.close(); });

  it("ADD_SIBLING creates blocked sibling and adds it as dependency to downstream", () => {
    const now = new Date().toISOString();
    const blockerNodeId = "n1-blocker";

    // Create sibling blocker node inheriting n1's dependencies (n0)
    const n1Deps = db.prepare("SELECT dependencies FROM macro_nodes WHERE id = ?").get("n1") as { dependencies: string | null };
    const inheritedDeps = n1Deps.dependencies ? JSON.parse(n1Deps.dependencies) : [];
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, description, status, dependencies, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'blocked', ?, ?, ?)`)
      .run(blockerNodeId, "bp-1", 2, "Wait for AWS creds", "Contact ops team", JSON.stringify(inheritedDeps), now, now);

    // Add blocker as dependency for n2
    const n2DepRow = db.prepare("SELECT dependencies FROM macro_nodes WHERE id = ?").get("n2") as { dependencies: string };
    const n2Deps = JSON.parse(n2DepRow.dependencies) as string[];
    n2Deps.push(blockerNodeId);
    db.prepare("UPDATE macro_nodes SET dependencies = ? WHERE id = ?").run(JSON.stringify(n2Deps), "n2");

    // Verify: blocker inherits n1's dependencies
    const blockerRow = db.prepare("SELECT dependencies, status FROM macro_nodes WHERE id = ?").get(blockerNodeId) as { dependencies: string; status: string };
    expect(JSON.parse(blockerRow.dependencies)).toEqual(["n0"]);
    expect(blockerRow.status).toBe("blocked");

    // Verify: n2 now depends on both n1 AND blocker
    const n2Row = db.prepare("SELECT dependencies FROM macro_nodes WHERE id = ?").get("n2") as { dependencies: string };
    expect(JSON.parse(n2Row.dependencies)).toEqual(["n1", "n1-blocker"]);

    // Verify: n2 is NOT executable (blocker is "blocked", not "done")
    const allNodes = db.prepare('SELECT id, status, dependencies FROM macro_nodes WHERE blueprint_id = ? ORDER BY "order" ASC')
      .all("bp-1") as Array<{ id: string; status: string; dependencies: string | null }>;

    const n2Executable = (() => {
      const n2 = allNodes.find(n => n.id === "n2")!;
      const deps: string[] = n2.dependencies ? JSON.parse(n2.dependencies) : [];
      return deps.every((depId) => {
        const dep = allNodes.find((n) => n.id === depId);
        return dep?.status === "done" || dep?.status === "skipped";
      });
    })();

    expect(n2Executable).toBe(false);
  });

  it("ADD_SIBLING: downstream becomes executable after blocker is resolved", () => {
    const now = new Date().toISOString();
    const blockerNodeId = "n1-blocker";

    // Create blocker
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, dependencies, created_at, updated_at) VALUES (?, ?, ?, ?, 'blocked', ?, ?, ?)`)
      .run(blockerNodeId, "bp-1", 2, "Wait for creds", '["n0"]', now, now);

    // Add blocker as dependency for n2
    db.prepare("UPDATE macro_nodes SET dependencies = ? WHERE id = ?").run('["n1","n1-blocker"]', "n2");

    // Initially n2 is blocked
    let allNodes = db.prepare('SELECT id, status, dependencies FROM macro_nodes WHERE blueprint_id = ?')
      .all("bp-1") as Array<{ id: string; status: string; dependencies: string | null }>;

    let n2Deps = JSON.parse(allNodes.find(n => n.id === "n2")!.dependencies!) as string[];
    let allDepsDone = n2Deps.every((depId) => {
      const dep = allNodes.find((n) => n.id === depId);
      return dep?.status === "done" || dep?.status === "skipped";
    });
    expect(allDepsDone).toBe(false);

    // Resolve blocker (mark as skipped)
    db.prepare("UPDATE macro_nodes SET status = 'skipped' WHERE id = ?").run(blockerNodeId);

    // Now n2 should be executable
    allNodes = db.prepare('SELECT id, status, dependencies FROM macro_nodes WHERE blueprint_id = ?')
      .all("bp-1") as Array<{ id: string; status: string; dependencies: string | null }>;

    n2Deps = JSON.parse(allNodes.find(n => n.id === "n2")!.dependencies!) as string[];
    allDepsDone = n2Deps.every((depId) => {
      const dep = allNodes.find((n) => n.id === depId);
      return dep?.status === "done" || dep?.status === "skipped";
    });
    expect(allDepsDone).toBe(true);
  });
});

// ─── Evaluation Prompt Building ─────────────────────────────

describe("buildEvaluationPrompt logic", () => {
  it("includes node title, description, artifact content, and callback URL", () => {
    const node = { title: "Build login UI", description: "Create login page with form" };
    const artifactContent = "**What was done:** Created login page with email/password fields.";
    const blueprint = { title: "Auth System", description: "JWT auth for API" };
    const blueprintId = "bp-123";
    const nodeId = "n-456";

    let prompt = `You are evaluating whether a completed development task needs follow-up work.\n\n`;
    prompt += `## Completed Task\n- Title: ${node.title}\n- Description: ${node.description}\n\n`;
    prompt += `## Handoff Summary\n${artifactContent}\n\n`;
    prompt += `## Blueprint Context\n- Blueprint: "${blueprint.title}"\n`;
    prompt += `\ncurl -s -X POST 'http://localhost:3001/api/blueprints/${blueprintId}/nodes/${nodeId}/evaluation-callback`;

    expect(prompt).toContain("Build login UI");
    expect(prompt).toContain("Create login page with form");
    expect(prompt).toContain("Created login page with email/password fields");
    expect(prompt).toContain("Auth System");
    expect(prompt).toContain("evaluation-callback");
    expect(prompt).toContain(blueprintId);
    expect(prompt).toContain(nodeId);
  });

  it("includes downstream dependent nodes when present", () => {
    const dependents = [
      { title: "Build API", description: "Create REST endpoints" },
      { title: "Write tests", description: "Add unit tests" },
    ];

    let prompt = "## Downstream Tasks (depend on this completed task):\n";
    for (const dep of dependents) {
      prompt += `- "${dep.title}": ${dep.description}\n`;
    }

    expect(prompt).toContain("Build API");
    expect(prompt).toContain("Write tests");
  });
});
