// backend/src/__tests__/agent-codex.test.ts
//
// Tests for the Codex CLI agent runtime: session parsing, health analysis,
// runtime class methods (encodeProjectCwd, detectNewSession, etc.),
// and self-registration into the agent-runtime registry.
//
// Uses vi.mock for child_process, fs to avoid needing a real codex binary.
// Uses vi.resetModules + dynamic import for module-level code re-execution.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Shared mock functions ───────────────────────────────────

const mockExecFile = vi.fn();
const mockExecFileSync = vi.fn();
const mockExistsSync = vi.fn();
const mockReaddirSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockStatSync = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
  execFileSync: mockExecFileSync,
}));

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
  readdirSync: mockReaddirSync,
  readFileSync: mockReadFileSync,
  statSync: mockStatSync,
}));

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock agent-runtime to capture registration calls
const mockRegisterRuntime = vi.fn();
vi.mock("../agent-runtime.js", () => ({
  registerRuntime: mockRegisterRuntime,
}));

// ─── Helper: dynamic import with module reset ─────────────────

async function importCodex() {
  vi.resetModules();
  return await import("../agent-codex.js");
}

// ─── parseCodexSessionFile ─────────────────────────────────────

describe("parseCodexSessionFile", () => {
  beforeEach(() => {
    vi.resetModules();
    mockReadFileSync.mockReset();
  });

  it("skips session_meta header lines", async () => {
    const { parseCodexSessionFile } = await importCodex();
    const raw = `{"type":"session_meta","payload":{"id":"abc-123","cwd":"/test","cli_version":"0.1.0"}}`;
    const nodes = parseCodexSessionFile("test.jsonl", raw);
    expect(nodes).toHaveLength(0);
  });

  it("parses user messages with string content", async () => {
    const { parseCodexSessionFile } = await importCodex();
    const raw = [
      '{"type":"session_meta","payload":{"id":"abc-123","cwd":"/test"}}',
      '{"type":"response_item","timestamp":"2025-01-01T00:00:00Z","payload":{"type":"message","role":"user","content":"Hello world"}}',
    ].join("\n");

    const nodes = parseCodexSessionFile("test.jsonl", raw);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe("user");
    expect(nodes[0].content).toBe("Hello world");
    expect(nodes[0].title).toBe("Hello world");
    expect(nodes[0].timestamp).toBe("2025-01-01T00:00:00Z");
  });

  it("parses user messages with content block array", async () => {
    const { parseCodexSessionFile } = await importCodex();
    const raw = [
      '{"type":"session_meta","payload":{"id":"abc-123"}}',
      '{"type":"response_item","timestamp":"2025-01-01T00:00:00Z","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Fix the bug"}]}}',
    ].join("\n");

    const nodes = parseCodexSessionFile("test.jsonl", raw);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe("user");
    expect(nodes[0].content).toBe("Fix the bug");
  });

  it("parses assistant messages", async () => {
    const { parseCodexSessionFile } = await importCodex();
    const raw = [
      '{"type":"session_meta","payload":{"id":"abc-123"}}',
      '{"type":"response_item","timestamp":"2025-01-01T00:01:00Z","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"I can help with that."}]}}',
    ].join("\n");

    const nodes = parseCodexSessionFile("test.jsonl", raw);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe("assistant");
    expect(nodes[0].content).toBe("I can help with that.");
  });

  it("skips developer messages", async () => {
    const { parseCodexSessionFile } = await importCodex();
    const raw = [
      '{"type":"session_meta","payload":{"id":"abc-123"}}',
      '{"type":"response_item","timestamp":"2025-01-01T00:00:00Z","payload":{"type":"message","role":"developer","content":"System instructions here"}}',
    ].join("\n");

    const nodes = parseCodexSessionFile("test.jsonl", raw);
    expect(nodes).toHaveLength(0);
  });

  it("parses function_call as tool_use node", async () => {
    const { parseCodexSessionFile } = await importCodex();
    const raw = [
      '{"type":"session_meta","payload":{"id":"abc-123"}}',
      '{"type":"response_item","timestamp":"2025-01-01T00:02:00Z","payload":{"type":"function_call","name":"shell","call_id":"call-1","arguments":"{\\"command\\":\\"ls -la\\"}"}}',
    ].join("\n");

    const nodes = parseCodexSessionFile("test.jsonl", raw);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe("tool_use");
    expect(nodes[0].toolName).toBe("shell");
    expect(nodes[0].toolUseId).toBe("call-1");
    expect(nodes[0].toolInput).toBe('{"command":"ls -la"}');
  });

  it("parses function_call_output as tool_result node", async () => {
    const { parseCodexSessionFile } = await importCodex();
    const raw = [
      '{"type":"session_meta","payload":{"id":"abc-123"}}',
      '{"type":"response_item","timestamp":"2025-01-01T00:03:00Z","payload":{"type":"function_call_output","call_id":"call-1","output":"total 42\\ndrwxr-xr-x 5 user staff 160 Jan 1 00:00 ."}}',
    ].join("\n");

    const nodes = parseCodexSessionFile("test.jsonl", raw);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe("tool_result");
    expect(nodes[0].toolUseId).toBe("call-1");
    expect(nodes[0].toolResult).toContain("total 42");
  });

  it("skips function_call_output with empty output", async () => {
    const { parseCodexSessionFile } = await importCodex();
    const raw = [
      '{"type":"session_meta","payload":{"id":"abc-123"}}',
      '{"type":"response_item","timestamp":"2025-01-01T00:03:00Z","payload":{"type":"function_call_output","call_id":"call-1"}}',
    ].join("\n");

    const nodes = parseCodexSessionFile("test.jsonl", raw);
    expect(nodes).toHaveLength(0);
  });

  it("parses event_msg agent_message as assistant node", async () => {
    const { parseCodexSessionFile } = await importCodex();
    const raw = [
      '{"type":"session_meta","payload":{"id":"abc-123"}}',
      '{"type":"event_msg","timestamp":"2025-01-01T00:05:00Z","payload":{"type":"agent_message","message":"Task completed successfully."}}',
    ].join("\n");

    const nodes = parseCodexSessionFile("test.jsonl", raw);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe("assistant");
    expect(nodes[0].content).toBe("Task completed successfully.");
  });

  it("parses event_msg turn_aborted as system node", async () => {
    const { parseCodexSessionFile } = await importCodex();
    const raw = [
      '{"type":"session_meta","payload":{"id":"abc-123"}}',
      '{"type":"event_msg","timestamp":"2025-01-01T00:06:00Z","payload":{"type":"turn_aborted","message":"Session was interrupted"}}',
    ].join("\n");

    const nodes = parseCodexSessionFile("test.jsonl", raw);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe("system");
    expect(nodes[0].title).toBe("Turn aborted");
    expect(nodes[0].content).toBe("Session was interrupted");
  });

  it("turn_aborted without message uses default text", async () => {
    const { parseCodexSessionFile } = await importCodex();
    const raw = [
      '{"type":"session_meta","payload":{"id":"abc-123"}}',
      '{"type":"event_msg","timestamp":"2025-01-01T00:06:00Z","payload":{"type":"turn_aborted"}}',
    ].join("\n");

    const nodes = parseCodexSessionFile("test.jsonl", raw);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].content).toBe("Session turn was aborted");
  });

  it("skips turn_context events", async () => {
    const { parseCodexSessionFile } = await importCodex();
    const raw = [
      '{"type":"session_meta","payload":{"id":"abc-123"}}',
      '{"type":"turn_context","timestamp":"2025-01-01T00:00:00Z","payload":{"turn_id":"turn-1","cwd":"/test","model":"o3-mini"}}',
    ].join("\n");

    const nodes = parseCodexSessionFile("test.jsonl", raw);
    expect(nodes).toHaveLength(0);
  });

  it("skips unparseable lines gracefully", async () => {
    const { parseCodexSessionFile } = await importCodex();
    const raw = [
      '{"type":"session_meta","payload":{"id":"abc-123"}}',
      "this is not json",
      '{"type":"response_item","timestamp":"2025-01-01T00:00:00Z","payload":{"type":"message","role":"user","content":"Hello"}}',
    ].join("\n");

    const nodes = parseCodexSessionFile("test.jsonl", raw);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe("user");
  });

  it("skips user messages with empty/whitespace content", async () => {
    const { parseCodexSessionFile } = await importCodex();
    const raw = [
      '{"type":"session_meta","payload":{"id":"abc-123"}}',
      '{"type":"response_item","timestamp":"2025-01-01T00:00:00Z","payload":{"type":"message","role":"user","content":"   "}}',
    ].join("\n");

    const nodes = parseCodexSessionFile("test.jsonl", raw);
    expect(nodes).toHaveLength(0);
  });

  it("parses a full realistic session with mixed event types", async () => {
    const { parseCodexSessionFile } = await importCodex();
    const raw = [
      '{"type":"session_meta","payload":{"id":"sess-001","cwd":"/Users/dev/project","cli_version":"0.1.2","timestamp":"2025-06-15T10:00:00Z"}}',
      '{"type":"turn_context","timestamp":"2025-06-15T10:00:01Z","payload":{"turn_id":"turn-1","cwd":"/Users/dev/project","model":"o3-mini"}}',
      '{"type":"response_item","timestamp":"2025-06-15T10:00:02Z","payload":{"type":"message","role":"developer","content":"You are a helpful coding assistant."}}',
      '{"type":"response_item","timestamp":"2025-06-15T10:00:03Z","payload":{"type":"message","role":"user","content":"List the files in the current directory"}}',
      '{"type":"response_item","timestamp":"2025-06-15T10:00:04Z","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"I\'ll list the files for you."}]}}',
      '{"type":"response_item","timestamp":"2025-06-15T10:00:05Z","payload":{"type":"function_call","name":"shell","call_id":"call-abc","arguments":"{\\"command\\":\\"ls -la\\"}"}}',
      '{"type":"response_item","timestamp":"2025-06-15T10:00:06Z","payload":{"type":"function_call_output","call_id":"call-abc","output":"total 8\\n-rw-r--r-- 1 dev staff 100 Jun 15 10:00 README.md"}}',
      '{"type":"event_msg","timestamp":"2025-06-15T10:00:07Z","payload":{"type":"agent_message","message":"Here are the files in your project directory."}}',
      '{"type":"event_msg","timestamp":"2025-06-15T10:00:08Z","payload":{"type":"token_count","total_tokens":1500}}',
    ].join("\n");

    const nodes = parseCodexSessionFile("test.jsonl", raw);

    // Should produce: user, assistant, tool_use, tool_result, assistant (agent_message)
    // Skipped: session_meta, turn_context, developer message, token_count
    expect(nodes).toHaveLength(5);

    expect(nodes[0].type).toBe("user");
    expect(nodes[0].content).toBe("List the files in the current directory");

    expect(nodes[1].type).toBe("assistant");
    expect(nodes[1].content).toBe("I'll list the files for you.");

    expect(nodes[2].type).toBe("tool_use");
    expect(nodes[2].toolName).toBe("shell");

    expect(nodes[3].type).toBe("tool_result");
    expect(nodes[3].toolUseId).toBe("call-abc");

    expect(nodes[4].type).toBe("assistant");
    expect(nodes[4].content).toBe("Here are the files in your project directory.");
  });

  it("reads from file when no rawContent provided", async () => {
    const { parseCodexSessionFile } = await importCodex();
    mockReadFileSync.mockReturnValue(
      '{"type":"session_meta","payload":{"id":"abc-123"}}\n' +
      '{"type":"response_item","timestamp":"2025-01-01T00:00:00Z","payload":{"type":"message","role":"user","content":"Hello"}}'
    );

    const nodes = parseCodexSessionFile("/path/to/session.jsonl");
    expect(mockReadFileSync).toHaveBeenCalledWith("/path/to/session.jsonl", "utf-8");
    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe("user");
  });

  it("truncates long titles", async () => {
    const { parseCodexSessionFile } = await importCodex();
    const longMessage = "A".repeat(200);
    const raw = [
      '{"type":"session_meta","payload":{"id":"abc-123"}}',
      `{"type":"response_item","timestamp":"2025-01-01T00:00:00Z","payload":{"type":"message","role":"user","content":"${longMessage}"}}`,
    ].join("\n");

    const nodes = parseCodexSessionFile("test.jsonl", raw);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].title.length).toBeLessThanOrEqual(120);
    expect(nodes[0].title).toContain("\u2026");
  });

  it("handles function_call with no arguments", async () => {
    const { parseCodexSessionFile } = await importCodex();
    const raw = [
      '{"type":"session_meta","payload":{"id":"abc-123"}}',
      '{"type":"response_item","timestamp":"2025-01-01T00:00:00Z","payload":{"type":"function_call","name":"get_cwd","call_id":"call-2"}}',
    ].join("\n");

    const nodes = parseCodexSessionFile("test.jsonl", raw);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].toolInput).toBe("{}");
  });

  it("extracts text from mixed content block types (ignores reasoning)", async () => {
    const { parseCodexSessionFile } = await importCodex();
    const raw = [
      '{"type":"session_meta","payload":{"id":"abc-123"}}',
      '{"type":"response_item","timestamp":"2025-01-01T00:00:00Z","payload":{"type":"message","role":"assistant","content":[{"type":"reasoning","text":"Let me think..."},{"type":"output_text","text":"Here is my answer."}]}}',
    ].join("\n");

    const nodes = parseCodexSessionFile("test.jsonl", raw);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].content).toBe("Here is my answer.");
  });
});

