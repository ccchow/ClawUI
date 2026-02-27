import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

const originalPlatform = process.platform;

describe("cli-runner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  // ─── Shared behavior tests (run on host platform) ───────────

  describe("shared behavior", () => {
    function mockCliOutput(output: string) {
      if (process.platform === "win32") {
        mockSpawn.mockImplementation(() => createMockSpawnChild(output));
      } else {
        mockExecFile.mockImplementation(
          (_cmd: any, _args: any, _opts: any, callback: any) => {
            callback(null, output, "");
            return {} as any;
          },
        );
      }
    }

    function mockCliError() {
      if (process.platform === "win32") {
        mockSpawn.mockImplementation(() => {
          const child = new EventEmitter() as any;
          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          child.stdin = { end: vi.fn() };
          child.pid = 12345;
          process.nextTick(() => { child.emit("close", 1); });
          return child;
        });
      } else {
        mockExecFile.mockImplementation(
          (_cmd: any, _args: any, _opts: any, callback: any) => {
            callback(new Error("command failed"), "", "stderr output");
            return {} as any;
          },
        );
      }
    }

    it("runPrompt appends suggestion suffix and parses suggestions", async () => {
      const output = `Here is the response content.
---SUGGESTIONS---
[{"title":"Next step","description":"Do something","prompt":"do it"}]`;
      const fullOutput = process.platform === "win32"
        ? output
        : `spawn /path/to/claude --args\n${output}`;
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
      const fullOutput = process.platform === "win32"
        ? output
        : `spawn /path/to/claude --args\n${output}`;
      mockCliOutput(fullOutput);

      const { runPrompt } = await import("../cli-runner.js");
      const result = await runPrompt("session-123", "test prompt");

      expect(result.output).toBe("Just a plain response without suggestions.");
      expect(result.suggestions).toEqual([]);
    });

    it("runPrompt rejects on CLI error with no output", async () => {
      mockCliError();

      const { runPrompt } = await import("../cli-runner.js");
      await expect(runPrompt("session-123", "test")).rejects.toThrow(/Claude CLI/);
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
      const fullOutput = process.platform === "win32"
        ? output
        : `spawn /path/to/claude\n${output}`;
      mockCliOutput(fullOutput);

      const { runPrompt } = await import("../cli-runner.js");
      const result = await runPrompt("session-123", "test");
      expect(result.suggestions).toHaveLength(3);
    });

    it("runPrompt handles malformed suggestion JSON gracefully", async () => {
      const output = `Response text.
---SUGGESTIONS---
not valid json at all`;
      const fullOutput = process.platform === "win32"
        ? output
        : `spawn /path/to/claude\n${output}`;
      mockCliOutput(fullOutput);

      const { runPrompt } = await import("../cli-runner.js");
      const result = await runPrompt("session-123", "test");
      expect(result.output).toBe("Response text.");
      expect(result.suggestions).toEqual([]);
    });
  });

  // ─── Windows-specific tests ─────────────────────────────────

  describe("Windows platform", () => {
    beforeEach(() => {
      Object.defineProperty(process, "platform", { value: "win32" });
    });

    it("uses spawn (not execFile) on Windows", async () => {
      vi.resetModules();
      mockSpawn.mockImplementation(() => createMockSpawnChild("Windows output"));

      const { runPrompt } = await import("../cli-runner.js");
      await runPrompt("session-win-1", "test prompt");

      expect(mockSpawn).toHaveBeenCalled();
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it("calls stdin.end() to signal no input", async () => {
      vi.resetModules();
      const child = createMockSpawnChild("output");
      mockSpawn.mockImplementation(() => child);

      const { runPrompt } = await import("../cli-runner.js");
      await runPrompt("session-win-2", "test");

      expect(child.stdin.end).toHaveBeenCalled();
    });

    it("collects stdout via event listeners", async () => {
      vi.resetModules();
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { end: vi.fn() };
      child.pid = 99;

      mockSpawn.mockImplementation(() => child);

      const { runPrompt } = await import("../cli-runner.js");
      const promise = runPrompt("session-win-3", "test");

      // Emit output in multiple chunks
      process.nextTick(() => {
        child.stdout.emit("data", Buffer.from("Hello "));
        child.stdout.emit("data", Buffer.from("World"));
        child.emit("close", 0);
      });

      const result = await promise;
      expect(result.output).toBe("Hello World");
    });

    it("strips ANSI codes from Windows output", async () => {
      vi.resetModules();
      mockSpawn.mockImplementation(() =>
        createMockSpawnChild("\x1B[32mColored\x1B[0m text"),
      );

      const { runPrompt } = await import("../cli-runner.js");
      const result = await runPrompt("session-win-4", "test");
      expect(result.output).toBe("Colored text");
    });

    it("rejects on non-zero exit code with no output", async () => {
      vi.resetModules();
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { end: vi.fn() };
      child.pid = 99;

      mockSpawn.mockImplementation(() => child);

      const { runPrompt } = await import("../cli-runner.js");
      const promise = runPrompt("session-win-5", "test");

      process.nextTick(() => {
        child.stderr.emit("data", Buffer.from("Something went wrong"));
        child.emit("close", 1);
      });

      await expect(promise).rejects.toThrow(/Claude CLI error \(exit 1\)/);
    });

    it("resolves with output even on non-zero exit when output is non-empty", async () => {
      vi.resetModules();
      mockSpawn.mockImplementation(() => createMockSpawnChild("Partial output", 1));

      const { runPrompt } = await import("../cli-runner.js");
      const result = await runPrompt("session-win-6", "test");
      expect(result.output).toBe("Partial output");
    });

    it("rejects when spawn emits an error event", async () => {
      vi.resetModules();
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { end: vi.fn() };
      child.pid = 99;

      mockSpawn.mockImplementation(() => child);

      const { runPrompt } = await import("../cli-runner.js");
      const promise = runPrompt("session-win-7", "test");

      process.nextTick(() => {
        child.emit("error", new Error("ENOENT: spawn failed"));
      });

      await expect(promise).rejects.toThrow(/spawn failed/);
    });
  });

  // ─── Unix-specific tests ────────────────────────────────────

  describe("Unix platform", () => {
    beforeEach(() => {
      Object.defineProperty(process, "platform", { value: "darwin" });
    });

    it("uses execFile (not spawn) on Unix", async () => {
      vi.resetModules();
      mockExecFile.mockImplementation(
        (_cmd: any, _args: any, _opts: any, callback: any) => {
          callback(null, "spawn claude --args\nUnix output", "");
          return {} as any;
        },
      );

      const { runPrompt } = await import("../cli-runner.js");
      await runPrompt("session-unix-1", "test prompt");

      expect(mockExecFile).toHaveBeenCalled();
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it("creates temp files for expect script", async () => {
      vi.resetModules();
      const fs = await import("node:fs");
      mockExecFile.mockImplementation(
        (_cmd: any, _args: any, _opts: any, callback: any) => {
          callback(null, "spawn claude\nOutput", "");
          return {} as any;
        },
      );

      const { runPrompt } = await import("../cli-runner.js");
      await runPrompt("session-unix-2", "test prompt");

      // writeFileSync should be called for prompt temp file and expect script
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    it("strips spawn line from expect output", async () => {
      vi.resetModules();
      mockExecFile.mockImplementation(
        (_cmd: any, _args: any, _opts: any, callback: any) => {
          callback(null, "spawn /usr/local/bin/claude --args\nActual response here", "");
          return {} as any;
        },
      );

      const { runPrompt } = await import("../cli-runner.js");
      const result = await runPrompt("session-unix-3", "test");
      expect(result.output).toBe("Actual response here");
    });

    it("rejects when execFile callback receives error with no output", async () => {
      vi.resetModules();
      mockExecFile.mockImplementation(
        (_cmd: any, _args: any, _opts: any, callback: any) => {
          callback(new Error("process timed out"), "", "timeout stderr");
          return {} as any;
        },
      );

      const { runPrompt } = await import("../cli-runner.js");
      await expect(runPrompt("session-unix-4", "test")).rejects.toThrow(/Claude CLI error/);
    });

    it("resolves with output even when error is set but stdout has content", async () => {
      vi.resetModules();
      mockExecFile.mockImplementation(
        (_cmd: any, _args: any, _opts: any, callback: any) => {
          callback(new Error("non-zero exit"), "spawn claude\nSome output text", "");
          return {} as any;
        },
      );

      const { runPrompt } = await import("../cli-runner.js");
      const result = await runPrompt("session-unix-5", "test");
      // Should resolve because there's stdout content (spawn line stripped)
      expect(result.output).toBe("Some output text");
    });

    it("cleans up temp files after execution", async () => {
      vi.resetModules();
      const fs = await import("node:fs");
      mockExecFile.mockImplementation(
        (_cmd: any, _args: any, _opts: any, callback: any) => {
          callback(null, "spawn claude\nDone", "");
          return {} as any;
        },
      );

      const { runPrompt } = await import("../cli-runner.js");
      await runPrompt("session-unix-6", "test");

      // unlinkSync should be called to clean up temp files
      expect(fs.unlinkSync).toHaveBeenCalled();
    });
  });

  // ─── macOS-specific tests ─────────────────────────────────

  describe("macOS platform", () => {
    beforeEach(() => {
      Object.defineProperty(process, "platform", { value: "darwin" });
    });

    it("uses execFile (not spawn) on macOS", async () => {
      vi.resetModules();
      mockExecFile.mockImplementation(
        (_cmd: any, _args: any, _opts: any, callback: any) => {
          callback(null, "spawn /opt/homebrew/bin/claude --args\nmacOS output", "");
          return {} as any;
        },
      );

      const { runPrompt } = await import("../cli-runner.js");
      await runPrompt("session-mac-1", "test prompt");

      expect(mockExecFile).toHaveBeenCalled();
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it("strips spawn line containing /opt/homebrew path", async () => {
      vi.resetModules();
      mockExecFile.mockImplementation(
        (_cmd: any, _args: any, _opts: any, callback: any) => {
          callback(null, "spawn /opt/homebrew/bin/claude --dangerously-skip-permissions --resume sess -p test\nActual macOS response", "");
          return {} as any;
        },
      );

      const { runPrompt } = await import("../cli-runner.js");
      const result = await runPrompt("session-mac-2", "test");
      expect(result.output).toBe("Actual macOS response");
    });

    it("strips spawn line with /Users/ homedir path", async () => {
      vi.resetModules();
      mockExecFile.mockImplementation(
        (_cmd: any, _args: any, _opts: any, callback: any) => {
          callback(null, "spawn /Users/testuser/.local/bin/claude --args\nResponse from macOS", "");
          return {} as any;
        },
      );

      const { runPrompt } = await import("../cli-runner.js");
      const result = await runPrompt("session-mac-3", "test");
      expect(result.output).toBe("Response from macOS");
    });

    it("handles macOS expect output with multiple spawn-like lines", async () => {
      vi.resetModules();
      mockExecFile.mockImplementation(
        (_cmd: any, _args: any, _opts: any, callback: any) => {
          // macOS expect can emit extra lines before the actual spawn line
          callback(null, "spawn /usr/local/bin/claude --args\nThe code spawns a new process\nActual result", "");
          return {} as any;
        },
      );

      const { runPrompt } = await import("../cli-runner.js");
      const result = await runPrompt("session-mac-4", "test");
      // Only the first "spawn" line (with "claude") should be stripped
      expect(result.output).toContain("Actual result");
    });

    it("cleans up temp files on macOS /var/folders tmpdir", async () => {
      vi.resetModules();
      const fs = await import("node:fs");
      mockExecFile.mockImplementation(
        (_cmd: any, _args: any, _opts: any, callback: any) => {
          callback(null, "spawn claude\nDone", "");
          return {} as any;
        },
      );

      const { runPrompt } = await import("../cli-runner.js");
      await runPrompt("session-mac-5", "test prompt");

      // Both prompt and expect temp files should be written and cleaned up
      expect(fs.writeFileSync).toHaveBeenCalled();
      expect(fs.unlinkSync).toHaveBeenCalled();
    });

    it("handles macOS stderr warnings without failing", async () => {
      vi.resetModules();
      mockExecFile.mockImplementation(
        (_cmd: any, _args: any, _opts: any, callback: any) => {
          // macOS sometimes emits Tcl warnings to stderr
          callback(null, "spawn claude\nValid output", "Tcl_Init: unable to set default encoding");
          return {} as any;
        },
      );

      const { runPrompt } = await import("../cli-runner.js");
      const result = await runPrompt("session-mac-6", "test");
      expect(result.output).toBe("Valid output");
    });

    it("handles SIGTERM from macOS Activity Monitor gracefully", async () => {
      vi.resetModules();
      mockExecFile.mockImplementation(
        (_cmd: any, _args: any, _opts: any, callback: any) => {
          const err = new Error("process killed") as NodeJS.ErrnoException;
          err.code = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
          callback(err, "spawn claude\nPartial output before kill", "");
          return {} as any;
        },
      );

      const { runPrompt } = await import("../cli-runner.js");
      const result = await runPrompt("session-mac-7", "test");
      // Should still resolve with partial output
      expect(result.output).toBe("Partial output before kill");
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
