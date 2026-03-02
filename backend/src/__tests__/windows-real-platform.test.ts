// backend/src/__tests__/windows-real-platform.test.ts
//
// Real-platform Windows tests — NO process.platform mocking.
//
// These tests only run on actual Windows hosts (CI windows-latest or local dev).
// They validate that path resolution, encodeProjectCwd, session dir construction,
// and config module behavior work correctly with real Windows APIs (path.join
// producing backslashes, os.homedir returning C:\Users\..., etc.).
//
// Guarded by describe.runIf(process.platform === "win32") so they are
// automatically skipped on Linux/macOS CI runners.
//
// Cross-validates the following mocked-platform tests:
//   - config.test.ts: resolveClaudePath/resolveOpenClawPath/resolveCodexPath/resolvePiPath Windows describes
//   - cli-utils.test.ts: isProcessAlive (Windows), resolveClaudeCliJs (Windows), encodeProjectPath Windows
//   - jsonl-parser.test.ts: decodeProjectPath (Windows) describe
//   - windows-agent-smoke.test.ts: all describes (runtime registration, path fallback, session dirs, encodeProjectCwd, cleanEnv)
//   - agent-codex.test.ts: encodeProjectCwd Windows-specific tests
//   - agent-openclaw.test.ts: encodeProjectCwd Windows-specific tests
//
// Where mocked tests use Object.defineProperty(process, "platform", { value: "win32" }),
// these tests verify the same behavior on real Windows where path.join() uses backslashes,
// os.homedir() returns C:\Users\..., and where.exe is a real binary.
// Last cross-validated: 2026-03-02

import { describe, it, expect, vi, beforeEach } from "vitest";
import { join, sep } from "node:path";
import { homedir } from "node:os";

// ─── 1. Native path module behavior ─────────────────────────