// ─── analyzeCodexSessionHealth ──────────────────────────────────

describe("analyzeCodexSessionHealth", () => {
  beforeEach(() => {
    vi.resetModules();
    mockReadFileSync.mockReset();
    mockExistsSync.mockReset();
    mockReaddirSync.mockReset();
    mockStatSync.mockReset();
  });

  it("returns null when file not found", async () => {
    const { analyzeCodexSessionHealth } = await importCodex();
    mockExistsSync.mockReturnValue(false);
    const result = analyzeCodexSessionHealth("nonexistent-id");
    expect(result).toBeNull();
  });

  it("analyzes a healthy session", async () => {
    const { analyzeCodexSessionHealth } = await importCodex();
    const content = [
      '{"type":"session_meta","payload":{"id":"sess-001","cwd":"/test"}}',
      '{"type":"response_item","payload":{"type":"message","role":"user","content":"Hello"}}',
      '{"type":"response_item","payload":{"type":"message","role":"assistant","content":"Hi there"}}',
      '{"type":"event_msg","payload":{"type":"token_count","total_tokens":500}}',
    ].join("\n");
    mockReadFileSync.mockReturnValue(content);

    const result = analyzeCodexSessionHealth("sess-001", "/tmp/test.jsonl");
    expect(result).not.toBeNull();
    expect(result!.failureReason).toBeNull();
    expect(result!.peakTokens).toBe(500);
    expect(result!.messageCount).toBe(4);
    expect(result!.contextPressure).toBe("none");
    expect(result!.compactCount).toBe(0);
    expect(result!.endedAfterCompaction).toBe(false);
  });

  it("detects API errors", async () => {
    const { analyzeCodexSessionHealth } = await importCodex();
    const content = [
      '{"type":"session_meta","payload":{"id":"sess-002","cwd":"/test"}}',
      '{"type":"response_item","payload":{"type":"message","role":"user","content":"Hello"}}',
      '{"type":"event_msg","payload":{"type":"api_error","message":"Rate limit exceeded"}}',
    ].join("\n");
    mockReadFileSync.mockReturnValue(content);

    const result = analyzeCodexSessionHealth("sess-002", "/tmp/test.jsonl");
    expect(result).not.toBeNull();
    expect(result!.failureReason).toBe("error");
    expect(result!.detail).toContain("Rate limit exceeded");
    expect(result!.lastApiError).toBe("Rate limit exceeded");
  });

  it("detects context exhaustion errors", async () => {
    const { analyzeCodexSessionHealth } = await importCodex();
    const content = [
      '{"type":"session_meta","payload":{"id":"sess-003","cwd":"/test"}}',
      '{"type":"event_msg","payload":{"type":"error","message":"context length exceeded the token limit"}}',
    ].join("\n");
    mockReadFileSync.mockReturnValue(content);

    const result = analyzeCodexSessionHealth("sess-003", "/tmp/test.jsonl");
    expect(result).not.toBeNull();
    expect(result!.failureReason).toBe("context_exhausted");
    expect(result!.detail).toContain("context");
  });

  it("detects output token limit errors", async () => {
    const { analyzeCodexSessionHealth } = await importCodex();
    const content = [
      '{"type":"session_meta","payload":{"id":"sess-004","cwd":"/test"}}',
      '{"type":"event_msg","payload":{"type":"error","message":"output exceeded the max token budget"}}',
    ].join("\n");
    mockReadFileSync.mockReturnValue(content);

    const result = analyzeCodexSessionHealth("sess-004", "/tmp/test.jsonl");
    expect(result).not.toBeNull();
    expect(result!.failureReason).toBe("output_token_limit");
  });

  it("detects turn_aborted as failure", async () => {
    const { analyzeCodexSessionHealth } = await importCodex();
    const content = [
      '{"type":"session_meta","payload":{"id":"sess-005","cwd":"/test"}}',
      '{"type":"response_item","payload":{"type":"message","role":"user","content":"Do something"}}',
      '{"type":"event_msg","payload":{"type":"turn_aborted","message":"Session was interrupted"}}',
    ].join("\n");
    mockReadFileSync.mockReturnValue(content);

    const result = analyzeCodexSessionHealth("sess-005", "/tmp/test.jsonl");
    expect(result).not.toBeNull();
    expect(result!.failureReason).toBe("error");
    expect(result!.detail).toBe("Session turn was aborted");
  });

  it("tracks peak token count from multiple token_count events", async () => {
    const { analyzeCodexSessionHealth } = await importCodex();
    const content = [
      '{"type":"session_meta","payload":{"id":"sess-006","cwd":"/test"}}',
      '{"type":"event_msg","payload":{"type":"token_count","total_tokens":1000}}',
      '{"type":"event_msg","payload":{"type":"token_count","total_tokens":5000}}',
      '{"type":"event_msg","payload":{"type":"token_count","total_tokens":3000}}',
    ].join("\n");
    mockReadFileSync.mockReturnValue(content);

    const result = analyzeCodexSessionHealth("sess-006", "/tmp/test.jsonl");
    expect(result).not.toBeNull();
    expect(result!.peakTokens).toBe(5000);
  });

  it("returns null when readFileSync throws", async () => {
    const { analyzeCodexSessionHealth } = await importCodex();
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const result = analyzeCodexSessionHealth("sess-007", "/tmp/nonexistent.jsonl");
    expect(result).toBeNull();
  });

  it("API error takes precedence over turn_aborted", async () => {
    const { analyzeCodexSessionHealth } = await importCodex();
    const content = [
      '{"type":"session_meta","payload":{"id":"sess-008","cwd":"/test"}}',
      '{"type":"event_msg","payload":{"type":"error","message":"Something broke"}}',
      '{"type":"event_msg","payload":{"type":"turn_aborted"}}',
    ].join("\n");
    mockReadFileSync.mockReturnValue(content);

    const result = analyzeCodexSessionHealth("sess-008", "/tmp/test.jsonl");
    expect(result).not.toBeNull();
    // API error takes precedence
    expect(result!.failureReason).toBe("error");
    expect(result!.detail).toContain("API error");
  });
});

