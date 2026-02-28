// backend/src/__tests__/config.test.ts
//
// Tests for resolveClaudePath() and resolveExpectPath() which run at import time.
// We must mock `process.platform`, `process.env`, `node:child_process`, `node:fs`,
// and `./cli-utils.js` (to avoid circular imports), then use `vi.resetModules()` +
// dynamic `await import()` for each test to re-trigger the module-level code.

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

// We'll use dynamic imports after resetModules, so declare shared mock functions
const mockExecFileSync = vi.fn();
const mockExistsSync = vi.fn();

vi.mock("node:child_process", () => ({
  execFileSync: mockExecFileSync,
}));

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
}));

// Mock cli-utils to avoid circular import chain (config → cli-utils → logger → config)
vi.mock("../cli-utils.js", () => ({
  resolveClaudeCliJs: vi.fn(() => null),
  cleanEnvForClaude: vi.fn(() => ({})),
  stripAnsi: vi.fn((s: string) => s),
  encodeProjectPath: vi.fn((s: string) => s),
  isProcessAlive: vi.fn(() => false),
  _resetCliJsCache: vi.fn(),
}));

describe("config.ts", () => {
  const originalPlatform = process.platform;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    mockExecFileSync.mockReset();
    mockExistsSync.mockReturnValue(false);
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    // Restore only the env vars we may have changed
    process.env.CLAUDE_PATH = originalEnv.CLAUDE_PATH;
    process.env.EXPECT_PATH = originalEnv.EXPECT_PATH;
    if (originalEnv.CLAUDE_PATH === undefined) delete process.env.CLAUDE_PATH;
    if (originalEnv.EXPECT_PATH === undefined) delete process.env.EXPECT_PATH;
  });

  // ─── resolveClaudePath ──────────────────────────────────────

  describe("resolveClaudePath", () => {
    it("uses CLAUDE_PATH env var when set", async () => {
      process.env.CLAUDE_PATH = "/custom/claude";
      const { CLAUDE_PATH } = await import("../config.js");
      expect(CLAUDE_PATH).toBe("/custom/claude");
    });

    describe("Windows", () => {
      beforeEach(() => {
        Object.defineProperty(process, "platform", { value: "win32" });
        delete process.env.CLAUDE_PATH;
      });

      it("finds claude.cmd in AppData/npm", async () => {
        mockExistsSync.mockImplementation((p: any) => {
          return String(p).includes("AppData") && String(p).endsWith("claude.cmd");
        });
        const { CLAUDE_PATH } = await import("../config.js");
        expect(CLAUDE_PATH).toContain("claude.cmd");
        expect(CLAUDE_PATH).toContain("AppData");
      });

      it("falls back to where.exe when no candidate exists", async () => {
        mockExistsSync.mockReturnValue(false);
        mockExecFileSync.mockReturnValue("C:\\Program Files\\claude\\claude.exe\r\n");
        const { CLAUDE_PATH } = await import("../config.js");
        expect(CLAUDE_PATH).toBe("C:\\Program Files\\claude\\claude.exe");
        expect(mockExecFileSync).toHaveBeenCalledWith(
          "where",
          ["claude"],
          expect.objectContaining({ encoding: "utf-8", timeout: 5000 }),
        );
      });

      it("falls back to bare 'claude' when where.exe fails", async () => {
        mockExistsSync.mockReturnValue(false);
        mockExecFileSync.mockImplementation(() => { throw new Error("not found"); });
        const { CLAUDE_PATH } = await import("../config.js");
        expect(CLAUDE_PATH).toBe("claude");
      });
    });

    describe("Unix", () => {
      beforeEach(() => {
        Object.defineProperty(process, "platform", { value: "darwin" });
        delete process.env.CLAUDE_PATH;
      });

      it("finds ~/.local/bin/claude", async () => {
        mockExistsSync.mockImplementation((p: any) => {
          return String(p).includes(".local/bin/claude") || String(p).includes(".local\\bin\\claude");
        });
        const { CLAUDE_PATH } = await import("../config.js");
        expect(CLAUDE_PATH).toContain("claude");
        expect(CLAUDE_PATH).toContain(".local");
      });

      it("finds /usr/local/bin/claude", async () => {
        mockExistsSync.mockImplementation((p: any) => {
          return String(p) === "/usr/local/bin/claude";
        });
        const { CLAUDE_PATH } = await import("../config.js");
        expect(CLAUDE_PATH).toBe("/usr/local/bin/claude");
      });

      it("falls back to /usr/bin/which when no candidates exist", async () => {
        mockExistsSync.mockReturnValue(false);
        mockExecFileSync.mockReturnValue("/opt/bin/claude\n");
        const { CLAUDE_PATH } = await import("../config.js");
        expect(CLAUDE_PATH).toBe("/opt/bin/claude");
        expect(mockExecFileSync).toHaveBeenCalledWith(
          "/usr/bin/which",
          ["claude"],
          expect.objectContaining({ encoding: "utf-8" }),
        );
      });

      it("falls back to bare 'claude' when which fails", async () => {
        mockExistsSync.mockReturnValue(false);
        mockExecFileSync.mockImplementation(() => { throw new Error("not found"); });
        const { CLAUDE_PATH } = await import("../config.js");
        expect(CLAUDE_PATH).toBe("claude");
      });
    });

    describe("macOS", () => {
      beforeEach(() => {
        Object.defineProperty(process, "platform", { value: "darwin" });
        delete process.env.CLAUDE_PATH;
      });

      it("prefers ~/.local/bin/claude over /usr/local/bin/claude", async () => {
        mockExistsSync.mockImplementation((p: any) => {
          const s = String(p);
          return s.includes(".local/bin/claude") || s.includes(".local\\bin\\claude") || s === "/usr/local/bin/claude";
        });
        const { CLAUDE_PATH } = await import("../config.js");
        expect(CLAUDE_PATH).toContain(".local");
      });

      it("finds claude installed via which on macOS", async () => {
        mockExistsSync.mockReturnValue(false);
        mockExecFileSync.mockReturnValue("/opt/homebrew/bin/claude\n");
        const { CLAUDE_PATH } = await import("../config.js");
        expect(CLAUDE_PATH).toBe("/opt/homebrew/bin/claude");
      });

      it("trims trailing newline from which output", async () => {
        mockExistsSync.mockReturnValue(false);
        mockExecFileSync.mockReturnValue("/usr/local/bin/claude\n\n");
        const { CLAUDE_PATH } = await import("../config.js");
        expect(CLAUDE_PATH).toBe("/usr/local/bin/claude");
      });
    });
  });

  // ─── resolveExpectPath ──────────────────────────────────────

  describe("resolveExpectPath", () => {
    describe("Windows", () => {
      beforeEach(() => {
        Object.defineProperty(process, "platform", { value: "win32" });
        delete process.env.EXPECT_PATH;
        delete process.env.CLAUDE_PATH;
      });

      it("returns empty string on Windows (expect not needed)", async () => {
        process.env.CLAUDE_PATH = "claude"; // skip resolution
        const { EXPECT_PATH } = await import("../config.js");
        expect(EXPECT_PATH).toBe("");
      });
    });

    describe("Unix", () => {
      beforeEach(() => {
        Object.defineProperty(process, "platform", { value: "darwin" });
        delete process.env.EXPECT_PATH;
      });

      it("uses EXPECT_PATH env var when set", async () => {
        process.env.EXPECT_PATH = "/custom/expect";
        process.env.CLAUDE_PATH = "claude"; // skip claude resolution
        const { EXPECT_PATH } = await import("../config.js");
        expect(EXPECT_PATH).toBe("/custom/expect");
      });

      it("finds /usr/bin/expect", async () => {
        process.env.CLAUDE_PATH = "claude";
        mockExistsSync.mockImplementation((p: any) => String(p) === "/usr/bin/expect");
        const { EXPECT_PATH } = await import("../config.js");
        expect(EXPECT_PATH).toBe("/usr/bin/expect");
      });

      it("finds /usr/local/bin/expect", async () => {
        process.env.CLAUDE_PATH = "claude";
        mockExistsSync.mockImplementation((p: any) => String(p) === "/usr/local/bin/expect");
        const { EXPECT_PATH } = await import("../config.js");
        expect(EXPECT_PATH).toBe("/usr/local/bin/expect");
      });

      it("finds /opt/homebrew/bin/expect", async () => {
        process.env.CLAUDE_PATH = "claude";
        mockExistsSync.mockImplementation((p: any) => String(p) === "/opt/homebrew/bin/expect");
        const { EXPECT_PATH } = await import("../config.js");
        expect(EXPECT_PATH).toBe("/opt/homebrew/bin/expect");
      });

      it("falls back to which when no candidates exist", async () => {
        process.env.CLAUDE_PATH = "claude";
        mockExistsSync.mockReturnValue(false);
        mockExecFileSync.mockReturnValue("/opt/bin/expect\n");
        const { EXPECT_PATH } = await import("../config.js");
        expect(EXPECT_PATH).toBe("/opt/bin/expect");
      });

      it("falls back to bare 'expect' when which fails", async () => {
        process.env.CLAUDE_PATH = "claude";
        mockExistsSync.mockReturnValue(false);
        mockExecFileSync.mockImplementation(() => { throw new Error("not found"); });
        const { EXPECT_PATH } = await import("../config.js");
        expect(EXPECT_PATH).toBe("expect");
      });
    });

    describe("macOS", () => {
      beforeEach(() => {
        Object.defineProperty(process, "platform", { value: "darwin" });
        delete process.env.EXPECT_PATH;
      });

      it("prefers /usr/bin/expect over Homebrew paths", async () => {
        process.env.CLAUDE_PATH = "claude";
        mockExistsSync.mockImplementation((p: any) => {
          const s = String(p);
          return s === "/usr/bin/expect" || s === "/opt/homebrew/bin/expect";
        });
        const { EXPECT_PATH } = await import("../config.js");
        expect(EXPECT_PATH).toBe("/usr/bin/expect");
      });

      it("finds /opt/homebrew/bin/expect on Apple Silicon when system expect is absent", async () => {
        process.env.CLAUDE_PATH = "claude";
        mockExistsSync.mockImplementation((p: any) => {
          return String(p) === "/opt/homebrew/bin/expect";
        });
        const { EXPECT_PATH } = await import("../config.js");
        expect(EXPECT_PATH).toBe("/opt/homebrew/bin/expect");
      });

      it("finds /opt/local/bin/expect for MacPorts installs", async () => {
        process.env.CLAUDE_PATH = "claude";
        mockExistsSync.mockImplementation((p: any) => {
          return String(p) === "/opt/local/bin/expect";
        });
        const { EXPECT_PATH } = await import("../config.js");
        expect(EXPECT_PATH).toBe("/opt/local/bin/expect");
      });

      it("finds /usr/local/bin/expect on Intel Mac Homebrew", async () => {
        process.env.CLAUDE_PATH = "claude";
        mockExistsSync.mockImplementation((p: any) => {
          return String(p) === "/usr/local/bin/expect";
        });
        const { EXPECT_PATH } = await import("../config.js");
        expect(EXPECT_PATH).toBe("/usr/local/bin/expect");
      });
    });
  });
});
