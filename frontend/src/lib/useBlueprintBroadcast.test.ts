import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useBlueprintBroadcast, type BroadcastOpType } from "./useBlueprintBroadcast";

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

  // Use a real class so `new BroadcastChannel(name)` works correctly
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

describe("useBlueprintBroadcast", () => {
  it("creates a BroadcastChannel with the correct name", () => {
    const onOp = vi.fn();
    const { unmount } = renderHook(() => useBlueprintBroadcast("bp-1", onOp));

    expect(channelInstances).toHaveLength(1);
    expect(channelInstances[0].name).toBe("clawui-blueprint-ops");
    unmount();
  });

  it("does not create a channel when blueprintId is undefined", () => {
    const onOp = vi.fn();
    const { unmount } = renderHook(() => useBlueprintBroadcast(undefined, onOp));

    expect(channelInstances).toHaveLength(0);
    unmount();
  });

  it("broadcastOperation posts message with correct shape", () => {
    const onOp = vi.fn();
    const { result, unmount } = renderHook(() => useBlueprintBroadcast("bp-1", onOp));

    act(() => {
      result.current("run", "node-1");
    });

    expect(channelInstances[0].postMessage).toHaveBeenCalledTimes(1);
    const msg = channelInstances[0].postMessage.mock.calls[0][0];
    expect(msg).toMatchObject({
      blueprintId: "bp-1",
      nodeId: "node-1",
      type: "run",
    });
    expect(typeof msg.timestamp).toBe("number");
    unmount();
  });

  it("broadcastOperation without nodeId omits it", () => {
    const onOp = vi.fn();
    const { result, unmount } = renderHook(() => useBlueprintBroadcast("bp-1", onOp));

    act(() => {
      result.current("generate");
    });

    const msg = channelInstances[0].postMessage.mock.calls[0][0];
    expect(msg.blueprintId).toBe("bp-1");
    expect(msg.type).toBe("generate");
    expect(msg.nodeId).toBeUndefined();
    unmount();
  });

  it("broadcastOperation is no-op when blueprintId is undefined", () => {
    const onOp = vi.fn();
    const { result, unmount } = renderHook(() => useBlueprintBroadcast(undefined, onOp));

    act(() => {
      result.current("run", "node-1");
    });

    // No channel was created, so nothing to assert on postMessage
    expect(channelInstances).toHaveLength(0);
    unmount();
  });

  it("receiving a broadcast for same blueprintId triggers onOperationDetected", () => {
    const onOp = vi.fn();
    const { unmount } = renderHook(() => useBlueprintBroadcast("bp-1", onOp));

    // Simulate incoming message from another tab
    act(() => {
      channelInstances[0].onmessage?.({
        data: { blueprintId: "bp-1", type: "enrich", nodeId: "n1", timestamp: Date.now() },
      } as MessageEvent);
    });

    expect(onOp).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("receiving a broadcast for different blueprintId does NOT trigger callback", () => {
    const onOp = vi.fn();
    const { unmount } = renderHook(() => useBlueprintBroadcast("bp-1", onOp));

    act(() => {
      channelInstances[0].onmessage?.({
        data: { blueprintId: "bp-OTHER", type: "run", timestamp: Date.now() },
      } as MessageEvent);
    });

    expect(onOp).not.toHaveBeenCalled();
    unmount();
  });

  it("handles all operation types", () => {
    const onOp = vi.fn();
    const { result, unmount } = renderHook(() => useBlueprintBroadcast("bp-1", onOp));

    const allTypes: BroadcastOpType[] = [
      "run", "enrich", "reevaluate", "split", "smart_deps",
      "generate", "run_all", "reevaluate_all", "resume", "coordinate",
    ];

    for (const type of allTypes) {
      act(() => {
        result.current(type, "node-x");
      });
    }

    expect(channelInstances[0].postMessage).toHaveBeenCalledTimes(allTypes.length);

    // Verify each call has the correct type
    for (let i = 0; i < allTypes.length; i++) {
      expect(channelInstances[0].postMessage.mock.calls[i][0].type).toBe(allTypes[i]);
    }
    unmount();
  });

  it("closes channel on unmount", () => {
    const onOp = vi.fn();
    const { unmount } = renderHook(() => useBlueprintBroadcast("bp-1", onOp));

    expect(channelInstances[0].close).not.toHaveBeenCalled();
    unmount();
    expect(channelInstances[0].close).toHaveBeenCalledTimes(1);
  });

  it("recreates channel when blueprintId changes", () => {
    const onOp = vi.fn();
    const { rerender, unmount } = renderHook(
      ({ bpId }) => useBlueprintBroadcast(bpId, onOp),
      { initialProps: { bpId: "bp-1" } },
    );

    expect(channelInstances).toHaveLength(1);
    const firstChannel = channelInstances[0];

    rerender({ bpId: "bp-2" });

    // Old channel closed, new one created
    expect(firstChannel.close).toHaveBeenCalledTimes(1);
    expect(channelInstances).toHaveLength(2);
    expect(channelInstances[1].name).toBe("clawui-blueprint-ops");
    unmount();
  });

  it("uses latest callback ref without re-creating channel", () => {
    const onOp1 = vi.fn();
    const onOp2 = vi.fn();
    const { rerender, unmount } = renderHook(
      ({ cb }) => useBlueprintBroadcast("bp-1", cb),
      { initialProps: { cb: onOp1 } },
    );

    // Re-render with new callback — channel should NOT be recreated
    rerender({ cb: onOp2 });
    expect(channelInstances).toHaveLength(1); // still same channel

    // Incoming message should call the NEW callback
    act(() => {
      channelInstances[0].onmessage?.({
        data: { blueprintId: "bp-1", type: "run", timestamp: Date.now() },
      } as MessageEvent);
    });

    expect(onOp1).not.toHaveBeenCalled();
    expect(onOp2).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("gracefully degrades when BroadcastChannel throws", () => {
    // Replace with a throwing constructor
    Object.defineProperty(globalThis, "BroadcastChannel", {
      value: vi.fn(() => { throw new Error("Not supported"); }),
      writable: true,
      configurable: true,
    });

    const onOp = vi.fn();
    const { result, unmount } = renderHook(() => useBlueprintBroadcast("bp-1", onOp));

    // broadcast should not throw
    act(() => {
      result.current("run", "node-1");
    });

    // No error thrown — graceful degradation
    expect(onOp).not.toHaveBeenCalled();
    unmount();
  });
});
