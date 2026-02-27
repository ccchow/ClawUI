import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MarkdownEditor } from "./MarkdownEditor";

// Mock MarkdownContent since it's a dependency
vi.mock("./MarkdownContent", () => ({
  MarkdownContent: ({ content }: { content: string }) => (
    <div data-testid="markdown-preview">{content}</div>
  ),
}));

describe("MarkdownEditor", () => {
  it("renders Edit and Preview tabs", () => {
    render(<MarkdownEditor value="" onChange={vi.fn()} />);
    expect(screen.getByText("Edit")).toBeInTheDocument();
    expect(screen.getByText("Preview")).toBeInTheDocument();
  });

  it("renders Edit and Preview tabs with role=tab", () => {
    render(<MarkdownEditor value="" onChange={vi.fn()} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);
  });

  it("marks Edit tab as selected by default", () => {
    render(<MarkdownEditor value="" onChange={vi.fn()} />);
    const editTab = screen.getByRole("tab", { name: "Edit" });
    expect(editTab.getAttribute("aria-selected")).toBe("true");
  });

  it("marks Preview tab as not selected by default", () => {
    render(<MarkdownEditor value="" onChange={vi.fn()} />);
    const previewTab = screen.getByRole("tab", { name: "Preview" });
    expect(previewTab.getAttribute("aria-selected")).toBe("false");
  });

  it("renders textarea in edit mode", () => {
    render(<MarkdownEditor value="test" onChange={vi.fn()} />);
    const textarea = screen.getByRole("textbox");
    expect(textarea).toBeInTheDocument();
    expect(textarea).toHaveValue("test");
  });

  it("calls onChange when textarea value changes", () => {
    const onChange = vi.fn();
    render(<MarkdownEditor value="" onChange={onChange} />);
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "new text" } });
    expect(onChange).toHaveBeenCalledWith("new text");
  });

  it("switches to preview mode on Preview tab click", () => {
    render(<MarkdownEditor value="Hello **world**" onChange={vi.fn()} />);
    fireEvent.click(screen.getByText("Preview"));
    // Textarea should not be present
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    // MarkdownContent preview should appear
    expect(screen.getByTestId("markdown-preview")).toBeInTheDocument();
  });

  it("shows 'Nothing to preview' when value is empty in preview mode", () => {
    render(<MarkdownEditor value="" onChange={vi.fn()} />);
    fireEvent.click(screen.getByText("Preview"));
    expect(screen.getByText("Nothing to preview")).toBeInTheDocument();
  });

  it("shows 'Nothing to preview' when value is whitespace only in preview mode", () => {
    render(<MarkdownEditor value="   " onChange={vi.fn()} />);
    fireEvent.click(screen.getByText("Preview"));
    expect(screen.getByText("Nothing to preview")).toBeInTheDocument();
  });

  it("renders markdown content in preview mode", () => {
    render(<MarkdownEditor value="Some markdown content" onChange={vi.fn()} />);
    fireEvent.click(screen.getByText("Preview"));
    expect(screen.getByText("Some markdown content")).toBeInTheDocument();
  });

  it("switches back to edit mode on Edit tab click", () => {
    render(<MarkdownEditor value="test" onChange={vi.fn()} />);
    fireEvent.click(screen.getByText("Preview"));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Edit"));
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("renders with custom placeholder", () => {
    render(<MarkdownEditor value="" onChange={vi.fn()} placeholder="Custom placeholder" />);
    expect(screen.getByPlaceholderText("Custom placeholder")).toBeInTheDocument();
  });

  it("renders default placeholder when not specified", () => {
    render(<MarkdownEditor value="" onChange={vi.fn()} />);
    expect(
      screen.getByPlaceholderText("Description (supports Markdown and image paste)"),
    ).toBeInTheDocument();
  });

  it("disables textarea when disabled prop is true", () => {
    render(<MarkdownEditor value="" onChange={vi.fn()} disabled={true} />);
    expect(screen.getByRole("textbox")).toBeDisabled();
  });

  it("textarea has aria-label matching placeholder", () => {
    render(<MarkdownEditor value="" onChange={vi.fn()} placeholder="Enter description" />);
    expect(screen.getByLabelText("Enter description")).toBeInTheDocument();
  });

  it("renders actions slot when provided", () => {
    render(
      <MarkdownEditor
        value=""
        onChange={vi.fn()}
        actions={<button>Save</button>}
      />,
    );
    expect(screen.getByText("Save")).toBeInTheDocument();
  });

  it("renders tablist role on tab container", () => {
    render(<MarkdownEditor value="" onChange={vi.fn()} />);
    expect(screen.getByRole("tablist")).toBeInTheDocument();
  });

  it("stops click propagation on the container", () => {
    const outerClickHandler = vi.fn();
    render(
      <div onClick={outerClickHandler}>
        <MarkdownEditor value="" onChange={vi.fn()} />
      </div>,
    );
    const editor = screen.getByRole("textbox").closest("div[class]")!;
    fireEvent.click(editor);
    // stopPropagation means the outer handler should NOT be called
    expect(outerClickHandler).not.toHaveBeenCalled();
  });

  it("applies custom className", () => {
    const { container } = render(
      <MarkdownEditor value="" onChange={vi.fn()} className="custom-class" />,
    );
    // The root div should have the custom class
    const rootDiv = container.firstChild as HTMLElement;
    expect(rootDiv.className).toContain("custom-class");
  });

  it("applies disabled styling when disabled", () => {
    render(<MarkdownEditor value="" onChange={vi.fn()} disabled={true} />);
    const textarea = screen.getByRole("textbox");
    expect(textarea.className).toContain("opacity-60");
    expect(textarea.className).toContain("cursor-not-allowed");
  });
});
