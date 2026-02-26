import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// We need to mock the file paths used by enrichment.ts.
// The module uses `import.meta.dirname` to resolve paths.
// We'll mock the fs functions to redirect to our temp dir.

// Mock the module-level constants by mocking the fs operations
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    // We'll override at test time
  };
});

describe("enrichment module", () => {
  // Since the module uses hardcoded paths based on import.meta.dirname,
  // we need to test with a different approach: test the logic through imports
  // after setting up the actual .clawui directory.
  // Instead, let's test the pure logic by importing and using the functions
  // with the actual file system, but in a controlled way.

  // Actually, the simplest approach: dynamically import and test with
  // the real .clawui dir (which exists in the project). But that would
  // modify real data. Better: test the logic functions by creating
  // a focused unit test that doesn't rely on the module's paths.

  // Best approach: test with the actual module but use beforeEach/afterEach
  // to save and restore the enrichments file.

  let originalContent: string | null;
  const PROJECT_ROOT = join(import.meta.dirname, "..", "..", "..");
  const CLAWUI_DIR = join(PROJECT_ROOT, ".clawui");
  const ENRICHMENTS_PATH = join(CLAWUI_DIR, "enrichments.json");

  beforeEach(() => {
    // Save original content
    if (existsSync(ENRICHMENTS_PATH)) {
      originalContent = readFileSync(ENRICHMENTS_PATH, "utf-8");
    } else {
      originalContent = null;
    }
  });

  afterEach(() => {
    // Restore original content
    if (originalContent !== null) {
      writeFileSync(ENRICHMENTS_PATH, originalContent, "utf-8");
    } else if (existsSync(ENRICHMENTS_PATH)) {
      rmSync(ENRICHMENTS_PATH);
    }
  });

  it("getEnrichments returns default when file does not exist", async () => {
    // Remove the file temporarily
    if (existsSync(ENRICHMENTS_PATH)) {
      rmSync(ENRICHMENTS_PATH);
    }
    // Re-import to get fresh module state
    const { getEnrichments } = await import("../enrichment.js");
    const data = getEnrichments();
    expect(data.version).toBe(1);
    expect(data.sessions).toEqual({});
    expect(data.nodes).toEqual({});
    expect(data.tags).toEqual([]);
  });

  it("updateSessionMeta creates and merges session enrichment", async () => {
    // Start fresh
    if (existsSync(ENRICHMENTS_PATH)) {
      rmSync(ENRICHMENTS_PATH);
    }
    const { updateSessionMeta, getEnrichments } = await import("../enrichment.js");

    const testId = `test-session-${randomUUID()}`;

    // Create
    const result1 = updateSessionMeta(testId, { starred: true, tags: ["tag1"] });
    expect(result1.starred).toBe(true);
    expect(result1.tags).toEqual(["tag1"]);

    // Merge
    const result2 = updateSessionMeta(testId, { notes: "my notes" });
    expect(result2.starred).toBe(true);
    expect(result2.notes).toBe("my notes");
    expect(result2.tags).toEqual(["tag1"]);

    // Verify tags are in global list
    const data = getEnrichments();
    expect(data.tags).toContain("tag1");
  });

  it("updateSessionMeta removes undefined/null keys", async () => {
    if (existsSync(ENRICHMENTS_PATH)) {
      rmSync(ENRICHMENTS_PATH);
    }
    const { updateSessionMeta } = await import("../enrichment.js");

    const testId = `test-session-${randomUUID()}`;
    updateSessionMeta(testId, { starred: true, notes: "note" });
    const result = updateSessionMeta(testId, { notes: undefined as unknown as string });
    expect(result.starred).toBe(true);
    expect(result).not.toHaveProperty("notes");
  });

  it("updateNodeMeta creates and merges node enrichment", async () => {
    if (existsSync(ENRICHMENTS_PATH)) {
      rmSync(ENRICHMENTS_PATH);
    }
    const { updateNodeMeta } = await import("../enrichment.js");

    const testId = `test-node-${randomUUID()}`;
    const result1 = updateNodeMeta(testId, { bookmarked: true });
    expect(result1.bookmarked).toBe(true);

    const result2 = updateNodeMeta(testId, { annotation: "important" });
    expect(result2.bookmarked).toBe(true);
    expect(result2.annotation).toBe("important");
  });

  it("getAllTags returns sorted tags list", async () => {
    if (existsSync(ENRICHMENTS_PATH)) {
      rmSync(ENRICHMENTS_PATH);
    }
    const { updateSessionMeta, getAllTags } = await import("../enrichment.js");

    const id1 = `test-session-${randomUUID()}`;
    const id2 = `test-session-${randomUUID()}`;
    updateSessionMeta(id1, { tags: ["beta", "alpha"] });
    updateSessionMeta(id2, { tags: ["gamma", "alpha"] });

    const tags = getAllTags();
    expect(tags).toEqual(["alpha", "beta", "gamma"]);
  });

  it("getEnrichments returns default for malformed JSON", async () => {
    mkdirSync(CLAWUI_DIR, { recursive: true });
    writeFileSync(ENRICHMENTS_PATH, "not valid json{{{", "utf-8");
    const { getEnrichments } = await import("../enrichment.js");
    const data = getEnrichments();
    expect(data.version).toBe(1);
    expect(data.sessions).toEqual({});
  });
});
