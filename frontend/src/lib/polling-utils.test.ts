import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { createDynamicInterval, POLL_SAFETY_CAP_MS, usePollingInterval, invalidateKeys } from "./polling-utils";

describe("createDynamicInterval", () => {
  let pollStartRef: { current: number | null };

  beforeEach(() => {
    pollStartRef = { current: null };
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns false and resets ref when activeInterval is false", () => {
    pollStartRef.current = 12345;
    const result = createDynamicInterval(pollStartRef, false);
    expect(result).toBe(false);
    expect(pollStartRef.current).toBeNull();
  });

  it("returns the interval when active and within safety cap", () => {
    const result = createDynamicInterval(pollStartRef, 5000);
    expect(result).toBe(5000);
    expect(pollStartRef.current).not.toBeNull();
  });

  it("initializes pollStartRef on first active call", () => {
    expect(pollStartRef.current).toBeNull();
    createDynamicInterval(pollStartRef, 2000);
    expect(pollStartRef.current).toBe(Date.now());
  });

  it("preserves existing pollStartRef timestamp on subsequent calls", () => {
    createDynamicInterval(pollStartRef, 5000);
    const firstStart = pollStartRef.current;
    vi.advanceTimersByTime(1000);
    createDynamicInterval(pollStartRef, 5000);
    expect(pollStartRef.current).toBe(firstStart);
  });

  it("returns false after exceeding safety cap", () => {
    createDynamicInterval(pollStartRef, 5000);
    vi.advanceTimersByTime(POLL_SAFETY_CAP_MS + 1);
    const result = createDynamicInterval(pollStartRef, 5000);
    expect(result).toBe(false);
    expect(pollStartRef.current).toBeNull();
  });

  it("resets and allows fresh polling after safety cap expiry", () => {
    // Start polling
    createDynamicInterval(pollStartRef, 5000);
    // Exceed cap
    vi.advanceTimersByTime(POLL_SAFETY_CAP_MS + 1);
    createDynamicInterval(pollStartRef, 5000); // returns false, resets
    // Next call with active interval should start fresh
    const result = createDynamicInterval(pollStartRef, 2000);
    expect(result).toBe(2000);
    expect(pollStartRef.current).not.toBeNull();
  });

  it("supports custom maxDuration", () => {
    const customMax = 5000;
    createDynamicInterval(pollStartRef, 2000, customMax);
    vi.advanceTimersByTime(customMax + 1);
    const result = createDynamicInterval(pollStartRef, 2000, customMax);
    expect(result).toBe(false);
  });

  it("passes through different interval values", () => {
    expect(createDynamicInterval(pollStartRef, 2000)).toBe(2000);
    expect(createDynamicInterval(pollStartRef, 5000)).toBe(5000);
    expect(createDynamicInterval(pollStartRef, 10000)).toBe(10000);
  });

  it("exports POLL_SAFETY_CAP_MS as 35 minutes", () => {
    expect(POLL_SAFETY_CAP_MS).toBe(35 * 60 * 1000);
  });
});

describe("invalidateKeys", () => {
  it("calls invalidateQueries for each key", () => {
    const mockInvalidate = vi.fn();
    const queryClient = { invalidateQueries: mockInvalidate } as never;
    const keys = [
      ["blueprint", "1"] as const,
      ["blueprint", "1", "queue"] as const,
      ["blueprint", "1", "insights"] as const,
    ];
    invalidateKeys(queryClient, keys);
    expect(mockInvalidate).toHaveBeenCalledTimes(3);
    expect(mockInvalidate).toHaveBeenCalledWith({ queryKey: ["blueprint", "1"] });
    expect(mockInvalidate).toHaveBeenCalledWith({ queryKey: ["blueprint", "1", "queue"] });
    expect(mockInvalidate).toHaveBeenCalledWith({ queryKey: ["blueprint", "1", "insights"] });
  });

  it("handles empty keys array", () => {
    const mockInvalidate = vi.fn();
    const queryClient = { invalidateQueries: mockInvalidate } as never;
    invalidateKeys(queryClient, []);
    expect(mockInvalidate).not.toHaveBeenCalled();
  });
});

describe("usePollingInterval", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a stable callback reference", () => {
    const { result, rerender } = renderHook(() =>
      usePollingInterval(() => 5000),
    );
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it("delegates to createDynamicInterval with the compute result", () => {
    const { result } = renderHook(() =>
      usePollingInterval(() => 5000),
    );
    expect(result.current()).toBe(5000);
  });

  it("returns false when compute returns false", () => {
    const { result } = renderHook(() =>
      usePollingInterval(() => false),
    );
    expect(result.current()).toBe(false);
  });

  it("applies safety cap after max duration", () => {
    const { result } = renderHook(() =>
      usePollingInterval(() => 2000),
    );
    // Start polling
    result.current();
    // Exceed safety cap
    vi.advanceTimersByTime(POLL_SAFETY_CAP_MS + 1);
    expect(result.current()).toBe(false);
  });

  it("picks up updated compute function via ref", () => {
    let interval: number | false = 2000;
    const { result } = renderHook(() =>
      usePollingInterval(() => interval),
    );
    expect(result.current()).toBe(2000);
    interval = 5000;
    expect(result.current()).toBe(5000);
    interval = false;
    expect(result.current()).toBe(false);
  });
});
