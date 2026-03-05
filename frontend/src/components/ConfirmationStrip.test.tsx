import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ConfirmationStrip } from "./ConfirmationStrip";

describe("ConfirmationStrip", () => {
  it("renders confirm label and default button texts", () => {
    render(
      <ConfirmationStrip
        confirmLabel="Delete this?"
        variant="red"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText("Delete this?")).toBeInTheDocument();
    expect(screen.getByText("Yes")).toBeInTheDocument();
    expect(screen.getByText("No")).toBeInTheDocument();
  });

  it("calls onConfirm when Yes is clicked", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmationStrip
        confirmLabel="Proceed?"
        variant="amber"
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("Yes"));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("calls onCancel when No is clicked", () => {
    const onCancel = vi.fn();
    render(
      <ConfirmationStrip
        confirmLabel="Proceed?"
        variant="amber"
        onConfirm={() => {}}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByText("No"));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("supports custom button texts", () => {
    render(
      <ConfirmationStrip
        confirmLabel="Unqueue?"
        variant="amber"
        onConfirm={() => {}}
        onCancel={() => {}}
        confirmText="Confirm"
        cancelText="Cancel"
      />,
    );
    expect(screen.getByText("Confirm")).toBeInTheDocument();
    expect(screen.getByText("Cancel")).toBeInTheDocument();
  });

  it("disables confirm button when disabled prop is true", () => {
    render(
      <ConfirmationStrip
        confirmLabel="Reset?"
        variant="blue"
        onConfirm={() => {}}
        onCancel={() => {}}
        disabled
      />,
    );
    expect(screen.getByText("Yes")).toBeDisabled();
  });

  it("renders as span when inline is true", () => {
    const { container } = render(
      <ConfirmationStrip
        confirmLabel="Reopen?"
        variant="blue"
        onConfirm={() => {}}
        onCancel={() => {}}
        inline
      />,
    );
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.tagName).toBe("SPAN");
  });

  it("renders as div when inline is false", () => {
    const { container } = render(
      <ConfirmationStrip
        confirmLabel="Run all?"
        variant="green"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.tagName).toBe("DIV");
  });

  it("stops click propagation when stopPropagation is true", () => {
    const outerClick = vi.fn();
    render(
      // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
      <div onClick={outerClick}>
        <ConfirmationStrip
          confirmLabel="Reset?"
          variant="amber"
          onConfirm={() => {}}
          onCancel={() => {}}
          stopPropagation
        />
      </div>,
    );
    fireEvent.click(screen.getByText("Reset?"));
    expect(outerClick).not.toHaveBeenCalled();
  });

  it("applies correct variant classes for each color", () => {
    const variants = ["amber", "red", "blue", "purple", "green"] as const;
    const expectedColors = {
      amber: "accent-amber",
      red: "accent-red",
      blue: "accent-blue",
      purple: "accent-purple",
      green: "accent-green",
    };

    for (const variant of variants) {
      const { container, unmount } = render(
        <ConfirmationStrip
          confirmLabel={`Test ${variant}`}
          variant={variant}
          onConfirm={() => {}}
          onCancel={() => {}}
        />,
      );
      const wrapper = container.firstChild as HTMLElement;
      expect(wrapper.className).toContain(expectedColors[variant]);
      unmount();
    }
  });

  it("has animate-fade-in class for entrance animation", () => {
    const { container } = render(
      <ConfirmationStrip
        confirmLabel="Test"
        variant="amber"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.className).toContain("animate-fade-in");
  });

  it("calls onCancel when Escape key is pressed", () => {
    const onCancel = vi.fn();
    render(
      <ConfirmationStrip
        confirmLabel="Delete?"
        variant="red"
        onConfirm={() => {}}
        onCancel={onCancel}
      />,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("does not call onCancel for non-Escape keys", () => {
    const onCancel = vi.fn();
    render(
      <ConfirmationStrip
        confirmLabel="Delete?"
        variant="red"
        onConfirm={() => {}}
        onCancel={onCancel}
      />,
    );
    fireEvent.keyDown(document, { key: "Enter" });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("auto-focuses the confirm button on mount", () => {
    render(
      <ConfirmationStrip
        confirmLabel="Proceed?"
        variant="green"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(document.activeElement).toBe(screen.getByText("Yes"));
  });

  it("returns focus to trigger element on cancel click", () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Trigger";
    document.body.appendChild(trigger);
    trigger.focus();

    const onCancel = vi.fn();
    render(
      <ConfirmationStrip
        confirmLabel="Confirm?"
        variant="amber"
        onConfirm={() => {}}
        onCancel={onCancel}
      />,
    );
    // Confirm button has focus now
    expect(document.activeElement).toBe(screen.getByText("Yes"));

    // Click cancel
    fireEvent.click(screen.getByText("No"));
    expect(document.activeElement).toBe(trigger);
    expect(onCancel).toHaveBeenCalledOnce();

    document.body.removeChild(trigger);
  });

  it("returns focus to trigger element on Escape", () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Trigger";
    document.body.appendChild(trigger);
    trigger.focus();

    const onCancel = vi.fn();
    render(
      <ConfirmationStrip
        confirmLabel="Confirm?"
        variant="blue"
        onConfirm={() => {}}
        onCancel={onCancel}
      />,
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.activeElement).toBe(trigger);
    expect(onCancel).toHaveBeenCalledOnce();

    document.body.removeChild(trigger);
  });

  it("cleans up Escape listener on unmount", () => {
    const onCancel = vi.fn();
    const { unmount } = render(
      <ConfirmationStrip
        confirmLabel="Test"
        variant="amber"
        onConfirm={() => {}}
        onCancel={onCancel}
      />,
    );
    unmount();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
  });
});
