// backend/src/__tests__/agent-openclaw.test.ts
//
// Tests for the OpenClaw agent runtime: session parsing, health analysis,
// runtime class methods (runSession, resumeSession, detectNewSession, etc.),
// and self-registration into the agent-runtime registry.
//
// Uses vi.mock for child_process, fs, crypto to avoid needing a real openclaw binary.
// Uses vi.resetModules + dynamic import for module-level code re-execution.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Shared mock functions ───────────────────────────────────

const mockExecFile = vi.fn();
const mockExecFileSync = vi.fn();
const mockExistsSync = vi.fn();
const mockReaddirSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockStatSync = vi.fn();
const mockRandomUUID = vi.fn(() => "test-uuid-1234");

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

vi.mock("node:crypto", () => ({
  randomUUID: () => mockRandomUUID(),
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

async function importOpenClaw() {
  vi.resetModules();
  return await import("../agent-openclaw.js");
}

// ─── parseOpenClawSessionFile ─────────────────────────────────

describe("parseOpenClawSessionFile", () => {
  beforeEach(() => {
    vi.resetModules();
    mockReadFileSync.mockReset();
  });

  it("skips session header lines", async () => {
    const { parseOpenClawSessionFile } = await importOpenClaw();
    const raw = `{"type":"session","version":3,"cwd":"/test","timestamp":"2025-01-01T00:00:00Z"}`;
    const nodes = parseOpenClawSessionFile("test.jsonl", raw);
    expect(nodes).toHaveLength(0);
  });

  it("parses user messages", async () => {
    const { parseOpenClawSessionFile } = await importOpenClaw();
    const raw = [
      '{"type":"session","version":3}',
      '{"type":"message","message":{"role":"user","content":"Hello world"},"timestamp":"2025-01-01T00:00:00Z","id":"msg-1"}',
    ].join("\n");

    const nodes = parseOpenClawSessionFile("test.jsonl", raw);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe("user");
    expect(nodes[0].content).toBe("Hello world");
    expect(nodes[0].id).toBe("msg-1");
    expect(nodes[0].title).toBe("Hello world");
  });

  it("parses assistant messages with string content", async () => {
    const { parseOpenClawSessionFile } = await importOpenClaw();
    const raw = [
      '{"type":"session","version":3}',
      '{"type":"message","message":{"role":"assistant","content":"I can help with that."},"timestamp":"2025-01-01T00:01:00Z","id":"msg-2"}',
    ].join("\n");

    const nodes = parseOpenClawSessionFile("test.jsonl", raw);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe("assistant");
    expect(nodes[0].content).toBe("I can help with that.");
  });

  it("parses assistant messages with content block array", async () => {
    const { parseOpenClawSessionFile } = await importOpenClaw();
    const content = [
      { type: "thinking", text: "Let me think about this..." },
      { type: "text", text: "Here is my answer." },
      { type: "tool_use", toolCallId: "tc-1", toolName: "Read", input: { file: "test.ts" } },
    ];
    const raw = [
      '{"type":"session","version":3}',
      JSON.stringify({ type: "message", message: { role: "assistant", content }, timestamp: "2025-01-01", id: "msg-3" }),
    ].join("\n");

    const nodes = parseOpenClawSessionFile("test.jsonl", raw);
    // Should produce: 1 assistant text node + 1 tool_use node (thinking is skipped)
    expect(nodes).toHaveLength(2);

    const assistantNode = nodes.find((n) => n.type === "assistant");
    expect(assistantNode).toBeDefined();
    expect(assistantNode!.content).toBe("Here is my answer.");

    const toolUseNode = nodes.find((n) => n.type === "tool_use");
    expect(toolUseNode).toBeDefined();
    expect(toolUseNode!.toolName).toBe("Read");
    expect(toolUseNode!.toolUseId).toBe("tc-1");
  });

  it("parses tool_call events into tool_use + tool_result pairs", async () => {
    const { parseOpenClawSessionFile } = await importOpenClaw();
    const raw = [
      '{"type":"session","version":3}',
      JSON.stringify({
        type: "tool_call",
        toolName: "Bash",
        toolCallId: "tc-99",
        input: { command: "ls" },
        output: "file1.ts\nfile2.ts",
        timestamp: "2025-01-01",
        id: "evt-1",
      }),
    ].join("\n");

    const nodes = parseOpenClawSessionFile("test.jsonl", raw);
    expect(nodes).toHaveLength(2);

    expect(nodes[0].type).toBe("tool_use");
    expect(nodes[0].toolName).toBe("Bash");
    expect(nodes[0].toolUseId).toBe("tc-99");
    expect(nodes[0].id).toBe("evt-1-use");

    expect(nodes[1].type).toBe("tool_result");
    expect(nodes[1].toolResult).toBe("file1.ts\nfile2.ts");
    expect(nodes[1].id).toBe("evt-1-result");
  });

  it("parses skill_call events", async () => {
    const { parseOpenClawSessionFile } = await importOpenClaw();
    const raw = [
      '{"type":"session","version":3}',
      JSON.stringify({
        type: "skill_call",
        skillName: "commit",
        toolCallId: "sk-1",
        input: { message: "fix: typo" },
        result: "Committed successfully",
        timestamp: "2025-01-01",
        id: "evt-2",
      }),
    ].join("\n");

    const nodes = parseOpenClawSessionFile("test.jsonl", raw);
    expect(nodes).toHaveLength(2);
    expect(nodes[0].type).toBe("tool_use");
    expect(nodes[0].toolName).toBe("commit");
    expect(nodes[1].type).toBe("tool_result");
    expect(nodes[1].content).toBe("Committed successfully");
  });

  it("parses tool_call with isError flag", async () => {
    const { parseOpenClawSessionFile } = await importOpenClaw();
    const raw = [
      '{"type":"session","version":3}',
      JSON.stringify({
        type: "tool_call",
        toolName: "Bash",
        toolCallId: "tc-err",
        input: { command: "invalid" },
        output: "command not found",
        isError: true,
        id: "evt-3",
      }),
    ].join("\n");

    const nodes = parseOpenClawSessionFile("test.jsonl", raw);
    expect(nodes).toHaveLength(2);
    expect(nodes[1].title).toContain("(error)");
  });

  it("parses error events", async () => {
    const { parseOpenClawSessionFile } = await importOpenClaw();
    const raw = [
      '{"type":"session","version":3}',
      '{"type":"error","message":"Rate limit exceeded","timestamp":"2025-01-01","id":"err-1"}',
    ].join("\n");

    const nodes = parseOpenClawSessionFile("test.jsonl", raw);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe("error");
    expect(nodes[0].content).toBe("Rate limit exceeded");
    expect(nodes[0].title).toBe("Error");
  });

  it("handles error events with no message", async () => {
    const { parseOpenClawSessionFile } = await importOpenClaw();
    const raw = [
      '{"type":"session","version":3}',
      '{"type":"error","id":"err-2"}',
    ].join("\n");

    const nodes = parseOpenClawSessionFile("test.jsonl", raw);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].content).toBe("Unknown error");
  });

  it("skips model_change events", async () => {
    const { parseOpenClawSessionFile } = await importOpenClaw();
    const raw = [
      '{"type":"session","version":3}',
      '{"type":"model_change","model":"claude-opus-4-20250514","timestamp":"2025-01-01"}',
    ].join("\n");

    const nodes = parseOpenClawSessionFile("test.jsonl", raw);
    expect(nodes).toHaveLength(0);
  });

  it("skips compaction events", async () => {
    const { parseOpenClawSessionFile } = await importOpenClaw();
    const raw = [
      '{"type":"session","version":3}',
      '{"type":"compaction","preTokens":150000,"timestamp":"2025-01-01"}',
      '{"type":"compact_boundary","timestamp":"2025-01-01"}',
    ].join("\n");

    const nodes = parseOpenClawSessionFile("test.jsonl", raw);
    expect(nodes).toHaveLength(0);
  });

  it("skips thinking_level_change events", async () => {
    const { parseOpenClawSessionFile } = await importOpenClaw();
    const raw = [
      '{"type":"session","version":3}',
      '{"type":"thinking_level_change","level":"extended","timestamp":"2025-01-01"}',
    ].join("\n");

    const nodes = parseOpenClawSessionFile("test.jsonl", raw);
    expect(nodes).toHaveLength(0);
  });

  it("skips blank user messages", async () => {
    const { parseOpenClawSessionFile } = await importOpenClaw();
    const raw = [
      '{"type":"session","version":3}',
      '{"type":"message","message":{"role":"user","content":"   "},"id":"msg-blank"}',
    ].join("\n");

    const nodes = parseOpenClawSessionFile("test.jsonl", raw);
    expect(nodes).toHaveLength(0);
  });

  it("skips invalid JSON lines gracefully", async () => {
    const { parseOpenClawSessionFile } = await importOpenClaw();
    const raw = [
      '{"type":"session","version":3}',
      "not valid json",
      '{"type":"message","message":{"role":"user","content":"Valid"},"id":"msg-ok"}',
    ].join("\n");

    const nodes = parseOpenClawSessionFile("test.jsonl", raw);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].content).toBe("Valid");
  });

  it("reads from file when no rawContent provided", async () => {
    const fileContent = [
      '{"type":"session","version":3}',
      '{"type":"message","message":{"role":"user","content":"From file"},"id":"msg-f"}',
    ].join("\n");
    mockReadFileSync.mockReturnValue(fileContent);

    const { parseOpenClawSessionFile } = await importOpenClaw();
    const nodes = parseOpenClawSessionFile("/path/to/session.jsonl");
    expect(nodes).toHaveLength(1);
    expect(nodes[0].content).toBe("From file");
    expect(mockReadFileSync).toHaveBeenCalledWith("/path/to/session.jsonl", "utf-8");
  });

  it("generates fallback IDs for events without id field", async () => {
    const { parseOpenClawSessionFile } = await importOpenClaw();
    const raw = [
      '{"type":"session","version":3}',
      '{"type":"message","message":{"role":"user","content":"No ID"}}',
    ].join("\n");

    const nodes = parseOpenClawSessionFile("test.jsonl", raw);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].id).toBe("line-1"); // line index 1 (0 is header)
  });

  it("truncates long titles to 120 chars", async () => {
    const { parseOpenClawSessionFile } = await importOpenClaw();
    const longText = "A".repeat(200);
    const raw = [
      '{"type":"session","version":3}',
      JSON.stringify({ type: "message", message: { role: "user", content: longText }, id: "msg-long" }),
    ].join("\n");

    const nodes = parseOpenClawSessionFile("test.jsonl", raw);
    expect(nodes[0].title.length).toBeLessThanOrEqual(120);
    expect(nodes[0].title.endsWith("\u2026")).toBe(true);
  });

  it("handles tool_call with no output (no result node)", async () => {
    const { parseOpenClawSessionFile } = await importOpenClaw();
    const raw = [
      '{"type":"session","version":3}',
      JSON.stringify({
        type: "tool_call",
        toolName: "Write",
        toolCallId: "tc-noout",
        input: { file: "test.ts", content: "code" },
        id: "evt-noout",
      }),
    ].join("\n");

    const nodes = parseOpenClawSessionFile("test.jsonl", raw);
    // Only tool_use, no tool_result since output is empty
    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe("tool_use");
  });

  it("handles a full realistic session with mixed event types", async () => {
    const { parseOpenClawSessionFile } = await importOpenClaw();
    const raw = [
      '{"type":"session","version":3,"cwd":"/project","timestamp":"2025-01-01"}',
      '{"type":"message","message":{"role":"user","content":"Fix the bug"},"id":"m1"}',
      '{"type":"message","message":{"role":"assistant","content":"Looking into it."},"id":"m2"}',
      '{"type":"tool_call","toolName":"Read","toolCallId":"tc1","input":{"file":"bug.ts"},"output":"line 1\\nline 2","id":"t1"}',
      '{"type":"model_change","model":"claude-sonnet-4-20250514"}',
      '{"type":"message","message":{"role":"assistant","content":"Found the issue."},"id":"m3"}',
      '{"type":"compaction","preTokens":120000}',
      '{"type":"error","message":"API timeout","id":"e1"}',
    ].join("\n");

    const nodes = parseOpenClawSessionFile("test.jsonl", raw);
    const types = nodes.map((n) => n.type);
    expect(types).toEqual([
      "user",       // m1
      "assistant",  // m2
      "tool_use",   // t1-use
      "tool_result", // t1-result
      "assistant",  // m3
      "error",      // e1
    ]);
  });
});

