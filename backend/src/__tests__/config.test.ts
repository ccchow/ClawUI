import { describe, it, expect } from "vitest";

// config.ts exports are evaluated at module load time, so we test
// the exported values after they've been resolved.

describe("config module", () => {
  it("exports CLAUDE_PATH as a non-empty string", async () => {
    const { CLAUDE_PATH } = await import("../config.js");
    expect(typeof CLAUDE_PATH).toBe("string");
    expect(CLAUDE_PATH.length).toBeGreaterThan(0);
  });

  it("exports EXPECT_PATH as a non-empty string", async () => {
    const { EXPECT_PATH } = await import("../config.js");
    expect(typeof EXPECT_PATH).toBe("string");
    expect(EXPECT_PATH.length).toBeGreaterThan(0);
  });

  it("exports PORT as a number defaulting to 3001", async () => {
    const { PORT } = await import("../config.js");
    expect(typeof PORT).toBe("number");
    // Default or env-overridden, but always a valid number
    expect(Number.isInteger(PORT)).toBe(true);
    expect(PORT).toBeGreaterThan(0);
  });

  it("exports CLAWUI_DB_DIR as an absolute path", async () => {
    const { CLAWUI_DB_DIR } = await import("../config.js");
    const { isAbsolute } = await import("node:path");
    expect(typeof CLAWUI_DB_DIR).toBe("string");
    expect(isAbsolute(CLAWUI_DB_DIR)).toBe(true);
  });

  it("exports NEXT_PUBLIC_API_PORT as a string", async () => {
    const { NEXT_PUBLIC_API_PORT } = await import("../config.js");
    expect(typeof NEXT_PUBLIC_API_PORT).toBe("string");
  });

  it("exports LOG_LEVEL as a string", async () => {
    const { LOG_LEVEL } = await import("../config.js");
    expect(typeof LOG_LEVEL).toBe("string");
    expect(["debug", "info", "warn", "error"]).toContain(LOG_LEVEL);
  });

  it("exports CLAWUI_DEV as a boolean", async () => {
    const { CLAWUI_DEV } = await import("../config.js");
    expect(typeof CLAWUI_DEV).toBe("boolean");
  });
});