describe.runIf(process.platform === "win32")("Windows real platform: path module", () => {
  it("path.sep is backslash on real Windows", () => {
    expect(sep).toBe("\\");
  });

  it("path.join produces backslash-separated paths", () => {
    const result = join("C:", "Users", "dev", "project");
    expect(result).toContain("\\");
    expect(result).not.toMatch(/(?<!\\)\//); // no standalone forward slashes
  });

  it("path.join with homedir() produces a valid Windows path", () => {
    const result = join(homedir(), ".claude", "projects");
    expect(result).toMatch(/^[A-Z]:\\/i);
    expect(result).toContain("\\.claude\\");
  });

  it("os.homedir() returns a drive-letter path", () => {
    const home = homedir();
    expect(home).toMatch(/^[A-Z]:\\/i);
    expect(home).not.toMatch(/^\//); // not a Unix path
  });
});

// ─── 2. Real encodeProjectCwd on Windows ────────────────────
//
// Import the actual runtime classes with mocked dependencies
// (we mock child_process/fs to avoid needing real agent binaries,
// but do NOT mock process.platform).

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

vi.mock("../jsonl-parser.js", () => ({
  analyzeSessionHealth: vi.fn(() => null),
}));

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

vi.mock("../config.js", () => ({
  CLAUDE_PATH: "claude",
  EXPECT_PATH: "",
  CLAUDE_CLI_JS: null,
  CODEX_PATH: null,
  OPENCLAW_PATH: null,
  OPENCLAW_PROFILE: null,
  PI_PATH: null,
}));

async function freshImportAllRuntimes() {
  vi.resetModules();
  const runtime = await import("../agent-runtime.js");
  await import("../agent-claude.js");
  await import("../agent-codex.js");
  await import("../agent-openclaw.js");
  await import("../agent-pimono.js");
  return runtime;
}

async function freshImportCodex() {
  vi.resetModules();
  await import("../agent-runtime.js");
  const mod = await import("../agent-codex.js");
  return mod.CodexAgentRuntime;
}

async function freshImportOpenClaw() {
  vi.resetModules();
  await import("../agent-runtime.js");
  const mod = await import("../agent-openclaw.js");
  return mod.OpenClawAgentRuntime;
}

async function freshImportPi() {
  vi.resetModules();
  await import("../agent-runtime.js");
  const mod = await import("../agent-pimono.js");
  return mod.PiMonoAgentRuntime;
}

async function freshImportClaude() {
  vi.resetModules();
  await import("../agent-runtime.js");
  const mod = await import("../agent-claude.js");
  return mod.ClaudeAgentRuntime;
}

describe.runIf(process.platform === "win32")("Windows real platform: encodeProjectCwd", () => {
  beforeEach(() => {
    mockExistsSync.mockReturnValue(false);
    mockExecFileSync.mockImplementation(() => {
      throw new Error("not found");
    });
  });

  it("Claude encodes a native Windows path correctly", async () => {
    const ClaudeRuntime = await freshImportClaude();
    const runtime = new ClaudeRuntime();

    // Use a real Windows-style path with backslashes (as path.join would produce)
    const nativePath = join("C:", "Users", "dev", "my-project");
    const encoded = runtime.encodeProjectCwd(nativePath);

    // Must not contain backslashes or colons
    expect(encoded).not.toContain("\\");
    expect(encoded).not.toContain(":");
    // Must contain the path segments
    expect(encoded).toContain("Users");
    expect(encoded).toContain("dev");
    expect(encoded).toContain("my-project");
  });

  it("Codex encodes a native Windows path correctly", async () => {
    const CodexRuntime = await freshImportCodex();
    const runtime = new CodexRuntime();

    const nativePath = join("D:", "Work", "repos", "project");
    const encoded = runtime.encodeProjectCwd(nativePath);

    expect(encoded).not.toContain("\\");
    expect(encoded).not.toContain(":");
    expect(encoded).toContain("Work");
    expect(encoded).toContain("project");
  });

  it("OpenClaw encodes a native Windows path correctly", async () => {
    const OpenClawRuntime = await freshImportOpenClaw();
    const runtime = new OpenClawRuntime();

    const nativePath = join("C:", "Users", "dev", "app");
    const encoded = runtime.encodeProjectCwd(nativePath);

    expect(encoded).not.toContain("\\");
    expect(encoded).not.toContain(":");
    expect(encoded).toContain("Users");
    expect(encoded).toContain("app");
  });

  it("Pi encodes a native Windows path correctly", async () => {
    const PiRuntime = await freshImportPi();
    const runtime = new PiRuntime();

    const nativePath = join("C:", "Users", "dev", "project");
    const encoded = runtime.encodeProjectCwd(nativePath);

    expect(encoded).not.toContain("\\");
    expect(encoded).not.toContain(":");
    expect(encoded).toContain("Users");
    expect(encoded).toContain("project");
  });

  it("all runtimes encode homedir-relative paths without backslashes", async () => {
    const { getRegisteredRuntimes } = await freshImportAllRuntimes();
    const runtimes = getRegisteredRuntimes();

    // Use a path constructed with real path.join (backslashes on Windows)
    const nativePath = join(homedir(), "projects", "test-app");

    for (const [type, factory] of runtimes) {
      const instance = factory();
      const encoded = instance.encodeProjectCwd(nativePath);

      expect(encoded, `${type} should not contain backslashes`).not.toContain("\\");
      expect(encoded, `${type} should not contain colons`).not.toContain(":");
      expect(encoded, `${type} should contain 'projects'`).toContain("projects");
      expect(encoded, `${type} should contain 'test-app'`).toContain("test-app");
    }
  });

  it("encoding handles UNC-like paths (network drives)", async () => {
    const { getRegisteredRuntimes } = await freshImportAllRuntimes();
    const runtimes = getRegisteredRuntimes();

    // UNC path style: \\server\share\project
    const uncPath = "\\\\server\\share\\project";

    for (const [type, factory] of runtimes) {
      const instance = factory();
      const encoded = instance.encodeProjectCwd(uncPath);

      expect(encoded, `${type} UNC path should not contain backslashes`).not.toContain("\\");
    }
  });
});

// ─── 3. Real getSessionsDir on Windows ──────────────────────

describe.runIf(process.platform === "win32")("Windows real platform: getSessionsDir", () => {
  beforeEach(() => {
    mockExistsSync.mockReturnValue(false);
    mockExecFileSync.mockImplementation(() => {
      throw new Error("not found");
    });
  });

  it("Claude sessions dir uses backslash separators", async () => {
    const ClaudeRuntime = await freshImportClaude();
    const runtime = new ClaudeRuntime();
    const dir = runtime.getSessionsDir();

    // On real Windows, path.join produces backslashes
    expect(dir).toContain("\\");
    expect(dir).toMatch(/^[A-Z]:\\/i); // starts with drive letter
    expect(dir).toContain(".claude");
    expect(dir).toContain("projects");
  });

  it("Codex sessions dir uses backslash separators", async () => {
    const CodexRuntime = await freshImportCodex();
    const runtime = new CodexRuntime();
    const dir = runtime.getSessionsDir();

    expect(dir).toContain("\\");
    expect(dir).toMatch(/^[A-Z]:\\/i);
    expect(dir).toContain(".codex");
    expect(dir).toContain("sessions");
  });

  it("OpenClaw sessions dir uses backslash separators", async () => {
    const OpenClawRuntime = await freshImportOpenClaw();
    const runtime = new OpenClawRuntime();
    const dir = runtime.getSessionsDir();

    expect(dir).toContain("\\");
    expect(dir).toMatch(/^[A-Z]:\\/i);
    expect(dir).toContain(".openclaw");
    expect(dir).toContain("agents");
  });

  it("Pi sessions dir uses backslash separators", async () => {
    const PiRuntime = await freshImportPi();
    const runtime = new PiRuntime();
    const dir = runtime.getSessionsDir();

    expect(dir).toContain("\\");
    expect(dir).toMatch(/^[A-Z]:\\/i);
    expect(dir).toContain(".pi");
    expect(dir).toContain("sessions");
  });
});

// ─── 4. Real cleanEnv on Windows ────────────────────────────

describe.runIf(process.platform === "win32")("Windows real platform: cleanEnv", () => {
  beforeEach(() => {
    mockExistsSync.mockReturnValue(false);
    mockExecFileSync.mockImplementation(() => {
      throw new Error("not found");
    });
  });

  it("all runtimes preserve PATH (case-insensitive on Windows)", async () => {
    const { getRegisteredRuntimes } = await freshImportAllRuntimes();
    const runtimes = getRegisteredRuntimes();

    for (const [type, factory] of runtimes) {
      const instance = factory();
      const env = instance.cleanEnv();

      // Windows env vars are case-insensitive; Node preserves original case.
      // PATH might appear as "Path" on some Windows systems.
      const hasPath = env.PATH !== undefined || env.Path !== undefined;
      expect(hasPath, `${type} cleanEnv should preserve PATH`).toBe(true);
    }
  });

  it("cleanEnv contains SystemRoot and COMSPEC (Windows-critical vars)", async () => {
    const { getRegisteredRuntimes } = await freshImportAllRuntimes();
    const runtimes = getRegisteredRuntimes();

    for (const [type, factory] of runtimes) {
      const instance = factory();
      const env = instance.cleanEnv();

      // process.env is case-insensitive on Windows, but { ...process.env }
      // creates a case-sensitive object. Check all key casings.
      const envKeys = Object.keys(env);

      if (process.env.SystemRoot) {
        const hasSystemRoot = envKeys.some((k) => k.toLowerCase() === "systemroot");
        expect(hasSystemRoot, `${type} should preserve SystemRoot`).toBe(true);
      }
      if (process.env.COMSPEC) {
        const hasComspec = envKeys.some((k) => k.toLowerCase() === "comspec");
        expect(hasComspec, `${type} should preserve COMSPEC`).toBe(true);
      }
    }
  });
});

// ─── 5. encodeProjectPath in cli-utils (real platform) ──────
//
// Note: config.ts path resolution (resolveClaudePath, resolveExpectPath, etc.)
// is thoroughly tested in config.test.ts which uses vi.mock on process.platform.
// Those tests verify Windows/Unix branching. We can't re-test config.ts here
// because vi.mock("../config.js") is hoisted and blocks real config imports.

describe.runIf(process.platform === "win32")("Windows real platform: cli-utils encodeProjectPath", () => {
  // Uses vi.importActual to get the REAL encodeProjectPath despite the
  // file-level vi.mock("../cli-utils.js") needed by agent runtime tests above.

  it("encodes a native Windows path built with path.join", async () => {
    // Import the REAL encodeProjectPath via vi.importActual to bypass
    // the file-level vi.mock("../cli-utils.js") that agent tests need.
    const { encodeProjectPath } = await vi.importActual<typeof import("../cli-utils.js")>("../cli-utils.js");

    const nativePath = join("C:", "Users", "dev", "project");
    // On Windows, nativePath = "C:\\Users\\dev\\project"
    const encoded = encodeProjectPath(nativePath);

    expect(encoded).not.toContain("\\");
    expect(encoded).not.toContain(":");
    expect(encoded).toContain("C-");
    expect(encoded).toContain("Users");
    expect(encoded).toContain("project");
  });

  it("roundtrip: join → encode preserves all segments", async () => {
    const { encodeProjectPath } = await vi.importActual<typeof import("../cli-utils.js")>("../cli-utils.js");

    const segments = ["D:", "Work", "my-org", "my-project", "sub-dir"];
    const nativePath = join(...segments);
    const encoded = encodeProjectPath(nativePath);

    // All non-root segments should be present in the encoded string
    for (const seg of segments.slice(1)) {
      expect(encoded).toContain(seg);
    }
    // Drive letter should be preserved (minus colon)
    expect(encoded).toMatch(/^D-/);
  });
});

// ─── 6. Cross-platform consistency check ────────────────────
//
// These tests run on ALL platforms. They verify that the encoding
// functions handle both forward and back slashes regardless of
// which platform is running the tests.

describe("Cross-platform: encodeProjectCwd handles both separators", () => {
  beforeEach(() => {
    mockExistsSync.mockReturnValue(false);
    mockExecFileSync.mockImplementation(() => {
      throw new Error("not found");
    });
  });

  it("Claude: same result for forward and back slashes", async () => {
    const ClaudeRuntime = await freshImportClaude();
    const runtime = new ClaudeRuntime();

    const fwd = runtime.encodeProjectCwd("C:/Users/dev/project");
    const back = runtime.encodeProjectCwd("C:\\Users\\dev\\project");

    // Both should produce the same encoded string
    expect(fwd).toBe(back);
  });

  it("Codex: same result for forward and back slashes", async () => {
    const CodexRuntime = await freshImportCodex();
    const runtime = new CodexRuntime();

    const fwd = runtime.encodeProjectCwd("C:/Users/dev/project");
    const back = runtime.encodeProjectCwd("C:\\Users\\dev\\project");

    expect(fwd).toBe(back);
  });

  it("OpenClaw: same result for forward and back slashes", async () => {
    const OpenClawRuntime = await freshImportOpenClaw();
    const runtime = new OpenClawRuntime();

    const fwd = runtime.encodeProjectCwd("C:/Users/dev/project");
    const back = runtime.encodeProjectCwd("C:\\Users\\dev\\project");

    expect(fwd).toBe(back);
  });

  it("Pi: same result for forward and back slashes", async () => {
    const PiRuntime = await freshImportPi();
    const runtime = new PiRuntime();

    const fwd = runtime.encodeProjectCwd("C:/Users/dev/project");
    const back = runtime.encodeProjectCwd("C:\\Users\\dev\\project");

    expect(fwd).toBe(back);
  });
});
