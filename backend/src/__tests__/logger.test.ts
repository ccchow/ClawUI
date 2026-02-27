import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We test createLogger by spying on console methods
import { createLogger } from "../logger.js";

describe("logger module", () => {
  let consoleSpy: {
    debug: ReturnType<typeof vi.spyOn>;
    log: ReturnType<typeof vi.spyOn>;
    warn: ReturnType<typeof vi.spyOn>;
    error: ReturnType<typeof vi.spyOn>;
  };

  beforeEach(() => {
    consoleSpy = {
      debug: vi.spyOn(console, "debug").mockImplementation(() => {}),
      log: vi.spyOn(console, "log").mockImplementation(() => {}),
      warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
      error: vi.spyOn(console, "error").mockImplementation(() => {}),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("createLogger returns an object with debug, info, warn, error methods", () => {
    const log = createLogger("test-module");
    expect(typeof log.debug).toBe("function");
    expect(typeof log.info).toBe("function");
    expect(typeof log.warn).toBe("function");
    expect(typeof log.error).toBe("function");
  });

  it("error method always logs (highest priority)", () => {
    const log = createLogger("test-module");
    log.error("something went wrong");
    expect(consoleSpy.error).toHaveBeenCalled();
    const msg = consoleSpy.error.mock.calls[0][0] as string;
    expect(msg).toContain("[ERROR]");
    expect(msg).toContain("[test-module]");
    expect(msg).toContain("something went wrong");
  });

  it("warn method logs at info level (default LOG_LEVEL)", () => {
    const log = createLogger("my-mod");
    log.warn("watch out");
    expect(consoleSpy.warn).toHaveBeenCalled();
    const msg = consoleSpy.warn.mock.calls[0][0] as string;
    expect(msg).toContain("[WARN]");
    expect(msg).toContain("[my-mod]");
  });

  it("info method logs at default level", () => {
    const log = createLogger("server");
    log.info("server started");
    expect(consoleSpy.log).toHaveBeenCalled();
    const msg = consoleSpy.log.mock.calls[0][0] as string;
    expect(msg).toContain("[INFO]");
    expect(msg).toContain("[server]");
    expect(msg).toContain("server started");
  });

  it("format includes ISO timestamp", () => {
    const log = createLogger("test");
    log.error("test message");
    const msg = consoleSpy.error.mock.calls[0][0] as string;
    // ISO timestamp pattern: YYYY-MM-DDTHH:MM:SS.sssZ
    expect(msg).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("passes extra arguments through to console", () => {
    const log = createLogger("test");
    const extra = { key: "value" };
    log.error("msg", extra);
    expect(consoleSpy.error).toHaveBeenCalledWith(expect.any(String), extra);
  });
});
