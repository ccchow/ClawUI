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

  it("runPrompt strips OSC escape sequences", async () => {
    const { execFile } = await import("node:child_process");
    const mockedExecFile = vi.mocked(execFile);

    mockedExecFile.mockImplementation(
      (_cmd: any, _args: any, _opts: any, callback: any) => {
        // OSC sequence: ESC ] ... BEL
        const output = `spawn /path/to/claude --args
\x1B]0;title\x07Clean text here`;
        callback(null, output, "");
        return {} as any;
      }
    );

    const { runPrompt } = await import("../cli-runner.js");
    const result = await runPrompt("session-123", "test prompt");
    expect(result.output).toBe("Clean text here");
  });

  it("runPrompt strips carriage returns", async () => {
    const { execFile } = await import("node:child_process");
    const mockedExecFile = vi.mocked(execFile);

    mockedExecFile.mockImplementation(
      (_cmd: any, _args: any, _opts: any, callback: any) => {
        const output = `spawn /path/to/claude\r\nLine one\r\nLine two`;
        callback(null, output, "");
        return {} as any;
      }
    );

    const { runPrompt } = await import("../cli-runner.js");
    const result = await runPrompt("session-123", "test");
    expect(result.output).not.toContain("\r");
    expect(result.output).toContain("Line one");
    expect(result.output).toContain("Line two");
  });

  it("runPrompt handles output without spawn line", async () => {
    const { execFile } = await import("node:child_process");
    const mockedExecFile = vi.mocked(execFile);

    mockedExecFile.mockImplementation(
      (_cmd: any, _args: any, _opts: any, callback: any) => {
        // No "spawn" line in output — use all lines
        const output = "Just a direct response\nSecond line";
        callback(null, output, "");
        return {} as any;
      }
    );

    const { runPrompt } = await import("../cli-runner.js");
    const result = await runPrompt("session-123", "test");
    expect(result.output).toBe("Just a direct response\nSecond line");
  });

  it("runPrompt resolves with output even when error is present", async () => {
    const { execFile } = await import("node:child_process");
    const mockedExecFile = vi.mocked(execFile);

    // When there's an error but also output, resolve with the output
    mockedExecFile.mockImplementation(
      (_cmd: any, _args: any, _opts: any, callback: any) => {
        const output = `spawn /path/to/claude --args
Partial output before error`;
        callback(new Error("timeout"), output, "");
        return {} as any;
      }
    );

    const { runPrompt } = await import("../cli-runner.js");
    const result = await runPrompt("session-123", "test");
    // Should resolve because clean output is non-empty
    expect(result.output).toBe("Partial output before error");
  });

  it("runPrompt resolves with empty string when output is only whitespace and no error", async () => {
    const { execFile } = await import("node:child_process");
    const mockedExecFile = vi.mocked(execFile);

    mockedExecFile.mockImplementation(
      (_cmd: any, _args: any, _opts: any, callback: any) => {
        const output = `spawn /path/to/claude --args
   `;
        callback(null, output, "");
        return {} as any;
      }
    );

    const { runPrompt } = await import("../cli-runner.js");
    const result = await runPrompt("session-123", "test");
    expect(result.output).toBe("");
  });

  it("runPrompt includes stderr in error message", async () => {
    const { execFile } = await import("node:child_process");
    const mockedExecFile = vi.mocked(execFile);

    mockedExecFile.mockImplementation(
      (_cmd: any, _args: any, _opts: any, callback: any) => {
        callback(new Error("process exited with code 1"), "", "detailed stderr info");
        return {} as any;
      }
    );

    const { runPrompt } = await import("../cli-runner.js");
    await expect(runPrompt("session-123", "test")).rejects.toThrow(
      "detailed stderr info"
    );
  });
});
