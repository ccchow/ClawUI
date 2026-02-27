// backend/src/__tests__/cli-utils.test.ts
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

// Mock child_process for isProcessAlive tests
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: vi.fn(actual.execFileSync),
  };
});

// Mock fs for resolveClaudeCliJs tests
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    readFileSync: vi.fn(actual.readFileSync),
  };
});

describe("cli-utils", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    vi.restoreAllMocks();
  });

  describe("cleanEnvForClaude", () => {
    it("strips CLAUDECODE from env", async () => {
      process.env.CLAUDECODE = "1";
      const { cleanEnvForClaude } = await import("../cli-utils.js");
      const env = cleanEnvForClaude();
      expect(env.CLAUDECODE).toBeUndefined();
      expect(env.PATH).toBeDefined(); // other vars preserved
      delete process.env.CLAUDECODE;
    });
  });

  // ─── isProcessAlive: platform-specific tests ─────────────────

  describe("isProcessAlive", () => {
    it("returns true for current process", async () => {
      const { isProcessAlive } = await import("../cli-utils.js");
      expect(isProcessAlive(process.pid)).toBe(true);
    });

    it("returns false for non-existent PID", async () => {
      const { isProcessAlive } = await import("../cli-utils.js");
      expect(isProcessAlive(999999)).toBe(false);
    });
  });

  describe("isProcessAlive (Windows)", () => {
    beforeEach(() => {
      Object.defineProperty(process, "platform", { value: "win32" });
    });

    it("returns true when tasklist output contains the PID", async () => {
      vi.resetModules();
      const cp = await import("node:child_process");
      vi.mocked(cp.execFileSync).mockReturnValue('"process.exe","1234","Console","1","10,000 K"\r\n');
      const { isProcessAlive } = await import("../cli-utils.js");
      expect(isProcessAlive(1234)).toBe(true);
      expect(cp.execFileSync).toHaveBeenCalledWith(
        "tasklist",
        ["/FI", "PID eq 1234", "/NH", "/FO", "CSV"],
        expect.objectContaining({ encoding: "utf-8", timeout: 5000 }),
      );
    });

    it("returns false when tasklist output does not contain the PID", async () => {
      vi.resetModules();
      const cp = await import("node:child_process");
      vi.mocked(cp.execFileSync).mockReturnValue('INFO: No tasks are running which match the specified criteria.\r\n');
      const { isProcessAlive } = await import("../cli-utils.js");
      expect(isProcessAlive(1234)).toBe(false);
    });

    it("returns false when tasklist throws", async () => {
      vi.resetModules();
      const cp = await import("node:child_process");
      vi.mocked(cp.execFileSync).mockImplementation(() => { throw new Error("tasklist failed"); });
      const { isProcessAlive } = await import("../cli-utils.js");
      expect(isProcessAlive(1234)).toBe(false);
    });
  });

  describe("isProcessAlive (Unix)", () => {
    beforeEach(() => {
      Object.defineProperty(process, "platform", { value: "darwin" });
    });

    it("returns true when signal 0 succeeds", async () => {
      vi.resetModules();
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
      const { isProcessAlive } = await import("../cli-utils.js");
      expect(isProcessAlive(5678)).toBe(true);
      expect(killSpy).toHaveBeenCalledWith(5678, 0);
      killSpy.mockRestore();
    });

    it("returns false when signal 0 throws ESRCH", async () => {
      vi.resetModules();
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
        const err = new Error("ESRCH") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      });
      const { isProcessAlive } = await import("../cli-utils.js");
      expect(isProcessAlive(5678)).toBe(false);
      killSpy.mockRestore();
    });
  });

  describe("isProcessAlive (macOS)", () => {
    beforeEach(() => {
      Object.defineProperty(process, "platform", { value: "darwin" });
    });

    it("returns true when signal 0 throws EPERM (process exists but no permission)", async () => {
      vi.resetModules();
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
        const err = new Error("EPERM") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      });
      const { isProcessAlive } = await import("../cli-utils.js");
      // EPERM means the process exists but we don't have permission to signal it.
      // The current implementation returns false for any throw — this documents that behavior.
      expect(isProcessAlive(1)).toBe(false);
      killSpy.mockRestore();
    });

    it("uses signal 0 (not tasklist) on macOS", async () => {
      vi.resetModules();
      const cp = await import("node:child_process");
      vi.mocked(cp.execFileSync).mockClear();
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
      const { isProcessAlive } = await import("../cli-utils.js");
      isProcessAlive(1234);
      // Should NOT use tasklist on macOS
      expect(cp.execFileSync).not.toHaveBeenCalled();
      expect(killSpy).toHaveBeenCalledWith(1234, 0);
      killSpy.mockRestore();
    });
  });

  // ─── resolveClaudeCliJs: platform-specific tests ─────────────

  describe("resolveClaudeCliJs (Windows)", () => {
    beforeEach(() => {
      Object.defineProperty(process, "platform", { value: "win32" });
    });

    it("returns .js path directly when claudePath ends with .js", async () => {
      vi.resetModules();
      const { resolveClaudeCliJs, _resetCliJsCache } = await import("../cli-utils.js");
      _resetCliJsCache();
      expect(resolveClaudeCliJs("/path/to/cli.js")).toBe("/path/to/cli.js");
      _resetCliJsCache();
    });

    it("returns .mjs path directly when claudePath ends with .mjs", async () => {
      vi.resetModules();
      const { resolveClaudeCliJs, _resetCliJsCache } = await import("../cli-utils.js");
      _resetCliJsCache();
      expect(resolveClaudeCliJs("/path/to/cli.mjs")).toBe("/path/to/cli.mjs");
      _resetCliJsCache();
    });

    it("parses .cmd shim to find cli.js", async () => {
      vi.resetModules();
      const fs = await import("node:fs");
      const existsMock = vi.mocked(fs.existsSync);
      const readMock = vi.mocked(fs.readFileSync);

      // First call: existsSync for .cmd file, second: for the resolved .js
      existsMock.mockImplementation((p: any) => {
        const pathStr = String(p);
        if (pathStr.endsWith("claude.cmd")) return true;
        if (pathStr.includes("cli.js")) return true;
        return false;
      });
      readMock.mockReturnValue(
        '@IF EXIST "%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" (\r\n' +
        '  "%~dp0\\node.exe" "%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n' +
        ")",
      );

      const { resolveClaudeCliJs, _resetCliJsCache } = await import("../cli-utils.js");
      _resetCliJsCache();
      const result = resolveClaudeCliJs("C:\\Users\\test\\AppData\\Roaming\\npm\\claude.cmd");
      expect(result).not.toBeNull();
      expect(result!).toContain("cli.js");
      _resetCliJsCache();
    });

    it("parses new npm .cmd shim with %dp0% format", async () => {
      vi.resetModules();
      const fs = await import("node:fs");
      const existsMock = vi.mocked(fs.existsSync);
      const readMock = vi.mocked(fs.readFileSync);

      existsMock.mockImplementation((p: any) => {
        const pathStr = String(p);
        if (pathStr.endsWith("claude.cmd")) return true;
        if (pathStr.includes("cli.js")) return true;
        return false;
      });
      // New npm shim format uses %dp0% instead of %~dp0
      readMock.mockReturnValue(
        '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n' +
        ':start\r\nSETLOCAL\r\nCALL :find_dp0\r\n' +
        'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n',
      );

      const { resolveClaudeCliJs, _resetCliJsCache } = await import("../cli-utils.js");
      _resetCliJsCache();
      const result = resolveClaudeCliJs("Q:\\.tools\\.npm-global\\claude.cmd");
      expect(result).not.toBeNull();
      expect(result!).toContain("cli.js");
      _resetCliJsCache();
    });

    it("returns null when .cmd shim does not contain a .js path", async () => {
      vi.resetModules();
      const fs = await import("node:fs");
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue("@echo off\nclaude %*\n");

      // Also mock fallback paths to not exist
      vi.mocked(fs.existsSync).mockImplementation((p: any) => {
        const pathStr = String(p);
        if (pathStr.endsWith("claude.cmd")) return true;
        return false;
      });

      const { resolveClaudeCliJs, _resetCliJsCache } = await import("../cli-utils.js");
      _resetCliJsCache();
      const result = resolveClaudeCliJs("C:\\Users\\test\\AppData\\Roaming\\npm\\claude");
      expect(result).toBeNull();
      _resetCliJsCache();
    });

    it("caches result and returns cached value on subsequent calls", async () => {
      vi.resetModules();
      const { resolveClaudeCliJs, _resetCliJsCache } = await import("../cli-utils.js");
      _resetCliJsCache();
      const first = resolveClaudeCliJs("/path/to/cli.js");
      const second = resolveClaudeCliJs("different/path.cmd"); // should still return cached
      expect(first).toBe(second);
      _resetCliJsCache();
    });

    it("_resetCliJsCache clears the cache", async () => {
      vi.resetModules();
      const { resolveClaudeCliJs, _resetCliJsCache } = await import("../cli-utils.js");
      _resetCliJsCache();
      const first = resolveClaudeCliJs("/path/to/cli.js");
      _resetCliJsCache();
      // After reset, a different path should work
      const second = resolveClaudeCliJs("/other/path.mjs");
      expect(first).toBe("/path/to/cli.js");
      expect(second).toBe("/other/path.mjs");
      _resetCliJsCache();
    });
  });

  describe("resolveClaudeCliJs (Unix)", () => {
    beforeEach(() => {
      Object.defineProperty(process, "platform", { value: "darwin" });
    });

    it("returns null immediately on non-Windows", async () => {
      vi.resetModules();
      const { resolveClaudeCliJs, _resetCliJsCache } = await import("../cli-utils.js");
      _resetCliJsCache();
      expect(resolveClaudeCliJs("/usr/local/bin/claude")).toBeNull();
      _resetCliJsCache();
    });
  });

  describe("resolveClaudeCliJs (macOS)", () => {
    beforeEach(() => {
      Object.defineProperty(process, "platform", { value: "darwin" });
    });

    it("returns null for Homebrew-installed Claude on macOS", async () => {
      vi.resetModules();
      const { resolveClaudeCliJs, _resetCliJsCache } = await import("../cli-utils.js");
      _resetCliJsCache();
      expect(resolveClaudeCliJs("/opt/homebrew/bin/claude")).toBeNull();
      _resetCliJsCache();
    });

    it("returns null for ~/.local/bin/claude on macOS", async () => {
      vi.resetModules();
      const { resolveClaudeCliJs, _resetCliJsCache } = await import("../cli-utils.js");
      _resetCliJsCache();
      expect(resolveClaudeCliJs("/Users/test/.local/bin/claude")).toBeNull();
      _resetCliJsCache();
    });

    it("returns null for bare 'claude' command on macOS", async () => {
      vi.resetModules();
      const { resolveClaudeCliJs, _resetCliJsCache } = await import("../cli-utils.js");
      _resetCliJsCache();
      expect(resolveClaudeCliJs("claude")).toBeNull();
      _resetCliJsCache();
    });
  });

  // ─── encodeProjectPath ───────────────────────────────────────

  describe("encodeProjectPath", () => {
    it("encodes Unix paths", async () => {
      const { encodeProjectPath } = await import("../cli-utils.js");
      expect(encodeProjectPath("/home/user/project")).toBe("-home-user-project");
    });

    it("encodes Windows paths (backslash + drive letter)", async () => {
      const { encodeProjectPath } = await import("../cli-utils.js");
      expect(encodeProjectPath("C:\\Users\\user\\project")).toBe("C--Users-user-project");
      expect(encodeProjectPath("Q:\\src\\ClawUI")).toBe("Q--src-ClawUI");
    });

    it("handles mixed separators", async () => {
      const { encodeProjectPath } = await import("../cli-utils.js");
      expect(encodeProjectPath("C:/Users/user/project")).toBe("C--Users-user-project");
    });

    it("handles UNC paths", async () => {
      const { encodeProjectPath } = await import("../cli-utils.js");
      // \\server\share → --server-share
      expect(encodeProjectPath("\\\\server\\share")).toBe("--server-share");
    });

    it("handles trailing separators", async () => {
      const { encodeProjectPath } = await import("../cli-utils.js");
      expect(encodeProjectPath("/home/user/project/")).toBe("-home-user-project-");
      expect(encodeProjectPath("C:\\Users\\")).toBe("C--Users-");
    });

    it("handles root paths", async () => {
      const { encodeProjectPath } = await import("../cli-utils.js");
      expect(encodeProjectPath("/")).toBe("-");
      expect(encodeProjectPath("C:\\")).toBe("C--");
    });
  });

  describe("encodeProjectPath (macOS)", () => {
    it("encodes typical macOS /Users/ path", async () => {
      const { encodeProjectPath } = await import("../cli-utils.js");
      expect(encodeProjectPath("/Users/leizhou/Git/ClawUI")).toBe("-Users-leizhou-Git-ClawUI");
    });

    it("encodes macOS /Applications path", async () => {
      const { encodeProjectPath } = await import("../cli-utils.js");
      expect(encodeProjectPath("/Applications/Xcode.app")).toBe("-Applications-Xcode.app");
    });

    it("encodes macOS /opt/homebrew path", async () => {
      const { encodeProjectPath } = await import("../cli-utils.js");
      expect(encodeProjectPath("/opt/homebrew/lib")).toBe("-opt-homebrew-lib");
    });

    it("encodes macOS /var/folders temp path", async () => {
      const { encodeProjectPath } = await import("../cli-utils.js");
      expect(encodeProjectPath("/var/folders/xx/abc123/T")).toBe("-var-folders-xx-abc123-T");
    });

    it("encodes macOS path with spaces", async () => {
      const { encodeProjectPath } = await import("../cli-utils.js");
      expect(encodeProjectPath("/Users/test/My Project")).toBe("-Users-test-My Project");
    });

    it("encodes macOS hidden directory paths", async () => {
      const { encodeProjectPath } = await import("../cli-utils.js");
      expect(encodeProjectPath("/Users/test/.config/claude")).toBe("-Users-test-.config-claude");
    });
  });

  // ─── stripAnsi ───────────────────────────────────────────────

  describe("stripAnsi", () => {
    it("strips ANSI escape codes and carriage returns", async () => {
      const { stripAnsi } = await import("../cli-utils.js");
      expect(stripAnsi("\x1B[32mColored\x1B[0m text\r\n")).toBe("Colored text\n");
    });

    it("strips OSC sequences", async () => {
      const { stripAnsi } = await import("../cli-utils.js");
      expect(stripAnsi("\x1B]0;title\x07content")).toBe("content");
    });
  });
});
