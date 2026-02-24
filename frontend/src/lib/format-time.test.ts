import { describe, it, expect, vi, afterEach } from "vitest";
import { formatTimeAgo } from "./format-time";

describe("formatTimeAgo", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 'just now' for timestamps less than 1 minute ago", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-15T12:00:30Z"));
    expect(formatTimeAgo("2025-01-15T12:00:00Z")).toBe("just now");
  });

  it("returns minutes ago for timestamps less than 1 hour ago", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-15T12:15:00Z"));
    expect(formatTimeAgo("2025-01-15T12:00:00Z")).toBe("15m ago");
  });

  it("returns hours ago for timestamps less than 24 hours ago", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-15T15:00:00Z"));
    expect(formatTimeAgo("2025-01-15T12:00:00Z")).toBe("3h ago");
  });

  it("returns days ago for timestamps less than 7 days ago", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-18T12:00:00Z"));
    expect(formatTimeAgo("2025-01-15T12:00:00Z")).toBe("3d ago");
  });

  it("returns formatted date for timestamps older than 7 days", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-30T12:00:00Z"));
    const result = formatTimeAgo("2025-01-15T12:00:00Z");
    // Should be a date string, not "Xd ago"
    expect(result).not.toContain("d ago");
    expect(result).not.toContain("just now");
  });

  it("handles numeric timestamps", () => {
    vi.useFakeTimers();
    const now = new Date("2025-01-15T12:05:00Z");
    vi.setSystemTime(now);
    const fiveMinAgo = new Date("2025-01-15T12:00:00Z").getTime();
    expect(formatTimeAgo(fiveMinAgo)).toBe("5m ago");
  });

  it("handles edge case at exactly 60 minutes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-15T13:00:00Z"));
    expect(formatTimeAgo("2025-01-15T12:00:00Z")).toBe("1h ago");
  });

  it("handles edge case at exactly 24 hours", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-16T12:00:00Z"));
    expect(formatTimeAgo("2025-01-15T12:00:00Z")).toBe("1d ago");
  });
});
