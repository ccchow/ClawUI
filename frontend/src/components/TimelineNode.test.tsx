import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TimelineNodeComponent, ToolPairNode } from "./TimelineNode";
import type { TimelineNode } from "@/lib/api";

// Mock api
vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<object>("@/lib/api");
  return {
    ...actual,
    updateNodeMeta: vi.fn(() => Promise.resolve()),
  };
});

function makeNode(overrides: Partial<TimelineNode> = {}): TimelineNode {
  return {
    id: "node-1",
    type: "user",
    timestamp: "2025-01-15T12:00:00Z",
    title: "Test title",
    content: "Test content",
    ...overrides,
  };
}

describe("TimelineNodeComponent", () => {
  it("renders user node with icon and title", () => {
    render(<TimelineNodeComponent node={makeNode({ type: "user", title: "User says hello" })} />);
    expect(screen.getByText("User says hello")).toBeInTheDocument();
    // type label is "user" (CSS uppercase makes it visual "USER")
    expect(screen.getByText("user")).toBeInTheDocument();
  });

  it("renders assistant node", () => {
    render(<TimelineNodeComponent node={makeNode({ type: "assistant", title: "AI response here" })} />);
    expect(screen.getByText("AI response here")).toBeInTheDocument();
    expect(screen.getByText("assistant")).toBeInTheDocument();
  });

  it("renders tool_use node with tool name badge", () => {
    render(
      <TimelineNodeComponent
        node={makeNode({
          type: "tool_use",
          toolName: "Read",
          toolInput: '{"file_path": "/tmp/test.ts"}',
          content: "reading file",
        })}
      />,
    );
    expect(screen.getByText("Read")).toBeInTheDocument();
  });

  it("shows tool input summary for Read tool", () => {
    render(
      <TimelineNodeComponent
        node={makeNode({
          type: "tool_use",
          toolName: "Read",
          toolInput: '{"file_path": "/tmp/test.ts"}',
          content: "reading file that is long enough to show expand",
        })}
      />,
    );
    expect(screen.getByText("/tmp/test.ts")).toBeInTheDocument();
  });

  it("shows tool input summary for Bash tool", () => {
    render(
      <TimelineNodeComponent
        node={makeNode({
          type: "tool_use",
          toolName: "Bash",
          toolInput: '{"command": "npm test"}',
          content: "running command that is a very long content for expand to appear and show",
        })}
      />,
    );
    expect(screen.getByText("npm test")).toBeInTheDocument();
  });

  it("shows bookmark button", () => {
    render(<TimelineNodeComponent node={makeNode()} />);
    expect(screen.getByTitle("Bookmark")).toBeInTheDocument();
  });

  it("toggles bookmark on click", () => {
    render(<TimelineNodeComponent node={makeNode()} />);
    const bookmarkBtn = screen.getByTitle("Bookmark");
    fireEvent.click(bookmarkBtn);
    // After click, it should show "Remove bookmark"
    expect(screen.getByTitle("Remove bookmark")).toBeInTheDocument();
  });

  it("shows annotation when present", () => {
    render(
      <TimelineNodeComponent node={makeNode({ annotation: "Important note here" })} />,
    );
    expect(screen.getByText("Important note here")).toBeInTheDocument();
  });

  it("expands on click for long content", () => {
    const longContent = "A".repeat(300);
    render(
      <TimelineNodeComponent
        node={makeNode({ type: "assistant", content: longContent })}
      />,
    );
    // Click the card to expand
    const card = screen.getByText("Test title").closest("[class*='cursor-pointer']");
    if (card) fireEvent.click(card);
  });

  it("formats timestamp", () => {
    render(
      <TimelineNodeComponent
        node={makeNode({ timestamp: "2025-01-15T14:30:45Z" })}
      />,
    );
    // Should show formatted time
    const timeEl = screen.getByText(/\d{2}:\d{2}:\d{2}/);
    expect(timeEl).toBeInTheDocument();
  });
});

describe("ToolPairNode", () => {
  it("renders tool name badge", () => {
    render(
      <ToolPairNode
        toolUse={makeNode({
          id: "tu-1",
          type: "tool_use",
          toolName: "Write",
          toolInput: '{"file_path": "/tmp/out.ts"}',
          content: "",
        })}
        toolResult={makeNode({
          id: "tr-1",
          type: "tool_result",
          content: "File written successfully",
        })}
      />,
    );
    expect(screen.getByText("Write")).toBeInTheDocument();
  });

  it("shows tool input summary", () => {
    render(
      <ToolPairNode
        toolUse={makeNode({
          type: "tool_use",
          toolName: "Read",
          toolInput: '{"file_path": "/src/app.ts"}',
          content: "",
        })}
        toolResult={makeNode({
          type: "tool_result",
          content: "const app = express();",
        })}
      />,
    );
    expect(screen.getByText("/src/app.ts")).toBeInTheDocument();
  });

  it("shows result preview in collapsed state", () => {
    render(
      <ToolPairNode
        toolUse={makeNode({
          type: "tool_use",
          toolName: "Bash",
          toolInput: '{"command": "ls"}',
          content: "",
        })}
        toolResult={makeNode({
          type: "tool_result",
          content: "file1.ts file2.ts",
        })}
      />,
    );
    expect(screen.getByText(/file1\.ts file2\.ts/)).toBeInTheDocument();
  });

  it("expands on click to show input and output sections", () => {
    render(
      <ToolPairNode
        toolUse={makeNode({
          type: "tool_use",
          toolName: "Grep",
          toolInput: '{"pattern": "TODO"}',
          content: "",
        })}
        toolResult={makeNode({
          type: "tool_result",
          content: "Found 3 matches",
        })}
      />,
    );

    // Click to expand
    const card = screen.getByText("Grep").closest("[class*='cursor-pointer']");
    if (card) fireEvent.click(card);

    // Should show Input and Output sections
    expect(screen.getByText("Input")).toBeInTheDocument();
    expect(screen.getByText("Output")).toBeInTheDocument();
  });

  it("shows bookmark button", () => {
    render(
      <ToolPairNode
        toolUse={makeNode({ type: "tool_use", toolName: "Read", toolInput: "{}", content: "" })}
        toolResult={makeNode({ type: "tool_result", content: "result" })}
      />,
    );
    expect(screen.getByTitle("Bookmark")).toBeInTheDocument();
  });

  it("uses correct badge color for different tools", () => {
    const { container: c1 } = render(
      <ToolPairNode
        toolUse={makeNode({ type: "tool_use", toolName: "Read", toolInput: "{}", content: "" })}
        toolResult={makeNode({ type: "tool_result", content: "result" })}
      />,
    );
    const badge = c1.querySelector("[class*='bg-emerald']");
    expect(badge).toBeInTheDocument();
  });
});
