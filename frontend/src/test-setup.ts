import "@testing-library/jest-dom";

// --- BroadcastChannel mock (not available in jsdom) ---

class MockBroadcastChannel {
  name: string;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  constructor(name: string) {
    this.name = name;
  }
  postMessage() {}
  close() {}
  addEventListener() {}
  removeEventListener() {}
  dispatchEvent() {
    return true;
  }
}

Object.defineProperty(globalThis, "BroadcastChannel", {
  value: MockBroadcastChannel,
  writable: true,
});
