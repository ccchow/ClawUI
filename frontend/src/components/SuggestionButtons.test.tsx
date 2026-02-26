import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SuggestionButtons } from "./SuggestionButtons";
import type { Suggestion } from "@/lib/api";

const mockSuggestions: Suggestion[] = [
  { title: "Fix bug", description: "Fix the login bug", prompt: "fix the login bug" },
  { title: "Add tests", description: "Add unit tests for auth", prompt: "add unit tests" },
  { title: "Refactor", description: "Refactor the module", prompt: "refactor module" },
];

describe("SuggestionButtons", () => {
  it("renders suggestion chips with title and description", () => {
    render(
      <SuggestionButtons suggestions={mockSuggestions} disabled={false} onSelect={vi.fn()} />,
    );
    expect(screen.getByText("Fix bug")).toBeInTheDocument();
    expect(screen.getByText("Fix the login bug")).toBeInTheDocument();
    expect(screen.getByText("Add tests")).toBeInTheDocument();
    expect(screen.getByText("Refactor")).toBeInTheDocument();
  });

  it("shows 'Suggested next steps' label", () => {
    render(
      <SuggestionButtons suggestions={mockSuggestions} disabled={false} onSelect={vi.fn()} />,
    );
    expect(screen.getByText("Suggested next steps")).toBeInTheDocument();
  });

  it("calls onSelect with the prompt when a suggestion is clicked", () => {
    const onSelect = vi.fn();
    render(
      <SuggestionButtons suggestions={mockSuggestions} disabled={false} onSelect={onSelect} />,
    );

    fireEvent.click(screen.getByText("Fix bug"));
    expect(onSelect).toHaveBeenCalledWith("fix the login bug");
  });

  it("renders empty placeholder when no suggestions", () => {
    const { container } = render(
      <SuggestionButtons suggestions={[]} disabled={false} onSelect={vi.fn()} />,
    );
    // Should render empty div with min-height
    const placeholder = container.firstChild as HTMLElement;
    expect(placeholder.className).toContain("min-h-");
    expect(screen.queryByText("Suggested next steps")).not.toBeInTheDocument();
  });

  it("disables buttons when disabled prop is true", () => {
    render(
      <SuggestionButtons suggestions={mockSuggestions} disabled={true} onSelect={vi.fn()} />,
    );
    const buttons = screen.getAllByRole("button");
    buttons.forEach((btn) => expect(btn).toBeDisabled());
  });

  it("does not call onSelect when disabled", () => {
    const onSelect = vi.fn();
    render(
      <SuggestionButtons suggestions={mockSuggestions} disabled={true} onSelect={onSelect} />,
    );

    fireEvent.click(screen.getByText("Fix bug"));
    expect(onSelect).not.toHaveBeenCalled();
  });
});
