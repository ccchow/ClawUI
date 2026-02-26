// backend/src/__tests__/cli-utils.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";

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

  describe("encodeProjectPath", () => {
    it("encodes Unix paths", async () => {
      const { encodeProjectPath } = await import("../cli-utils.js");
      expect(encodeProjectPath("/home/user/project")).toBe("-home-user-project");
    });

    it("encodes Windows paths (backslash + drive letter)", async () => {
      const { encodeProjectPath } = await import("../cli-utils.js");
      // Claude CLI encodes C:\Users\user\project as C--Users-user-project
      // The colon becomes - and each \ becomes -
      expect(encodeProjectPath("C:\\Users\\user\\project")).toBe("C--Users-user-project");
      expect(encodeProjectPath("Q:\\src\\ClawUI")).toBe("Q--src-ClawUI");
    });

    it("handles mixed separators", async () => {
      const { encodeProjectPath } = await import("../cli-utils.js");
      expect(encodeProjectPath("C:/Users/user/project")).toBe("C--Users-user-project");
    });
  });

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
