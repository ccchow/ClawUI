import { describe, it, expect } from "vitest";

/**
 * Tests for plan-generator logic patterns:
 * - JSON extraction from Claude output
 * - Plan generation output structure validation
 * - Dependency graph validity
 * - Legacy array format handling
 *
 * These test the pure logic functions without calling the Claude CLI.
 */

// ─── extractJSON logic (from plan-generator.ts) ──────────────

function extractJSON(text: string): unknown {
  // Try direct parse
  try { return JSON.parse(text); } catch { /* fall through */ }
  // Try extracting from markdown code block
  const match = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (match) {
    try { return JSON.parse(match[1]); } catch { /* fall through */ }
  }
  // Try finding array in text (greedy — outermost brackets)
  const arrMatch = text.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try { return JSON.parse(arrMatch[0]); } catch { /* fall through */ }
  }
  // Try finding object in text
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      const parsed = JSON.parse(objMatch[0]);
      if (Array.isArray(parsed.nodes || parsed.steps)) return parsed.nodes || parsed.steps;
    } catch { /* fall through */ }
  }
  throw new Error(`Could not parse JSON from Claude output.`);
}

describe("extractJSON", () => {
  it("parses plain JSON object", () => {
    const input = '{"remove":[],"update":[],"add":[{"title":"Setup","description":"Initialize project","dependencies":[]}]}';
    const result = extractJSON(input) as { remove: unknown[]; add: unknown[] };
    expect(result.remove).toEqual([]);
    expect(result.add).toHaveLength(1);
  });

  it("parses plain JSON array", () => {
    const input = '[{"title":"Step 1","description":"Do thing 1"},{"title":"Step 2","description":"Do thing 2"}]';
    const result = extractJSON(input) as unknown[];
    expect(result).toHaveLength(2);
  });

  it("extracts JSON from markdown code block", () => {
    const input = `Here is the plan:
\`\`\`json
{"remove":[],"update":[],"add":[{"title":"Build API","description":"Create REST endpoints"}]}
\`\`\`
`;
    const result = extractJSON(input) as { add: unknown[] };
    expect(result.add).toHaveLength(1);
  });

  it("extracts JSON from code block without language tag", () => {
    const input = `\`\`\`
[{"title":"Step 1","description":"Do it"}]
\`\`\``;
    const result = extractJSON(input) as unknown[];
    expect(result).toHaveLength(1);
  });

  it("extracts array from text with surrounding prose", () => {
    const input = `I've analyzed the codebase and here are the steps:

[{"title":"Setup tests","description":"Add vitest config"},{"title":"Write tests","description":"Cover main functions"}]

These steps should be completed in order.`;
    const result = extractJSON(input) as unknown[];
    expect(result).toHaveLength(2);
  });

  it("extracts object with nodes/steps key from text", () => {
    const input = `Here is my analysis:

{"nodes": [{"title": "Step A", "description": "Do A"}, {"title": "Step B", "description": "Do B"}]}

That should work.`;
    const result = extractJSON(input) as unknown[];
    expect(result).toHaveLength(2);
  });

  it("handles steps key alias when embedded in surrounding text", () => {
    // When JSON is plain, direct parse returns the object as-is.
    // The nodes/steps extraction only triggers when the JSON is embedded in text.
    const input = 'Here is the plan: {"steps": [{"title": "One", "description": "First step"}]} done.';
    const result = extractJSON(input) as unknown[];
    expect(result).toHaveLength(1);
  });

  it("returns raw object when steps JSON is parsed directly", () => {
    // Direct JSON parse succeeds, returns the whole object (not the array)
    const input = '{"steps": [{"title": "One", "description": "First step"}]}';
    const result = extractJSON(input) as { steps: unknown[] };
    expect(result.steps).toHaveLength(1);
  });

  it("throws on completely invalid input", () => {
    expect(() => extractJSON("This is just plain text with no JSON at all.")).toThrow(
      "Could not parse JSON",
    );
  });

  it("throws on malformed JSON", () => {
    expect(() => extractJSON("{invalid json here}")).toThrow();
  });
});

// ─── Plan Generation Output Validation ───────────────────────