// ─── CodexAgentRuntime class ────────────────────────────────────

describe("CodexAgentRuntime", () => {
  beforeEach(() => {
    vi.resetModules();
    mockExecFile.mockReset();
    mockExecFileSync.mockReset();
    mockExistsSync.mockReset();
    mockReaddirSync.mockReset();
    mockReadFileSync.mockReset();
    mockStatSync.mockReset();
  });

  it("has correct type", async () => {
    const { CodexAgentRuntime } = await importCodex();
    const runtime = new CodexAgentRuntime();
    expect(runtime.type).toBe("codex");
  });

  it("has correct capabilities", async () => {
    const { CodexAgentRuntime } = await importCodex();
    const runtime = new CodexAgentRuntime();
    expect(runtime.capabilities).toEqual({
      supportsResume: true,
      supportsInteractive: true,
      supportsTextOutput: true,
      supportsDangerousMode: true,
    });
  });

  it("getSessionsDir returns ~/.codex/sessions", async () => {
    const { CodexAgentRuntime } = await importCodex();
    const runtime = new CodexAgentRuntime();
    const dir = runtime.getSessionsDir();
    expect(dir).toContain(".codex");
    expect(dir).toContain("sessions");
  });

  describe("encodeProjectCwd", () => {
    it("encodes a simple path", async () => {
      const { CodexAgentRuntime } = await importCodex();
      const runtime = new CodexAgentRuntime();
      expect(runtime.encodeProjectCwd("/Users/dev/project")).toBe("Users-dev-project");
    });

    it("encodes root path", async () => {
      const { CodexAgentRuntime } = await importCodex();
      const runtime = new CodexAgentRuntime();
      expect(runtime.encodeProjectCwd("/")).toBe("");
    });

    it("encodes path with multiple segments", async () => {
      const { CodexAgentRuntime } = await importCodex();
      const runtime = new CodexAgentRuntime();
      expect(runtime.encodeProjectCwd("/home/user/code/my-project")).toBe("home-user-code-my-project");
    });

    it("handles path without leading slash", async () => {
      const { CodexAgentRuntime } = await importCodex();
      const runtime = new CodexAgentRuntime();
      expect(runtime.encodeProjectCwd("relative/path")).toBe("relative-path");
    });
  });

  describe("cleanEnv", () => {
    it("strips CODEX_HOME and CODEX_SESSION", async () => {
      const { CodexAgentRuntime } = await importCodex();
      const runtime = new CodexAgentRuntime();

      process.env.CODEX_HOME = "/some/path";
      process.env.CODEX_SESSION = "some-session";

      const env = runtime.cleanEnv();
      expect(env.CODEX_HOME).toBeUndefined();
      expect(env.CODEX_SESSION).toBeUndefined();

      // Cleanup
      delete process.env.CODEX_HOME;
      delete process.env.CODEX_SESSION;
    });

    it("preserves other env vars", async () => {
      const { CodexAgentRuntime } = await importCodex();
      const runtime = new CodexAgentRuntime();

      const env = runtime.cleanEnv();
      expect(env.PATH).toBeDefined();
    });
  });

  describe("runSession", () => {
    it("calls codex exec with --json --dangerously-bypass-approvals-and-sandbox and the prompt", async () => {
      const { CodexAgentRuntime } = await importCodex();
      const runtime = new CodexAgentRuntime();

      // Simulate successful exec returning an agent message
      mockExecFile.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: (err: null, stdout: string) => void) => {
        cb(null, '{"type":"event_msg","payload":{"type":"agent_message","message":"Done."}}\n');
        return { pid: 1234 };
      });

      const result = await runtime.runSession("Hello", "/test/cwd");

      expect(mockExecFile).toHaveBeenCalledTimes(1);
      const callArgs = mockExecFile.mock.calls[0];
      // args should include exec, --json, --dangerously-bypass-approvals-and-sandbox, -C, cwd, prompt
      expect(callArgs[1]).toContain("exec");
      expect(callArgs[1]).toContain("--json");
      expect(callArgs[1]).toContain("--dangerously-bypass-approvals-and-sandbox");
      expect(callArgs[1]).toContain("-C");
      expect(callArgs[1]).toContain("/test/cwd");
      expect(callArgs[1]).toContain("Hello");

      expect(result).toBe("Done.");
    });

    it("calls onPid when PID is available", async () => {
      const { CodexAgentRuntime } = await importCodex();
      const runtime = new CodexAgentRuntime();

      const childObj = { pid: 5678 };
      mockExecFile.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: (err: null, stdout: string) => void) => {
        cb(null, '{"type":"event_msg","payload":{"type":"agent_message","message":"ok"}}');
        return childObj;
      });

      const pidCallback = vi.fn();
      await runtime.runSession("test", undefined, pidCallback);
      expect(pidCallback).toHaveBeenCalledWith(5678);
    });

    it("resolves with stdout even on error if output exists", async () => {
      const { CodexAgentRuntime } = await importCodex();
      const runtime = new CodexAgentRuntime();

      mockExecFile.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: (err: Error, stdout: string) => void) => {
        cb(new Error("timeout"), '{"type":"event_msg","payload":{"type":"agent_message","message":"partial result"}}');
        return { pid: 1 };
      });

      const result = await runtime.runSession("test");
      expect(result).toBe("partial result");
    });

    it("rejects when error and no stdout", async () => {
      const { CodexAgentRuntime } = await importCodex();
      const runtime = new CodexAgentRuntime();

      mockExecFile.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: (err: Error, stdout: string, stderr: string) => void) => {
        cb(new Error("codex not found"), "", "binary not found");
        return {};
      });

      await expect(runtime.runSession("test")).rejects.toThrow("Codex CLI error");
    });
  });

  describe("runSessionInteractive", () => {
    it("calls codex exec with --dangerously-bypass-approvals-and-sandbox without --json", async () => {
      const { CodexAgentRuntime } = await importCodex();
      const runtime = new CodexAgentRuntime();

      mockExecFile.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: (err: null, stdout: string) => void) => {
        cb(null, "Interactive output");
        return {};
      });

      const result = await runtime.runSessionInteractive("Do something", "/test/dir");

      const callArgs = mockExecFile.mock.calls[0];
      expect(callArgs[1]).toContain("exec");
      expect(callArgs[1]).toContain("--dangerously-bypass-approvals-and-sandbox");
      expect(callArgs[1]).not.toContain("--json");
      expect(callArgs[1]).toContain("-C");
      expect(result).toBe("Interactive output");
    });

    it("rejects on error", async () => {
      const { CodexAgentRuntime } = await importCodex();
      const runtime = new CodexAgentRuntime();

      mockExecFile.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: (err: Error, stdout: string, stderr: string) => void) => {
        cb(new Error("failed"), "", "error output");
        return {};
      });

      await expect(runtime.runSessionInteractive("test")).rejects.toThrow("Codex interactive failed");
    });
  });

  describe("resumeSession", () => {
    it("calls codex exec resume with session ID", async () => {
      const { CodexAgentRuntime } = await importCodex();
      const runtime = new CodexAgentRuntime();

      mockExecFile.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: (err: null, stdout: string) => void) => {
        cb(null, '{"type":"event_msg","payload":{"type":"agent_message","message":"Resumed."}}');
        return { pid: 999 };
      });

      const result = await runtime.resumeSession("sess-abc", "Continue work", "/test");

      const callArgs = mockExecFile.mock.calls[0];
      expect(callArgs[1]).toContain("exec");
      expect(callArgs[1]).toContain("resume");
      expect(callArgs[1]).toContain("sess-abc");
      expect(callArgs[1]).toContain("Continue work");
      expect(callArgs[1]).toContain("--json");
      expect(callArgs[1]).toContain("--dangerously-bypass-approvals-and-sandbox");

      expect(result).toBe("Resumed.");
    });
  });

  describe("detectNewSession", () => {
    it("returns null when sessions dir does not exist", async () => {
      const { CodexAgentRuntime } = await importCodex();
      const runtime = new CodexAgentRuntime();
      mockExistsSync.mockReturnValue(false);

      const result = runtime.detectNewSession("/test/project", new Date("2025-01-01"));
      expect(result).toBeNull();
    });

    it("finds newest session matching project cwd", async () => {
      const { CodexAgentRuntime } = await importCodex();
      const runtime = new CodexAgentRuntime();

      const sessionsDir = runtime.getSessionsDir();

      // Mock directory structure: sessions/2025/06/15/
      mockExistsSync.mockReturnValue(true);

      // Root sessions dir
      mockReaddirSync.mockImplementation((dir: string) => {
        if (dir === sessionsDir) return ["2025"];
        if (dir.endsWith("2025")) return ["06"];
        if (dir.endsWith("06")) return ["15"];
        if (dir.endsWith("15")) return ["rollout-20250615-sess-abc.jsonl"];
        return [];
      });

      const sessionFilePath = `${sessionsDir}/2025/06/15/rollout-20250615-sess-abc.jsonl`;

      mockStatSync.mockImplementation((path: string) => {
        if (path === sessionFilePath) {
          return {
            isDirectory: () => false,
            mtime: new Date("2025-06-15T12:00:00Z"),
          };
        }
        return { isDirectory: () => true, mtime: new Date() };
      });

      // Session header with matching cwd
      mockReadFileSync.mockReturnValue(
        '{"type":"session_meta","payload":{"id":"sess-abc","cwd":"/test/project"}}\n'
      );

      const result = runtime.detectNewSession("/test/project", new Date("2025-06-15T10:00:00Z"));
      expect(result).toBe("sess-abc");
    });

    it("returns null when no sessions match project cwd", async () => {
      const { CodexAgentRuntime } = await importCodex();
      const runtime = new CodexAgentRuntime();

      const sessionsDir = runtime.getSessionsDir();

      mockExistsSync.mockReturnValue(true);

      mockReaddirSync.mockImplementation((dir: string) => {
        if (dir === sessionsDir) return ["2025"];
        if (dir.endsWith("2025")) return ["06"];
        if (dir.endsWith("06")) return ["15"];
        if (dir.endsWith("15")) return ["rollout-20250615-sess-xyz.jsonl"];
        return [];
      });

      const sessionFilePath = `${sessionsDir}/2025/06/15/rollout-20250615-sess-xyz.jsonl`;

      mockStatSync.mockImplementation((path: string) => {
        if (path === sessionFilePath) {
          return {
            isDirectory: () => false,
            mtime: new Date("2025-06-15T12:00:00Z"),
          };
        }
        return { isDirectory: () => true, mtime: new Date() };
      });

      // Session with different cwd
      mockReadFileSync.mockReturnValue(
        '{"type":"session_meta","payload":{"id":"sess-xyz","cwd":"/other/project"}}\n'
      );

      const result = runtime.detectNewSession("/test/project", new Date("2025-06-15T10:00:00Z"));
      expect(result).toBeNull();
    });

    it("returns null when sessions are older than beforeTimestamp", async () => {
      const { CodexAgentRuntime } = await importCodex();
      const runtime = new CodexAgentRuntime();

      const sessionsDir = runtime.getSessionsDir();

      mockExistsSync.mockReturnValue(true);

      mockReaddirSync.mockImplementation((dir: string) => {
        if (dir === sessionsDir) return ["2025"];
        if (dir.endsWith("2025")) return ["06"];
        if (dir.endsWith("06")) return ["15"];
        if (dir.endsWith("15")) return ["rollout-20250615-sess-old.jsonl"];
        return [];
      });

      const sessionFilePath = `${sessionsDir}/2025/06/15/rollout-20250615-sess-old.jsonl`;

      mockStatSync.mockImplementation((path: string) => {
        if (path === sessionFilePath) {
          return {
            isDirectory: () => false,
            mtime: new Date("2025-06-15T08:00:00Z"),
          };
        }
        return { isDirectory: () => true, mtime: new Date() };
      });

      mockReadFileSync.mockReturnValue(
        '{"type":"session_meta","payload":{"id":"sess-old","cwd":"/test/project"}}\n'
      );

      // beforeTimestamp is after the session mtime
      const result = runtime.detectNewSession("/test/project", new Date("2025-06-15T10:00:00Z"));
      expect(result).toBeNull();
    });
  });

  describe("findSessionFile", () => {
    it("finds a session file by ID across date directories", async () => {
      const { CodexAgentRuntime } = await importCodex();
      const runtime = new CodexAgentRuntime();

      const sessionsDir = runtime.getSessionsDir();

      mockExistsSync.mockReturnValue(true);

      mockReaddirSync.mockImplementation((dir: string) => {
        if (dir === sessionsDir) return ["2025"];
        if (dir.endsWith("2025")) return ["06"];
        if (dir.endsWith("06")) return ["15"];
        if (dir.endsWith("15")) return ["rollout-20250615-sess-find-me.jsonl"];
        return [];
      });

      mockStatSync.mockImplementation((path: string) => {
        if (path.endsWith(".jsonl")) {
          return { isDirectory: () => false };
        }
        return { isDirectory: () => true };
      });

      const result = runtime.findSessionFile("sess-find-me");
      expect(result).toContain("sess-find-me.jsonl");
    });

    it("returns null when sessions dir does not exist", async () => {
      const { CodexAgentRuntime } = await importCodex();
      const runtime = new CodexAgentRuntime();

      mockExistsSync.mockReturnValue(false);

      const result = runtime.findSessionFile("nonexistent");
      expect(result).toBeNull();
    });
  });
});

