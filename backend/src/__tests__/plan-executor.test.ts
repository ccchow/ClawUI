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
  // Re-implement encodeProjectPath from cli-utils.ts for isolated testing
  function encodeProjectPath(projectCwd: string): string {
    return projectCwd
      .replace(/:/g, "-")
      .replace(/[\\/]/g, "-");
  }

  describe("Unix paths", () => {
    it("encodes CWD path correctly", () => {
      expect(encodeProjectPath("/home/testuser/projects/TestProject"))
        .toBe("-home-testuser-projects-TestProject");
    });

    it("handles root path", () => {
      expect(encodeProjectPath("/")).toBe("-");
    });

    it("handles deeply nested paths", () => {
      expect(encodeProjectPath("/home/user/projects/my-app/packages/core"))
        .toBe("-home-user-projects-my-app-packages-core");
    });
  });

  describe("Windows paths", () => {
    it("encodes Windows path with backslashes and drive letter", () => {
      expect(encodeProjectPath("C:\\Users\\user\\projects\\MyApp"))
        .toBe("C--Users-user-projects-MyApp");
    });

    it("handles mixed separators on Windows", () => {
      expect(encodeProjectPath("C:/Users/user"))
        .toBe("C--Users-user");
    });

    it("handles single-letter drive roots", () => {
      expect(encodeProjectPath("D:\\")).toBe("D--");
      expect(encodeProjectPath("Q:\\src")).toBe("Q--src");
    });

    it("encodes drive colon separately from backslashes", () => {
      // Verify that C: becomes C- (colon→dash) and \ becomes - (slash→dash)
      // So C:\ → C-- (one from colon, one from backslash)
      expect(encodeProjectPath("C:\\")).toBe("C--");
    });
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

// ─── Failure Classification ─────────────────────────────────

describe("classifyFailure logic", () => {
  // Re-implement classifyFailure for isolated testing (without JSONL dependency)
  function classifyFailure(
    errorMsg: string,
    output: string | undefined,
  ): { reason: string; detail: string } {
    const isTimeout = /killed|timeout|timed out|SIGTERM|ETIMEDOUT/i.test(errorMsg);

    const combinedText = [errorMsg, output || ""].join("\n");
    if (output) {
      if (output.includes("exceeded") && output.includes("output token maximum")) {
        return {
          reason: "output_token_limit",
          detail: "Claude's response exceeded the output token limit. The task may need to be broken into smaller steps.",
        };
      }
    }
    if (
      /context.?window|context.?length.?exceeded|maximum context length/i.test(combinedText) ||
      /input.*token.*limit|max_tokens_exceeded/i.test(combinedText) ||
      /conversation is too long|too many tokens/i.test(combinedText)
    ) {
      return {
        reason: "context_exhausted",
        detail: `Context window exceeded: ${errorMsg.slice(0, 200)}`,
      };
    }

    if (isTimeout) {
      return {
        reason: "timeout",
        detail: `Execution timed out: ${errorMsg}`,
      };
    }

    return {
      reason: "error",
      detail: errorMsg,
    };
  }

  it("classifies timeout errors from SIGTERM", () => {
    const result = classifyFailure("Process was killed by SIGTERM", undefined);
    expect(result.reason).toBe("timeout");
    expect(result.detail).toContain("timed out");
  });

  it("classifies timeout errors from ETIMEDOUT", () => {
    const result = classifyFailure("connect ETIMEDOUT", undefined);
    expect(result.reason).toBe("timeout");
  });

  it("classifies output token limit from output", () => {
    const result = classifyFailure("exit code 1", "Error: response exceeded the output token maximum");
    expect(result.reason).toBe("output_token_limit");
  });

  it("classifies context exhaustion from error message", () => {
    const result = classifyFailure("context_length_exceeded: this model's maximum context length", undefined);
    expect(result.reason).toBe("context_exhausted");
  });

  it("classifies context exhaustion from conversation too long", () => {
    const result = classifyFailure("conversation is too long for this model", undefined);
    expect(result.reason).toBe("context_exhausted");
  });

  it("classifies context exhaustion from max_tokens_exceeded", () => {
    const result = classifyFailure("max_tokens_exceeded in input processing", undefined);
    expect(result.reason).toBe("context_exhausted");
  });

  it("classifies generic errors", () => {
    const result = classifyFailure("Some unknown error happened", undefined);
    expect(result.reason).toBe("error");
    expect(result.detail).toBe("Some unknown error happened");
  });

  it("prioritizes output_token_limit over timeout", () => {
    const result = classifyFailure("killed by timeout", "exceeded the output token maximum limit");
    expect(result.reason).toBe("output_token_limit");
  });

  it("prioritizes context_exhausted over timeout when in error message", () => {
    const result = classifyFailure("killed: maximum context length exceeded", undefined);
    expect(result.reason).toBe("context_exhausted");
  });
});

describe("classifyHungFailure logic", () => {
  // Simplified classifyHungFailure (no JSONL dependency)
  function classifyHungFailure(): { reason: string; detail: string } {
    return {
      reason: "hung",
      detail: "Execution produced no meaningful output (Claude may have hung or timed out)",
    };
  }

  it("returns hung for no session", () => {
    const result = classifyHungFailure();
    expect(result.reason).toBe("hung");
    expect(result.detail).toContain("no meaningful output");
  });
});

// ─── extractTaskCompleteSummary ─────────────────────────────

describe("extractTaskCompleteSummary logic", () => {
  function extractTaskCompleteSummary(output: string): string | null {
    const startMarker = "===TASK_COMPLETE===";
    const endMarker = "===END_TASK===";
    const startIdx = output.lastIndexOf(startMarker);
    if (startIdx === -1) return null;
    const endIdx = output.indexOf(endMarker, startIdx);
    if (endIdx === -1) return null;
    const content = output.slice(startIdx + startMarker.length, endIdx).trim();
    return content.length > 0 ? content : null;
  }

  it("extracts summary between markers", () => {
    const output = "Some output\n===TASK_COMPLETE===\nImplemented JWT auth\n===END_TASK===\nMore stuff";
    expect(extractTaskCompleteSummary(output)).toBe("Implemented JWT auth");
  });

  it("uses lastIndexOf to skip echoed prompt markers", () => {
    const output = "===TASK_COMPLETE===\nTemplate summary\n===END_TASK===\nMore output\n===TASK_COMPLETE===\nReal summary\n===END_TASK===";
    expect(extractTaskCompleteSummary(output)).toBe("Real summary");
  });

  it("returns null when no markers found", () => {
    expect(extractTaskCompleteSummary("Normal output without markers")).toBeNull();
  });

  it("returns null when only start marker found", () => {
    expect(extractTaskCompleteSummary("Output\n===TASK_COMPLETE===\nNo end marker")).toBeNull();
  });

  it("returns null when content between markers is empty", () => {
    expect(extractTaskCompleteSummary("===TASK_COMPLETE===\n===END_TASK===")).toBeNull();
  });

  it("returns null when content is only whitespace", () => {
    expect(extractTaskCompleteSummary("===TASK_COMPLETE===\n   \n===END_TASK===")).toBeNull();
  });
});

// ─── withTimeout logic ──────────────────────────────────────

describe("withTimeout", () => {
  function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(message));
      }, ms);
      promise.then(
        (val) => { clearTimeout(timer); resolve(val); },
        (err) => { clearTimeout(timer); reject(err); },
      );
    });
  }

  it("resolves when promise completes before timeout", async () => {
    const result = await withTimeout(
      Promise.resolve("success"),
      1000,
      "timeout",
    );
    expect(result).toBe("success");
  });

  it("rejects with timeout message when promise takes too long", async () => {
    const slowPromise = new Promise<string>((resolve) => {
      setTimeout(() => resolve("too late"), 500);
    });
    await expect(
      withTimeout(slowPromise, 10, "Operation timed out"),
    ).rejects.toThrow("Operation timed out");
  });

  it("propagates the original rejection when promise fails", async () => {
    const failingPromise = Promise.reject(new Error("original error"));
    await expect(
      withTimeout(failingPromise, 1000, "timeout"),
    ).rejects.toThrow("original error");
  });
});

// ─── Two-tier dependency validation ─────────────────────────

