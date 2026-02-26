import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PromptInput } from "./PromptInput";

describe("PromptInput", () => {
  it("renders input and submit button", () => {
    render(<PromptInput disabled={false} loading={false} onSubmit={vi.fn()} />);
    expect(screen.getByPlaceholderText(/enter a custom prompt/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run" })).toBeInTheDocument();
  });

  it("submits trimmed value on form submit", () => {
    const onSubmit = vi.fn();
    render(<PromptInput disabled={false} loading={false} onSubmit={onSubmit} />);

    const input = screen.getByPlaceholderText(/enter a custom prompt/i);
    fireEvent.change(input, { target: { value: "  fix the bug  " } });
    fireEvent.submit(input.closest("form")!);

    expect(onSubmit).toHaveBeenCalledWith("fix the bug");
  });

  it("clears input after submit", () => {
    const onSubmit = vi.fn();
    render(<PromptInput disabled={false} loading={false} onSubmit={onSubmit} />);

    const input = screen.getByPlaceholderText(/enter a custom prompt/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "fix bug" } });
    fireEvent.submit(input.closest("form")!);

    expect(input.value).toBe("");
  });

  it("does not submit empty input", () => {
    const onSubmit = vi.fn();
    render(<PromptInput disabled={false} loading={false} onSubmit={onSubmit} />);

    const input = screen.getByPlaceholderText(/enter a custom prompt/i);
    fireEvent.submit(input.closest("form")!);

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not submit whitespace-only input", () => {
    const onSubmit = vi.fn();
    render(<PromptInput disabled={false} loading={false} onSubmit={onSubmit} />);

    const input = screen.getByPlaceholderText(/enter a custom prompt/i);
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.submit(input.closest("form")!);

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("disables input when disabled prop is true", () => {
    render(<PromptInput disabled={true} loading={false} onSubmit={vi.fn()} />);
    expect(screen.getByPlaceholderText(/enter a custom prompt/i)).toBeDisabled();
  });

  it("disables submit button when disabled", () => {
    render(<PromptInput disabled={true} loading={false} onSubmit={vi.fn()} />);
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("disables submit button when input is empty", () => {
    render(<PromptInput disabled={false} loading={false} onSubmit={vi.fn()} />);
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("shows 'Running...' text when loading", () => {
    render(<PromptInput disabled={false} loading={true} onSubmit={vi.fn()} />);
    expect(screen.getByText("Running...")).toBeInTheDocument();
  });

  it("shows 'Run' text when not loading", () => {
    render(<PromptInput disabled={false} loading={false} onSubmit={vi.fn()} />);
    expect(screen.getByText("Run")).toBeInTheDocument();
  });

  it("does not submit when disabled even with value", () => {
    const onSubmit = vi.fn();
    render(<PromptInput disabled={true} loading={false} onSubmit={onSubmit} />);

    const input = screen.getByPlaceholderText(/enter a custom prompt/i);
    fireEvent.change(input, { target: { value: "test" } });
    fireEvent.submit(input.closest("form")!);

    expect(onSubmit).not.toHaveBeenCalled();
  });
});
