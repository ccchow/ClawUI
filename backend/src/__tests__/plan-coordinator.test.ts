import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock plan-db
vi.mock("../plan-db.js", () => ({
  getBlueprint: vi.fn(),
  getInsightsForBlueprint: vi.fn(),
  markAllInsightsRead: vi.fn(),
}));

// Mock plan-generator
vi.mock("../plan-generator.js", () => ({
  runAgentInteractive: vi.fn(async () => ""),
  getApiBase: vi.fn(() => "http://localhost:3001"),
  getAuthParam: vi.fn(() => "auth=test-token"),
}));

// Mock agent runtimes (side-effect imports)
vi.mock("../agent-claude.js", () => ({}));
vi.mock("../agent-pimono.js", () => ({}));
vi.mock("../agent-openclaw.js", () => ({}));
vi.mock("../agent-codex.js", () => ({}));

// Mock role loader (replaces individual role side-effect mocks)
vi.mock("../roles/load-all-roles.js", () => ({}));

import { coordinateBlueprint, buildCoordinatorPrompt } from "../plan-coordinator.js";
import { getBlueprint, getInsightsForBlueprint, markAllInsightsRead } from "../plan-db.js";
import { runAgentInteractive } from "../plan-generator.js";

describe("plan-coordinator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockBlueprint = {
    id: "bp-1",
    title: "Test Blueprint",
    description: "A test blueprint",
    projectCwd: "/test/project",
    status: "running" as const,
    nodes: [
      { id: "node-1", title: "Setup DB", status: "done", description: "Set up database", dependencies: [], order: 0, seq: 1, createdAt: "2024-01-01", updatedAt: "2024-01-01" },
      { id: "node-2", title: "Build API", status: "pending", description: "Build REST API", dependencies: ["node-1"], roles: ["sde"], order: 1, seq: 2, createdAt: "2024-01-01", updatedAt: "2024-01-01" },
      { id: "node-3", title: "Write Tests", status: "pending", description: "Write unit tests", dependencies: ["node-2"], roles: ["qa"], order: 2, seq: 3, createdAt: "2024-01-01", updatedAt: "2024-01-01" },
    ],
    createdAt: "2024-01-01",
    updatedAt: "2024-01-01",
  };

  const mockInsights = [
    {
      id: "insight-1",
      blueprintId: "bp-1",
      sourceNodeId: "node-1",
      role: "sde",
      severity: "warning" as const,
      message: "Missing error handling in database setup",
      read: false,
      dismissed: false,
      createdAt: "2024-01-01T00:00:00Z",
    },
    {
      id: "insight-2",
      blueprintId: "bp-1",
      sourceNodeId: "node-1",
      role: "qa",
      severity: "critical" as const,
      message: "No test coverage for migration scripts",
      read: false,
      dismissed: false,
      createdAt: "2024-01-01T01:00:00Z",
    },
  ];

  describe("buildCoordinatorPrompt", () => {
    it("includes insight messages with role and severity", () => {
      const prompt = buildCoordinatorPrompt("bp-1", mockInsights, mockBlueprint);

      expect(prompt).toContain("[WARNING] [role: sde] Missing error handling in database setup");
      expect(prompt).toContain("[CRITICAL] [role: qa] No test coverage for migration scripts");
      expect(prompt).toContain("insight ID: insight-1");
      expect(prompt).toContain("insight ID: insight-2");
    });

    it("includes node titles and statuses in current graph", () => {
      const prompt = buildCoordinatorPrompt("bp-1", mockInsights, mockBlueprint);

      expect(prompt).toContain("[done] Setup DB (id: node-1)");
      expect(prompt).toContain("[pending] Build API (id: node-2");
      expect(prompt).toContain("[pending] Write Tests (id: node-3");
    });

    it("includes node dependencies and roles", () => {
      const prompt = buildCoordinatorPrompt("bp-1", mockInsights, mockBlueprint);

      expect(prompt).toContain("deps=[node-1]");
      expect(prompt).toContain("roles=[sde]");
      expect(prompt).toContain("roles=[qa]");
    });

    it("includes curl endpoint templates", () => {
      const prompt = buildCoordinatorPrompt("bp-1", mockInsights, mockBlueprint);

      expect(prompt).toContain("http://localhost:3001/api/blueprints/bp-1/nodes/batch-create?auth=test-token");
      expect(prompt).toContain("http://localhost:3001/api/blueprints/bp-1/nodes/<nodeId>?auth=test-token");
      expect(prompt).toContain("http://localhost:3001/api/blueprints/bp-1/insights/<insightId>/mark-read?auth=test-token");
      expect(prompt).toContain("http://localhost:3001/api/blueprints/bp-1/insights/<insightId>/dismiss?auth=test-token");
    });

    it("includes source node IDs in insight lines", () => {
      const prompt = buildCoordinatorPrompt("bp-1", mockInsights, mockBlueprint);

      expect(prompt).toContain("(source node: node-1)");
    });

    it("includes blueprint title and description", () => {
      const prompt = buildCoordinatorPrompt("bp-1", mockInsights, mockBlueprint);

      expect(prompt).toContain('"Test Blueprint"');
      expect(prompt).toContain("Description: A test blueprint");
      expect(prompt).toContain("Working directory: /test/project");
    });
  });

  describe("coordinateBlueprint", () => {
    it("returns early when no unread insights (no agent call)", async () => {
      (getInsightsForBlueprint as ReturnType<typeof vi.fn>).mockReturnValue([]);

      await coordinateBlueprint("bp-1");

      expect(getInsightsForBlueprint).toHaveBeenCalledWith("bp-1", { unreadOnly: true });
      expect(runAgentInteractive).not.toHaveBeenCalled();
      expect(markAllInsightsRead).not.toHaveBeenCalled();
    });

    it("calls agent and marks all read after completion", async () => {
      (getInsightsForBlueprint as ReturnType<typeof vi.fn>).mockReturnValue(mockInsights);
      (getBlueprint as ReturnType<typeof vi.fn>).mockReturnValue(mockBlueprint);
      (runAgentInteractive as ReturnType<typeof vi.fn>).mockResolvedValue("done");

      await coordinateBlueprint("bp-1");

      expect(getInsightsForBlueprint).toHaveBeenCalledWith("bp-1", { unreadOnly: true });
      expect(getBlueprint).toHaveBeenCalledWith("bp-1");
      expect(runAgentInteractive).toHaveBeenCalledTimes(1);
      // Verify prompt contains insight content
      const prompt = (runAgentInteractive as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(prompt).toContain("Missing error handling");
      expect(prompt).toContain("No test coverage");
      // Verify CWD passed through
      expect((runAgentInteractive as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe("/test/project");
      // Safety fallback
      expect(markAllInsightsRead).toHaveBeenCalledWith("bp-1");
    });

    it("marks all read even if agent call fails", async () => {
      (getInsightsForBlueprint as ReturnType<typeof vi.fn>).mockReturnValue(mockInsights);
      (getBlueprint as ReturnType<typeof vi.fn>).mockReturnValue(mockBlueprint);
      (runAgentInteractive as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Agent failed"));

      await coordinateBlueprint("bp-1");

      expect(runAgentInteractive).toHaveBeenCalledTimes(1);
      // Fallback still runs despite error
      expect(markAllInsightsRead).toHaveBeenCalledWith("bp-1");
    });

    it("returns early if blueprint not found", async () => {
      (getInsightsForBlueprint as ReturnType<typeof vi.fn>).mockReturnValue(mockInsights);
      (getBlueprint as ReturnType<typeof vi.fn>).mockReturnValue(null);

      await coordinateBlueprint("bp-missing");

      expect(runAgentInteractive).not.toHaveBeenCalled();
      expect(markAllInsightsRead).not.toHaveBeenCalled();
    });
  });
});