describe("Two-tier dependency validation", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    const now = new Date().toISOString();
    db.prepare("INSERT INTO blueprints (id, title, status, created_at, updated_at) VALUES (?, ?, 'running', ?, ?)").run("bp-1", "Test", now, now);
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, dependencies, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("n1", "bp-1", 0, "First", "running", null, now, now);
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, dependencies, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("n2", "bp-1", 1, "Second", "pending", '["n1"]', now, now);
  });
  afterEach(() => { db.close(); });

  it("queue-time check: allows queueing when deps are running", () => {
    // Lenient check — only blocks when deps are "failed" or "blocked"
    const node = db.prepare("SELECT * FROM macro_nodes WHERE id = ?").get("n2") as { dependencies: string | null };
    const deps: string[] = node.dependencies ? JSON.parse(node.dependencies) : [];

    const blockedStatuses = new Set(["failed", "blocked"]);
    const canQueue = deps.every((depId) => {
      const dep = db.prepare("SELECT status FROM macro_nodes WHERE id = ?").get(depId) as { status: string };
      return !blockedStatuses.has(dep.status);
    });
    expect(canQueue).toBe(true); // running deps are fine for queueing
  });

  it("queue-time check: blocks queueing when deps are failed", () => {
    db.prepare("UPDATE macro_nodes SET status = 'failed' WHERE id = ?").run("n1");

    const node = db.prepare("SELECT * FROM macro_nodes WHERE id = ?").get("n2") as { dependencies: string | null };
    const deps: string[] = node.dependencies ? JSON.parse(node.dependencies) : [];

    const blockedStatuses = new Set(["failed", "blocked"]);
    const canQueue = deps.every((depId) => {
      const dep = db.prepare("SELECT status FROM macro_nodes WHERE id = ?").get(depId) as { status: string };
      return !blockedStatuses.has(dep.status);
    });
    expect(canQueue).toBe(false);
  });

  it("queue-time check: blocks queueing when deps are blocked", () => {
    db.prepare("UPDATE macro_nodes SET status = 'blocked' WHERE id = ?").run("n1");

    const node = db.prepare("SELECT * FROM macro_nodes WHERE id = ?").get("n2") as { dependencies: string | null };
    const deps: string[] = node.dependencies ? JSON.parse(node.dependencies) : [];

    const blockedStatuses = new Set(["failed", "blocked"]);
    const canQueue = deps.every((depId) => {
      const dep = db.prepare("SELECT status FROM macro_nodes WHERE id = ?").get(depId) as { status: string };
      return !blockedStatuses.has(dep.status);
    });
    expect(canQueue).toBe(false);
  });

  it("queue-time check: allows queueing when deps are queued or pending", () => {
    db.prepare("UPDATE macro_nodes SET status = 'queued' WHERE id = ?").run("n1");

    const node = db.prepare("SELECT * FROM macro_nodes WHERE id = ?").get("n2") as { dependencies: string | null };
    const deps: string[] = node.dependencies ? JSON.parse(node.dependencies) : [];

    const blockedStatuses = new Set(["failed", "blocked"]);
    const canQueue = deps.every((depId) => {
      const dep = db.prepare("SELECT status FROM macro_nodes WHERE id = ?").get(depId) as { status: string };
      return !blockedStatuses.has(dep.status);
    });
    expect(canQueue).toBe(true);
  });

  it("execution-time check: strict — requires deps to be done or skipped", () => {
    // Strict check — deps must be "done" or "skipped"
    const node = db.prepare("SELECT * FROM macro_nodes WHERE id = ?").get("n2") as { dependencies: string | null };
    const deps: string[] = node.dependencies ? JSON.parse(node.dependencies) : [];

    const canExecute = deps.every((depId) => {
      const dep = db.prepare("SELECT status FROM macro_nodes WHERE id = ?").get(depId) as { status: string };
      return dep.status === "done" || dep.status === "skipped";
    });
    expect(canExecute).toBe(false); // n1 is "running", not "done"
  });

  it("execution-time check: allows when deps are done", () => {
    db.prepare("UPDATE macro_nodes SET status = 'done' WHERE id = ?").run("n1");

    const node = db.prepare("SELECT * FROM macro_nodes WHERE id = ?").get("n2") as { dependencies: string | null };
    const deps: string[] = node.dependencies ? JSON.parse(node.dependencies) : [];

    const canExecute = deps.every((depId) => {
      const dep = db.prepare("SELECT status FROM macro_nodes WHERE id = ?").get(depId) as { status: string };
      return dep.status === "done" || dep.status === "skipped";
    });
    expect(canExecute).toBe(true);
  });

  it("execution-time check: allows when deps are skipped", () => {
    db.prepare("UPDATE macro_nodes SET status = 'skipped' WHERE id = ?").run("n1");

    const node = db.prepare("SELECT * FROM macro_nodes WHERE id = ?").get("n2") as { dependencies: string | null };
    const deps: string[] = node.dependencies ? JSON.parse(node.dependencies) : [];

    const canExecute = deps.every((depId) => {
      const dep = db.prepare("SELECT status FROM macro_nodes WHERE id = ?").get(depId) as { status: string };
      return dep.status === "done" || dep.status === "skipped";
    });
    expect(canExecute).toBe(true);
  });
});

// ─── RunAll pre-queuing logic ───────────────────────────────

describe("RunAll pre-queuing and failure reset", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    const now = new Date().toISOString();
    db.prepare("INSERT INTO blueprints (id, title, status, created_at, updated_at) VALUES (?, ?, 'approved', ?, ?)").run("bp-1", "Test Plan", now, now);
    // Chain: n1 -> n2 -> n3
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, dependencies, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("n1", "bp-1", 0, "First", "pending", null, now, now);
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, dependencies, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("n2", "bp-1", 1, "Second", "pending", '["n1"]', now, now);
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, dependencies, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("n3", "bp-1", 2, "Third", "pending", '["n2"]', now, now);
  });
  afterEach(() => { db.close(); });

  it("pre-queuing marks eligible pending nodes as queued", () => {
    // Simulate executeAllNodes pre-queuing logic
    const allNodes = db.prepare('SELECT id, status, dependencies FROM macro_nodes WHERE blueprint_id = ? ORDER BY "order" ASC')
      .all("bp-1") as Array<{ id: string; status: string; dependencies: string | null }>;

    const preQueued: string[] = [];
    for (const node of allNodes) {
      if (node.status !== "pending") continue;
      const deps: string[] = node.dependencies ? JSON.parse(node.dependencies) : [];
      const allDepsEligible = deps.every((depId) => {
        const dep = allNodes.find((n) => n.id === depId);
        if (!dep) return false;
        return ["done", "skipped", "pending", "queued"].includes(dep.status);
      });
      if (allDepsEligible) {
        db.prepare("UPDATE macro_nodes SET status = 'queued' WHERE id = ?").run(node.id);
        preQueued.push(node.id);
      }
    }

    // All three should be pre-queued because their deps are pending/queued
    expect(preQueued).toEqual(["n1", "n2", "n3"]);
  });

  it("does not pre-queue nodes with failed dependencies", () => {
    // Make n3 also depend on n1 directly, so failing n1 blocks both n2 and n3
    db.prepare("UPDATE macro_nodes SET dependencies = ? WHERE id = ?").run('["n1","n2"]', "n3");
    db.prepare("UPDATE macro_nodes SET status = 'failed' WHERE id = ?").run("n1");

    const allNodes = db.prepare('SELECT id, status, dependencies FROM macro_nodes WHERE blueprint_id = ? ORDER BY "order" ASC')
      .all("bp-1") as Array<{ id: string; status: string; dependencies: string | null }>;

    const preQueued: string[] = [];
    for (const node of allNodes) {
      if (node.status !== "pending") continue;
      const deps: string[] = node.dependencies ? JSON.parse(node.dependencies) : [];
      const allDepsEligible = deps.every((depId) => {
        const dep = allNodes.find((n) => n.id === depId);
        if (!dep) return false;
        return ["done", "skipped", "pending", "queued"].includes(dep.status);
      });
      if (allDepsEligible) {
        preQueued.push(node.id);
      }
    }

    // n2 depends on failed n1, n3 depends on both n1 (failed) and n2 — neither should be pre-queued
    expect(preQueued).toEqual([]);
  });

  it("resets pre-queued nodes back to pending on failure", () => {
    // Simulate pre-queuing
    db.prepare("UPDATE macro_nodes SET status = 'queued' WHERE id = ?").run("n1");
    db.prepare("UPDATE macro_nodes SET status = 'queued' WHERE id = ?").run("n2");
    db.prepare("UPDATE macro_nodes SET status = 'queued' WHERE id = ?").run("n3");

    const preQueuedNodeIds = ["n1", "n2", "n3"];

    // Simulate: n1 runs and fails
    db.prepare("UPDATE macro_nodes SET status = 'failed' WHERE id = ?").run("n1");
    const idx = preQueuedNodeIds.indexOf("n1");
    if (idx >= 0) preQueuedNodeIds.splice(idx, 1);

    // Reset remaining pre-queued nodes
    for (const remainingNodeId of preQueuedNodeIds) {
      db.prepare("UPDATE macro_nodes SET status = 'pending' WHERE id = ?").run(remainingNodeId);
    }

    const n2 = db.prepare("SELECT status FROM macro_nodes WHERE id = ?").get("n2") as { status: string };
    const n3 = db.prepare("SELECT status FROM macro_nodes WHERE id = ?").get("n3") as { status: string };
    expect(n2.status).toBe("pending");
    expect(n3.status).toBe("pending");
  });
});

