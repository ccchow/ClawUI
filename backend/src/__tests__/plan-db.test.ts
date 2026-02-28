import { describe, it, expect, beforeAll } from "vitest";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

// We need to set up a real SQLite DB for plan-db tests since the module
// relies on getDb() from db.ts. We'll initialize the DB before tests.

// The plan-db module uses getDb() which requires initDb() to have been called.
// We'll initialize a temporary database.

describe("plan-db", () => {
  beforeAll(async () => {
    const tmpDir = join(tmpdir(), `clawui-plandb-test-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });

    // Import db module and initialize with a temp database
    // Since db.ts uses hardcoded paths, we need to use initDb() which creates
    // the DB at the project's .clawui/index.db path.
    // For isolation, we'll just use the real initDb and test plan functions.
    const { initDb } = await import("../db.js");
    initDb();

    const { initPlanTables } = await import("../plan-db.js");
    initPlanTables();
  });

  it("createBlueprint and getBlueprint", async () => {
    const { createBlueprint, getBlueprint } = await import("../plan-db.js");

    const bp = createBlueprint("Test Plan", "A test description", "/tmp/test");
    expect(bp.id).toBeDefined();
    expect(bp.title).toBe("Test Plan");
    expect(bp.description).toBe("A test description");
    expect(bp.status).toBe("draft");
    expect(bp.projectCwd).toBe("/tmp/test");
    expect(bp.nodes).toEqual([]);

    const fetched = getBlueprint(bp.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.title).toBe("Test Plan");
    expect(fetched!.nodes).toEqual([]);
  });

  it("getBlueprint returns null for non-existent id", async () => {
    const { getBlueprint } = await import("../plan-db.js");
    expect(getBlueprint("non-existent-id")).toBeNull();
  });

  it("listBlueprints returns all blueprints", { timeout: 30_000 }, async () => {
    const { createBlueprint, listBlueprints } = await import("../plan-db.js");

    const cwd = `/tmp/list-test-${randomUUID()}`;
    const bp = createBlueprint(`List Test ${randomUUID()}`, undefined, cwd);
    const list = listBlueprints({ projectCwd: cwd });
    expect(list.length).toBeGreaterThan(0);
    expect(list.some((b) => b.id === bp.id)).toBe(true);
  });

  it("listBlueprints filters by status", { timeout: 30_000 }, async () => {
    const { createBlueprint, updateBlueprint, listBlueprints } = await import("../plan-db.js");

    const cwd = `/tmp/filter-test-${randomUUID()}`;
    const bp = createBlueprint(`Filter Test ${randomUUID()}`, undefined, cwd);
    updateBlueprint(bp.id, { status: "approved" });

    const drafts = listBlueprints({ status: "draft", projectCwd: cwd });
    expect(drafts.every((b) => b.status === "draft")).toBe(true);

    const approved = listBlueprints({ status: "approved", projectCwd: cwd });
    expect(approved.some((b) => b.id === bp.id)).toBe(true);
  });

  it("updateBlueprint modifies fields", async () => {
    const { createBlueprint, updateBlueprint } = await import("../plan-db.js");

    const bp = createBlueprint("Update Me");
    const updated = updateBlueprint(bp.id, {
      title: "Updated Title",
      status: "approved",
    });
    expect(updated).not.toBeNull();
    expect(updated!.title).toBe("Updated Title");
    expect(updated!.status).toBe("approved");
  });

  it("updateBlueprint returns null for missing id", async () => {
    const { updateBlueprint } = await import("../plan-db.js");
    expect(updateBlueprint("nonexistent", { title: "x" })).toBeNull();
  });

  it("deleteBlueprint removes the blueprint", async () => {
    const { createBlueprint, getBlueprint, deleteBlueprint } = await import("../plan-db.js");

    const bp = createBlueprint("Delete Me");
    deleteBlueprint(bp.id);
    expect(getBlueprint(bp.id)).toBeNull();
  });

  // ─── MacroNode CRUD ────────────────────────────────────────

  it("createMacroNode and retrieve via getBlueprint", async () => {
    const { createBlueprint, createMacroNode, getBlueprint } = await import("../plan-db.js");

    const bp = createBlueprint("Node Test");
    const node = createMacroNode(bp.id, {
      title: "Step 1",
      description: "Do something",
      order: 0,
      dependencies: [],
    });

    expect(node.id).toBeDefined();
    expect(node.title).toBe("Step 1");
    expect(node.status).toBe("pending");
    expect(node.dependencies).toEqual([]);

    const fetched = getBlueprint(bp.id);
    expect(fetched!.nodes).toHaveLength(1);
    expect(fetched!.nodes[0].id).toBe(node.id);
  });

  it("createMacroNode with dependencies", async () => {
    const { createBlueprint, createMacroNode, getBlueprint } = await import("../plan-db.js");

    const bp = createBlueprint("Deps Test");
    const node1 = createMacroNode(bp.id, { title: "Step 1", order: 0 });
    const node2 = createMacroNode(bp.id, {
      title: "Step 2",
      order: 1,
      dependencies: [node1.id],
    });

    const fetched = getBlueprint(bp.id);
    const fetchedNode2 = fetched!.nodes.find((n) => n.id === node2.id);
    expect(fetchedNode2!.dependencies).toEqual([node1.id]);
  });

  it("updateMacroNode modifies fields", async () => {
    const { createBlueprint, createMacroNode, updateMacroNode } = await import("../plan-db.js");

    const bp = createBlueprint("Update Node Test");
    const node = createMacroNode(bp.id, { title: "Original", order: 0 });

    const updated = updateMacroNode(bp.id, node.id, {
      title: "Modified",
      status: "done",
      description: "updated desc",
    });
    expect(updated).not.toBeNull();
    expect(updated!.title).toBe("Modified");
    expect(updated!.status).toBe("done");
  });

  it("updateMacroNode returns null for missing node", async () => {
    const { createBlueprint, updateMacroNode } = await import("../plan-db.js");

    const bp = createBlueprint("Missing Node Test");
    expect(updateMacroNode(bp.id, "nonexistent", { title: "x" })).toBeNull();
  });

  it("deleteMacroNode removes the node", async () => {
    const { createBlueprint, createMacroNode, deleteMacroNode, getBlueprint } = await import("../plan-db.js");

    const bp = createBlueprint("Delete Node Test");
    const node = createMacroNode(bp.id, { title: "To Delete", order: 0 });
    deleteMacroNode(bp.id, node.id);

    const fetched = getBlueprint(bp.id);
    expect(fetched!.nodes).toHaveLength(0);
  });

  it("reorderMacroNodes changes order", async () => {
    const { createBlueprint, createMacroNode, reorderMacroNodes, getBlueprint } = await import("../plan-db.js");

    const bp = createBlueprint("Reorder Test");
    const n1 = createMacroNode(bp.id, { title: "A", order: 0 });
    const n2 = createMacroNode(bp.id, { title: "B", order: 1 });

    reorderMacroNodes(bp.id, [
      { id: n1.id, order: 1 },
      { id: n2.id, order: 0 },
    ]);

    const fetched = getBlueprint(bp.id);
    expect(fetched!.nodes[0].id).toBe(n2.id);
    expect(fetched!.nodes[1].id).toBe(n1.id);
  });

  // ─── Artifact CRUD ─────────────────────────────────────────

  it("createArtifact and getArtifactsForNode", async () => {
    const {
      createBlueprint,
      createMacroNode,
      createArtifact,
      getArtifactsForNode,
    } = await import("../plan-db.js");

    const bp = createBlueprint("Artifact Test");
    const n1 = createMacroNode(bp.id, { title: "Source", order: 0 });
    const n2 = createMacroNode(bp.id, { title: "Target", order: 1 });

    const art = createArtifact(bp.id, n1.id, "handoff_summary", "Summary content", n2.id);
    expect(art.id).toBeDefined();
    expect(art.type).toBe("handoff_summary");
    expect(art.sourceNodeId).toBe(n1.id);
    expect(art.targetNodeId).toBe(n2.id);

    const outputArtifacts = getArtifactsForNode(n1.id, "output");
    expect(outputArtifacts).toHaveLength(1);
    expect(outputArtifacts[0].content).toBe("Summary content");

    const inputArtifacts = getArtifactsForNode(n2.id, "input");
    expect(inputArtifacts).toHaveLength(1);
  });

  it("deleteArtifact removes the artifact", async () => {
    const { createBlueprint, createMacroNode, createArtifact, deleteArtifact, getArtifactsForNode } = await import("../plan-db.js");

    const bp = createBlueprint("Delete Artifact Test");
    const n = createMacroNode(bp.id, { title: "N", order: 0 });
    const art = createArtifact(bp.id, n.id, "custom", "content");

    deleteArtifact(art.id);
    expect(getArtifactsForNode(n.id, "output")).toHaveLength(0);
  });

  // ─── Execution CRUD ────────────────────────────────────────

  it("createExecution and getExecutionsForNode", async () => {
    const { createBlueprint, createMacroNode, createExecution, getExecutionsForNode } = await import("../plan-db.js");

    const bp = createBlueprint("Execution Test");
    const n = createMacroNode(bp.id, { title: "E", order: 0 });

    const exec = createExecution(n.id, bp.id, "session-1", "primary", "context");
    expect(exec.id).toBeDefined();
    expect(exec.nodeId).toBe(n.id);
    expect(exec.type).toBe("primary");
    expect(exec.status).toBe("running");

    const execs = getExecutionsForNode(n.id);
    expect(execs).toHaveLength(1);
    expect(execs[0].sessionId).toBe("session-1");
  });

  it("updateExecution modifies fields", async () => {
    const { createBlueprint, createMacroNode, createExecution, updateExecution } = await import("../plan-db.js");

    const bp = createBlueprint("Update Exec Test");
    const n = createMacroNode(bp.id, { title: "UE", order: 0 });
    const exec = createExecution(n.id, bp.id, undefined, "primary");

    const updated = updateExecution(exec.id, {
      status: "done",
      outputSummary: "All done",
      completedAt: "2024-01-01T01:00:00Z",
    });
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("done");
    expect(updated!.outputSummary).toBe("All done");
    expect(updated!.completedAt).toBe("2024-01-01T01:00:00Z");
  });

  it("updateExecution returns null for missing id", async () => {
    const { updateExecution } = await import("../plan-db.js");
    expect(updateExecution("nonexistent", { status: "done" })).toBeNull();
  });

  it("getExecutionBySession returns execution by session ID", async () => {
    const { createBlueprint, createMacroNode, createExecution, getExecutionBySession } = await import("../plan-db.js");

    const bp = createBlueprint("Session Exec Test");
    const n = createMacroNode(bp.id, { title: "SE", order: 0 });
    const sessionId = `session-${randomUUID()}`;
    createExecution(n.id, bp.id, sessionId, "primary");

    const found = getExecutionBySession(sessionId);
    expect(found).not.toBeNull();
    expect(found!.sessionId).toBe(sessionId);
  });

  it("getExecutionBySession returns null when not found", async () => {
    const { getExecutionBySession } = await import("../plan-db.js");
    expect(getExecutionBySession("nonexistent-session")).toBeNull();
  });

  it("getNodeBySession returns node linked through execution", async () => {
    const { createBlueprint, createMacroNode, createExecution, getNodeBySession } = await import("../plan-db.js");

    const bp = createBlueprint("Node By Session Test");
    const n = createMacroNode(bp.id, { title: "NBS", order: 0 });
    const sessionId = `session-${randomUUID()}`;
    createExecution(n.id, bp.id, sessionId, "primary");

    const found = getNodeBySession(sessionId);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(n.id);
  });

  // ─── Backward-compat aliases ───────────────────────────────

  it("backward-compat createNode alias works", async () => {
    const { createBlueprint, createNode } = await import("../plan-db.js");

    const bp = createBlueprint("Compat Test");
    const node = createNode(bp.id, { title: "Compat Step", seq: 0 });
    expect(node.title).toBe("Compat Step");
    expect(node.order).toBe(0);
  });

  it("cascade delete removes nodes when blueprint is deleted", async () => {
    const { createBlueprint, createMacroNode, deleteBlueprint } = await import("../plan-db.js");
    const { getDb } = await import("../db.js");

    const bp = createBlueprint("Cascade Test");
    createMacroNode(bp.id, { title: "C1", order: 0 });
    createMacroNode(bp.id, { title: "C2", order: 1 });

    deleteBlueprint(bp.id);

    // Verify nodes are also gone
    const db = getDb();
    const rows = db
      .prepare("SELECT COUNT(*) as cnt FROM macro_nodes WHERE blueprint_id = ?")
      .get(bp.id) as { cnt: number };
    expect(rows.cnt).toBe(0);
  });

  it("createExecution with explicit status and completedAt", async () => {
    const { createBlueprint, createMacroNode, createExecution } = await import("../plan-db.js");

    const bp = createBlueprint("Explicit Status Test");
    const n = createMacroNode(bp.id, { title: "ES", order: 0 });

    const exec = createExecution(
      n.id,
      bp.id,
      "s1",
      "retry",
      "input context",
      undefined,
      "done",
      "output summary",
      "2024-06-01T00:00:00Z"
    );
    expect(exec.status).toBe("done");
    expect(exec.outputSummary).toBe("output summary");
    expect(exec.completedAt).toBe("2024-06-01T00:00:00Z");
  });

  // ─── Archive / Unarchive ──────────────────────────────────

  it("archiveBlueprint sets archivedAt timestamp", async () => {
    const { createBlueprint, archiveBlueprint } = await import("../plan-db.js");

    const bp = createBlueprint("Archive Test");
    expect(bp.archivedAt).toBeUndefined();

    const archived = archiveBlueprint(bp.id);
    expect(archived).not.toBeNull();
    expect(archived!.archivedAt).toBeDefined();
  });

  it("archiveBlueprint returns null for non-existent id", async () => {
    const { archiveBlueprint } = await import("../plan-db.js");
    expect(archiveBlueprint("nonexistent")).toBeNull();
  });

  it("unarchiveBlueprint clears archivedAt", async () => {
    const { createBlueprint, archiveBlueprint, unarchiveBlueprint } = await import("../plan-db.js");

    const bp = createBlueprint("Unarchive Test");
    archiveBlueprint(bp.id);

    const unarchived = unarchiveBlueprint(bp.id);
    expect(unarchived).not.toBeNull();
    expect(unarchived!.archivedAt).toBeUndefined();
  });

  it("unarchiveBlueprint returns null for non-existent id", async () => {
    const { unarchiveBlueprint } = await import("../plan-db.js");
    expect(unarchiveBlueprint("nonexistent")).toBeNull();
  });

  it("listBlueprints excludes archived by default", { timeout: 30_000 }, async () => {
    const { createBlueprint, archiveBlueprint, listBlueprints } = await import("../plan-db.js");

    const cwd = `/tmp/archived-list-test-${randomUUID()}`;
    const bp = createBlueprint(`Archived List Test ${randomUUID()}`, undefined, cwd);
    archiveBlueprint(bp.id);

    const list = listBlueprints({ projectCwd: cwd });
    expect(list.some((b) => b.id === bp.id)).toBe(false);
  });

  it("listBlueprints includes archived when includeArchived=true", { timeout: 30_000 }, async () => {
    const { createBlueprint, archiveBlueprint, listBlueprints } = await import("../plan-db.js");

    const cwd = `/tmp/archived-include-test-${randomUUID()}`;
    const bp = createBlueprint(`Archived Include Test ${randomUUID()}`, undefined, cwd);
    archiveBlueprint(bp.id);

    const list = listBlueprints({ includeArchived: true, projectCwd: cwd });
    expect(list.some((b) => b.id === bp.id)).toBe(true);
  });

  // ─── Star / Unstar ──────────────────────────────────────────

  it("starBlueprint sets starred to true", async () => {
    const { createBlueprint, starBlueprint } = await import("../plan-db.js");

    const bp = createBlueprint("Star Test");
    expect(bp.starred).toBeFalsy();

    const starred = starBlueprint(bp.id);
    expect(starred).not.toBeNull();
    expect(starred!.starred).toBe(true);
  });

  it("starBlueprint returns null for non-existent id", async () => {
    const { starBlueprint } = await import("../plan-db.js");
    expect(starBlueprint("nonexistent")).toBeNull();
  });

  it("unstarBlueprint clears starred", async () => {
    const { createBlueprint, starBlueprint, unstarBlueprint } = await import("../plan-db.js");

    const bp = createBlueprint("Unstar Test");
    starBlueprint(bp.id);

    const unstarred = unstarBlueprint(bp.id);
    expect(unstarred).not.toBeNull();
    expect(unstarred!.starred).toBeFalsy();
  });

  it("unstarBlueprint returns null for non-existent id", async () => {
    const { unstarBlueprint } = await import("../plan-db.js");
    expect(unstarBlueprint("nonexistent")).toBeNull();
  });

  it("starBlueprint does not change blueprint status", async () => {
    const { createBlueprint, updateBlueprint, starBlueprint } = await import("../plan-db.js");

    const bp = createBlueprint("Star Status Test");
    updateBlueprint(bp.id, { status: "approved" });

    const starred = starBlueprint(bp.id);
    expect(starred).not.toBeNull();
    expect(starred!.status).toBe("approved");
    expect(starred!.starred).toBe(true);
  });

  it("unstarBlueprint does not change blueprint status", async () => {
    const { createBlueprint, updateBlueprint, starBlueprint, unstarBlueprint } = await import("../plan-db.js");

    const bp = createBlueprint("Unstar Status Test");
    updateBlueprint(bp.id, { status: "running" });
    starBlueprint(bp.id);

    const unstarred = unstarBlueprint(bp.id);
    expect(unstarred).not.toBeNull();
    expect(unstarred!.status).toBe("running");
    expect(unstarred!.starred).toBeFalsy();
  });

  it("starBlueprint does not create executions or change node statuses", async () => {
    const { createBlueprint, createMacroNode, starBlueprint, getBlueprint } = await import("../plan-db.js");

    const bp = createBlueprint("Star No Exec Test");
    createMacroNode(bp.id, { title: "Node 1", order: 0 });
    createMacroNode(bp.id, { title: "Node 2", order: 1 });

    const beforeStar = getBlueprint(bp.id);
    expect(beforeStar!.nodes).toHaveLength(2);
    const nodeStatusesBefore = beforeStar!.nodes.map((n) => n.status);
    const execCountBefore = beforeStar!.nodes.reduce((sum, n) => sum + n.executions.length, 0);

    starBlueprint(bp.id);

    const afterStar = getBlueprint(bp.id);
    expect(afterStar!.nodes).toHaveLength(2);
    const nodeStatusesAfter = afterStar!.nodes.map((n) => n.status);
    const execCountAfter = afterStar!.nodes.reduce((sum, n) => sum + n.executions.length, 0);

    expect(nodeStatusesAfter).toEqual(nodeStatusesBefore);
    expect(execCountAfter).toBe(execCountBefore);
  });

  it("listBlueprints returns starred blueprints first", { timeout: 30_000 }, async () => {
    const { createBlueprint, starBlueprint, listBlueprints } = await import("../plan-db.js");

    const cwd = `/tmp/starred-order-test-${randomUUID()}`;
    const bp1 = createBlueprint(`Starred Order A ${randomUUID()}`, undefined, cwd);
    const bp2 = createBlueprint(`Starred Order B ${randomUUID()}`, undefined, cwd);
    starBlueprint(bp1.id);

    const list = listBlueprints({ projectCwd: cwd });
    const idx1 = list.findIndex((b) => b.id === bp1.id);
    const idx2 = list.findIndex((b) => b.id === bp2.id);
    // Starred bp1 should appear before non-starred bp2
    expect(idx1).toBeLessThan(idx2);
  });

  // ─── Execution callback columns ───────────────────────────

  it("setExecutionBlocker stores blocker info", async () => {
    const { createBlueprint, createMacroNode, createExecution, setExecutionBlocker, getExecution } = await import("../plan-db.js");

    const bp = createBlueprint("Blocker Test");
    const n = createMacroNode(bp.id, { title: "B", order: 0 });
    const exec = createExecution(n.id, bp.id, undefined, "primary");

    const blockerJson = JSON.stringify({ type: "missing_dependency", description: "Redis not installed" });
    setExecutionBlocker(exec.id, blockerJson);

    const fetched = getExecution(exec.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.blockerInfo).toBe(blockerJson);
  });

  it("setExecutionTaskSummary stores task summary", async () => {
    const { createBlueprint, createMacroNode, createExecution, setExecutionTaskSummary, getExecution } = await import("../plan-db.js");

    const bp = createBlueprint("Summary Test");
    const n = createMacroNode(bp.id, { title: "S", order: 0 });
    const exec = createExecution(n.id, bp.id, undefined, "primary");

    setExecutionTaskSummary(exec.id, "Implemented JWT auth");

    const fetched = getExecution(exec.id);
    expect(fetched!.taskSummary).toBe("Implemented JWT auth");
  });

  it("setExecutionReportedStatus stores status and reason", async () => {
    const { createBlueprint, createMacroNode, createExecution, setExecutionReportedStatus, getExecution } = await import("../plan-db.js");

    const bp = createBlueprint("Reported Status Test");
    const n = createMacroNode(bp.id, { title: "RS", order: 0 });
    const exec = createExecution(n.id, bp.id, undefined, "primary");

    setExecutionReportedStatus(exec.id, "done");
    let fetched = getExecution(exec.id);
    expect(fetched!.reportedStatus).toBe("done");
    expect(fetched!.reportedReason).toBeUndefined();

    setExecutionReportedStatus(exec.id, "failed", "Tests didn't pass");
    fetched = getExecution(exec.id);
    expect(fetched!.reportedStatus).toBe("failed");
    expect(fetched!.reportedReason).toBe("Tests didn't pass");
  });

  it("getExecution returns null for non-existent id", async () => {
    const { getExecution } = await import("../plan-db.js");
    expect(getExecution("nonexistent-exec")).toBeNull();
  });

  // ─── Execution context health columns ─────────────────────

  it("updateExecution stores context health metrics", async () => {
    const { createBlueprint, createMacroNode, createExecution, updateExecution, getExecution } = await import("../plan-db.js");

    const bp = createBlueprint("Context Health Test");
    const n = createMacroNode(bp.id, { title: "CH", order: 0 });
    const exec = createExecution(n.id, bp.id, undefined, "primary");

    updateExecution(exec.id, {
      compactCount: 3,
      peakTokens: 167000,
      contextPressure: "critical",
    });

    const fetched = getExecution(exec.id);
    expect(fetched!.compactCount).toBe(3);
    expect(fetched!.peakTokens).toBe(167000);
    expect(fetched!.contextPressure).toBe("critical");
  });

  it("updateExecution stores failure reason", async () => {
    const { createBlueprint, createMacroNode, createExecution, updateExecution, getExecution } = await import("../plan-db.js");

    const bp = createBlueprint("Failure Reason Test");
    const n = createMacroNode(bp.id, { title: "FR", order: 0 });
    const exec = createExecution(n.id, bp.id, undefined, "primary");

    updateExecution(exec.id, {
      status: "failed",
      failureReason: "context_exhausted",
    });

    const fetched = getExecution(exec.id);
    expect(fetched!.status).toBe("failed");
    expect(fetched!.failureReason).toBe("context_exhausted");
  });

  it("updateExecution stores cliPid for process tracking", async () => {
    const { createBlueprint, createMacroNode, createExecution, updateExecution, getExecution } = await import("../plan-db.js");

    const bp = createBlueprint("CLI PID Test");
    const n = createMacroNode(bp.id, { title: "PID", order: 0 });
    const exec = createExecution(n.id, bp.id, undefined, "primary");

    updateExecution(exec.id, { cliPid: 12345 });

    const fetched = getExecution(exec.id);
    expect(fetched!.cliPid).toBe(12345);
  });

  // ─── Recovery functions ───────────────────────────────────

  it("getStaleRunningExecutions returns running executions", async () => {
    const { createBlueprint, createMacroNode, createExecution, getStaleRunningExecutions } = await import("../plan-db.js");

    const sessionId = `stale-session-${randomUUID()}`;
    const bp = createBlueprint("Stale Exec Test", "desc", "/tmp/stale-test");
    const n = createMacroNode(bp.id, { title: "Stale", order: 0 });
    createExecution(n.id, bp.id, sessionId, "primary");

    const stale = getStaleRunningExecutions();
    expect(stale.length).toBeGreaterThan(0);
    const found = stale.find((e) => e.sessionId === sessionId);
    expect(found).toBeDefined();
    expect(found!.blueprintId).toBe(bp.id);
    expect(found!.nodeId).toBe(n.id);
    expect(found!.projectCwd).toBe("/tmp/stale-test");
  });

  it("getOrphanedQueuedNodes returns queued nodes", async () => {
    const { createBlueprint, createMacroNode, updateMacroNode, getOrphanedQueuedNodes } = await import("../plan-db.js");

    const bp = createBlueprint("Orphan Test");
    const n = createMacroNode(bp.id, { title: "Queued Node", order: 0 });
    updateMacroNode(bp.id, n.id, { status: "queued" });

    const orphaned = getOrphanedQueuedNodes();
    expect(orphaned.some((o) => o.id === n.id && o.blueprintId === bp.id)).toBe(true);
  });

  it("getOrphanedQueuedNodes returns empty when no queued nodes exist", async () => {
    const { createBlueprint, createMacroNode, getOrphanedQueuedNodes } = await import("../plan-db.js");

    const bp = createBlueprint("No Orphans Plan");
    createMacroNode(bp.id, { title: "Pending Node", order: 0 });
    // Node stays in default 'pending' status — should not appear as orphaned

    const orphaned = getOrphanedQueuedNodes();
    expect(orphaned.every((o) => o.blueprintId !== bp.id)).toBe(true);
  });

  it("getOrphanedQueuedNodes excludes non-queued statuses", async () => {
    const { createBlueprint, createMacroNode, updateMacroNode, getOrphanedQueuedNodes } = await import("../plan-db.js");

    const bp = createBlueprint("Mixed Status Orphan Test");
    const pending = createMacroNode(bp.id, { title: "Pending", order: 0 });
    const running = createMacroNode(bp.id, { title: "Running", order: 1 });
    const done = createMacroNode(bp.id, { title: "Done", order: 2 });
    const failed = createMacroNode(bp.id, { title: "Failed", order: 3 });
    const queued = createMacroNode(bp.id, { title: "Queued", order: 4 });

    updateMacroNode(bp.id, running.id, { status: "running" });
    updateMacroNode(bp.id, done.id, { status: "done" });
    updateMacroNode(bp.id, failed.id, { status: "failed" });
    updateMacroNode(bp.id, queued.id, { status: "queued" });
    // pending stays at default

    const orphaned = getOrphanedQueuedNodes();
    const bpOrphans = orphaned.filter((o) => o.blueprintId === bp.id);

    expect(bpOrphans).toHaveLength(1);
    expect(bpOrphans[0].id).toBe(queued.id);
    // Verify excluded statuses don't appear
    expect(bpOrphans.some((o) => o.id === pending.id)).toBe(false);
    expect(bpOrphans.some((o) => o.id === running.id)).toBe(false);
    expect(bpOrphans.some((o) => o.id === done.id)).toBe(false);
    expect(bpOrphans.some((o) => o.id === failed.id)).toBe(false);
  });

  it("getOrphanedQueuedNodes returns multiple queued nodes across blueprints", async () => {
    const { createBlueprint, createMacroNode, updateMacroNode, getOrphanedQueuedNodes } = await import("../plan-db.js");

    const bp1 = createBlueprint("Orphan BP1");
    const bp2 = createBlueprint("Orphan BP2");
    const n1 = createMacroNode(bp1.id, { title: "Q1", order: 0 });
    const n2 = createMacroNode(bp1.id, { title: "Q2", order: 1 });
    const n3 = createMacroNode(bp2.id, { title: "Q3", order: 0 });

    updateMacroNode(bp1.id, n1.id, { status: "queued" });
    updateMacroNode(bp1.id, n2.id, { status: "queued" });
    updateMacroNode(bp2.id, n3.id, { status: "queued" });

    const orphaned = getOrphanedQueuedNodes();

    // All three queued nodes should appear
    expect(orphaned.some((o) => o.id === n1.id && o.blueprintId === bp1.id)).toBe(true);
    expect(orphaned.some((o) => o.id === n2.id && o.blueprintId === bp1.id)).toBe(true);
    expect(orphaned.some((o) => o.id === n3.id && o.blueprintId === bp2.id)).toBe(true);
  });

  it("getOrphanedQueuedNodes maps blueprint_id to blueprintId correctly", async () => {
    const { createBlueprint, createMacroNode, updateMacroNode, getOrphanedQueuedNodes } = await import("../plan-db.js");

    const bp = createBlueprint("Field Mapping Test");
    const n = createMacroNode(bp.id, { title: "Mapped Node", order: 0 });
    updateMacroNode(bp.id, n.id, { status: "queued" });

    const orphaned = getOrphanedQueuedNodes();
    const found = orphaned.find((o) => o.id === n.id);

    expect(found).toBeDefined();
    // Verify camelCase field mapping (not snake_case from DB)
    expect(found!.blueprintId).toBe(bp.id);
    expect((found as Record<string, unknown>)["blueprint_id"]).toBeUndefined();
  });

  it("getOrphanedQueuedNodes excludes all non-queued statuses including blocked and skipped", async () => {
    const { createBlueprint, createMacroNode, updateMacroNode, getOrphanedQueuedNodes } = await import("../plan-db.js");

    const bp = createBlueprint("Full Mixed Status Orphan Test");
    const pending = createMacroNode(bp.id, { title: "Pending", order: 0 });
    const running = createMacroNode(bp.id, { title: "Running", order: 1 });
    const done = createMacroNode(bp.id, { title: "Done", order: 2 });
    const failed = createMacroNode(bp.id, { title: "Failed", order: 3 });
    const blocked = createMacroNode(bp.id, { title: "Blocked", order: 4 });
    const skipped = createMacroNode(bp.id, { title: "Skipped", order: 5 });
    const queued1 = createMacroNode(bp.id, { title: "Queued 1", order: 6 });
    const queued2 = createMacroNode(bp.id, { title: "Queued 2", order: 7 });

    updateMacroNode(bp.id, running.id, { status: "running" });
    updateMacroNode(bp.id, done.id, { status: "done" });
    updateMacroNode(bp.id, failed.id, { status: "failed" });
    updateMacroNode(bp.id, blocked.id, { status: "blocked" });
    updateMacroNode(bp.id, skipped.id, { status: "skipped" });
    updateMacroNode(bp.id, queued1.id, { status: "queued" });
    updateMacroNode(bp.id, queued2.id, { status: "queued" });
    // pending stays at default

    const orphaned = getOrphanedQueuedNodes();
    const bpOrphans = orphaned.filter((o) => o.blueprintId === bp.id);

    // Only the two queued nodes should be detected
    expect(bpOrphans).toHaveLength(2);
    const orphanIds = bpOrphans.map((o) => o.id).sort();
    expect(orphanIds).toEqual([queued1.id, queued2.id].sort());

    // Verify every non-queued status is excluded
    expect(bpOrphans.some((o) => o.id === pending.id)).toBe(false);
    expect(bpOrphans.some((o) => o.id === running.id)).toBe(false);
    expect(bpOrphans.some((o) => o.id === done.id)).toBe(false);
    expect(bpOrphans.some((o) => o.id === failed.id)).toBe(false);
    expect(bpOrphans.some((o) => o.id === blocked.id)).toBe(false);
    expect(bpOrphans.some((o) => o.id === skipped.id)).toBe(false);
  });

  it("recoverStaleExecutions marks dead executions as failed", async () => {
    const { createBlueprint, createMacroNode, createExecution, updateMacroNode, recoverStaleExecutions, getExecution } = await import("../plan-db.js");

    const bp = createBlueprint("Recovery Test");
    const n = createMacroNode(bp.id, { title: "Recover", order: 0 });
    updateMacroNode(bp.id, n.id, { status: "running" });
    const exec = createExecution(n.id, bp.id, undefined, "primary");

    recoverStaleExecutions();

    const fetched = getExecution(exec.id);
    expect(fetched!.status).toBe("failed");
    expect(fetched!.outputSummary).toContain("Server restarted");
  });

  it("recoverStaleExecutions skips executions in skipIds", async () => {
    const { createBlueprint, createMacroNode, createExecution, updateMacroNode, recoverStaleExecutions, getExecution } = await import("../plan-db.js");

    const bp = createBlueprint("Recovery Skip Test");
    const n = createMacroNode(bp.id, { title: "Skip Recover", order: 0 });
    updateMacroNode(bp.id, n.id, { status: "running" });
    const exec = createExecution(n.id, bp.id, undefined, "primary");

    const skipIds = new Set([exec.id]);
    recoverStaleExecutions(skipIds);

    const fetched = getExecution(exec.id);
    // Should still be running since it was in skipIds
    expect(fetched!.status).toBe("running");
  });

  // ─── Related Sessions CRUD ────────────────────────────────

  it("createRelatedSession and getRelatedSessionsForNode", async () => {
    const { createBlueprint, createMacroNode, createRelatedSession, getRelatedSessionsForNode } = await import("../plan-db.js");

    const bp = createBlueprint("Related Session Test");
    const n = createMacroNode(bp.id, { title: "RS Node", order: 0 });

    const rs = createRelatedSession(n.id, bp.id, "related-session-1", "enrich", "2024-01-01T00:00:00Z", "2024-01-01T00:01:00Z");
    expect(rs.id).toBeDefined();
    expect(rs.sessionId).toBe("related-session-1");
    expect(rs.type).toBe("enrich");
    expect(rs.completedAt).toBe("2024-01-01T00:01:00Z");

    const sessions = getRelatedSessionsForNode(n.id);
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    expect(sessions.some((s) => s.sessionId === "related-session-1")).toBe(true);
  });

  it("createRelatedSession without completedAt", async () => {
    const { createBlueprint, createMacroNode, createRelatedSession } = await import("../plan-db.js");

    const bp = createBlueprint("Related Session No Complete Test");
    const n = createMacroNode(bp.id, { title: "RS Node 2", order: 0 });

    const rs = createRelatedSession(n.id, bp.id, "related-session-2", "evaluate");
    expect(rs.completedAt).toBeUndefined();
  });

  // ─── getNodeInfoForSessions batch lookup ──────────────────

  it("getNodeInfoForSessions returns node info for sessions", async () => {
    const { createBlueprint, createMacroNode, createExecution, getNodeInfoForSessions } = await import("../plan-db.js");

    const bp = createBlueprint("Node Info Test");
    const n = createMacroNode(bp.id, { title: "Info Node", description: "My description", order: 0 });
    const sessionId = `info-session-${randomUUID()}`;
    createExecution(n.id, bp.id, sessionId, "primary");

    const result = getNodeInfoForSessions([sessionId]);
    expect(result.size).toBe(1);
    const info = result.get(sessionId);
    expect(info!.nodeTitle).toBe("Info Node");
    expect(info!.nodeDescription).toBe("My description");
    expect(info!.blueprintId).toBe(bp.id);
  });

  it("getNodeInfoForSessions returns empty map for empty input", async () => {
    const { getNodeInfoForSessions } = await import("../plan-db.js");
    const result = getNodeInfoForSessions([]);
    expect(result.size).toBe(0);
  });

  // ─── createMacroNode order shifting ───────────────────────

  it("createMacroNode shifts existing nodes at or above the new order", async () => {
    const { createBlueprint, createMacroNode, getBlueprint } = await import("../plan-db.js");

    const bp = createBlueprint("Order Shift Test");
    const n0 = createMacroNode(bp.id, { title: "A", order: 0 });
    const n1 = createMacroNode(bp.id, { title: "B", order: 1 });

    // Insert at order 1, should push B to order 2
    createMacroNode(bp.id, { title: "C", order: 1 });

    const fetched = getBlueprint(bp.id);
    const nodes = fetched!.nodes;
    const nodeA = nodes.find((n) => n.id === n0.id);
    const nodeB = nodes.find((n) => n.id === n1.id);
    const nodeC = nodes.find((n) => n.title === "C");

    expect(nodeA!.order).toBe(0);
    expect(nodeC!.order).toBe(1);
    expect(nodeB!.order).toBe(2);
  });

  // ─── Backward-compat updateNode alias ─────────────────────

  it("backward-compat updateNode maps legacy field names", async () => {
    const { createBlueprint, createMacroNode, updateNode } = await import("../plan-db.js");

    const bp = createBlueprint("UpdateNode Compat Test");
    const n = createMacroNode(bp.id, { title: "Legacy", order: 0 });

    const updated = updateNode(bp.id, n.id, {
      dependsOn: ["dep-1"],
      seq: 5,
    });
    expect(updated).not.toBeNull();
    expect(updated!.dependencies).toEqual(["dep-1"]);
    expect(updated!.order).toBe(5);
  });

  // ─── Comprehensive field mapping tests ─────────────────────
  // Verify every entity type maps snake_case DB columns to camelCase TS properties
  // and that no snake_case keys leak into the returned objects.

  const SNAKE_CASE_FIELDS = [
    "project_cwd", "created_at", "updated_at", "archived_at", "agent_type",
    "blueprint_id", "parallel_group", "estimated_minutes", "actual_minutes",
    "source_node_id", "target_node_id", "node_id", "session_id",
    "input_context", "output_summary", "context_tokens_used",
    "parent_execution_id", "cli_pid", "blocker_info", "task_summary",
    "failure_reason", "reported_status", "reported_reason",
    "compact_count", "peak_tokens", "context_pressure",
    "started_at", "completed_at",
  ];

  function assertNoSnakeCaseKeys(obj: Record<string, unknown>) {
    const keys = Object.keys(obj);
    for (const snake of SNAKE_CASE_FIELDS) {
      expect(keys).not.toContain(snake);
    }
    // Extra safety: no key with underscore that isn't a known exception
    const underscoreKeys = keys.filter((k) => k.includes("_"));
    expect(underscoreKeys).toEqual([]);
  }

  it("Blueprint field mapping: all camelCase, no snake_case leakage", async () => {
    const { createBlueprint, starBlueprint, archiveBlueprint, getBlueprint } = await import("../plan-db.js");

    const bp = createBlueprint("BP Field Map", "desc", "/tmp/field-map");
    starBlueprint(bp.id);
    archiveBlueprint(bp.id);

    const fetched = getBlueprint(bp.id)!;
    expect(fetched).not.toBeNull();

    // Verify all expected camelCase fields
    expect(fetched.id).toBe(bp.id);
    expect(fetched.title).toBe("BP Field Map");
    expect(fetched.description).toBe("desc");
    expect(fetched.status).toBe("draft");
    expect(fetched.projectCwd).toBe("/tmp/field-map");
    expect(fetched.starred).toBe(true);
    expect(fetched.archivedAt).toBeDefined();
    expect(fetched.createdAt).toBeDefined();
    expect(fetched.updatedAt).toBeDefined();
    expect(Array.isArray(fetched.nodes)).toBe(true);

    // Verify no snake_case keys
    assertNoSnakeCaseKeys(fetched as unknown as Record<string, unknown>);
  });

  it("Blueprint field mapping in listBlueprints", async () => {
    const { createBlueprint, listBlueprints } = await import("../plan-db.js");

    const cwd = `/tmp/list-fm-${randomUUID()}`;
    const bp = createBlueprint(`List FM ${randomUUID()}`, "desc", cwd);
    const list = listBlueprints({ includeArchived: true, projectCwd: cwd });
    const found = list.find((b) => b.id === bp.id)!;
    expect(found).toBeDefined();

    assertNoSnakeCaseKeys(found as unknown as Record<string, unknown>);
    expect(found.createdAt).toBeDefined();
    expect(found.updatedAt).toBeDefined();
  });

  it("MacroNode field mapping: all camelCase, no snake_case leakage", async () => {
    const { createBlueprint, createMacroNode, updateMacroNode, getBlueprint } = await import("../plan-db.js");

    const bp = createBlueprint("Node FM Test");
    const dep = createMacroNode(bp.id, { title: "Dep", order: 0 });
    const node = createMacroNode(bp.id, {
      title: "Full Node",
      description: "detailed desc",
      order: 1,
      dependencies: [dep.id],
      parallelGroup: "group-a",
      prompt: "Do the thing",
      estimatedMinutes: 30,
      agentType: "claude",
    });

    // Set additional fields via update
    updateMacroNode(bp.id, node.id, {
      actualMinutes: 25,
      error: "Something failed",
    });

    const fetched = getBlueprint(bp.id)!;
    const fetchedNode = fetched.nodes.find((n) => n.id === node.id)!;
    expect(fetchedNode).toBeDefined();

    // Verify all camelCase fields
    expect(fetchedNode.id).toBe(node.id);
    expect(fetchedNode.blueprintId).toBe(bp.id);
    expect(fetchedNode.order).toBe(1);
    expect(fetchedNode.title).toBe("Full Node");
    expect(fetchedNode.description).toBe("detailed desc");
    expect(fetchedNode.dependencies).toEqual([dep.id]);
    expect(fetchedNode.parallelGroup).toBe("group-a");
    expect(fetchedNode.prompt).toBe("Do the thing");
    expect(fetchedNode.estimatedMinutes).toBe(30);
    expect(fetchedNode.actualMinutes).toBe(25);
    expect(fetchedNode.error).toBe("Something failed");
    expect(fetchedNode.agentType).toBe("claude");
    expect(fetchedNode.createdAt).toBeDefined();
    expect(fetchedNode.updatedAt).toBeDefined();
    expect(Array.isArray(fetchedNode.inputArtifacts)).toBe(true);
    expect(Array.isArray(fetchedNode.outputArtifacts)).toBe(true);
    expect(Array.isArray(fetchedNode.executions)).toBe(true);

    // Verify no snake_case keys
    assertNoSnakeCaseKeys(fetchedNode as unknown as Record<string, unknown>);
  });

  it("Artifact field mapping: all camelCase, no snake_case leakage", async () => {
    const { createBlueprint, createMacroNode, createArtifact, getArtifactsForNode } = await import("../plan-db.js");

    const bp = createBlueprint("Art FM Test");
    const n1 = createMacroNode(bp.id, { title: "Src", order: 0 });
    const n2 = createMacroNode(bp.id, { title: "Tgt", order: 1 });

    createArtifact(bp.id, n1.id, "handoff_summary", "summary content", n2.id);

    const outputArts = getArtifactsForNode(n1.id, "output");
    expect(outputArts).toHaveLength(1);
    const art = outputArts[0];

    // Verify all camelCase fields
    expect(art.id).toBeDefined();
    expect(art.type).toBe("handoff_summary");
    expect(art.content).toBe("summary content");
    expect(art.sourceNodeId).toBe(n1.id);
    expect(art.targetNodeId).toBe(n2.id);
    expect(art.blueprintId).toBe(bp.id);
    expect(art.createdAt).toBeDefined();

    // Verify no snake_case keys
    assertNoSnakeCaseKeys(art as unknown as Record<string, unknown>);
  });

  it("NodeExecution field mapping: all camelCase, no snake_case leakage", async () => {
    const {
      createBlueprint, createMacroNode, createExecution, updateExecution,
      setExecutionBlocker, setExecutionTaskSummary, setExecutionReportedStatus,
      getExecution,
    } = await import("../plan-db.js");

    const bp = createBlueprint("Exec FM Test");
    const n = createMacroNode(bp.id, { title: "EFM", order: 0 });

    const parentExec = createExecution(n.id, bp.id, "parent-sess", "primary", "input ctx");
    const exec = createExecution(n.id, bp.id, "child-sess", "retry", "child input", parentExec.id, "running", undefined, undefined, 42);

    // Populate all remaining fields via update + setters
    updateExecution(exec.id, {
      status: "failed",
      outputSummary: "Completed with errors",
      contextTokensUsed: 150000,
      completedAt: "2024-06-15T12:00:00Z",
      failureReason: "context_exhausted",
      compactCount: 2,
      peakTokens: 180000,
      contextPressure: "high",
    });
    setExecutionBlocker(exec.id, JSON.stringify({ type: "technical_limitation" }));
    setExecutionTaskSummary(exec.id, "Tried to implement auth");
    setExecutionReportedStatus(exec.id, "failed", "Tests didn't pass");

    const fetched = getExecution(exec.id)!;
    expect(fetched).not.toBeNull();

    // Verify all camelCase fields
    expect(fetched.id).toBe(exec.id);
    expect(fetched.nodeId).toBe(n.id);
    expect(fetched.blueprintId).toBe(bp.id);
    expect(fetched.sessionId).toBe("child-sess");
    expect(fetched.type).toBe("retry");
    expect(fetched.status).toBe("failed");
    expect(fetched.inputContext).toBe("child input");
    expect(fetched.outputSummary).toBe("Completed with errors");
    expect(fetched.contextTokensUsed).toBe(150000);
    expect(fetched.parentExecutionId).toBe(parentExec.id);
    expect(fetched.cliPid).toBe(42);
    expect(fetched.blockerInfo).toBeDefined();
    expect(fetched.taskSummary).toBe("Tried to implement auth");
    expect(fetched.failureReason).toBe("context_exhausted");
    expect(fetched.reportedStatus).toBe("failed");
    expect(fetched.reportedReason).toBe("Tests didn't pass");
    expect(fetched.compactCount).toBe(2);
    expect(fetched.peakTokens).toBe(180000);
    expect(fetched.contextPressure).toBe("high");
    expect(fetched.startedAt).toBeDefined();
    expect(fetched.completedAt).toBe("2024-06-15T12:00:00Z");

    // Verify no snake_case keys
    assertNoSnakeCaseKeys(fetched as unknown as Record<string, unknown>);
  });

  it("NodeExecution field mapping via getExecutionsForNode", async () => {
    const { createBlueprint, createMacroNode, createExecution, getExecutionsForNode } = await import("../plan-db.js");

    const bp = createBlueprint("Exec List FM Test");
    const n = createMacroNode(bp.id, { title: "ELFM", order: 0 });
    createExecution(n.id, bp.id, `sess-${randomUUID()}`, "primary", "ctx");

    const execs = getExecutionsForNode(n.id);
    expect(execs.length).toBeGreaterThan(0);

    for (const exec of execs) {
      assertNoSnakeCaseKeys(exec as unknown as Record<string, unknown>);
      expect(exec.nodeId).toBe(n.id);
      expect(exec.blueprintId).toBe(bp.id);
      expect(exec.startedAt).toBeDefined();
    }
  });

  it("NodeExecution field mapping via getExecutionBySession", async () => {
    const { createBlueprint, createMacroNode, createExecution, getExecutionBySession } = await import("../plan-db.js");

    const bp = createBlueprint("Exec By Sess FM Test");
    const n = createMacroNode(bp.id, { title: "EBSFM", order: 0 });
    const sessId = `fm-sess-${randomUUID()}`;
    createExecution(n.id, bp.id, sessId, "primary");

    const fetched = getExecutionBySession(sessId)!;
    expect(fetched).not.toBeNull();
    assertNoSnakeCaseKeys(fetched as unknown as Record<string, unknown>);
    expect(fetched.sessionId).toBe(sessId);
    expect(fetched.nodeId).toBe(n.id);
  });

  it("RelatedSession field mapping: all camelCase, no snake_case leakage", async () => {
    const { createBlueprint, createMacroNode, createRelatedSession, getRelatedSessionsForNode } = await import("../plan-db.js");

    const bp = createBlueprint("RS FM Test");
    const n = createMacroNode(bp.id, { title: "RSFM", order: 0 });

    createRelatedSession(n.id, bp.id, "rs-session-fm", "evaluate", "2024-01-01T00:00:00Z", "2024-01-01T00:05:00Z");

    const sessions = getRelatedSessionsForNode(n.id);
    const found = sessions.find((s) => s.sessionId === "rs-session-fm")!;
    expect(found).toBeDefined();

    // Verify all camelCase fields
    expect(found.id).toBeDefined();
    expect(found.nodeId).toBe(n.id);
    expect(found.blueprintId).toBe(bp.id);
    expect(found.sessionId).toBe("rs-session-fm");
    expect(found.type).toBe("evaluate");
    expect(found.startedAt).toBe("2024-01-01T00:00:00Z");
    expect(found.completedAt).toBe("2024-01-01T00:05:00Z");

    // Verify no snake_case keys
    assertNoSnakeCaseKeys(found as unknown as Record<string, unknown>);
  });

  it("StaleExecution field mapping: all camelCase, no snake_case leakage", async () => {
    const { createBlueprint, createMacroNode, createExecution, getStaleRunningExecutions } = await import("../plan-db.js");

    const bp = createBlueprint("Stale FM Test", "desc", "/tmp/stale-fm");
    const n = createMacroNode(bp.id, { title: "SFM", order: 0 });
    const sessId = `stale-fm-${randomUUID()}`;
    createExecution(n.id, bp.id, sessId, "primary");

    const stale = getStaleRunningExecutions();
    const found = stale.find((e) => e.sessionId === sessId);
    expect(found).toBeDefined();

    // Verify camelCase fields
    expect(found!.id).toBeDefined();
    expect(found!.nodeId).toBe(n.id);
    expect(found!.blueprintId).toBe(bp.id);
    expect(found!.sessionId).toBe(sessId);
    expect(found!.projectCwd).toBe("/tmp/stale-fm");
    expect(found!.startedAt).toBeDefined();

    // Verify no snake_case keys
    assertNoSnakeCaseKeys(found as unknown as Record<string, unknown>);
  });

  it("Nested field mapping: Blueprint → MacroNode → Execution all camelCase", async () => {
    const { createBlueprint, createMacroNode, createExecution, getBlueprint } = await import("../plan-db.js");

    const bp = createBlueprint("Nested FM Test", "nested desc", "/tmp/nested-fm");
    const n = createMacroNode(bp.id, { title: "Nested Node", description: "node desc", order: 0, dependencies: [] });
    createExecution(n.id, bp.id, `nested-sess-${randomUUID()}`, "primary", "input");

    const fetched = getBlueprint(bp.id)!;
    expect(fetched).not.toBeNull();

    // Blueprint level
    assertNoSnakeCaseKeys(fetched as unknown as Record<string, unknown>);
    expect(fetched.projectCwd).toBe("/tmp/nested-fm");

    // MacroNode level
    expect(fetched.nodes).toHaveLength(1);
    const fetchedNode = fetched.nodes[0];
    assertNoSnakeCaseKeys(fetchedNode as unknown as Record<string, unknown>);
    expect(fetchedNode.blueprintId).toBe(bp.id);

    // Execution level
    expect(fetchedNode.executions).toHaveLength(1);
    const fetchedExec = fetchedNode.executions[0];
    assertNoSnakeCaseKeys(fetchedExec as unknown as Record<string, unknown>);
    expect(fetchedExec.nodeId).toBe(n.id);
    expect(fetchedExec.blueprintId).toBe(bp.id);
  });
});
