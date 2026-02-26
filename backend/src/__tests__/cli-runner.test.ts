import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

// Mock child_process. On Windows, runClaude uses spawn; on Unix, execFile.
const mockExecFile = vi.fn();
const mockSpawn = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
  spawn: mockSpawn,
}));

// Mock fs operations used for temp files
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

const IS_WIN = process.platform === "win32";

/**
 * Create a mock child process for spawn that emits stdout data then closes.
 */
function createMockSpawnChild(stdout: string, exitCode: number = 0) {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: vi.fn() };
  child.pid = 12345;

  // Emit data and close asynchronously so listeners can be set up
  process.nextTick(() => {
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    child.emit("close", exitCode);
  });

  return child;
}

/**
 * Set up mocks to simulate CLI output.
 */
function mockCliOutput(output: string, exitCode: number = 0) {
  if (IS_WIN) {
    mockSpawn.mockImplementation(() => createMockSpawnChild(output, exitCode));
  } else {
    mockExecFile.mockImplementation(
      (_cmd: any, _args: any, _opts: any, callback: any) => {
        callback(null, output, "");
        return {} as any;
      }
    );
  }
}

function mockCliError() {
  if (IS_WIN) {
    mockSpawn.mockImplementation(() => {
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { end: vi.fn() };
      child.pid = 12345;
      process.nextTick(() => {
        child.emit("close", 1);
      });
      return child;
    });
  } else {
    mockExecFile.mockImplementation(
      (_cmd: any, _args: any, _opts: any, callback: any) => {
        callback(new Error("command failed"), "", "stderr output");
        return {} as any;
      }
    );
  }
}

describe("cli-runner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runPrompt appends suggestion suffix and parses suggestions", async () => {
    const output = `Here is the response content.
---SUGGESTIONS---
[{"title":"Next step","description":"Do something","prompt":"do it"}]`;
    const fullOutput = IS_WIN ? output : `spawn /path/to/claude --args\n${output}`;
    mockCliOutput(fullOutput);

    const { runPrompt } = await import("../cli-runner.js");
    const result = await runPrompt("session-123", "test prompt");

    expect(result.output).toBe("Here is the response content.");
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].title).toBe("Next step");
    expect(result.suggestions[0].prompt).toBe("do it");
  });

  it("runPrompt handles output without suggestions", async () => {
    const output = "Just a plain response without suggestions.";
    const fullOutput = IS_WIN ? output : `spawn /path/to/claude --args\n${output}`;
    mockCliOutput(fullOutput);

    const { runPrompt } = await import("../cli-runner.js");
    const result = await runPrompt("session-123", "test prompt");

    expect(result.output).toBe(
      "Just a plain response without suggestions."
    );
    expect(result.suggestions).toEqual([]);
  });

  it("runPrompt strips ANSI escape codes", async () => {
    const output = "\x1B[32mColored\x1B[0m text here";
    const fullOutput = IS_WIN ? output : `spawn /path/to/claude --args\n${output}`;
    mockCliOutput(fullOutput);

    const { runPrompt } = await import("../cli-runner.js");
    const result = await runPrompt("session-123", "test prompt");
    expect(result.output).toBe("Colored text here");
  });

  it("runPrompt rejects on CLI error with no output", async () => {
    mockCliError();

    const { runPrompt } = await import("../cli-runner.js");
    await expect(runPrompt("session-123", "test")).rejects.toThrow(
      /Claude CLI/
    );
  });

  it("runPrompt limits suggestions to 3", async () => {
    const suggestions = Array.from({ length: 5 }, (_, i) => ({
      title: `s${i}`,
      description: `d${i}`,
      prompt: `p${i}`,
    }));

    const output = `Response.
---SUGGESTIONS---
${JSON.stringify(suggestions)}`;
    const fullOutput = IS_WIN ? output : `spawn /path/to/claude\n${output}`;
    mockCliOutput(fullOutput);

    const { runPrompt } = await import("../cli-runner.js");
    const result = await runPrompt("session-123", "test");
    expect(result.suggestions).toHaveLength(3);
  });

  it("runPrompt handles malformed suggestion JSON gracefully", async () => {
    const output = `Response text.
---SUGGESTIONS---
not valid json at all`;
    const fullOutput = IS_WIN ? output : `spawn /path/to/claude\n${output}`;
    mockCliOutput(fullOutput);

    const { runPrompt } = await import("../cli-runner.js");
    const result = await runPrompt("session-123", "test");
    expect(result.output).toBe("Response text.");
    expect(result.suggestions).toEqual([]);
  });
});