// ─── removeQueuedTask logic ─────────────────────────────────

describe("removeQueuedTask logic", () => {
  it("removes a queued task by nodeId", () => {
    const queues = new Map<string, Array<{ task: () => Promise<unknown>; resolve: (val: unknown) => void; reject: (err: Error) => void; nodeId?: string }>>();

    function removeQueuedTask(bpId: string, nodeId: string): { removed: boolean } {
      const queue = queues.get(bpId);
      if (!queue) return { removed: false };
      const idx = queue.findIndex(item => item.nodeId === nodeId);
      if (idx === -1) return { removed: false };
      const [removed] = queue.splice(idx, 1);
      removed.resolve(null);
      return { removed: true };
    }

    // Setup queue with items
    const items = [
      { task: async () => {}, resolve: () => {}, reject: () => {}, nodeId: "n1" },
      { task: async () => {}, resolve: () => {}, reject: () => {}, nodeId: "n2" },
      { task: async () => {}, resolve: () => {}, reject: () => {}, nodeId: "n3" },
    ];
    queues.set("bp-1", items as Array<{ task: () => Promise<unknown>; resolve: (val: unknown) => void; reject: (err: Error) => void; nodeId?: string }>);

    const result = removeQueuedTask("bp-1", "n2");
    expect(result.removed).toBe(true);
    expect(queues.get("bp-1")).toHaveLength(2);
    expect(queues.get("bp-1")!.some(i => i.nodeId === "n2")).toBe(false);
  });

  it("returns false when queue does not exist", () => {
    const queues = new Map<string, Array<{ nodeId?: string }>>();

    function removeQueuedTask(bpId: string): { removed: boolean } {
      const queue = queues.get(bpId);
      if (!queue) return { removed: false };
      return { removed: false };
    }

    expect(removeQueuedTask("nonexistent").removed).toBe(false);
  });

  it("returns false when nodeId not found in queue", () => {
    const queues = new Map<string, Array<{ task: () => Promise<unknown>; resolve: (val: unknown) => void; reject: (err: Error) => void; nodeId?: string }>>();
    queues.set("bp-1", [
      { task: async () => {}, resolve: () => {}, reject: () => {}, nodeId: "n1" },
    ] as Array<{ task: () => Promise<unknown>; resolve: (val: unknown) => void; reject: (err: Error) => void; nodeId?: string }>);

    function removeQueuedTask(bpId: string, nodeId: string): { removed: boolean } {
      const queue = queues.get(bpId);
      if (!queue) return { removed: false };
      const idx = queue.findIndex(item => item.nodeId === nodeId);
      if (idx === -1) return { removed: false };
      return { removed: true };
    }

    expect(removeQueuedTask("bp-1", "n999").removed).toBe(false);
  });
});

// ─── getGlobalQueueInfo logic ───────────────────────────────

describe("getGlobalQueueInfo aggregation logic", () => {
  it("aggregates tasks across blueprints", () => {
    const running = new Set(["bp-1"]);
    const runningNodeId = new Map([["bp-1", "n1"]]);
    const pendingTasks = new Map<string, Array<{ type: string; nodeId?: string; queuedAt: string }>>([
      ["bp-1", [{ type: "run", nodeId: "n2", queuedAt: "2024-01-01T00:00:00Z" }]],
      ["bp-2", [
        { type: "run", nodeId: "n3", queuedAt: "2024-01-01T00:00:01Z" },
        { type: "reevaluate", nodeId: "n4", queuedAt: "2024-01-01T00:00:02Z" },
      ]],
    ]);

    interface Task { blueprintId: string; type: string; nodeId?: string }
    const tasks: Task[] = [];

    for (const bpId of running) {
      tasks.push({ blueprintId: bpId, type: "running", nodeId: runningNodeId.get(bpId) });
    }
    for (const [bpId, pending] of pendingTasks) {
      for (const t of pending) {
        tasks.push({ blueprintId: bpId, type: t.type, nodeId: t.nodeId });
      }
    }

    expect(tasks).toHaveLength(4);
    expect(tasks[0]).toEqual({ blueprintId: "bp-1", type: "running", nodeId: "n1" });
    expect(tasks.filter(t => t.blueprintId === "bp-2")).toHaveLength(2);
  });

  it("returns empty when nothing is running", () => {
    const running = new Set<string>();
    const pendingTasks = new Map<string, Array<{ type: string; nodeId?: string }>>();

    const active = running.size > 0 || pendingTasks.size > 0;
    expect(active).toBe(false);
  });
});

// ─── Node split logic ───────────────────────────────────────

describe("Node split: dependency rewiring", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    const now = new Date().toISOString();
    db.prepare("INSERT INTO blueprints (id, title, status, created_at, updated_at) VALUES (?, ?, 'approved', ?, ?)").run("bp-1", "Test Plan", now, now);
    // n0 (done) -> n1 (pending, to be split) -> n2 (pending, depends on n1)
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, dependencies, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("n0", "bp-1", 0, "Setup", "done", null, now, now);
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, dependencies, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("n1", "bp-1", 1, "Big Task", "pending", '["n0"]', now, now);
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, dependencies, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("n2", "bp-1", 2, "Final", "pending", '["n1"]', now, now);
  });
  afterEach(() => { db.close(); });

  it("split creates sub-nodes that chain correctly", () => {
    const now = new Date().toISOString();
    // Simulate split: n1 becomes skipped, sub1 and sub2 replace it
    const n1Row = db.prepare("SELECT dependencies FROM macro_nodes WHERE id = ?").get("n1") as { dependencies: string | null };
    const n1Deps = n1Row.dependencies ? JSON.parse(n1Row.dependencies) : [];

    // Create sub-node 1 inheriting n1's deps
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, dependencies, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`)
      .run("sub1", "bp-1", 1, "Sub Task 1", JSON.stringify(n1Deps), now, now);

    // Create sub-node 2 depending on sub1
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, dependencies, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`)
      .run("sub2", "bp-1", 2, "Sub Task 2", '["sub1"]', now, now);

    // Rewire: n2 now depends on sub2 (last sub-node) instead of n1
    db.prepare("UPDATE macro_nodes SET dependencies = ? WHERE id = ?").run('["sub2"]', "n2");

    // Mark n1 as skipped
    db.prepare("UPDATE macro_nodes SET status = 'skipped' WHERE id = ?").run("n1");

    // Verify the chain: n0 (done) -> sub1 -> sub2 -> n2
    const sub1 = db.prepare("SELECT dependencies, status FROM macro_nodes WHERE id = ?").get("sub1") as { dependencies: string; status: string };
    expect(JSON.parse(sub1.dependencies)).toEqual(["n0"]);
    expect(sub1.status).toBe("pending");

    const sub2 = db.prepare("SELECT dependencies FROM macro_nodes WHERE id = ?").get("sub2") as { dependencies: string };
    expect(JSON.parse(sub2.dependencies)).toEqual(["sub1"]);

    const n2 = db.prepare("SELECT dependencies FROM macro_nodes WHERE id = ?").get("n2") as { dependencies: string };
    expect(JSON.parse(n2.dependencies)).toEqual(["sub2"]);

    // n1 is skipped
    const n1 = db.prepare("SELECT status FROM macro_nodes WHERE id = ?").get("n1") as { status: string };
    expect(n1.status).toBe("skipped");

    // sub1 should be the next executable node
    const allNodes = db.prepare('SELECT id, status, dependencies FROM macro_nodes WHERE blueprint_id = ? AND status != \'skipped\' ORDER BY "order" ASC')
      .all("bp-1") as Array<{ id: string; status: string; dependencies: string | null }>;

    const nextCandidate = allNodes.find((node) => {
      if (node.status !== "pending") return false;
      const deps: string[] = node.dependencies ? JSON.parse(node.dependencies) : [];
      return deps.every((depId) => {
        const dep = allNodes.find((n) => n.id === depId);
        return dep?.status === "done" || dep?.status === "skipped";
      });
    });
    expect(nextCandidate?.id).toBe("sub1");
  });
});

