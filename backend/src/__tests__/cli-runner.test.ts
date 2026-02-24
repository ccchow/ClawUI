import { describe, it, expect, vi, beforeEach } from "vitest";

// We test the exported parseSuggestions logic and the runPrompt interface.
// Since the actual CLI execution requires /usr/bin/expect and the Claude binary,
// we mock the child_process module.

// The module has private functions (runClaude, parseSuggestions) and exports runPrompt.
// We need to test parseSuggestions behavior through runPrompt, or test it
// by extracting and testing the parsing logic.

// Approach: mock execFile so runClaude resolves with controlled output,
// then test runPrompt end-to-end behavior.

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
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

describe("cli-runner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runPrompt appends suggestion suffix and parses suggestions", async () => {
    const { execFile } = await import("node:child_process");
    const mockedExecFile = vi.mocked(execFile);

    // Make execFile invoke the callback with output containing suggestions
    mockedExecFile.mockImplementation(
      (_cmd: any, _args: any, _opts: any, callback: any) => {
        const output = `spawn /path/to/claude --args
Here is the response content.
---SUGGESTIONS---
[{"title":"Next step","description":"Do something","prompt":"do it"}]`;
        callback(null, output, "");
        return {} as any;
      }
    );

    const { runPrompt } = await import("../cli-runner.js");
    const result = await runPrompt("session-123", "test prompt");

    expect(result.output).toBe("Here is the response content.");
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].title).toBe("Next step");
    expect(result.suggestions[0].prompt).toBe("do it");
  });

  it("runPrompt handles output without suggestions", async () => {
    const { execFile } = await import("node:child_process");
    const mockedExecFile = vi.mocked(execFile);

    mockedExecFile.mockImplementation(
      (_cmd: any, _args: any, _opts: any, callback: any) => {
        const output = `spawn /path/to/claude --args
Just a plain response without suggestions.`;
        callback(null, output, "");
        return {} as any;
      }
    );

    const { runPrompt } = await import("../cli-runner.js");
    const result = await runPrompt("session-123", "test prompt");

    expect(result.output).toBe(
      "Just a plain response without suggestions."
    );
    expect(result.suggestions).toEqual([]);
  });

  it("runPrompt strips ANSI escape codes", async () => {
    const { execFile } = await import("node:child_process");
    const mockedExecFile = vi.mocked(execFile);

    mockedExecFile.mockImplementation(
      (_cmd: any, _args: any, _opts: any, callback: any) => {
        const output = `spawn /path/to/claude --args
\x1B[32mColored\x1B[0m text here`;
        callback(null, output, "");
        return {} as any;
      }
    );

    const { runPrompt } = await import("../cli-runner.js");
    const result = await runPrompt("session-123", "test prompt");
    expect(result.output).toBe("Colored text here");
  });

  it("runPrompt rejects on CLI error with no output", async () => {
    const { execFile } = await import("node:child_process");
    const mockedExecFile = vi.mocked(execFile);

    mockedExecFile.mockImplementation(
      (_cmd: any, _args: any, _opts: any, callback: any) => {
        callback(new Error("command failed"), "", "stderr output");
        return {} as any;
      }
    );

    const { runPrompt } = await import("../cli-runner.js");
    await expect(runPrompt("session-123", "test")).rejects.toThrow(
      "Claude CLI error"
    );
  });

  it("runPrompt limits suggestions to 3", async () => {
    const { execFile } = await import("node:child_process");
    const mockedExecFile = vi.mocked(execFile);

    const suggestions = Array.from({ length: 5 }, (_, i) => ({
      title: `s${i}`,
      description: `d${i}`,
      prompt: `p${i}`,
    }));

    mockedExecFile.mockImplementation(
      (_cmd: any, _args: any, _opts: any, callback: any) => {
        const output = `spawn /path/to/claude
Response.
---SUGGESTIONS---
${JSON.stringify(suggestions)}`;
        callback(null, output, "");
        return {} as any;
      }
    );

    const { runPrompt } = await import("../cli-runner.js");
    const result = await runPrompt("session-123", "test");
    expect(result.suggestions).toHaveLength(3);
  });

  it("runPrompt handles malformed suggestion JSON gracefully", async () => {
    const { execFile } = await import("node:child_process");
    const mockedExecFile = vi.mocked(execFile);

    mockedExecFile.mockImplementation(
      (_cmd: any, _args: any, _opts: any, callback: any) => {
        const output = `spawn /path/to/claude
Response text.
---SUGGESTIONS---
not valid json at all`;
        callback(null, output, "");
        return {} as any;
      }
    );

    const { runPrompt } = await import("../cli-runner.js");
    const result = await runPrompt("session-123", "test");
    expect(result.output).toBe("Response text.");
    expect(result.suggestions).toEqual([]);
  });
});