// ─── Self-registration ────────────────────────────────────────

describe("Codex self-registration", () => {
  it("registers 'codex' runtime on import", async () => {
    mockRegisterRuntime.mockReset();
    await importCodex();

    expect(mockRegisterRuntime).toHaveBeenCalledWith("codex", expect.any(Function));
  });

  it("factory creates a CodexAgentRuntime instance", async () => {
    mockRegisterRuntime.mockReset();
    const { CodexAgentRuntime } = await importCodex();

    const factory = mockRegisterRuntime.mock.calls[0][1];
    const instance = factory();
    expect(instance).toBeInstanceOf(CodexAgentRuntime);
    expect(instance.type).toBe("codex");
  });
});

// ─── extractOutput (via runSession) ─────────────────────────────

describe("extractOutput (via runSession)", () => {
  beforeEach(() => {
    vi.resetModules();
    mockExecFile.mockReset();
  });

  it("extracts task_complete message", async () => {
    const { CodexAgentRuntime } = await importCodex();
    const runtime = new CodexAgentRuntime();

    const output = [
      '{"type":"event_msg","payload":{"type":"agent_message","message":"Working on it..."}}',
      '{"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"All done!"}}',
    ].join("\n");

    mockExecFile.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: (err: null, stdout: string) => void) => {
      cb(null, output);
      return { pid: 1 };
    });

    const result = await runtime.runSession("test");
    expect(result).toBe("All done!");
  });

  it("falls back to last assistant message when no event_msg", async () => {
    const { CodexAgentRuntime } = await importCodex();
    const runtime = new CodexAgentRuntime();

    const output = [
      '{"type":"response_item","payload":{"type":"message","role":"assistant","content":"First response"}}',
      '{"type":"response_item","payload":{"type":"message","role":"assistant","content":"Second response"}}',
    ].join("\n");

    mockExecFile.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: (err: null, stdout: string) => void) => {
      cb(null, output);
      return { pid: 1 };
    });

    const result = await runtime.runSession("test");
    expect(result).toBe("Second response");
  });

  it("returns raw output when no messages found", async () => {
    const { CodexAgentRuntime } = await importCodex();
    const runtime = new CodexAgentRuntime();

    mockExecFile.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: (err: null, stdout: string) => void) => {
      cb(null, "some raw text");
      return { pid: 1 };
    });

    const result = await runtime.runSession("test");
    expect(result).toBe("some raw text");
  });

  it("returns empty string for empty output", async () => {
    const { CodexAgentRuntime } = await importCodex();
    const runtime = new CodexAgentRuntime();

    mockExecFile.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: (err: null, stdout: string) => void) => {
      cb(null, "");
      return { pid: 1 };
    });

    const result = await runtime.runSession("test");
    expect(result).toBe("");
  });
});