// ─── Reported status (API callback) decision logic ──────────

describe("Reported status decision logic", () => {
  it("reported_status 'done' takes priority over output inference", () => {
    const dbReportedStatus = "done";
    const output = "Very short";

    // In executeNodeInternal, dbReportedStatus is checked first
    // Even if output is short (< 50 chars), "done" report takes priority
    let resultStatus: string;
    if (dbReportedStatus) {
      resultStatus = dbReportedStatus === "done" ? "done" : "failed";
    } else if (output.length < 50) {
      resultStatus = "failed";
    } else {
      resultStatus = "done";
    }

    expect(resultStatus).toBe("done");
  });

  it("reported_status 'blocked' results in node blocked status", () => {
    const dbReportedStatus = "blocked";
    const dbReportedReason = "Need AWS credentials";

    let nodeStatus: string;
    if (dbReportedStatus === "blocked") {
      nodeStatus = "blocked";
    } else {
      nodeStatus = "done";
    }

    expect(nodeStatus).toBe("blocked");
    expect(dbReportedReason).toContain("AWS");
  });

  it("falls back to output inference when no reported_status", () => {
    const dbReportedStatus = null;
    const output = "I completed the implementation successfully. All tests pass.";

    let resultStatus: string;
    if (dbReportedStatus) {
      resultStatus = dbReportedStatus;
    } else if (output.length < 50) {
      resultStatus = "failed";
    } else {
      resultStatus = "done";
    }

    expect(resultStatus).toBe("done");
  });
});

// ─── Blueprint completion detection ─────────────────────────