describe("Plan generation output structure", () => {
  interface GeneratedPlan {
    remove?: string[];
    update?: Array<{ id: string; title?: string; description?: string }>;
    add?: Array<{ title: string; description: string; dependencies?: number[] }>;
  }

  it("validates correct plan structure with all fields", () => {
    const plan: GeneratedPlan = {
      remove: ["node-1"],
      update: [{ id: "node-2", title: "Updated step" }],
      add: [
        { title: "New step 1", description: "Do something new", dependencies: [] },
        { title: "New step 2", description: "Depends on step 1", dependencies: [0] },
      ],
    };

    expect(plan.remove).toHaveLength(1);
    expect(plan.update).toHaveLength(1);
    expect(plan.add).toHaveLength(2);
    expect(plan.add![1].dependencies).toEqual([0]);
  });

  it("validates empty plan (no changes needed)", () => {
    const plan: GeneratedPlan = {
      remove: [],
      update: [],
      add: [],
    };

    expect(plan.remove).toHaveLength(0);
    expect(plan.update).toHaveLength(0);
    expect(plan.add).toHaveLength(0);
  });

  it("validates plan with only additions", () => {
    const plan: GeneratedPlan = {
      remove: [],
      update: [],
      add: [
        { title: "Setup", description: "Install dependencies" },
        { title: "Implement", description: "Write the code", dependencies: [0] },
        { title: "Test", description: "Run tests", dependencies: [1] },
      ],
    };

    expect(plan.add).toHaveLength(3);
    // Verify dependency chain: 0 -> 1 -> 2
    expect(plan.add![0].dependencies).toBeUndefined();
    expect(plan.add![1].dependencies).toEqual([0]);
    expect(plan.add![2].dependencies).toEqual([1]);
  });
});

// ─── Dependency Graph Validation ─────────────────────────────

describe("Dependency graph validity", () => {
  it("validates that dependency indices are within bounds", () => {
    const steps = [
      { title: "A", description: "a", dependencies: [] },
      { title: "B", description: "b", dependencies: [0] },
      { title: "C", description: "c", dependencies: [0, 1] },
    ];

    for (const step of steps) {
      for (const depIdx of step.dependencies) {
        expect(depIdx).toBeGreaterThanOrEqual(0);
        expect(depIdx).toBeLessThan(steps.length);
      }
    }
  });

  it("detects out-of-bounds dependency indices", () => {
    const steps = [
      { title: "A", description: "a", dependencies: [5] }, // invalid!
    ];

    const invalidDeps = steps[0].dependencies.filter(
      (idx) => idx < 0 || idx >= steps.length,
    );
    expect(invalidDeps).toHaveLength(1);
  });

  it("maps dependency indices to real node IDs", () => {
    const createdNodes = [
      { id: "uuid-1", title: "A" },
      { id: "uuid-2", title: "B" },
      { id: "uuid-3", title: "C" },
    ];

    const newStep = { title: "D", description: "d", dependencies: [0, 2] };

    const depIds = newStep.dependencies
      .map((idx) => (idx >= 0 && idx < createdNodes.length ? createdNodes[idx].id : null))
      .filter((id): id is string => id !== null);

    expect(depIds).toEqual(["uuid-1", "uuid-3"]);
  });

  it("filters out invalid dependency indices gracefully", () => {
    const createdNodes = [{ id: "uuid-1" }, { id: "uuid-2" }];
    const dependencies = [0, 5, -1, 1]; // 5 and -1 are invalid

    const depIds = dependencies
      .map((idx) => (idx >= 0 && idx < createdNodes.length ? createdNodes[idx].id : null))
      .filter((id): id is string => id !== null);

    expect(depIds).toEqual(["uuid-1", "uuid-2"]);
  });

  it("detects self-referencing dependencies", () => {
    const steps = [
      { title: "A", dependencies: [0] }, // depends on itself
    ];

    // In the code's mapping logic, step 0 references createdNodes[0],
    // which hasn't been created yet at that point, so it would map to null
    const createdNodes: Array<{ id: string }> = [];
    const depIds = steps[0].dependencies
      .map((idx) => (idx >= 0 && idx < createdNodes.length ? createdNodes[idx].id : null))
      .filter((id): id is string => id !== null);

    // Self-reference is effectively filtered out since the node hasn't been created yet
    expect(depIds).toEqual([]);
  });
});

// ─── Legacy Array Format Handling ────────────────────────────

describe("Legacy array format (backward compat)", () => {
  it("detects when parsed result is a plain array (legacy format)", () => {
    const parsed = [
      { title: "Step 1", description: "Do thing 1" },
      { title: "Step 2", description: "Do thing 2" },
    ];

    expect(Array.isArray(parsed)).toBe(true);
  });

  it("computes correct order offset from existing nodes", () => {
    const existingNodes = [
      { order: 0 },
      { order: 1 },
      { order: 2 },
    ];

    const maxOrder = Math.max(0, ...existingNodes.map((n) => n.order));
    expect(maxOrder).toBe(2);

    // New nodes start at maxOrder + 1
    const newSteps = [{ title: "A" }, { title: "B" }];
    const orders = newSteps.map((_, i) => maxOrder + i + 1);
    expect(orders).toEqual([3, 4]);
  });

  it("handles empty existing nodes", () => {
    const existingNodes: Array<{ order: number }> = [];
    const maxOrder = Math.max(0, ...existingNodes.map((n) => n.order));
    expect(maxOrder).toBe(0);
    // New node should be at order 1
    expect(maxOrder + 1).toBe(1);
  });
});

