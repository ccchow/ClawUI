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

  it("listBlueprints returns all blueprints", async () => {
    const { createBlueprint, listBlueprints } = await import("../plan-db.js");

    const bp = createBlueprint(`List Test ${randomUUID()}`);
    const list = listBlueprints();
    expect(list.length).toBeGreaterThan(0);
    expect(list.some((b) => b.id === bp.id)).toBe(true);
  });

  it("listBlueprints filters by status", async () => {
    const { createBlueprint, updateBlueprint, listBlueprints } = await import("../plan-db.js");

    const bp = createBlueprint(`Filter Test ${randomUUID()}`);
    updateBlueprint(bp.id, { status: "approved" });

    const drafts = listBlueprints({ status: "draft" });
    expect(drafts.every((b) => b.status === "draft")).toBe(true);

    const approved = listBlueprints({ status: "approved" });
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
});