describe("Blueprint completion detection", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    const now = new Date().toISOString();
    db.prepare("INSERT INTO blueprints (id, title, status, created_at, updated_at) VALUES (?, ?, 'running', ?, ?)").run("bp-1", "Test", now, now);
  });
  afterEach(() => { db.close(); });

  it("marks blueprint as done when all nodes are done or skipped", () => {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'done', ?, ?)`).run("n1", "bp-1", 0, "A", now, now);
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'skipped', ?, ?)`).run("n2", "bp-1", 1, "B", now, now);
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'done', ?, ?)`).run("n3", "bp-1", 2, "C", now, now);

    const nodes = db.prepare("SELECT status FROM macro_nodes WHERE blueprint_id = ?").all("bp-1") as Array<{ status: string }>;
    const allDone = nodes.every((n) => n.status === "done" || n.status === "skipped");
    expect(allDone).toBe(true);
  });

  it("does not mark blueprint as done when some nodes are pending", () => {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'done', ?, ?)`).run("n1", "bp-1", 0, "A", now, now);
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)`).run("n2", "bp-1", 1, "B", now, now);

    const nodes = db.prepare("SELECT status FROM macro_nodes WHERE blueprint_id = ?").all("bp-1") as Array<{ status: string }>;
    const allDone = nodes.every((n) => n.status === "done" || n.status === "skipped");
    expect(allDone).toBe(false);
  });

  it("does not mark blueprint as done when some nodes are blocked", () => {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'done', ?, ?)`).run("n1", "bp-1", 0, "A", now, now);
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'blocked', ?, ?)`).run("n2", "bp-1", 1, "B", now, now);

    const nodes = db.prepare("SELECT status FROM macro_nodes WHERE blueprint_id = ?").all("bp-1") as Array<{ status: string }>;
    const allDone = nodes.every((n) => n.status === "done" || n.status === "skipped");
    expect(allDone).toBe(false);
  });
});

// ─── Orphan Node Recovery ───────────────────────────────────

describe("requeueOrphanedNodes logic", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    const now = new Date().toISOString();
    db.prepare("INSERT INTO blueprints (id, title, status, created_at, updated_at) VALUES (?, ?, 'running', ?, ?)").run("bp-1", "Orphan Test", now, now);
    db.prepare("INSERT INTO blueprints (id, title, status, created_at, updated_at) VALUES (?, ?, 'approved', ?, ?)").run("bp-2", "Other Plan", now, now);
  });
  afterEach(() => { db.close(); });

  it("identifies orphaned queued nodes", () => {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)`).run("n1", "bp-1", 0, "Queued Node", now, now);
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)`).run("n2", "bp-1", 1, "Pending Node", now, now);
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'done', ?, ?)`).run("n3", "bp-1", 2, "Done Node", now, now);

    const orphaned = db.prepare("SELECT id, blueprint_id FROM macro_nodes WHERE status = 'queued'")
      .all() as { id: string; blueprint_id: string }[];

    expect(orphaned).toHaveLength(1);
    expect(orphaned[0].id).toBe("n1");
    expect(orphaned[0].blueprint_id).toBe("bp-1");
  });

  it("identifies orphaned nodes across multiple blueprints", () => {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)`).run("n1", "bp-1", 0, "Q1", now, now);
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)`).run("n2", "bp-2", 0, "Q2", now, now);
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)`).run("n3", "bp-1", 1, "Q3", now, now);

    const orphaned = db.prepare("SELECT id, blueprint_id FROM macro_nodes WHERE status = 'queued'")
      .all() as { id: string; blueprint_id: string }[];

    expect(orphaned).toHaveLength(3);
    expect(orphaned.filter(o => o.blueprint_id === "bp-1")).toHaveLength(2);
    expect(orphaned.filter(o => o.blueprint_id === "bp-2")).toHaveLength(1);
  });

  it("returns empty when no queued nodes exist", () => {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)`).run("n1", "bp-1", 0, "Pending", now, now);
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'done', ?, ?)`).run("n2", "bp-1", 1, "Done", now, now);

    const orphaned = db.prepare("SELECT id, blueprint_id FROM macro_nodes WHERE status = 'queued'")
      .all() as { id: string; blueprint_id: string }[];

    expect(orphaned).toHaveLength(0);
  });

  it("re-enqueuing adds pending tasks to in-memory queue", () => {
    // Simulate the in-memory pending task tracking from requeueOrphanedNodes
    const pendingTasks = new Map<string, Array<{ type: string; nodeId?: string; queuedAt: string }>>();

    function addPendingTask(bpId: string, task: { type: string; nodeId?: string; queuedAt: string }): void {
      const tasks = pendingTasks.get(bpId) ?? [];
      tasks.push(task);
      pendingTasks.set(bpId, tasks);
    }

    // Simulate orphaned nodes
    const orphaned = [
      { id: "n1", blueprintId: "bp-1" },
      { id: "n2", blueprintId: "bp-1" },
      { id: "n3", blueprintId: "bp-2" },
    ];

    for (const { id: nodeId, blueprintId } of orphaned) {
      addPendingTask(blueprintId, { type: "run", nodeId, queuedAt: new Date().toISOString() });
    }

    expect(pendingTasks.get("bp-1")).toHaveLength(2);
    expect(pendingTasks.get("bp-2")).toHaveLength(1);
    expect(pendingTasks.get("bp-1")![0].nodeId).toBe("n1");
    expect(pendingTasks.get("bp-1")![1].nodeId).toBe("n2");
    expect(pendingTasks.get("bp-2")![0].nodeId).toBe("n3");
  });

  it("failed re-enqueued node resets status from queued to pending", () => {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)`).run("n1", "bp-1", 0, "Queued Node", now, now);

    // Simulate requeueOrphanedNodes failure path: reset queued -> pending
    const node = db.prepare("SELECT status FROM macro_nodes WHERE id = ?").get("n1") as { status: string };
    expect(node.status).toBe("queued");

    // Execution fails, reset to pending
    db.prepare("UPDATE macro_nodes SET status = 'pending' WHERE id = ? AND status = 'queued'").run("n1");

    const after = db.prepare("SELECT status FROM macro_nodes WHERE id = ?").get("n1") as { status: string };
    expect(after.status).toBe("pending");
  });

  it("does not reset already-running nodes back to pending on failure", () => {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'running', ?, ?)`).run("n1", "bp-1", 0, "Running Node", now, now);

    // Simulate the conditional reset: only resets if status is still "queued"
    const result = db.prepare("UPDATE macro_nodes SET status = 'pending' WHERE id = ? AND status = 'queued'").run("n1");
    expect(result.changes).toBe(0);

    const after = db.prepare("SELECT status FROM macro_nodes WHERE id = ?").get("n1") as { status: string };
    expect(after.status).toBe("running");
  });

  it("does not reset done or failed nodes back to pending on conditional update", () => {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'done', ?, ?)`).run("n1", "bp-1", 0, "Done Node", now, now);
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'failed', ?, ?)`).run("n2", "bp-1", 1, "Failed Node", now, now);

    // Conditional reset only applies to status = 'queued'
    const r1 = db.prepare("UPDATE macro_nodes SET status = 'pending' WHERE id = ? AND status = 'queued'").run("n1");
    const r2 = db.prepare("UPDATE macro_nodes SET status = 'pending' WHERE id = ? AND status = 'queued'").run("n2");
    expect(r1.changes).toBe(0);
    expect(r2.changes).toBe(0);

    const n1 = db.prepare("SELECT status FROM macro_nodes WHERE id = ?").get("n1") as { status: string };
    const n2 = db.prepare("SELECT status FROM macro_nodes WHERE id = ?").get("n2") as { status: string };
    expect(n1.status).toBe("done");
    expect(n2.status).toBe("failed");
  });

  it("handles orphaned queued nodes mixed across blueprints with different statuses", () => {
    const now = new Date().toISOString();
    // bp-1 (running): has queued and pending nodes
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)`).run("n1", "bp-1", 0, "Q1", now, now);
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)`).run("n2", "bp-1", 1, "P1", now, now);
    // bp-2 (approved): has queued, done, and running nodes
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'done', ?, ?)`).run("n3", "bp-2", 0, "D1", now, now);
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)`).run("n4", "bp-2", 1, "Q2", now, now);
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'running', ?, ?)`).run("n5", "bp-2", 2, "R1", now, now);

    const orphaned = db.prepare("SELECT id, blueprint_id FROM macro_nodes WHERE status = 'queued'")
      .all() as { id: string; blueprint_id: string }[];

    // Only the queued nodes should be detected as orphans
    expect(orphaned).toHaveLength(2);
    const ids = orphaned.map(o => o.id).sort();
    expect(ids).toEqual(["n1", "n4"]);
    // Each from a different blueprint
    expect(orphaned.find(o => o.id === "n1")!.blueprint_id).toBe("bp-1");
    expect(orphaned.find(o => o.id === "n4")!.blueprint_id).toBe("bp-2");
  });

  it("re-enqueue pending task removal cleans up the map", () => {
    // Simulate the full lifecycle: add pending → remove pending → verify clean
    const pendingTasks = new Map<string, Array<{ type: string; nodeId?: string; queuedAt: string }>>();

    function addPendingTask(bpId: string, task: { type: string; nodeId?: string; queuedAt: string }): void {
      const tasks = pendingTasks.get(bpId) ?? [];
      tasks.push(task);
      pendingTasks.set(bpId, tasks);
    }

    function removePendingTask(bpId: string, nodeId?: string, type?: string): void {
      const tasks = pendingTasks.get(bpId) ?? [];
      const idx = tasks.findIndex(
        (t) => (!nodeId || t.nodeId === nodeId) && (!type || t.type === type),
      );
      if (idx >= 0) tasks.splice(idx, 1);
      if (tasks.length === 0) pendingTasks.delete(bpId);
      else pendingTasks.set(bpId, tasks);
    }

    // Simulate 3 orphaned nodes from bp-1
    addPendingTask("bp-1", { type: "run", nodeId: "n1", queuedAt: "2025-01-01T00:00:00Z" });
    addPendingTask("bp-1", { type: "run", nodeId: "n2", queuedAt: "2025-01-01T00:00:01Z" });
    addPendingTask("bp-1", { type: "run", nodeId: "n3", queuedAt: "2025-01-01T00:00:02Z" });
    expect(pendingTasks.get("bp-1")).toHaveLength(3);

    // Simulate execution completing: remove one by one
    removePendingTask("bp-1", "n1", "run");
    expect(pendingTasks.get("bp-1")).toHaveLength(2);

    removePendingTask("bp-1", "n2", "run");
    expect(pendingTasks.get("bp-1")).toHaveLength(1);
    expect(pendingTasks.get("bp-1")![0].nodeId).toBe("n3");

    // Last removal should delete the key entirely
    removePendingTask("bp-1", "n3", "run");
    expect(pendingTasks.has("bp-1")).toBe(false);
  });

  it("removePendingTask is no-op for non-existent tasks", () => {
    const pendingTasks = new Map<string, Array<{ type: string; nodeId?: string; queuedAt: string }>>();

    function removePendingTask(bpId: string, nodeId?: string, type?: string): void {
      const tasks = pendingTasks.get(bpId) ?? [];
      const idx = tasks.findIndex(
        (t) => (!nodeId || t.nodeId === nodeId) && (!type || t.type === type),
      );
      if (idx >= 0) tasks.splice(idx, 1);
      if (tasks.length === 0) pendingTasks.delete(bpId);
      else pendingTasks.set(bpId, tasks);
    }

    // Removing from empty map should not throw
    removePendingTask("bp-nonexistent", "n99", "run");
    expect(pendingTasks.has("bp-nonexistent")).toBe(false);

    // Add one task, try to remove a different one
    const tasks = [{ type: "run" as const, nodeId: "n1", queuedAt: "2025-01-01T00:00:00Z" }];
    pendingTasks.set("bp-1", tasks);
    removePendingTask("bp-1", "n99", "run");
    expect(pendingTasks.get("bp-1")).toHaveLength(1);
    expect(pendingTasks.get("bp-1")![0].nodeId).toBe("n1");
  });

  it("serial queue ensures orphaned nodes from same blueprint run sequentially", async () => {
    // Re-implement queue to verify serial execution for orphan re-queue
    const executionOrder: string[] = [];

    function createQueue() {
      const queues = new Map<string, Array<{ task: () => Promise<void>; resolve: (val: void) => void; reject: (err: Error) => void }>>();
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

      function enqueue(bpId: string, task: () => Promise<void>): Promise<void> {
        return new Promise<void>((resolve, reject) => {
          const queue = queues.get(bpId) ?? [];
          queue.push({ task, resolve, reject });
          queues.set(bpId, queue);
          drainQueue(bpId);
        });
      }

      return { enqueue, running };
    }

    const { enqueue } = createQueue();

    // Simulate re-queuing 3 orphaned nodes from bp-1
    const promises = ["n1", "n2", "n3"].map(nodeId =>
      enqueue("bp-1", async () => {
        executionOrder.push(`start:${nodeId}`);
        // Simulate async execution
        await new Promise(resolve => setTimeout(resolve, 5));
        executionOrder.push(`end:${nodeId}`);
      }),
    );

    await Promise.all(promises);

    // Verify strict serial execution: each starts only after the previous ends
    expect(executionOrder).toEqual([
      "start:n1", "end:n1",
      "start:n2", "end:n2",
      "start:n3", "end:n3",
    ]);
  });

  it("orphaned nodes from different blueprints can execute in parallel", async () => {
    const active = new Set<string>();
    let maxConcurrent = 0;

    function createQueue() {
      const queues = new Map<string, Array<{ task: () => Promise<void>; resolve: (val: void) => void; reject: (err: Error) => void }>>();
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

      function enqueue(bpId: string, task: () => Promise<void>): Promise<void> {
        return new Promise<void>((resolve, reject) => {
          const queue = queues.get(bpId) ?? [];
          queue.push({ task, resolve, reject });
          queues.set(bpId, queue);
          drainQueue(bpId);
        });
      }

      return { enqueue };
    }

    const { enqueue } = createQueue();

    // Enqueue orphaned nodes from 3 different blueprints
    const promises = ["bp-1", "bp-2", "bp-3"].map(bpId =>
      enqueue(bpId, async () => {
        active.add(bpId);
        maxConcurrent = Math.max(maxConcurrent, active.size);
        await new Promise(resolve => setTimeout(resolve, 10));
        active.delete(bpId);
      }),
    );

    await Promise.all(promises);

    // All 3 blueprints should have been active concurrently
    expect(maxConcurrent).toBe(3);
  });

  it("conditional reset is atomic — only one queued node is reset per UPDATE", () => {
    const now = new Date().toISOString();
    // Two queued nodes in the same blueprint
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)`).run("n1", "bp-1", 0, "Q1", now, now);
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)`).run("n2", "bp-1", 1, "Q2", now, now);

    // Reset only n1 (by id), simulating a per-node failure handler
    const result = db.prepare("UPDATE macro_nodes SET status = 'pending' WHERE id = ? AND status = 'queued'").run("n1");
    expect(result.changes).toBe(1);

    // n1 is pending, n2 is still queued
    const n1 = db.prepare("SELECT status FROM macro_nodes WHERE id = ?").get("n1") as { status: string };
    const n2 = db.prepare("SELECT status FROM macro_nodes WHERE id = ?").get("n2") as { status: string };
    expect(n1.status).toBe("pending");
    expect(n2.status).toBe("queued");
  });

  it("re-detecting orphans after partial recovery finds remaining queued nodes", () => {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)`).run("n1", "bp-1", 0, "Q1", now, now);
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)`).run("n2", "bp-1", 1, "Q2", now, now);
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)`).run("n3", "bp-2", 0, "Q3", now, now);

    // First recovery: n1 executes successfully (transitions to done), n2 fails (reset to pending)
    db.prepare("UPDATE macro_nodes SET status = 'done' WHERE id = ?").run("n1");
    db.prepare("UPDATE macro_nodes SET status = 'pending' WHERE id = ? AND status = 'queued'").run("n2");

    // Re-detect orphans — only n3 should remain
    const orphaned = db.prepare("SELECT id, blueprint_id FROM macro_nodes WHERE status = 'queued'")
      .all() as { id: string; blueprint_id: string }[];

    expect(orphaned).toHaveLength(1);
    expect(orphaned[0].id).toBe("n3");
    expect(orphaned[0].blueprint_id).toBe("bp-2");
  });

  it("end-to-end mixed status orphan lifecycle across all statuses and blueprints", () => {
    const now = new Date().toISOString();
    // Add a third blueprint
    db.prepare("INSERT INTO blueprints (id, title, status, created_at, updated_at) VALUES (?, ?, 'approved', ?, ?)").run("bp-3", "Third Blueprint", now, now);

    // bp-1: pending, queued (with execution record), running, done
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)`).run("n1", "bp-1", 0, "Pending", now, now);
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)`).run("n2", "bp-1", 1, "Queued+Exec", now, now);
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'running', ?, ?)`).run("n3", "bp-1", 2, "Running", now, now);
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'done', ?, ?)`).run("n4", "bp-1", 3, "Done", now, now);

    // bp-2: failed, blocked, queued (no execution record), skipped
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'failed', ?, ?)`).run("n5", "bp-2", 0, "Failed", now, now);
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'blocked', ?, ?)`).run("n6", "bp-2", 1, "Blocked", now, now);
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)`).run("n7", "bp-2", 2, "Queued-Clean", now, now);
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'skipped', ?, ?)`).run("n8", "bp-2", 3, "Skipped", now, now);

    // bp-3: two queued nodes (both orphans)
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)`).run("n9", "bp-3", 0, "Queued-A", now, now);
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)`).run("n10", "bp-3", 1, "Queued-B", now, now);

    // Add interrupted execution record for n2 (bp-1 queued node)
    db.prepare("INSERT INTO node_executions (id, node_id, blueprint_id, session_id, type, status, started_at) VALUES (?, ?, ?, ?, 'primary', 'running', ?)").run("exec-prev", "n2", "bp-1", "sess-old", now);

    // --- Phase 1: Detection ---
    const orphaned = db.prepare("SELECT id, blueprint_id FROM macro_nodes WHERE status = 'queued'")
      .all() as { id: string; blueprint_id: string }[];

    expect(orphaned).toHaveLength(4);
    const orphanIds = orphaned.map(o => o.id).sort();
    expect(orphanIds).toEqual(["n10", "n2", "n7", "n9"]);

    // Verify blueprint distribution
    const bp1Orphans = orphaned.filter(o => o.blueprint_id === "bp-1");
    const bp2Orphans = orphaned.filter(o => o.blueprint_id === "bp-2");
    const bp3Orphans = orphaned.filter(o => o.blueprint_id === "bp-3");
    expect(bp1Orphans).toHaveLength(1);
    expect(bp2Orphans).toHaveLength(1);
    expect(bp3Orphans).toHaveLength(2);

    // --- Phase 2: Simulate requeue + partial failure ---
    // n2 (bp-1): execution succeeds → transitions to done
    db.prepare("UPDATE macro_nodes SET status = 'done' WHERE id = ?").run("n2");

    // n7 (bp-2): execution fails → conditional reset to pending
    const resetN7 = db.prepare("UPDATE macro_nodes SET status = 'pending' WHERE id = ? AND status = 'queued'").run("n7");
    expect(resetN7.changes).toBe(1);

    // n9 (bp-3): transitions to running during execution (no reset possible)
    db.prepare("UPDATE macro_nodes SET status = 'running' WHERE id = ?").run("n9");
    const resetN9 = db.prepare("UPDATE macro_nodes SET status = 'pending' WHERE id = ? AND status = 'queued'").run("n9");
    expect(resetN9.changes).toBe(0); // Already running, conditional reset is no-op

    // n10 (bp-3): still queued, execution hasn't started yet

    // --- Phase 3: Re-detect remaining orphans ---
    const remaining = db.prepare("SELECT id, blueprint_id FROM macro_nodes WHERE status = 'queued'")
      .all() as { id: string; blueprint_id: string }[];

    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe("n10");
    expect(remaining[0].blueprint_id).toBe("bp-3");

    // --- Phase 4: Verify all non-queued nodes are untouched ---
    const allNodes = db.prepare("SELECT id, status FROM macro_nodes ORDER BY id")
      .all() as { id: string; status: string }[];
    const statusMap = Object.fromEntries(allNodes.map(n => [n.id, n.status]));

    expect(statusMap["n1"]).toBe("pending");   // Never touched
    expect(statusMap["n2"]).toBe("done");      // Requeued → succeeded
    expect(statusMap["n3"]).toBe("running");   // Never touched
    expect(statusMap["n4"]).toBe("done");      // Never touched
    expect(statusMap["n5"]).toBe("failed");    // Never touched
    expect(statusMap["n6"]).toBe("blocked");   // Never touched
    expect(statusMap["n7"]).toBe("pending");   // Requeued → failed → reset to pending
    expect(statusMap["n8"]).toBe("skipped");   // Never touched
    expect(statusMap["n9"]).toBe("running");   // Requeued → transitioned to running
    expect(statusMap["n10"]).toBe("queued");   // Still orphaned

    // Verify execution history for n2 is preserved
    const execs = db.prepare("SELECT id, status FROM node_executions WHERE node_id = ?")
      .all("n2") as { id: string; status: string }[];
    expect(execs).toHaveLength(1);
    expect(execs[0].id).toBe("exec-prev");
    expect(execs[0].status).toBe("running");
  });

  it("queued node with execution record preserves execution history", () => {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)`).run("n1", "bp-1", 0, "Queued Node", now, now);

    // The node had a previous execution that was interrupted
    db.prepare(`INSERT INTO node_executions (id, node_id, blueprint_id, session_id, type, status, started_at) VALUES (?, ?, ?, ?, 'primary', 'running', ?)`).run("exec-1", "n1", "bp-1", "sess-abc", now);

    // Orphan detection still finds the queued node
    const orphaned = db.prepare("SELECT id, blueprint_id FROM macro_nodes WHERE status = 'queued'")
      .all() as { id: string; blueprint_id: string }[];
    expect(orphaned).toHaveLength(1);

    // Previous execution record is preserved
    const execs = db.prepare("SELECT id, status FROM node_executions WHERE node_id = ?")
      .all("n1") as { id: string; status: string }[];
    expect(execs).toHaveLength(1);
    expect(execs[0].id).toBe("exec-1");
    expect(execs[0].status).toBe("running");
  });
});