// ─── Prompt Construction ─────────────────────────────────────

describe("Generator prompt construction", () => {
  it("categorizes existing nodes correctly", () => {
    const nodes = [
      { id: "n1", status: "done", order: 0, title: "First", description: "Done step" },
      { id: "n2", status: "skipped", order: 1, title: "Skipped", description: "" },
      { id: "n3", status: "running", order: 2, title: "Running", description: "" },
      { id: "n4", status: "pending", order: 3, title: "Pending", description: "" },
      { id: "n5", status: "failed", order: 4, title: "Failed", description: "" },
    ];

    const doneNodes = nodes.filter((n) => n.status === "done" || n.status === "skipped");
    const pendingNodes = nodes.filter((n) => n.status === "pending" || n.status === "failed");
    const runningNodes = nodes.filter((n) => n.status === "running");

    expect(doneNodes).toHaveLength(2);
    expect(pendingNodes).toHaveLength(2);
    expect(runningNodes).toHaveLength(1);
  });

  it("builds nodes context with correct categories", () => {
    const doneNodes = [{ order: 0, status: "done", title: "Setup", description: "Install deps" }];
    const pendingNodes = [{ order: 1, status: "pending", id: "n2", title: "Build", description: "Code it" }];

    let nodesContext = "";
    if (doneNodes.length > 0) {
      nodesContext += `\nCompleted nodes:\n${doneNodes.map((n) => `  #${n.order}. [${n.status}] ${n.title}`).join("\n")}`;
    }
    if (pendingNodes.length > 0) {
      nodesContext += `\nPending nodes:\n${pendingNodes.map((n) => `  #${n.order}. [${n.status}] id=${n.id} ${n.title}`).join("\n")}`;
    }

    expect(nodesContext).toContain("Completed nodes");
    expect(nodesContext).toContain("[done] Setup");
    expect(nodesContext).toContain("Pending nodes");
    expect(nodesContext).toContain("[pending] id=n2 Build");
  });

  it("includes user instruction when provided", () => {
    const userInstruction = "Focus on adding authentication first";
    const desc = "Build a REST API";

    let prompt = `Task: ${desc}\n`;
    if (userInstruction) {
      prompt += `\n--- USER INSTRUCTION ---\n${userInstruction}\n--- END INSTRUCTION ---\n`;
    }

    expect(prompt).toContain("USER INSTRUCTION");
    expect(prompt).toContain("Focus on adding authentication first");
  });
});

// ─── Mixed dependency format (string IDs + integer indices) ──

describe("Mixed dependency format in batch-create", () => {
  it("resolves integer indices to batch-created node IDs", () => {
    const createdNodes = [
      { id: "uuid-1", title: "Backend" },
      { id: "uuid-2", title: "Frontend" },
    ];
    const existingNodeIds = new Set(["existing-1", "existing-2"]);

    const step = {
      title: "Integration",
      dependencies: [0, 1, "existing-1"] as (string | number)[],
    };

    const depIds = step.dependencies
      .map((dep) => {
        if (typeof dep === "number") {
          return dep >= 0 && dep < createdNodes.length ? createdNodes[dep].id : null;
        }
        if (typeof dep === "string") {
          return existingNodeIds.has(dep) || createdNodes.some((n) => n.id === dep) ? dep : null;
        }
        return null;
      })
      .filter((id): id is string => id !== null);

    expect(depIds).toEqual(["uuid-1", "uuid-2", "existing-1"]);
  });

  it("filters out invalid integer indices", () => {
    const createdNodes = [{ id: "uuid-1" }];
    const step = { dependencies: [0, 5, -1] as (string | number)[] };

    const depIds = step.dependencies
      .map((dep) => {
        if (typeof dep === "number") {
          return dep >= 0 && dep < createdNodes.length ? createdNodes[dep].id : null;
        }
        return null;
      })
      .filter((id): id is string => id !== null);

    expect(depIds).toEqual(["uuid-1"]);
  });

  it("filters out unknown string IDs", () => {
    const createdNodes: Array<{ id: string }> = [];
    const existingNodeIds = new Set(["known-1"]);

    const step = { dependencies: ["known-1", "unknown-2"] as (string | number)[] };

    const depIds = step.dependencies
      .map((dep) => {
        if (typeof dep === "string") {
          return existingNodeIds.has(dep) || createdNodes.some((n) => n.id === dep) ? dep : null;
        }
        return null;
      })
      .filter((id): id is string => id !== null);

    expect(depIds).toEqual(["known-1"]);
  });
});