// ─── analyzeOpenClawSessionHealth ─────────────────────────────

describe("analyzeOpenClawSessionHealth", () => {
  beforeEach(() => {
    vi.resetModules();
    mockExistsSync.mockReset();
    mockReaddirSync.mockReset();
    mockReadFileSync.mockReset();
  });

  it("returns null when agents dir does not exist and no filePath", async () => {
    mockExistsSync.mockReturnValue(false);
    const { analyzeOpenClawSessionHealth } = await importOpenClaw();
    const result = analyzeOpenClawSessionHealth("missing-session");
    expect(result).toBeNull();
  });

  it("returns null when session file cannot be read", async () => {
    mockReadFileSync.mockImplementation(() => { throw new Error("ENOENT"); });
    const { analyzeOpenClawSessionHealth } = await importOpenClaw();
    const result = analyzeOpenClawSessionHealth("bad-session", "/nonexistent/path.jsonl");
    expect(result).toBeNull();
  });

  it("returns contextPressure=none for a clean session", async () => {
    const raw = [
      '{"type":"session","version":3}',
      '{"type":"message","message":{"role":"user","content":"Hello"}}',
      '{"type":"message","message":{"role":"assistant","content":"Hi!"}}',
    ].join("\n");
    mockReadFileSync.mockReturnValue(raw);

    const { analyzeOpenClawSessionHealth } = await importOpenClaw();
    const result = analyzeOpenClawSessionHealth("clean-session", "/path/to/session.jsonl");

    expect(result).not.toBeNull();
    expect(result!.contextPressure).toBe("none");
    expect(result!.compactCount).toBe(0);
    expect(result!.failureReason).toBeNull();
    expect(result!.messageCount).toBe(3); // session + user + assistant
  });

  it("detects moderate context pressure (1 compaction)", async () => {
    const raw = [
      '{"type":"session","version":3}',
      '{"type":"message","message":{"role":"user","content":"Hello"}}',
      '{"type":"message","message":{"role":"assistant","content":"Hi"}}',
      '{"type":"compaction","preTokens":100000}',
      '{"type":"message","message":{"role":"user","content":"Continue"}}',
      '{"type":"message","message":{"role":"assistant","content":"Sure"}}',
    ].join("\n");
    mockReadFileSync.mockReturnValue(raw);

    const { analyzeOpenClawSessionHealth } = await importOpenClaw();
    const result = analyzeOpenClawSessionHealth("sess-1", "/path.jsonl");

    expect(result!.contextPressure).toBe("moderate");
    expect(result!.compactCount).toBe(1);
  });

  it("detects high context pressure (2 compactions)", async () => {
    const raw = [
      '{"type":"session","version":3}',
      '{"type":"compaction","preTokens":120000}',
      '{"type":"message","message":{"role":"assistant","content":"Ok"}}',
      '{"type":"message","message":{"role":"assistant","content":"More"}}',
      '{"type":"compaction","preTokens":130000}',
      '{"type":"message","message":{"role":"assistant","content":"Done"}}',
      '{"type":"message","message":{"role":"assistant","content":"Final"}}',
    ].join("\n");
    mockReadFileSync.mockReturnValue(raw);

    const { analyzeOpenClawSessionHealth } = await importOpenClaw();
    const result = analyzeOpenClawSessionHealth("sess-2", "/path.jsonl");

    expect(result!.contextPressure).toBe("high");
    expect(result!.compactCount).toBe(2);
  });

  it("detects high context pressure (1 compaction + peak > 150k)", async () => {
    const raw = [
      '{"type":"session","version":3}',
      '{"type":"compaction","preTokens":160000}',
      '{"type":"message","message":{"role":"assistant","content":"Ok"}}',
      '{"type":"message","message":{"role":"assistant","content":"More"}}',
    ].join("\n");
    mockReadFileSync.mockReturnValue(raw);

    const { analyzeOpenClawSessionHealth } = await importOpenClaw();
    const result = analyzeOpenClawSessionHealth("sess-hp", "/path.jsonl");

    expect(result!.contextPressure).toBe("high");
    expect(result!.peakTokens).toBe(160000);
  });

  it("detects critical context pressure (3+ compactions)", async () => {
    const raw = [
      '{"type":"session","version":3}',
      '{"type":"compaction","preTokens":100000}',
      '{"type":"message","message":{"role":"assistant","content":"A"}}',
      '{"type":"compaction","preTokens":110000}',
      '{"type":"message","message":{"role":"assistant","content":"B"}}',
      '{"type":"compaction","preTokens":120000}',
      '{"type":"message","message":{"role":"assistant","content":"C"}}',
    ].join("\n");
    mockReadFileSync.mockReturnValue(raw);

    const { analyzeOpenClawSessionHealth } = await importOpenClaw();
    const result = analyzeOpenClawSessionHealth("sess-3", "/path.jsonl");

    expect(result!.contextPressure).toBe("critical");
    expect(result!.compactCount).toBe(3);
  });

  it("detects critical pressure when ended after 2+ compactions", async () => {
    const raw = [
      '{"type":"session","version":3}',
      '{"type":"compaction","preTokens":100000}',
      '{"type":"message","message":{"role":"assistant","content":"A"}}',
      '{"type":"compaction","preTokens":110000}',
      // Only 1 response after last compaction → endedAfterCompaction
      '{"type":"message","message":{"role":"assistant","content":"final"}}',
    ].join("\n");
    mockReadFileSync.mockReturnValue(raw);

    const { analyzeOpenClawSessionHealth } = await importOpenClaw();
    const result = analyzeOpenClawSessionHealth("sess-crit", "/path.jsonl");

    expect(result!.contextPressure).toBe("critical");
    expect(result!.endedAfterCompaction).toBe(true);
    expect(result!.responsesAfterLastCompact).toBe(1);
  });

  it("detects API error and sets failure reason", async () => {
    const raw = [
      '{"type":"session","version":3}',
      '{"type":"message","message":{"role":"user","content":"Do something"}}',
      '{"type":"error","message":"API rate limit exceeded"}',
    ].join("\n");
    mockReadFileSync.mockReturnValue(raw);

    const { analyzeOpenClawSessionHealth } = await importOpenClaw();
    const result = analyzeOpenClawSessionHealth("sess-err", "/path.jsonl");

    expect(result!.lastApiError).toBe("API rate limit exceeded");
    expect(result!.failureReason).toBe("error");
    expect(result!.detail).toContain("API error");
  });

  it("detects context exhaustion error from error message", async () => {
    const raw = [
      '{"type":"session","version":3}',
      '{"type":"error","message":"context window exceeded token limit"}',
    ].join("\n");
    mockReadFileSync.mockReturnValue(raw);

    const { analyzeOpenClawSessionHealth } = await importOpenClaw();
    const result = analyzeOpenClawSessionHealth("sess-ctx", "/path.jsonl");

    expect(result!.failureReason).toBe("context_exhausted");
  });

  it("detects output token limit error", async () => {
    const raw = [
      '{"type":"session","version":3}',
      '{"type":"error","message":"exceeded maximum output tokens allowed"}',
    ].join("\n");
    mockReadFileSync.mockReturnValue(raw);

    const { analyzeOpenClawSessionHealth } = await importOpenClaw();
    const result = analyzeOpenClawSessionHealth("sess-otl", "/path.jsonl");

    expect(result!.failureReason).toBe("output_token_limit");
  });

  it("tracks peak tokens from assistant message usage", async () => {
    const raw = [
      '{"type":"session","version":3}',
      JSON.stringify({ type: "message", message: { role: "assistant", content: "Hi", usage: { input: 50000, output: 5000, totalTokens: 55000 } } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: "Bye", usage: { input: 80000, output: 10000, totalTokens: 100000 } } }),
    ].join("\n");
    mockReadFileSync.mockReturnValue(raw);

    const { analyzeOpenClawSessionHealth } = await importOpenClaw();
    const result = analyzeOpenClawSessionHealth("sess-tok", "/path.jsonl");

    expect(result!.peakTokens).toBe(100000);
  });

  it("scans agent directories to find session file by ID", async () => {
    // Setup: agents dir exists, has one agent with a matching session
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith("agents")) return true;
      if (p.endsWith("sessions")) return true;
      if (p.endsWith("target-session.jsonl")) return true;
      return false;
    });
    mockReaddirSync.mockImplementation((p: string, opts?: unknown) => {
      if (String(p).endsWith("agents")) {
        if (opts && typeof opts === "object" && "withFileTypes" in opts) {
          return [{ name: "my-agent", isDirectory: () => true }];
        }
        return ["my-agent"];
      }
      return [];
    });

    const sessionContent = [
      '{"type":"session","version":3}',
      '{"type":"message","message":{"role":"user","content":"test"}}',
    ].join("\n");
    mockReadFileSync.mockReturnValue(sessionContent);

    const { analyzeOpenClawSessionHealth } = await importOpenClaw();
    const result = analyzeOpenClawSessionHealth("target-session");

    expect(result).not.toBeNull();
    expect(result!.messageCount).toBe(2);
  });

  it("detects context_exhausted from compaction pattern (no error)", async () => {
    const raw = [
      '{"type":"session","version":3}',
      '{"type":"compaction","preTokens":130000}',
      '{"type":"message","message":{"role":"assistant","content":"A"}}',
      '{"type":"compaction","preTokens":140000}',
      // 0 assistant messages after last compact → endedAfterCompaction
    ].join("\n");
    mockReadFileSync.mockReturnValue(raw);

    const { analyzeOpenClawSessionHealth } = await importOpenClaw();
    const result = analyzeOpenClawSessionHealth("sess-compact-die", "/path.jsonl");

    expect(result!.failureReason).toBe("context_exhausted");
    expect(result!.endedAfterCompaction).toBe(true);
    expect(result!.responsesAfterLastCompact).toBe(0);
  });
});