// ─── Smart Stale Execution Recovery ─────────────────────────

describe("smartRecoverStaleExecutions logic", () => {
  let db: Database.Database;

  // Extended schema for recovery tests (needs cli_pid column)
  const RECOVERY_SCHEMA = `
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
      cli_pid INTEGER,
      started_at TEXT NOT NULL, completed_at TEXT
    );
  `;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.exec(RECOVERY_SCHEMA);
    const now = new Date().toISOString();
    db.prepare("INSERT INTO blueprints (id, title, status, project_cwd, created_at, updated_at) VALUES (?, ?, 'running', ?, ?, ?)").run("bp-1", "Recovery Test", "/tmp/project", now, now);
  });
  afterEach(() => { db.close(); });

  it("finds stale running executions with project context", () => {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'running', ?, ?)`).run("n1", "bp-1", 0, "Running", now, now);
    db.prepare("INSERT INTO node_executions (id, node_id, blueprint_id, session_id, cli_pid, status, started_at) VALUES (?, ?, ?, ?, ?, 'running', ?)").run("e1", "n1", "bp-1", "sess-1", 12345, now);

    const stale = db.prepare(`
      SELECT ne.id, ne.node_id, ne.blueprint_id, ne.session_id, ne.cli_pid, ne.started_at, b.project_cwd
      FROM node_executions ne
      JOIN blueprints b ON ne.blueprint_id = b.id
      WHERE ne.status = 'running'
    `).all() as { id: string; node_id: string; blueprint_id: string; session_id: string | null; cli_pid: number | null; started_at: string; project_cwd: string | null }[];

    expect(stale).toHaveLength(1);
    expect(stale[0].id).toBe("e1");
    expect(stale[0].session_id).toBe("sess-1");
    expect(stale[0].cli_pid).toBe(12345);
    expect(stale[0].project_cwd).toBe("/tmp/project");
  });

  it("marks truly dead executions as failed with restart message", () => {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'running', ?, ?)`).run("n1", "bp-1", 0, "DeadNode", now, now);
    db.prepare("INSERT INTO node_executions (id, node_id, blueprint_id, status, started_at) VALUES (?, ?, ?, 'running', ?)").run("e1", "n1", "bp-1", now);

    // Simulate recoverStaleExecutions with no skipIds (all are dead)
    const stale = db.prepare("SELECT id, node_id, blueprint_id FROM node_executions WHERE status = 'running'")
      .all() as { id: string; node_id: string; blueprint_id: string }[];
    const failTime = new Date().toISOString();

    for (const exec of stale) {
      db.prepare("UPDATE node_executions SET status = 'failed', output_summary = 'Server restarted while execution was running', completed_at = ? WHERE id = ?").run(failTime, exec.id);
      db.prepare("UPDATE macro_nodes SET status = 'failed', error = 'Execution interrupted by server restart' WHERE id = ? AND status = 'running'").run(exec.node_id);
    }

    const exec = db.prepare("SELECT status, output_summary FROM node_executions WHERE id = ?").get("e1") as { status: string; output_summary: string };
    expect(exec.status).toBe("failed");
    expect(exec.output_summary).toContain("Server restarted");

    const node = db.prepare("SELECT status, error FROM macro_nodes WHERE id = ?").get("n1") as { status: string; error: string };
    expect(node.status).toBe("failed");
    expect(node.error).toContain("server restart");
  });

  it("skips alive executions when recovering stale ones", () => {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'running', ?, ?)`).run("n1", "bp-1", 0, "Alive", now, now);
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'running', ?, ?)`).run("n2", "bp-1", 1, "Dead", now, now);
    db.prepare("INSERT INTO node_executions (id, node_id, blueprint_id, cli_pid, status, started_at) VALUES (?, ?, ?, ?, 'running', ?)").run("e1", "n1", "bp-1", 99999, now);
    db.prepare("INSERT INTO node_executions (id, node_id, blueprint_id, status, started_at) VALUES (?, ?, ?, 'running', ?)").run("e2", "n2", "bp-1", now);

    // Simulate: e1 is alive (in skipIds), e2 is dead
    const skipIds = new Set(["e1"]);
    const stale = db.prepare("SELECT id, node_id, blueprint_id FROM node_executions WHERE status = 'running'")
      .all() as { id: string; node_id: string; blueprint_id: string }[];

    const toFail = stale.filter(e => !skipIds.has(e.id));
    expect(toFail).toHaveLength(1);
    expect(toFail[0].id).toBe("e2");

    for (const exec of toFail) {
      db.prepare("UPDATE node_executions SET status = 'failed', output_summary = 'Server restarted while execution was running' WHERE id = ?").run(exec.id);
      db.prepare("UPDATE macro_nodes SET status = 'failed' WHERE id = ? AND status = 'running'").run(exec.node_id);
    }

    // e1 should still be running
    const e1 = db.prepare("SELECT status FROM node_executions WHERE id = ?").get("e1") as { status: string };
    expect(e1.status).toBe("running");

    // e2 should be failed
    const e2 = db.prepare("SELECT status FROM node_executions WHERE id = ?").get("e2") as { status: string };
    expect(e2.status).toBe("failed");
  });

  it("resets stuck running blueprints to approved when no active nodes remain", () => {
    const now = new Date().toISOString();
    // All nodes are done/failed, none running/queued
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'done', ?, ?)`).run("n1", "bp-1", 0, "Done", now, now);
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'failed', ?, ?)`).run("n2", "bp-1", 1, "Failed", now, now);

    // Blueprint is still "running" but has no active nodes
    const stuckBlueprints = db.prepare("SELECT id FROM blueprints WHERE status = 'running'").all() as { id: string }[];

    for (const bp of stuckBlueprints) {
      const stillActive = db.prepare("SELECT COUNT(*) as cnt FROM macro_nodes WHERE blueprint_id = ? AND status IN ('running', 'queued')").get(bp.id) as { cnt: number };
      if (stillActive.cnt === 0) {
        db.prepare("UPDATE blueprints SET status = 'approved' WHERE id = ?").run(bp.id);
      }
    }

    const bp = db.prepare("SELECT status FROM blueprints WHERE id = ?").get("bp-1") as { status: string };
    expect(bp.status).toBe("approved");
  });

  it("does not reset blueprints that still have active nodes", () => {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'done', ?, ?)`).run("n1", "bp-1", 0, "Done", now, now);
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)`).run("n2", "bp-1", 1, "Queued", now, now);

    const stillActive = db.prepare("SELECT COUNT(*) as cnt FROM macro_nodes WHERE blueprint_id = ? AND status IN ('running', 'queued')").get("bp-1") as { cnt: number };
    expect(stillActive.cnt).toBe(1);

    // Should NOT reset since there's a queued node
    if (stillActive.cnt === 0) {
      db.prepare("UPDATE blueprints SET status = 'approved' WHERE id = ?").run("bp-1");
    }

    const bp = db.prepare("SELECT status FROM blueprints WHERE id = ?").get("bp-1") as { status: string };
    expect(bp.status).toBe("running");
  });

  it("finds recently-failed restart executions within time window", () => {
    const recentTime = new Date().toISOString();
    const oldTime = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30 min ago

    const now = new Date().toISOString();
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'failed', ?, ?)`).run("n1", "bp-1", 0, "Recent", now, now);
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'failed', ?, ?)`).run("n2", "bp-1", 1, "Old", now, now);

    db.prepare("INSERT INTO node_executions (id, node_id, blueprint_id, session_id, status, output_summary, started_at, completed_at) VALUES (?, ?, ?, ?, 'failed', ?, ?, ?)").run("e1", "n1", "bp-1", "sess-1", "Server restarted while execution was running", now, recentTime);
    db.prepare("INSERT INTO node_executions (id, node_id, blueprint_id, session_id, status, output_summary, started_at, completed_at) VALUES (?, ?, ?, ?, 'failed', ?, ?, ?)").run("e2", "n2", "bp-1", "sess-2", "Server restarted while execution was running", now, oldTime);

    const cutoffMinutes = 10;
    const cutoff = new Date(Date.now() - cutoffMinutes * 60 * 1000).toISOString();
    const recentFailed = db.prepare(`
      SELECT ne.id, ne.node_id, ne.blueprint_id, ne.session_id, ne.cli_pid, ne.started_at, b.project_cwd
      FROM node_executions ne
      JOIN blueprints b ON ne.blueprint_id = b.id
      WHERE ne.status = 'failed'
        AND ne.output_summary LIKE '%Server restarted%'
        AND ne.completed_at > ?
    `).all(cutoff) as { id: string }[];

    // Only the recently-failed one should be found
    expect(recentFailed).toHaveLength(1);
    expect(recentFailed[0].id).toBe("e1");
  });

  it("process liveness check logic", () => {
    // Re-implement isProcessAlive logic
    function isProcessAlive(pid: number): boolean {
      try {
        process.kill(pid, 0); // Signal 0 tests existence without killing
        return true;
      } catch {
        return false;
      }
    }

    // Current process should be alive
    expect(isProcessAlive(process.pid)).toBe(true);

    // A non-existent PID should not be alive (use a very high PID)
    expect(isProcessAlive(2147483647)).toBe(false);
  });

  it("recovery decision tree: alive pid -> monitor, dead pid -> fail", () => {
    // Simulate the smartRecoverStaleExecutions decision logic
    interface StaleExec {
      id: string;
      nodeId: string;
      blueprintId: string;
      sessionId: string | null;
      cliPid: number | null;
      projectCwd: string | null;
    }

    function classifyExecution(
      exec: StaleExec,
      isPidAlive: (pid: number) => boolean,
      isSessionActive: (sessionId: string) => boolean,
    ): "monitor" | "finalize" | "fail" {
      if (!exec.projectCwd) return "fail";

      const pidAlive = exec.cliPid ? isPidAlive(exec.cliPid) : false;
      const sessionActive = exec.sessionId ? isSessionActive(exec.sessionId) : false;

      if (pidAlive || sessionActive) return "monitor";
      if (exec.sessionId) return "finalize"; // Dead but session file exists
      return "fail";
    }

    // Case 1: PID alive -> monitor
    expect(classifyExecution(
      { id: "e1", nodeId: "n1", blueprintId: "bp1", sessionId: null, cliPid: 123, projectCwd: "/tmp" },
      () => true,
      () => false,
    )).toBe("monitor");

    // Case 2: Session active -> monitor
    expect(classifyExecution(
      { id: "e2", nodeId: "n2", blueprintId: "bp1", sessionId: "sess-1", cliPid: null, projectCwd: "/tmp" },
      () => false,
      () => true,
    )).toBe("monitor");

    // Case 3: Both dead, session exists -> finalize (recovered)
    expect(classifyExecution(
      { id: "e3", nodeId: "n3", blueprintId: "bp1", sessionId: "sess-2", cliPid: 456, projectCwd: "/tmp" },
      () => false,
      () => false,
    )).toBe("finalize");

    // Case 4: Truly dead (no session) -> fail
    expect(classifyExecution(
      { id: "e4", nodeId: "n4", blueprintId: "bp1", sessionId: null, cliPid: 789, projectCwd: "/tmp" },
      () => false,
      () => false,
    )).toBe("fail");

    // Case 5: No projectCwd -> fail (can't check liveness)
    expect(classifyExecution(
      { id: "e5", nodeId: "n5", blueprintId: "bp1", sessionId: "sess-3", cliPid: 111, projectCwd: null },
      () => true,
      () => true,
    )).toBe("fail");
  });

  it("recovery monitor timeout after 45 minutes", () => {
    // Simulate the recovery monitor timeout logic
    const MAX_RECOVERY_MS = 45 * 60 * 1000;

    interface RecoveryEntry {
      executionId: string;
      startedAt: string;
      sessionId: string | null;
      checkCount: number;
    }

    function shouldTimeout(entry: RecoveryEntry): boolean {
      const elapsed = Date.now() - new Date(entry.startedAt).getTime();
      return elapsed > MAX_RECOVERY_MS;
    }

    // Recent execution: no timeout
    expect(shouldTimeout({
      executionId: "e1",
      startedAt: new Date().toISOString(),
      sessionId: null,
      checkCount: 0,
    })).toBe(false);

    // Old execution: should timeout
    expect(shouldTimeout({
      executionId: "e2",
      startedAt: new Date(Date.now() - 50 * 60 * 1000).toISOString(),
      sessionId: "sess-1",
      checkCount: 100,
    })).toBe(true);

    // Edge case: exactly at boundary
    expect(shouldTimeout({
      executionId: "e3",
      startedAt: new Date(Date.now() - 45 * 60 * 1000 - 1).toISOString(),
      sessionId: null,
      checkCount: 50,
    })).toBe(true);
  });

  it("timed-out execution with session is finalized, without session is failed", () => {
    // Simulate the timeout handler logic
    function resolveTimedOut(entry: { sessionId: string | null }): "finalize" | "fail" {
      return entry.sessionId ? "finalize" : "fail";
    }

    expect(resolveTimedOut({ sessionId: "sess-1" })).toBe("finalize");
    expect(resolveTimedOut({ sessionId: null })).toBe("fail");
  });

  it("recently-failed execution reverted to running when session still active", () => {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'failed', ?, ?)`).run("n1", "bp-1", 0, "FalselyFailed", now, now);
    db.prepare("INSERT INTO node_executions (id, node_id, blueprint_id, session_id, status, output_summary, started_at, completed_at) VALUES (?, ?, ?, ?, 'failed', ?, ?, ?)").run("e1", "n1", "bp-1", "sess-1", "Server restarted while execution was running", now, now);

    // Simulate reverting a false failure
    db.prepare("UPDATE node_executions SET status = 'running', session_id = ? WHERE id = ?").run("sess-1", "e1");
    db.prepare("UPDATE macro_nodes SET status = 'running', error = '' WHERE id = ?").run("n1");

    const exec = db.prepare("SELECT status, session_id FROM node_executions WHERE id = ?").get("e1") as { status: string; session_id: string };
    expect(exec.status).toBe("running");
    expect(exec.session_id).toBe("sess-1");

    const node = db.prepare("SELECT status, error FROM macro_nodes WHERE id = ?").get("n1") as { status: string; error: string };
    expect(node.status).toBe("running");
    expect(node.error).toBe("");
  });

  it("finalized recovered execution is marked done with artifact context", () => {
    const startedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // Started 10 min ago
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'running', ?, ?)`).run("n1", "bp-1", 0, "Recovered", now, now);
    db.prepare("INSERT INTO node_executions (id, node_id, blueprint_id, session_id, status, started_at) VALUES (?, ?, ?, ?, 'running', ?)").run("e1", "n1", "bp-1", "sess-1", startedAt);

    // Simulate finalizeRecoveredExecution
    const elapsed = (Date.now() - new Date(startedAt).getTime()) / 60_000;
    const completedAt = new Date().toISOString();

    db.prepare("UPDATE node_executions SET status = 'done', session_id = ?, completed_at = ?, output_summary = ? WHERE id = ?")
      .run("sess-1", completedAt, "Recovered after server restart -- session completed successfully", "e1");
    db.prepare("UPDATE macro_nodes SET status = 'done', error = '', actual_minutes = ? WHERE id = ?")
      .run(Math.round(elapsed * 10) / 10, "n1");

    const exec = db.prepare("SELECT status, output_summary, session_id FROM node_executions WHERE id = ?").get("e1") as { status: string; output_summary: string; session_id: string };
    expect(exec.status).toBe("done");
    expect(exec.output_summary).toContain("Recovered after server restart");
    expect(exec.session_id).toBe("sess-1");

    const node = db.prepare("SELECT status, actual_minutes FROM macro_nodes WHERE id = ?").get("n1") as { status: string; actual_minutes: number };
    expect(node.status).toBe("done");
    expect(node.actual_minutes).toBeGreaterThan(0);
  });

  it("recovery does not claim sessions that belong to other executions", () => {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'running', ?, ?)`).run("n1", "bp-1", 0, "Node1", now, now);
    db.prepare(`INSERT INTO macro_nodes (id, blueprint_id, "order", title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'failed', ?, ?)`).run("n2", "bp-1", 1, "Node2", now, now);
    db.prepare("INSERT INTO node_executions (id, node_id, blueprint_id, session_id, status, started_at) VALUES (?, ?, ?, ?, 'running', ?)").run("e1", "n1", "bp-1", "sess-1", now);
    db.prepare("INSERT INTO node_executions (id, node_id, blueprint_id, session_id, status, output_summary, started_at, completed_at) VALUES (?, ?, ?, ?, 'failed', ?, ?, ?)").run("e2", "n2", "bp-1", null, "Server restarted while execution was running", now, now);

    // Simulate: trying to detect session for e2, but sess-1 already belongs to e1
    const detectedSession = "sess-1";
    const existing = db.prepare("SELECT id FROM node_executions WHERE session_id = ?").get(detectedSession) as { id: string } | undefined;

    // Should NOT assign because it belongs to e1
    expect(existing).toBeDefined();
    expect(existing!.id).toBe("e1");

    // The logic should skip: if (existing && existing.id !== exec.id) continue;
    const shouldSkip = existing && existing.id !== "e2";
    expect(shouldSkip).toBe(true);
  });
});
