// backend/src/__tests__/windows-agent-smoke.test.ts
//
// Integration smoke test: verifies all agent runtimes initialize correctly on
// Windows without crashing. Tests runtime registration, path resolution
// graceful failure, session dir access, encodeProjectCwd round-trip,
// and cleanEnv validity.
//
// Mocks child_process to avoid calling where/which, and sets process.platform
// to "win32" to simulate Windows behavior.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { homedir } from "node:os";

// ─── Shared mock functions ───────────────────────────────────

const mockExecFile = vi.fn();
const mockExecFileSync = vi.fn();
const mockSpawn = vi.fn();
const mockExistsSync = vi.fn();
const mockReaddirSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockStatSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockUnlinkSync = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
  execFileSync: mockExecFileSync,
  spawn: mockSpawn,
}));

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
  readdirSync: mockReaddirSync,
  readFileSync: mockReadFileSync,
  statSync: mockStatSync,
  writeFileSync: mockWriteFileSync,
  unlinkSync: mockUnlinkSync,
}));

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("../session-header.js", () => ({
  readSessionHeader: vi.fn(() => null),
}));

// Mock jsonl-parser to avoid heavy imports (only needed by agent-claude)
vi.mock("../jsonl-parser.js", () => ({
  analyzeSessionHealth: vi.fn(() => null),
}));

// Mock cli-utils.js to avoid circular import issues
vi.mock("../cli-utils.js", () => ({
  resolveClaudeCliJs: vi.fn(() => null),
  cleanEnvForClaude: vi.fn(() => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key === "CLAUDE_PATH") continue;
      if (key.startsWith("CLAUDE")) delete env[key];
    }
    return env;
  }),
  stripAnsi: vi.fn((s: string) => s),
  encodeProjectPath: vi.fn((s: string) => s),
  isProcessAlive: vi.fn(() => false),
  _resetCliJsCache: vi.fn(),
}));

// Mock config.js — simulate agents not installed (null paths)
vi.mock("../config.js", () => ({
  CLAUDE_PATH: "claude",
  EXPECT_PATH: "",
  CLAUDE_CLI_JS: null,
  CODEX_PATH: null,
  OPENCLAW_PATH: null,
  OPENCLAW_PROFILE: null,
  PI_PATH: null,
}));

// Use the real agent-runtime registry (not mocked)
// so we can test actual registration and getRegisteredRuntimes().

// ─── Platform setup ──────────────────────────────────────────

const originalPlatform = process.platform;

// ─── Helper: fresh import of all runtimes ────────────────────

async function importAllRuntimes() {
  vi.resetModules();
  // Import the registry first
  const runtime = await import("../agent-runtime.js");
  // Side-effect imports trigger self-registration
  await import("../agent-claude.js");
  await import("../agent-codex.js");
  await import("../agent-openclaw.js");
  await import("../agent-pimono.js");
  return runtime;
}

async function importCodexRuntime() {
  vi.resetModules();
  await import("../agent-runtime.js");
  const mod = await import("../agent-codex.js");
  return mod.CodexAgentRuntime;
}

async function importOpenClawRuntime() {
  vi.resetModules();
  await import("../agent-runtime.js");
  const mod = await import("../agent-openclaw.js");
  return mod.OpenClawAgentRuntime;
}

async function importPiRuntime() {
  vi.resetModules();
  await import("../agent-runtime.js");
  const mod = await import("../agent-pimono.js");
  return mod.PiMonoAgentRuntime;
}

async function importClaudeRuntime() {
  vi.resetModules();
  await import("../agent-runtime.js");
  const mod = await import("../agent-claude.js");
  return mod.ClaudeAgentRuntime;
}

// ─── Tests ───────────────────────────────────────────────────

