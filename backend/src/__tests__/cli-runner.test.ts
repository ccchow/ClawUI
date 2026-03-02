import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentRuntime, AgentCapabilities } from "../agent-runtime.js";

/**
 * Create a mock AgentRuntime that resolves resumeSession with the given output.
 */
function createMockRuntime(output: string | (() => Promise<string>)): AgentRuntime {
  return {
    type: "claude",
    capabilities: {
      supportsResume: true,
      supportsInteractive: true,
      supportsTextOutput: true,
      supportsDangerousMode: true,
    } as AgentCapabilities,
    getSessionsDir: () => "/mock/sessions",
    runSession: vi.fn(async () => ""),
    runSessionInteractive: vi.fn(async () => ""),
    resumeSession: vi.fn(async () => {
      if (typeof output === "function") return output();
      return output;
    }),
    encodeProjectCwd: (cwd: string) => cwd,
    detectNewSession: () => null,
    cleanEnv: () => ({ ...process.env }),
    analyzeSessionHealth: vi.fn(() => null),
  };
}

describe("cli-runner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── runPrompt with AgentRuntime dispatch ─────────────────

  describe("runPrompt", () => {
    it("appends suggestion suffix and parses suggestions from runtime output", async () => {
      const output = `Here is the response content.
---SUGGESTIONS---
[{"title":"Next step","description":"Do something","prompt":"do it"}]`;
      const runtime = createMockRuntime(output);

      const { runPrompt } = await import("../cli-runner.js");
      const result = await runPrompt("session-123", "test prompt", "/cwd", runtime);

      expect(result.output).toBe("Here is the response content.");
      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0].title).toBe("Next step");
      expect(result.suggestions[0].prompt).toBe("do it");
    });

    it("calls runtime.resumeSession with prompt + suggestion suffix", async () => {
      const runtime = createMockRuntime("plain output");

      const { runPrompt } = await import("../cli-runner.js");
      await runPrompt("session-123", "test prompt", "/cwd", runtime);

      expect(runtime.resumeSession).toHaveBeenCalledWith(
        "session-123",
        expect.stringContaining("test prompt"),
        "/cwd",
        expect.any(Function),
      );
      // The prompt should include the suggestion suffix
      const actualPrompt = vi.mocked(runtime.resumeSession).mock.calls[0][1];
      expect(actualPrompt).toContain("---SUGGESTIONS---");
    });

    it("handles output without suggestions", async () => {
      const runtime = createMockRuntime("Just a plain response without suggestions.");

      const { runPrompt } = await import("../cli-runner.js");
      const result = await runPrompt("session-123", "test prompt", "/cwd", runtime);

      expect(result.output).toBe("Just a plain response without suggestions.");
      expect(result.suggestions).toEqual([]);
    });

    it("rejects when runtime is not provided", async () => {
      const { runPrompt } = await import("../cli-runner.js");
      await expect(runPrompt("session-123", "test")).rejects.toThrow(/No agent runtime provided/);
    });

    it("rejects when runtime does not support resume", async () => {
      const runtime = createMockRuntime("output");
      (runtime.capabilities as AgentCapabilities).supportsResume = false;

      const { runPrompt } = await import("../cli-runner.js");
      await expect(runPrompt("session-123", "test", "/cwd", runtime)).rejects.toThrow(
        /does not support session resume/,
      );
      expect(runtime.resumeSession).not.toHaveBeenCalled();
    });

    it("rejects when runtime.resumeSession throws", async () => {
      const runtime = createMockRuntime(async () => {
        throw new Error("CLI process failed");
      });

      const { runPrompt } = await import("../cli-runner.js");
      await expect(runPrompt("session-123", "test", "/cwd", runtime)).rejects.toThrow(/CLI process failed/);
    });

    it("limits suggestions to 3", async () => {
      const suggestions = Array.from({ length: 5 }, (_, i) => ({
        title: `s${i}`,
        description: `d${i}`,
        prompt: `p${i}`,
      }));

      const output = `Response.
---SUGGESTIONS---
${JSON.stringify(suggestions)}`;
      const runtime = createMockRuntime(output);

      const { runPrompt } = await import("../cli-runner.js");
      const result = await runPrompt("session-123", "test", "/cwd", runtime);
      expect(result.suggestions).toHaveLength(3);
    });

    it("handles malformed suggestion JSON gracefully", async () => {
      const output = `Response text.
---SUGGESTIONS---
not valid json at all`;
      const runtime = createMockRuntime(output);

      const { runPrompt } = await import("../cli-runner.js");
      const result = await runPrompt("session-123", "test", "/cwd", runtime);
      expect(result.output).toBe("Response text.");
      expect(result.suggestions).toEqual([]);
    });

    it("works with different agent runtime types", async () => {
      const openclawRuntime: AgentRuntime = {
        ...createMockRuntime("OpenClaw response"),
        type: "openclaw",
      };

      const { runPrompt } = await import("../cli-runner.js");
      const result = await runPrompt("session-456", "test prompt", "/cwd", openclawRuntime);

      expect(result.output).toBe("OpenClaw response");
      expect(openclawRuntime.resumeSession).toHaveBeenCalledWith(
        "session-456",
        expect.stringContaining("test prompt"),
        "/cwd",
        expect.any(Function),
      );
    });

    it("passes onPid callback to runtime for PID tracking", async () => {
      const { setChildPidTracker, runPrompt } = await import("../cli-runner.js");
      const trackFn = vi.fn();
      const untrackFn = vi.fn();
      setChildPidTracker(trackFn, untrackFn);

      const runtime = createMockRuntime("output");
      // Override resumeSession to call onPid
      vi.mocked(runtime.resumeSession).mockImplementation(async (_sid, _prompt, _cwd, onPid) => {
        if (onPid) onPid(12345);
        return "output";
      });

      await runPrompt("session-123", "test", "/cwd", runtime);
      expect(trackFn).toHaveBeenCalledWith(12345);
    });
  });

  // ─── validateSessionId ──────────────────────────────────────

  describe("validateSessionId", () => {
    it("accepts valid UUID-like session IDs", async () => {
      const { validateSessionId } = await import("../cli-runner.js");
      expect(() => validateSessionId("abc-123-def")).not.toThrow();
      expect(() => validateSessionId("session_test_01")).not.toThrow();
    });

    it("rejects session IDs with special characters", async () => {
      const { validateSessionId } = await import("../cli-runner.js");
      expect(() => validateSessionId("id; rm -rf /")).toThrow(/Invalid session ID/);
      expect(() => validateSessionId("id\nmalicious")).toThrow(/Invalid session ID/);
      expect(() => validateSessionId("../path-traversal")).toThrow(/Invalid session ID/);
    });

    it("rejects empty session IDs", async () => {
      const { validateSessionId } = await import("../cli-runner.js");
      expect(() => validateSessionId("")).toThrow(/Invalid session ID/);
    });

    it("rejects session IDs over 128 characters", async () => {
      const { validateSessionId } = await import("../cli-runner.js");
      expect(() => validateSessionId("a".repeat(129))).toThrow(/Invalid session ID/);
    });
  });
});