// ─── OpenClawAgentRuntime class ──────────────────────────────

describe("OpenClawAgentRuntime", () => {
  let OpenClawAgentRuntime: typeof import("../agent-openclaw.js").OpenClawAgentRuntime;

  beforeEach(async () => {
    vi.resetModules();
    mockExecFile.mockReset();
    mockExistsSync.mockReset();
    mockReaddirSync.mockReset();
    mockReadFileSync.mockReset();
    mockStatSync.mockReset();
    mockRandomUUID.mockReturnValue("test-uuid-1234");

    // Set OPENCLAW_PATH so module-level resolution doesn't fail
    process.env.OPENCLAW_PATH = "/mock/openclaw";

    const mod = await importOpenClaw();
    OpenClawAgentRuntime = mod.OpenClawAgentRuntime;
  });

  afterEach(() => {
    delete process.env.OPENCLAW_PATH;
  });

  describe("type and capabilities", () => {
    it("has type 'openclaw'", () => {
      const runtime = new OpenClawAgentRuntime();
      expect(runtime.type).toBe("openclaw");
    });

    it("supports resume and interactive but not dangerous mode", () => {
      const runtime = new OpenClawAgentRuntime();
      expect(runtime.capabilities.supportsResume).toBe(true);
      expect(runtime.capabilities.supportsInteractive).toBe(true);
      expect(runtime.capabilities.supportsTextOutput).toBe(true);
      expect(runtime.capabilities.supportsDangerousMode).toBe(false);
    });
  });

  describe("getSessionsDir", () => {
    it("returns ~/.openclaw/agents", () => {
      const runtime = new OpenClawAgentRuntime();
      const dir = runtime.getSessionsDir();
      expect(dir).toContain(".openclaw");
      expect(dir).toContain("agents");
    });
  });

  describe("encodeProjectCwd", () => {
    it("replaces slashes with hyphens and strips leading hyphen", () => {
      const runtime = new OpenClawAgentRuntime();
      expect(runtime.encodeProjectCwd("/Users/test/project")).toBe("Users-test-project");
    });

    it("handles paths without leading slash", () => {
      const runtime = new OpenClawAgentRuntime();
      expect(runtime.encodeProjectCwd("relative/path")).toBe("relative-path");
    });
  });

  describe("cleanEnv", () => {
    it("strips CLAUDECODE and OPENCLAW_SESSION env vars", () => {
      process.env.CLAUDECODE = "1";
      process.env.OPENCLAW_SESSION = "abc";
      process.env.HOME = "/test/home";

      const runtime = new OpenClawAgentRuntime();
      const env = runtime.cleanEnv();

      expect(env.CLAUDECODE).toBeUndefined();
      expect(env.OPENCLAW_SESSION).toBeUndefined();
      expect(env.HOME).toBe("/test/home");

      delete process.env.CLAUDECODE;
      delete process.env.OPENCLAW_SESSION;
    });
  });

  describe("runSession", () => {
    it("executes openclaw agent with --json flag", async () => {
      const runtime = new OpenClawAgentRuntime();
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, JSON.stringify({ message: { content: "Done!" } }), "");
        return { pid: 12345 };
      });

      const result = await runtime.runSession("test prompt", "/test/cwd");
      expect(result).toBe("Done!");

      expect(mockExecFile).toHaveBeenCalledWith(
        expect.any(String), // OPENCLAW_PATH
        expect.arrayContaining(["agent", "--session-id", "test-uuid-1234", "--message", "test prompt", "--json"]),
        expect.objectContaining({ cwd: "/test/cwd" }),
        expect.any(Function),
      );
    });

    it("calls onPid callback with process ID", async () => {
      const runtime = new OpenClawAgentRuntime();
      const onPid = vi.fn();
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, '{"message":{"content":"ok"}}', "");
        return { pid: 42 };
      });

      await runtime.runSession("prompt", undefined, onPid);
      expect(onPid).toHaveBeenCalledWith(42);
    });

    it("returns stdout on error if output is present", async () => {
      const runtime = new OpenClawAgentRuntime();
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(new Error("exit code 1"), '{"message":{"content":"partial result"}}', "some stderr");
        return { pid: 1 };
      });

      const result = await runtime.runSession("prompt");
      expect(result).toBe("partial result");
    });

    it("rejects on error when no output", async () => {
      const runtime = new OpenClawAgentRuntime();
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(new Error("CLI crashed"), "", "fatal error");
        return { pid: 1 };
      });

      await expect(runtime.runSession("prompt")).rejects.toThrow("OpenClaw CLI error");
    });

    it("handles plain text output (non-JSON)", async () => {
      const runtime = new OpenClawAgentRuntime();
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, "Plain text response from openclaw", "");
        return { pid: 1 };
      });

      const result = await runtime.runSession("prompt");
      expect(result).toBe("Plain text response from openclaw");
    });

    it("extracts text from content block array in JSON response", async () => {
      const runtime = new OpenClawAgentRuntime();
      const response = {
        message: {
          content: [
            { type: "text", text: "Part 1." },
            { type: "text", text: "Part 2." },
          ],
        },
      };
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, JSON.stringify(response), "");
        return { pid: 1 };
      });

      const result = await runtime.runSession("prompt");
      expect(result).toBe("Part 1.\nPart 2.");
    });
  });

  describe("resumeSession", () => {
    it("uses the provided session ID (not a new UUID)", async () => {
      const runtime = new OpenClawAgentRuntime();
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, '{"message":{"content":"Resumed"}}', "");
        return { pid: 99 };
      });

      const result = await runtime.resumeSession("existing-session-id", "continue", "/cwd");
      expect(result).toBe("Resumed");

      expect(mockExecFile).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(["--session-id", "existing-session-id", "--message", "continue", "--json"]),
        expect.anything(),
        expect.any(Function),
      );
    });

    it("calls onPid callback", async () => {
      const runtime = new OpenClawAgentRuntime();
      const onPid = vi.fn();
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, '{"message":{"content":"ok"}}', "");
        return { pid: 77 };
      });

      await runtime.resumeSession("sess-id", "go", undefined, onPid);
      expect(onPid).toHaveBeenCalledWith(77);
    });

    it("returns partial output on error", async () => {
      const runtime = new OpenClawAgentRuntime();
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(new Error("timeout"), "partial output text", "");
        return { pid: 1 };
      });

      const result = await runtime.resumeSession("sess", "prompt");
      expect(result).toBe("partial output text");
    });

    it("rejects when error and no output", async () => {
      const runtime = new OpenClawAgentRuntime();
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(new Error("fail"), "", "");
        return { pid: 1 };
      });

      await expect(runtime.resumeSession("sess", "prompt")).rejects.toThrow("OpenClaw resume error");
    });
  });

  describe("runSessionInteractive", () => {
    it("executes without --json flag", async () => {
      const runtime = new OpenClawAgentRuntime();
      mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
        // Verify no --json flag
        expect(args).not.toContain("--json");
        cb(null, "interactive output", "");
        return { pid: 1 };
      });

      const result = await runtime.runSessionInteractive("prompt", "/cwd");
      expect(result).toBe("interactive output");
    });

    it("rejects on error", async () => {
      const runtime = new OpenClawAgentRuntime();
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(new Error("interactive failed"), "", "err");
        return { pid: 1 };
      });

      await expect(runtime.runSessionInteractive("prompt")).rejects.toThrow("OpenClaw interactive failed");
    });
  });

  describe("detectNewSession", () => {
    it("returns null when agents dir does not exist", () => {
      const runtime = new OpenClawAgentRuntime();
      mockExistsSync.mockReturnValue(false);

      const result = runtime.detectNewSession("/project", new Date());
      expect(result).toBeNull();
    });

    it("returns null when agents dir is unreadable", () => {
      const runtime = new OpenClawAgentRuntime();
      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockImplementation(() => { throw new Error("EACCES"); });

      const result = runtime.detectNewSession("/project", new Date());
      expect(result).toBeNull();
    });

    it("finds the newest session matching project CWD", () => {
      const runtime = new OpenClawAgentRuntime();
      const beforeTime = new Date("2025-01-01T00:00:00Z");
      const afterTime = new Date("2025-01-01T01:00:00Z");

      // agents dir exists
      mockExistsSync.mockImplementation((p: string) => {
        if (String(p).endsWith("agents")) return true;
        if (String(p).endsWith("sessions")) return true;
        return false;
      });

      // agents dir has one agent
      mockReaddirSync.mockImplementation((p: string) => {
        if (String(p).endsWith("agents")) return ["my-agent"];
        if (String(p).endsWith("sessions")) return ["sess-abc.jsonl", "sess-xyz.jsonl"];
        return [];
      });

      // stat returns newer mtime for both
      mockStatSync.mockImplementation((p: string) => ({
        mtime: afterTime,
      }));

      // First file matches CWD, second doesn't
      mockReadFileSync.mockImplementation((p: string) => {
        if (String(p).includes("sess-abc")) {
          return '{"type":"session","version":3,"cwd":"/project"}';
        }
        return '{"type":"session","version":3,"cwd":"/other"}';
      });

      const result = runtime.detectNewSession("/project", beforeTime);
      expect(result).toBe("sess-abc");
    });

    it("picks the newest session when multiple match", () => {
      const runtime = new OpenClawAgentRuntime();
      const beforeTime = new Date("2025-01-01T00:00:00Z");
      const olderTime = new Date("2025-01-01T01:00:00Z");
      const newerTime = new Date("2025-01-01T02:00:00Z");

      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockImplementation((p: string) => {
        if (String(p).endsWith("agents")) return ["agent1"];
        if (String(p).endsWith("sessions")) return ["old.jsonl", "new.jsonl"];
        return [];
      });

      mockStatSync.mockImplementation((p: string) => {
        if (String(p).includes("old.jsonl")) return { mtime: olderTime };
        return { mtime: newerTime };
      });

      mockReadFileSync.mockReturnValue('{"type":"session","version":3,"cwd":"/project"}');

      const result = runtime.detectNewSession("/project", beforeTime);
      expect(result).toBe("new");
    });

    it("skips non-jsonl files", () => {
      const runtime = new OpenClawAgentRuntime();
      const beforeTime = new Date("2025-01-01T00:00:00Z");
      const afterTime = new Date("2025-01-01T01:00:00Z");

      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockImplementation((p: string) => {
        if (String(p).endsWith("agents")) return ["agent1"];
        if (String(p).endsWith("sessions")) return ["not-a-session.txt", "real.jsonl"];
        return [];
      });

      mockStatSync.mockReturnValue({ mtime: afterTime });
      mockReadFileSync.mockReturnValue('{"type":"session","version":3,"cwd":"/project"}');

      const result = runtime.detectNewSession("/project", beforeTime);
      expect(result).toBe("real");
    });

    it("skips files older than beforeTimestamp", () => {
      const runtime = new OpenClawAgentRuntime();
      const beforeTime = new Date("2025-01-01T02:00:00Z");
      const oldTime = new Date("2025-01-01T01:00:00Z");

      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockImplementation((p: string) => {
        if (String(p).endsWith("agents")) return ["agent1"];
        if (String(p).endsWith("sessions")) return ["old.jsonl"];
        return [];
      });

      mockStatSync.mockReturnValue({ mtime: oldTime });

      const result = runtime.detectNewSession("/project", beforeTime);
      expect(result).toBeNull();
    });
  });

  describe("findSessionFile", () => {
    it("returns null when agents dir does not exist", () => {
      const runtime = new OpenClawAgentRuntime();
      mockExistsSync.mockReturnValue(false);

      const result = runtime.findSessionFile("some-session-id");
      expect(result).toBeNull();
    });

    it("returns null when no agent dir contains the session", () => {
      const runtime = new OpenClawAgentRuntime();
      mockExistsSync.mockImplementation((p: string) => {
        if (String(p).endsWith("agents")) return true;
        return false; // session file not found
      });
      mockReaddirSync.mockReturnValue([
        { name: "agent1", isDirectory: () => true },
      ]);

      const result = runtime.findSessionFile("missing");
      expect(result).toBeNull();
    });

    it("finds session file across agent directories", () => {
      const runtime = new OpenClawAgentRuntime();
      mockExistsSync.mockImplementation((p: string) => {
        if (String(p).endsWith("agents")) return true;
        if (String(p).includes("agent2") && String(p).endsWith("target.jsonl")) return true;
        return false;
      });
      mockReaddirSync.mockReturnValue([
        { name: "agent1", isDirectory: () => true },
        { name: "agent2", isDirectory: () => true },
      ]);

      const result = runtime.findSessionFile("target");
      expect(result).toContain("agent2");
      expect(result).toContain("target.jsonl");
    });

    it("returns null when readdirSync fails", () => {
      const runtime = new OpenClawAgentRuntime();
      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockImplementation(() => { throw new Error("EACCES"); });

      const result = runtime.findSessionFile("any");
      expect(result).toBeNull();
    });
  });
});