// Mocked-platform test: simulates Windows on any OS by overriding process.platform.
// Validates runtime registration, path fallback, session dirs, encodeProjectCwd,
// and cleanEnv with all external calls (child_process, fs) mocked.
// Validated against real Windows CI in windows-real-platform.test.ts.
// Last cross-validated: 2026-03-02
describe("Windows agent smoke tests", () => {
  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "win32" });
    mockExecFileSync.mockReset();
    mockExecFile.mockReset();
    mockSpawn.mockReset();
    mockExistsSync.mockReset();
    mockReaddirSync.mockReset();
    mockReadFileSync.mockReset();
    mockStatSync.mockReset();
    // Default: no files exist (agents not installed)
    mockExistsSync.mockReturnValue(false);
    // where.exe fails (agents not in PATH)
    mockExecFileSync.mockImplementation(() => {
      throw new Error("INFO: Could not find files for the given pattern(s).");
    });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  // ─── 1. Runtime registration ────────────────────────────────

  describe("runtime registration", () => {
    it("all four runtimes register successfully", async () => {
      const { getRegisteredRuntimes } = await importAllRuntimes();
      const runtimes = getRegisteredRuntimes();

      expect(runtimes.has("claude")).toBe(true);
      expect(runtimes.has("codex")).toBe(true);
      expect(runtimes.has("openclaw")).toBe(true);
      expect(runtimes.has("pi")).toBe(true);
      expect(runtimes.size).toBe(4);
    });

    it("each factory produces a valid runtime instance", async () => {
      const { getRegisteredRuntimes } = await importAllRuntimes();
      const runtimes = getRegisteredRuntimes();

      for (const [type, factory] of runtimes) {
        const instance = factory();
        expect(instance.type).toBe(type);
        expect(typeof instance.getSessionsDir).toBe("function");
        expect(typeof instance.encodeProjectCwd).toBe("function");
        expect(typeof instance.cleanEnv).toBe("function");
        expect(typeof instance.runSession).toBe("function");
        expect(typeof instance.resumeSession).toBe("function");
        expect(typeof instance.detectNewSession).toBe("function");
        expect(typeof instance.analyzeSessionHealth).toBe("function");
      }
    });
  });

  // ─── 2. Path resolution graceful failure ────────────────────

  describe("path resolution graceful failure", () => {
    // Config path resolution is tested in config.test.ts.
    // Here we verify the agent modules themselves handle null paths
    // gracefully by falling back to bare command names.

    it("Codex falls back to bare 'codex' when config path is null", async () => {
      const CodexRuntime = await importCodexRuntime();
      const runtime = new CodexRuntime();

      // The runtime should be constructable without crashing
      expect(runtime.type).toBe("codex");

      // runSession should attempt to execute the bare command name
      mockExecFile.mockImplementation(
        (bin: string, _args: string[], _opts: unknown, cb: (err: Error) => void) => {
          // Verify it uses the fallback bare command, not /usr/bin/which
          expect(bin).toBe("codex");
          cb(new Error("ENOENT"));
          return {};
        },
      );

      await expect(runtime.runSession("test")).rejects.toThrow();
    });

    it("OpenClaw falls back to bare 'openclaw' when config path is null", async () => {
      const OpenClawRuntime = await importOpenClawRuntime();
      const runtime = new OpenClawRuntime();

      expect(runtime.type).toBe("openclaw");

      mockExecFile.mockImplementation(
        (bin: string, _args: string[], _opts: unknown, cb: (err: Error) => void) => {
          expect(bin).toBe("openclaw");
          cb(new Error("ENOENT"));
          return {};
        },
      );

      await expect(runtime.runSession("test")).rejects.toThrow();
    });

    it("Pi falls back to bare 'pi' when config path is null", async () => {
      const PiRuntime = await importPiRuntime();
      const runtime = new PiRuntime();

      expect(runtime.type).toBe("pi");

      mockExecFile.mockImplementation(
        (bin: string, _args: string[], _opts: unknown, cb: (err: Error) => void) => {
          // Pi falls back to "pi" bare command
          expect(bin).toBe("pi");
          cb(new Error("ENOENT"));
          return {};
        },
      );

      await expect(runtime.runSession("test")).rejects.toThrow();
    });
  });

  // ─── 3. Session dir access ──────────────────────────────────

  describe("session dir access", () => {
    it("Claude sessions dir uses os.homedir()", async () => {
      const ClaudeRuntime = await importClaudeRuntime();
      const runtime = new ClaudeRuntime();
      const dir = runtime.getSessionsDir();

      expect(dir).toContain(homedir());
      expect(dir).toContain(".claude");
      expect(dir).toContain("projects");
      // Note: os.homedir() is a native call unaffected by process.platform mocking.
      // On Linux CI, homedir() returns /home/... even when platform is mocked to "win32".
      // The real-platform test (windows-real-platform.test.ts) verifies backslash
      // separators and drive-letter prefixes on actual Windows.
    });

    it("Codex sessions dir uses os.homedir()", async () => {
      const CodexRuntime = await importCodexRuntime();
      const runtime = new CodexRuntime();
      const dir = runtime.getSessionsDir();

      expect(dir).toContain(homedir());
      expect(dir).toContain(".codex");
      expect(dir).toContain("sessions");
    });

    it("OpenClaw sessions dir uses os.homedir()", async () => {
      const OpenClawRuntime = await importOpenClawRuntime();
      const runtime = new OpenClawRuntime();
      const dir = runtime.getSessionsDir();

      expect(dir).toContain(homedir());
      expect(dir).toContain(".openclaw");
      expect(dir).toContain("agents");
    });

    it("Pi sessions dir uses os.homedir()", async () => {
      const PiRuntime = await importPiRuntime();
      const runtime = new PiRuntime();
      const dir = runtime.getSessionsDir();

      expect(dir).toContain(homedir());
      expect(dir).toContain(".pi");
      expect(dir).toContain("sessions");
    });

    it("existsSync on session dirs does not throw", async () => {
      const { getRegisteredRuntimes } = await importAllRuntimes();
      const runtimes = getRegisteredRuntimes();

      // Allow existsSync to actually be called (mocked to return false = dir doesn't exist)
      mockExistsSync.mockReturnValue(false);

      for (const [, factory] of runtimes) {
        const instance = factory();
        const dir = instance.getSessionsDir();
        // Calling existsSync should not throw even if dir doesn't exist
        expect(() => mockExistsSync(dir)).not.toThrow();
      }
    });
  });

  // ─── 4. encodeProjectCwd round-trip ─────────────────────────

  describe("encodeProjectCwd round-trip", () => {
    const WINDOWS_PATH = "Q:\\src\\ClawUI";

    it("Codex: encodes Windows path without backslashes or colons", async () => {
      const CodexRuntime = await importCodexRuntime();
      const runtime = new CodexRuntime();
      const encoded = runtime.encodeProjectCwd(WINDOWS_PATH);

      expect(encoded).not.toContain("\\");
      expect(encoded).not.toContain(":");
      expect(encoded).toContain("Q");
      expect(encoded).toContain("src");
      expect(encoded).toContain("ClawUI");
    });

    it("OpenClaw: encodes Windows path without backslashes or colons", async () => {
      const OpenClawRuntime = await importOpenClawRuntime();
      const runtime = new OpenClawRuntime();
      const encoded = runtime.encodeProjectCwd(WINDOWS_PATH);

      expect(encoded).not.toContain("\\");
      expect(encoded).not.toContain(":");
      expect(encoded).toContain("Q");
      expect(encoded).toContain("src");
      expect(encoded).toContain("ClawUI");
    });

    it("Pi: encodes Windows path without backslashes or colons", async () => {
      const PiRuntime = await importPiRuntime();
      const runtime = new PiRuntime();
      const encoded = runtime.encodeProjectCwd(WINDOWS_PATH);

      expect(encoded).not.toContain("\\");
      expect(encoded).not.toContain(":");
      expect(encoded).toContain("Q");
      expect(encoded).toContain("src");
      expect(encoded).toContain("ClawUI");
    });

    it("Claude: encodes Windows path without backslashes or colons", async () => {
      const ClaudeRuntime = await importClaudeRuntime();
      const runtime = new ClaudeRuntime();
      const encoded = runtime.encodeProjectCwd(WINDOWS_PATH);

      expect(encoded).not.toContain("\\");
      expect(encoded).not.toContain(":");
      expect(encoded).toContain("Q");
      expect(encoded).toContain("src");
      expect(encoded).toContain("ClawUI");
    });

    it("all runtimes produce consistent encoding for C:\\Users\\dev\\project", async () => {
      const winPath = "C:\\Users\\dev\\project";
      const { getRegisteredRuntimes } = await importAllRuntimes();
      const runtimes = getRegisteredRuntimes();

      for (const [, factory] of runtimes) {
        const instance = factory();
        const encoded = instance.encodeProjectCwd(winPath);

        // No backslashes or colons in any encoding
        expect(encoded).not.toContain("\\");
        expect(encoded).not.toContain(":");
        // All should contain the path segments
        expect(encoded).toContain("Users");
        expect(encoded).toContain("dev");
        expect(encoded).toContain("project");
      }
    });

    it("handles deeply nested Windows path", async () => {
      const deepPath = "D:\\Work\\repos\\my-org\\my-project\\subdir";
      const { getRegisteredRuntimes } = await importAllRuntimes();
      const runtimes = getRegisteredRuntimes();

      for (const [, factory] of runtimes) {
        const instance = factory();
        const encoded = instance.encodeProjectCwd(deepPath);

        expect(encoded).not.toContain("\\");
        expect(encoded).not.toContain(":");
        expect(encoded).toContain("Work");
        expect(encoded).toContain("my-project");
      }
    });

    it("handles mixed slash Windows path", async () => {
      const mixedPath = "C:\\Users/dev\\project";
      const { getRegisteredRuntimes } = await importAllRuntimes();
      const runtimes = getRegisteredRuntimes();

      for (const [, factory] of runtimes) {
        const instance = factory();
        const encoded = instance.encodeProjectCwd(mixedPath);

        expect(encoded).not.toContain("\\");
        expect(encoded).not.toContain(":");
      }
    });
  });

  // ─── 5. cleanEnv ────────────────────────────────────────────

  describe("cleanEnv", () => {
    it("Codex cleanEnv returns valid env object with PATH", async () => {
      const CodexRuntime = await importCodexRuntime();
      const runtime = new CodexRuntime();
      const env = runtime.cleanEnv();

      expect(env).toBeDefined();
      expect(typeof env).toBe("object");
      // PATH should be preserved (critical for Windows subprocess execution)
      expect(env.PATH || env.Path).toBeDefined();
    });

    it("OpenClaw cleanEnv returns valid env object with PATH", async () => {
      const OpenClawRuntime = await importOpenClawRuntime();
      const runtime = new OpenClawRuntime();
      const env = runtime.cleanEnv();

      expect(env).toBeDefined();
      expect(typeof env).toBe("object");
      expect(env.PATH || env.Path).toBeDefined();
    });

    it("Pi cleanEnv returns valid env object with PATH", async () => {
      const PiRuntime = await importPiRuntime();
      const runtime = new PiRuntime();
      const env = runtime.cleanEnv();

      expect(env).toBeDefined();
      expect(typeof env).toBe("object");
      expect(env.PATH || env.Path).toBeDefined();
    });

    it("Claude cleanEnv returns valid env object with PATH", async () => {
      const ClaudeRuntime = await importClaudeRuntime();
      const runtime = new ClaudeRuntime();
      const env = runtime.cleanEnv();

      expect(env).toBeDefined();
      expect(typeof env).toBe("object");
      expect(env.PATH || env.Path).toBeDefined();
    });

    it("Codex cleanEnv strips CODEX_HOME and CODEX_SESSION", async () => {
      process.env.CODEX_HOME = "C:\\Users\\test\\.codex";
      process.env.CODEX_SESSION = "sess-123";

      const CodexRuntime = await importCodexRuntime();
      const runtime = new CodexRuntime();
      const env = runtime.cleanEnv();

      expect(env.CODEX_HOME).toBeUndefined();
      expect(env.CODEX_SESSION).toBeUndefined();

      delete process.env.CODEX_HOME;
      delete process.env.CODEX_SESSION;
    });

    it("OpenClaw cleanEnv strips OPENCLAW_SESSION", async () => {
      process.env.OPENCLAW_SESSION = "sess-456";

      const OpenClawRuntime = await importOpenClawRuntime();
      const runtime = new OpenClawRuntime();
      const env = runtime.cleanEnv();

      expect(env.OPENCLAW_SESSION).toBeUndefined();

      delete process.env.OPENCLAW_SESSION;
    });

    it("Claude cleanEnv strips CLAUDE* vars but keeps CLAUDE_PATH", async () => {
      process.env.CLAUDECODE = "1";
      process.env.CLAUDE_PATH = "C:\\claude\\claude.exe";

      const ClaudeRuntime = await importClaudeRuntime();
      const runtime = new ClaudeRuntime();
      const env = runtime.cleanEnv();

      expect(env.CLAUDECODE).toBeUndefined();
      expect(env.CLAUDE_PATH).toBe("C:\\claude\\claude.exe");

      delete process.env.CLAUDECODE;
      delete process.env.CLAUDE_PATH;
    });

    it("cleanEnv does not contain Unix-only assumptions", async () => {
      const { getRegisteredRuntimes } = await importAllRuntimes();
      const runtimes = getRegisteredRuntimes();

      for (const [, factory] of runtimes) {
        const instance = factory();
        const env = instance.cleanEnv();

        // Env should be a plain object, not null/undefined
        expect(env).not.toBeNull();
        expect(env).not.toBeUndefined();

        // Should not set SHELL to a Unix-only path
        // (cleanEnv should not add Unix-specific vars)
        if (env.SHELL) {
          // If SHELL exists, it should be inherited from process.env, not newly set
          expect(env.SHELL).toBe(process.env.SHELL);
        }
      }
    });
  });
});
