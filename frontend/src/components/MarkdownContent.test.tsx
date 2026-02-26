import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MarkdownContent } from "./MarkdownContent";

describe("MarkdownContent", () => {
  it("renders plain text as paragraph", () => {
    render(<MarkdownContent content="Hello world" />);
    expect(screen.getByText("Hello world")).toBeInTheDocument();
  });

  it("renders h1 heading", () => {
    const { container } = render(<MarkdownContent content="# Hello Heading" />);
    const h1 = container.querySelector("h1");
    expect(h1).toBeInTheDocument();
    expect(h1?.textContent).toBe("Hello Heading");
  });

  it("renders h2 heading", () => {
    const { container } = render(<MarkdownContent content="## Sub Heading" />);
    const h2 = container.querySelector("h2");
    expect(h2).toBeInTheDocument();
    expect(h2?.textContent).toBe("Sub Heading");
  });

  it("renders h3 heading", () => {
    const { container } = render(<MarkdownContent content="### Third Level" />);
    const h3 = container.querySelector("h3");
    expect(h3).toBeInTheDocument();
    expect(h3?.textContent).toBe("Third Level");
  });

  it("renders multiple headings", () => {
    const content = ["# H1", "## H2", "### H3"].join("\n");
    const { container } = render(<MarkdownContent content={content} />);
    expect(container.querySelector("h1")).toBeInTheDocument();
    expect(container.querySelector("h2")).toBeInTheDocument();
    expect(container.querySelector("h3")).toBeInTheDocument();
  });

  it("renders bold text", () => {
    render(<MarkdownContent content="This is **bold** text" />);
    const bold = screen.getByText("bold");
    expect(bold.tagName).toBe("STRONG");
  });

  it("renders italic text", () => {
    render(<MarkdownContent content="This is *italic* text" />);
    const italic = screen.getByText("italic");
    expect(italic.tagName).toBe("EM");
  });

  it("renders inline code", () => {
    render(<MarkdownContent content="Use `console.log` for debugging" />);
    const code = screen.getByText("console.log");
    expect(code.tagName).toBe("CODE");
  });

  it("renders links with safe href", () => {
    render(<MarkdownContent content="Visit [Google](https://google.com)" />);
    const link = screen.getByText("Google") as HTMLAnchorElement;
    expect(link.tagName).toBe("A");
    expect(link.href).toBe("https://google.com/");
    expect(link.target).toBe("_blank");
    expect(link.rel).toContain("noopener");
  });

  it("sanitizes unsafe link URLs", () => {
    render(<MarkdownContent content="Click [here](javascript:alert(1))" />);
    const link = screen.getByText("here") as HTMLAnchorElement;
    expect(link.href).toContain("#");
    expect(link.href).not.toContain("javascript");
  });

  it("renders code blocks", () => {
    const content = ["```js", "const x = 1;", "```"].join("\n");
    render(<MarkdownContent content={content} />);
    expect(screen.getByText("const x = 1;")).toBeInTheDocument();
    expect(screen.getByText("js")).toBeInTheDocument();
  });

  it("renders unordered lists", () => {
    const content = ["- Item 1", "- Item 2", "- Item 3"].join("\n");
    const { container } = render(<MarkdownContent content={content} />);
    const listItems = container.querySelectorAll("li");
    expect(listItems).toHaveLength(3);
    expect(listItems[0].textContent).toBe("Item 1");
    expect(listItems[1].textContent).toBe("Item 2");
    expect(listItems[2].textContent).toBe("Item 3");
    expect(container.querySelector("ul")).toBeInTheDocument();
  });

  it("renders ordered lists", () => {
    const content = ["1. First", "2. Second", "3. Third"].join("\n");
    const { container } = render(<MarkdownContent content={content} />);
    const listItems = container.querySelectorAll("li");
    expect(listItems).toHaveLength(3);
    expect(listItems[0].textContent).toBe("First");
    expect(container.querySelector("ol")).toBeInTheDocument();
  });

  it("handles empty content", () => {
    const { container } = render(<MarkdownContent content="" />);
    // Empty content returns null — no wrapper div
    expect(container.firstChild).toBeNull();
  });

  it("renders multiple paragraphs", () => {
    const content = ["First paragraph", "", "Second paragraph"].join("\n");
    const { container } = render(<MarkdownContent content={content} />);
    const paragraphs = container.querySelectorAll("p");
    expect(paragraphs.length).toBeGreaterThanOrEqual(2);
    const texts = Array.from(paragraphs).map((p) => p.textContent);
    expect(texts).toContain("First paragraph");
    expect(texts).toContain("Second paragraph");
  });

  it("renders code block with copy button", () => {
    const content = ["```", "some code", "```"].join("\n");
    render(<MarkdownContent content={content} />);
    expect(screen.getByTitle("Copy to clipboard")).toBeInTheDocument();
  });

  it("renders blockquotes", () => {
    const { container } = render(<MarkdownContent content="> This is a quote" />);
    const bq = container.querySelector("blockquote");
    expect(bq).toBeInTheDocument();
    expect(bq?.textContent).toBe("This is a quote");
  });

  it("renders horizontal rules", () => {
    const content = ["Above", "---", "Below"].join("\n");
    const { container } = render(<MarkdownContent content={content} />);
    expect(container.querySelector("hr")).toBeInTheDocument();
  });

  it("renders strikethrough text", () => {
    render(<MarkdownContent content="This is ~~deleted~~ text" />);
    const del = screen.getByText("deleted");
    expect(del.tagName).toBe("DEL");
  });

  it("renders with maxHeight prop", () => {
    const { container } = render(
      <MarkdownContent content="Hello" maxHeight="200px" />
    );
    const div = container.firstChild as HTMLElement;
    expect(div.style.maxHeight).toBe("200px");
  });

  it("renders with maxHeight=none", () => {
    const { container } = render(
      <MarkdownContent content="Hello" maxHeight="none" />
    );
    const div = container.firstChild as HTMLElement;
    expect(div.style.maxHeight).toBe("");
  });

  it("copy button has aria-label", () => {
    const content = ["```", "code", "```"].join("\n");
    render(<MarkdownContent content={content} />);
    expect(screen.getByLabelText("Copy to clipboard")).toBeInTheDocument();
  });
});
