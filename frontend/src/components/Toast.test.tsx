import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { ToastProvider, useToast } from "./Toast";

// Test component that exposes showToast via a button
function ToastTrigger({ message = "Test toast", type }: { message?: string; type?: "success" | "error" | "info" }) {
  const { showToast } = useToast();
  return (
    <button onClick={() => showToast(message, type)} data-testid="trigger">
      Show Toast
    </button>
  );
}

describe("Toast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders toast when showToast is called inside ToastProvider", () => {
    render(
      <ToastProvider>
        <ToastTrigger message="Hello world" />
      </ToastProvider>,
    );

    // No toast initially
    expect(screen.queryByTestId("toast-item")).not.toBeInTheDocument();

    // Trigger toast
    fireEvent.click(screen.getByTestId("trigger"));

    // Toast should appear
    expect(screen.getByTestId("toast-item")).toBeInTheDocument();
    expect(screen.getByText("Hello world")).toBeInTheDocument();
  });

  it("showToast is a no-op outside ToastProvider", () => {
    render(<ToastTrigger message="Should not appear" />);

    // Click the trigger — should not throw
    fireEvent.click(screen.getByTestId("trigger"));

    // No toast container
    expect(screen.queryByTestId("toast-container")).not.toBeInTheDocument();
    expect(screen.queryByText("Should not appear")).not.toBeInTheDocument();
  });

  it("renders toast with correct role and aria-live", () => {
    render(
      <ToastProvider>
        <ToastTrigger />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByTestId("trigger"));

    const toast = screen.getByTestId("toast-item");
    expect(toast).toHaveAttribute("role", "status");
    expect(toast).toHaveAttribute("aria-live", "polite");
  });

  it("renders success toast with checkmark icon by default", () => {
    render(
      <ToastProvider>
        <ToastTrigger message="Success!" />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByTestId("trigger"));

    const toast = screen.getByTestId("toast-item");
    expect(toast).toHaveTextContent("\u2713"); // checkmark
    expect(toast).toHaveTextContent("Success!");
  });

  it("renders error toast with X icon", () => {
    render(
      <ToastProvider>
        <ToastTrigger message="Error!" type="error" />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByTestId("trigger"));

    const toast = screen.getByTestId("toast-item");
    expect(toast).toHaveTextContent("\u2717"); // X mark
    expect(toast).toHaveTextContent("Error!");
  });

  it("renders info toast with info icon", () => {
    render(
      <ToastProvider>
        <ToastTrigger message="Info!" type="info" />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByTestId("trigger"));

    const toast = screen.getByTestId("toast-item");
    expect(toast).toHaveTextContent("\u2139"); // info symbol
    expect(toast).toHaveTextContent("Info!");
  });

  it("auto-dismisses toast after TOAST_DURATION (3000ms)", () => {
    render(
      <ToastProvider>
        <ToastTrigger message="Temporary toast" />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByTestId("trigger"));
    expect(screen.getByText("Temporary toast")).toBeInTheDocument();

    // Advance past TOAST_DURATION (3000ms) — enters exit animation
    act(() => { vi.advanceTimersByTime(3000); });

    // Advance past exit animation duration (200ms)
    act(() => { vi.advanceTimersByTime(200); });

    // Toast should be removed
    expect(screen.queryByText("Temporary toast")).not.toBeInTheDocument();
  });

  it("stacks multiple toasts", () => {
    render(
      <ToastProvider>
        <ToastTrigger message="Toast 1" />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByTestId("trigger"));

    // Render a second trigger with different message
    const { unmount } = render(
      <ToastProvider>
        <ToastTrigger message="Toast 2" />
      </ToastProvider>,
    );

    // Actually, let's use a different approach — use a component that shows two toasts
    unmount();
  });

  it("multiple toasts render in the container", () => {
    // Component that shows two toasts sequentially
    function MultiToast() {
      const { showToast } = useToast();
      return (
        <button
          onClick={() => {
            showToast("First toast");
            showToast("Second toast");
          }}
          data-testid="multi-trigger"
        >
          Show Two
        </button>
      );
    }

    render(
      <ToastProvider>
        <MultiToast />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByTestId("multi-trigger"));

    const toasts = screen.getAllByTestId("toast-item");
    expect(toasts).toHaveLength(2);
    expect(screen.getByText("First toast")).toBeInTheDocument();
    expect(screen.getByText("Second toast")).toBeInTheDocument();
  });

  it("dismiss button removes toast", () => {
    render(
      <ToastProvider>
        <ToastTrigger message="Dismissable" />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByTestId("trigger"));
    expect(screen.getByText("Dismissable")).toBeInTheDocument();

    // Click dismiss button
    const dismissBtn = screen.getByLabelText("Dismiss");
    fireEvent.click(dismissBtn);

    // Advance past exit animation
    act(() => { vi.advanceTimersByTime(200); });

    expect(screen.queryByText("Dismissable")).not.toBeInTheDocument();
  });

  it("toast container has fixed positioning and high z-index", () => {
    render(
      <ToastProvider>
        <ToastTrigger />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByTestId("trigger"));

    const container = screen.getByTestId("toast-container");
    expect(container.className).toContain("fixed");
    expect(container.className).toContain("bottom-4");
    expect(container.className).toContain("right-4");
    expect(container.className).toContain("z-[9999]");
  });

  it("toast container is only rendered when toasts exist", () => {
    render(
      <ToastProvider>
        <ToastTrigger />
      </ToastProvider>,
    );

    // No container initially
    expect(screen.queryByTestId("toast-container")).not.toBeInTheDocument();

    // Show toast
    fireEvent.click(screen.getByTestId("trigger"));
    expect(screen.getByTestId("toast-container")).toBeInTheDocument();

    // Dismiss and wait for removal
    act(() => { vi.advanceTimersByTime(3200); });
    expect(screen.queryByTestId("toast-container")).not.toBeInTheDocument();
  });

  it("context value is stable across renders (memoized)", () => {
    const contextValues: ReturnType<typeof useToast>[] = [];

    function ContextSpy() {
      const ctx = useToast();
      contextValues.push(ctx);
      return null;
    }

    const { rerender } = render(
      <ToastProvider>
        <ContextSpy />
      </ToastProvider>,
    );

    // Re-render the provider
    rerender(
      <ToastProvider>
        <ContextSpy />
      </ToastProvider>,
    );

    // The showToast function reference should be the same across renders
    expect(contextValues.length).toBeGreaterThanOrEqual(2);
    expect(contextValues[0].showToast).toBe(contextValues[1].showToast);
  });
});