// ─── Self-registration ──────────────────────────────────────

describe("self-registration", () => {
  it("registers openclaw runtime factory on module import", async () => {
    mockExistsSync.mockReturnValue(false);
    mockExecFileSync.mockImplementation(() => { throw new Error("not found"); });
    process.env.OPENCLAW_PATH = "/mock/openclaw";

    await importOpenClaw();

    expect(mockRegisterRuntime).toHaveBeenCalledWith("openclaw", expect.any(Function));

    delete process.env.OPENCLAW_PATH;
  });
});

// ─── resolveOpenClawPath (module-level) ─────────────────────

describe("resolveOpenClawPath (via module-level OPENCLAW_PATH)", () => {
  const originalOpenClawPath = process.env.OPENCLAW_PATH;

  beforeEach(() => {
    vi.resetModules();
    mockExecFile.mockReset();
    mockExecFileSync.mockReset();
    mockExistsSync.mockReturnValue(false);
  });

  afterEach(() => {
    if (originalOpenClawPath === undefined) {
      delete process.env.OPENCLAW_PATH;
    } else {
      process.env.OPENCLAW_PATH = originalOpenClawPath;
    }
  });

  it("uses OPENCLAW_PATH env var when set", async () => {
    process.env.OPENCLAW_PATH = "/custom/openclaw";

    const { OpenClawAgentRuntime } = await import("../agent-openclaw.js");
    const runtime = new OpenClawAgentRuntime();

    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, '{"message":{"content":"ok"}}', "");
      return { pid: 1 };
    });

    await runtime.runSession("test");
    expect(mockExecFile.mock.calls[0][0]).toBe("/custom/openclaw");
  });

  it("finds ~/.local/bin/openclaw when it exists", async () => {
    delete process.env.OPENCLAW_PATH;
    mockExistsSync.mockImplementation((p: unknown) => {
      return String(p).includes(".local/bin/openclaw") || String(p).includes(".local\\bin\\openclaw");
    });

    const { OpenClawAgentRuntime } = await import("../agent-openclaw.js");
    const runtime = new OpenClawAgentRuntime();

    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, '{"message":{"content":"ok"}}', "");
      return { pid: 1 };
    });

    await runtime.runSession("test");
    expect(mockExecFile.mock.calls[0][0]).toContain(".local");
    expect(mockExecFile.mock.calls[0][0]).toContain("openclaw");
  });

  it("finds /usr/local/bin/openclaw", async () => {
    delete process.env.OPENCLAW_PATH;
    mockExistsSync.mockImplementation((p: unknown) => String(p) === "/usr/local/bin/openclaw");

    const { OpenClawAgentRuntime } = await import("../agent-openclaw.js");
    const runtime = new OpenClawAgentRuntime();

    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, '{"message":{"content":"ok"}}', "");
      return { pid: 1 };
    });

    await runtime.runSession("test");
    expect(mockExecFile.mock.calls[0][0]).toBe("/usr/local/bin/openclaw");
  });

  it("falls back to which when no candidates exist", async () => {
    delete process.env.OPENCLAW_PATH;
    mockExistsSync.mockReturnValue(false);
    mockExecFileSync.mockReturnValue("/opt/bin/openclaw\n");

    const { OpenClawAgentRuntime } = await import("../agent-openclaw.js");
    const runtime = new OpenClawAgentRuntime();

    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, '{"message":{"content":"ok"}}', "");
      return { pid: 1 };
    });

    await runtime.runSession("test");
    expect(mockExecFile.mock.calls[0][0]).toBe("/opt/bin/openclaw");
  });

  it("falls back to bare 'openclaw' when which fails", async () => {
    delete process.env.OPENCLAW_PATH;
    mockExistsSync.mockReturnValue(false);
    mockExecFileSync.mockImplementation(() => { throw new Error("not found"); });

    const { OpenClawAgentRuntime } = await import("../agent-openclaw.js");
    const runtime = new OpenClawAgentRuntime();

    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, '{"message":{"content":"ok"}}', "");
      return { pid: 1 };
    });

    await runtime.runSession("test");
    expect(mockExecFile.mock.calls[0][0]).toBe("openclaw");
  });
});
