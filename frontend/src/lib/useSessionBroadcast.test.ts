import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useSessionBroadcast } from "./useSessionBroadcast";

// Track BroadcastChannel instances created during tests
interface MockChannel {
  name: string;
  postMessage: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  onmessage: ((event: MessageEvent) => void) | null;
}

let channelInstances: MockChannel[];

beforeEach(() => {
  channelInstances = [];

  class MockBC {
    name: string;
    postMessage = vi.fn();
    close = vi.fn();
    onmessage: ((event: MessageEvent) => void) | null = null;
    onmessageerror: ((event: MessageEvent) => void) | null = null;
    addEventListener = vi.fn();
    removeEventListener = vi.fn();
    dispatchEvent = vi.fn(() => true);
    constructor(name: string) {
      this.name = name;
      channelInstances.push(this);
    }
  }

  Object.defineProperty(globalThis, "BroadcastChannel", {
    value: MockBC,
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  channelInstances = [];
});

describe("useSessionBroadcast", () => {
  it("creates a BroadcastChannel with the correct name", () => {
    const onRunState = vi.fn();
    const { unmount } = renderHook(() => useSessionBroadcast("sess-1", onRunState));

    expect(channelInstances).toHaveLength(1);
    expect(channelInstances[0].name).toBe("clawui-session-runs");
    unmount();
  });

  it("does not create a channel when sessionId is undefined", () => {
    const onRunState = vi.fn();
    const { unmount } = renderHook(() => useSessionBroadcast(undefined, onRunState));

    expect(channelInstances).toHaveLength(0);
    unmount();
  });

  it("broadcasts start action with correct message shape", () => {
    const onRunState = vi.fn();
    const { result, unmount } = renderHook(() => useSessionBroadcast("sess-1", onRunState));

    act(() => {
      result.current("start");
    });

    expect(channelInstances[0].postMessage).toHaveBeenCalledTimes(1);
    const msg = channelInstances[0].postMessage.mock.calls[0][0];
    expect(msg).toMatchObject({
      sessionId: "sess-1",
      action: "start",
    });
    expect(typeof msg.timestamp).toBe("number");
    unmount();
  });

  it("broadcasts stop action with correct message shape", () => {
    const onRunState = vi.fn();
    const { result, unmount } = renderHook(() => useSessionBroadcast("sess-1", onRunState));

    act(() => {
      result.current("stop");
    });

    const msg = channelInstances[0].postMessage.mock.calls[0][0];
    expect(msg).toMatchObject({
      sessionId: "sess-1",
      action: "stop",
    });
    unmount();
  });

  it("broadcast is no-op when sessionId is undefined", () => {
    const onRunState = vi.fn();
    const { result, unmount } = renderHook(() => useSessionBroadcast(undefined, onRunState));

    act(() => {
      result.current("start");
    });

    expect(channelInstances).toHaveLength(0);
    unmount();
  });

  it("receiving 'start' broadcast triggers callback with true", () => {
    const onRunState = vi.fn();
    const { unmount } = renderHook(() => useSessionBroadcast("sess-1", onRunState));

    act(() => {
      channelInstances[0].onmessage?.({
        data: { sessionId: "sess-1", action: "start", timestamp: Date.now() },
      } as MessageEvent);
    });

    expect(onRunState).toHaveBeenCalledWith(true);
    unmount();
  });

  it("receiving 'stop' broadcast triggers callback with false", () => {
    const onRunState = vi.fn();
    const { unmount } = renderHook(() => useSessionBroadcast("sess-1", onRunState));

    act(() => {
      channelInstances[0].onmessage?.({
        data: { sessionId: "sess-1", action: "stop", timestamp: Date.now() },
      } as MessageEvent);
    });

    expect(onRunState).toHaveBeenCalledWith(false);
    unmount();
  });

  it("receiving broadcast for different sessionId does NOT trigger callback", () => {
    const onRunState = vi.fn();
    const { unmount } = renderHook(() => useSessionBroadcast("sess-1", onRunState));

    act(() => {
      channelInstances[0].onmessage?.({
        data: { sessionId: "sess-OTHER", action: "start", timestamp: Date.now() },
      } as MessageEvent);
    });

    expect(onRunState).not.toHaveBeenCalled();
    unmount();
  });

  it("closes channel on unmount", () => {
    const onRunState = vi.fn();
    const { unmount } = renderHook(() => useSessionBroadcast("sess-1", onRunState));

    expect(channelInstances[0].close).not.toHaveBeenCalled();
    unmount();
    expect(channelInstances[0].close).toHaveBeenCalledTimes(1);
  });

  it("recreates channel when sessionId changes", () => {
    const onRunState = vi.fn();
    const { rerender, unmount } = renderHook(
      ({ sid }) => useSessionBroadcast(sid, onRunState),
      { initialProps: { sid: "sess-1" } },
    );

    expect(channelInstances).toHaveLength(1);
    const firstChannel = channelInstances[0];

    rerender({ sid: "sess-2" });

    expect(firstChannel.close).toHaveBeenCalledTimes(1);
    expect(channelInstances).toHaveLength(2);
    unmount();
  });

  it("uses latest callback ref without re-creating channel", () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    const { rerender, unmount } = renderHook(
      ({ cb }) => useSessionBroadcast("sess-1", cb),
      { initialProps: { cb: cb1 } },
    );

    rerender({ cb: cb2 });
    expect(channelInstances).toHaveLength(1); // same channel

    act(() => {
      channelInstances[0].onmessage?.({
        data: { sessionId: "sess-1", action: "start", timestamp: Date.now() },
      } as MessageEvent);
    });

    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).toHaveBeenCalledWith(true);
    unmount();
  });

  it("gracefully degrades when BroadcastChannel throws", () => {
    Object.defineProperty(globalThis, "BroadcastChannel", {
      value: vi.fn(() => { throw new Error("Not supported"); }),
      writable: true,
      configurable: true,
    });

    const onRunState = vi.fn();
    const { result, unmount } = renderHook(() => useSessionBroadcast("sess-1", onRunState));

    // broadcast should not throw
    act(() => {
      result.current("start");
    });

    expect(onRunState).not.toHaveBeenCalled();
    unmount();
  });
});