// ─── cleanEnvForClaude ─────────────────────────────────────

describe("cleanEnvForClaude", () => {
  it("strips CLAUDECODE from environment", () => {
    function cleanEnvForClaude(): NodeJS.ProcessEnv {
      const env = { ...process.env };
      delete env.CLAUDECODE;
      return env;
    }

    // Simulate CLAUDECODE being set
    const originalValue = process.env.CLAUDECODE;
    process.env.CLAUDECODE = "test-value";

    const cleaned = cleanEnvForClaude();
    expect(cleaned.CLAUDECODE).toBeUndefined();
    // Other env vars should be preserved
    expect(cleaned.PATH).toBeDefined();

    // Restore
    if (originalValue !== undefined) {
      process.env.CLAUDECODE = originalValue;
    } else {
      delete process.env.CLAUDECODE;
    }
  });

  it("does not modify original process.env", () => {
    function cleanEnvForClaude(): NodeJS.ProcessEnv {
      const env = { ...process.env };
      delete env.CLAUDECODE;
      return env;
    }

    process.env.CLAUDECODE = "test-value";
    cleanEnvForClaude();
    expect(process.env.CLAUDECODE).toBe("test-value");

    delete process.env.CLAUDECODE;
  });
});

// ─── generatePlan prompt construction (full integration) ────

describe("generatePlan prompt includes handoff summaries for done nodes", () => {
  it("includes handoff summary content for done nodes", () => {
    const doneNodes = [
      { id: "n1", status: "done", title: "Setup DB" },
    ];

    // Simulate getArtifactsForNode returning a summary
    const artifactsByNode = new Map<string, { content: string }[]>();
    artifactsByNode.set("n1", [{ content: "**What was done:** Created PostgreSQL schema with users, sessions, and permissions tables." }]);

    const doneLines = doneNodes.map(n => {
      const outputArtifacts = artifactsByNode.get(n.id) ?? [];
      const latestArtifact = outputArtifacts.length > 0 ? outputArtifacts[outputArtifacts.length - 1] : null;
      const summary = latestArtifact
        ? ` — Handoff: ${latestArtifact.content.slice(0, 300)}`
        : "";
      return `  [id: ${n.id}] [${n.status}] ${n.title}${summary}`;
    });

    const nodesContext = `\n\nCompleted nodes:\n${doneLines.join("\n")}`;

    expect(nodesContext).toContain("[done] Setup DB");
    expect(nodesContext).toContain("Handoff: **What was done:**");
    expect(nodesContext).toContain("PostgreSQL schema");
  });

  it("omits handoff when no artifacts exist", () => {
    const doneNodes = [
      { id: "n1", status: "done", title: "Setup DB" },
    ];

    const artifactsByNode = new Map<string, { content: string }[]>();

    const doneLines = doneNodes.map(n => {
      const outputArtifacts = artifactsByNode.get(n.id) ?? [];
      const latestArtifact = outputArtifacts.length > 0 ? outputArtifacts[outputArtifacts.length - 1] : null;
      const summary = latestArtifact
        ? ` — Handoff: ${latestArtifact.content.slice(0, 300)}`
        : "";
      return `  [id: ${n.id}] [${n.status}] ${n.title}${summary}`;
    });

    const line = doneLines[0];
    expect(line).toContain("[done] Setup DB");
    expect(line).not.toContain("Handoff:");
  });

  it("truncates handoff summary to 300 chars", () => {
    const longContent = "**What was done:** " + "x".repeat(500);
    const truncated = longContent.slice(0, 300);
    expect(truncated.length).toBe(300);
    expect(truncated).not.toEqual(longContent);
  });
});

// ─── Generate is additive-only ──────────────────────────────

describe("Generate additive-only: ignores remove/update keys", () => {
  it("only uses the add array from response", () => {
    const response = {
      remove: ["n1"],
      update: [{ id: "n2", title: "Changed" }],
      add: [
        { title: "New Step", description: "Something new", dependencies: [] },
      ],
    };

    // Generate logic defensively only reads .add
    const nodesToCreate = response.add ?? [];
    expect(nodesToCreate).toHaveLength(1);
    expect(nodesToCreate[0].title).toBe("New Step");

    // remove and update should be ignored
    // (in production code, they are simply never read)
  });

  it("handles response with only add key", () => {
    const response = {
      add: [
        { title: "Step 1", description: "A" },
        { title: "Step 2", description: "B", dependencies: [0] },
      ],
    };

    const nodesToCreate = response.add ?? [];
    expect(nodesToCreate).toHaveLength(2);
  });

  it("handles empty add array", () => {
    const response = { add: [] };
    const nodesToCreate = response.add ?? [];
    expect(nodesToCreate).toHaveLength(0);
  });
});
