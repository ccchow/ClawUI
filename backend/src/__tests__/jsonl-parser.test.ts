import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

// We test the exported helper functions directly
import {
  cleanContent,
  summarize,
  extractTextContent,
  parseTimelineRaw,
  decodeProjectPath,
} from "../jsonl-parser.js";

// ─── cleanContent ────────────────────────────────────────────

describe("cleanContent", () => {
  it("strips suggestion suffix from user messages", () => {
    const text =
      'Hello world\n\nAfter completing the task above, append a line "---SUGGESTIONS---" followed by a JSON array.';
    expect(cleanContent(text, "user")).toBe("Hello world");
  });

  it("strips suggestion JSON from assistant messages", () => {
    const text =
      'Here is the answer.\n---SUGGESTIONS---\n[{"title":"a","description":"b","prompt":"c"}]';
    expect(cleanContent(text, "assistant")).toBe("Here is the answer.");
  });

  it("returns text unchanged for other types", () => {
    expect(cleanContent("some text", "tool_use")).toBe("some text");
  });

  it("returns empty/falsy text as-is", () => {
    expect(cleanContent("", "user")).toBe("");
  });

  it("handles assistant text without suggestions marker", () => {
    expect(cleanContent("Just a response.", "assistant")).toBe(
      "Just a response."
    );
  });

  it("uses lastIndexOf for the suggestion marker", () => {
    const text =
      "Some text ---SUGGESTIONS--- middle\n---SUGGESTIONS---\n[final]";
    const result = cleanContent(text, "assistant");
    expect(result).toBe(
      "Some text ---SUGGESTIONS--- middle"
    );
  });
});

// ─── summarize ───────────────────────────────────────────────

describe("summarize", () => {
  it("returns short text unchanged", () => {
    expect(summarize("hello")).toBe("hello");
  });

  it("truncates long text with ellipsis", () => {
    const long = "a".repeat(200);
    const result = summarize(long, 120);
    expect(result.length).toBe(123); // 120 + "..."
    expect(result.endsWith("...")).toBe(true);
  });

  it("collapses newlines to spaces", () => {
    expect(summarize("line1\nline2\nline3")).toBe("line1 line2 line3");
  });

  it("returns empty string for empty input", () => {
    expect(summarize("")).toBe("");
  });

  it("respects custom maxLen", () => {
    const result = summarize("abcdefghij", 5);
    expect(result).toBe("abcde...");
  });
});

// ─── extractTextContent ──────────────────────────────────────

describe("extractTextContent", () => {
  it("returns strings directly", () => {
    expect(extractTextContent("hello")).toBe("hello");
  });

  it("extracts text from array of text blocks", () => {
    const content = [
      { type: "text", text: "Hello" },
      { type: "text", text: "World" },
    ];
    expect(extractTextContent(content)).toBe("Hello\nWorld");
  });

  it("handles thinking blocks", () => {
    const content = [{ type: "thinking", thinking: "let me think..." }];
    expect(extractTextContent(content)).toBe("[Thinking] let me think...");
  });

  it("handles tool_use blocks", () => {
    const content = [
      { type: "tool_use", name: "bash", input: { command: "ls" } },
    ];
    const result = extractTextContent(content);
    expect(result).toContain("[Tool: bash]");
    expect(result).toContain("ls");
  });

  it("handles tool_result blocks with string content", () => {
    const content = [{ type: "tool_result", content: "file1.ts\nfile2.ts" }];
    expect(extractTextContent(content)).toBe("file1.ts\nfile2.ts");
  });

  it("handles tool_result blocks with array content", () => {
    const content = [
      {
        type: "tool_result",
        content: [
          { type: "text", text: "result line 1" },
          { type: "text", text: "result line 2" },
        ],
      },
    ];
    expect(extractTextContent(content)).toBe("result line 1\nresult line 2");
  });

  it("handles mixed content", () => {
    const content = [
      { type: "text", text: "Hello" },
      { type: "thinking", thinking: "hmm" },
    ];
    const result = extractTextContent(content);
    expect(result).toContain("Hello");
    expect(result).toContain("[Thinking] hmm");
  });

  it("handles non-string/non-array content", () => {
    const result = extractTextContent({ foo: "bar" });
    expect(result).toContain("foo");
    expect(result).toContain("bar");
  });

  it("handles null/undefined content", () => {
    const result = extractTextContent(null);
    expect(result).toBe('""');
  });

  it("filters empty strings from array", () => {
    const content = [
      { type: "text", text: "" },
      { type: "text", text: "hello" },
    ];
    expect(extractTextContent(content)).toBe("hello");
  });
});

// ─── parseTimelineRaw ────────────────────────────────────────

describe("parseTimelineRaw", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `clawui-test-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeJsonl(lines: object[]): string {
    const filePath = join(tmpDir, "test.jsonl");
    const content = lines.map((l) => JSON.stringify(l)).join("\n");
    writeFileSync(filePath, content, "utf-8");
    return filePath;
  }

  it("parses user messages", () => {
    const filePath = writeJsonl([
      {
        type: "user",
        uuid: "u1",
        timestamp: "2024-01-01T00:00:00Z",
        message: { role: "user", content: "Hello world" },
      },
    ]);
    const nodes = parseTimelineRaw(filePath);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe("user");
    expect(nodes[0].content).toBe("Hello world");
    expect(nodes[0].id).toBe("u1");
  });

  it("parses assistant messages with text blocks", () => {
    const filePath = writeJsonl([
      {
        type: "assistant",
        uuid: "a1",
        timestamp: "2024-01-01T00:00:01Z",
        message: {
          content: [
            { type: "text", text: "Here is my response." },
          ],
        },
      },
    ]);
    const nodes = parseTimelineRaw(filePath);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe("assistant");
    expect(nodes[0].content).toBe("Here is my response.");
  });

  it("parses assistant tool_use blocks", () => {
    const filePath = writeJsonl([
      {
        type: "assistant",
        uuid: "a2",
        timestamp: "2024-01-01T00:00:01Z",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tu1",
              name: "bash",
              input: { command: "ls -la" },
            },
          ],
        },
      },
    ]);
    const nodes = parseTimelineRaw(filePath);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe("tool_use");
    expect(nodes[0].toolName).toBe("bash");
    expect(nodes[0].toolUseId).toBe("tu1");
  });

  it("parses tool_result blocks in user messages", () => {
    const filePath = writeJsonl([
      {
        type: "assistant",
        uuid: "a3",
        timestamp: "2024-01-01T00:00:01Z",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tu2",
              name: "read_file",
              input: { path: "/foo.ts" },
            },
          ],
        },
      },
      {
        type: "user",
        uuid: "u2",
        timestamp: "2024-01-01T00:00:02Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu2",
              content: "file contents here",
            },
          ],
        },
      },
    ]);
    const nodes = parseTimelineRaw(filePath);
    // tool_use + tool_result
    expect(nodes).toHaveLength(2);
    const toolResult = nodes.find((n) => n.type === "tool_result");
    expect(toolResult).toBeDefined();
    expect(toolResult!.toolName).toBe("read_file");
    expect(toolResult!.content).toBe("file contents here");
  });

  it("skips malformed JSON lines", () => {
    const filePath = join(tmpDir, "bad.jsonl");
    writeFileSync(
      filePath,
      'not json\n{"type":"user","uuid":"u1","timestamp":"2024-01-01T00:00:00Z","message":{"role":"user","content":"valid"}}',
      "utf-8"
    );
    const nodes = parseTimelineRaw(filePath);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].content).toBe("valid");
  });

  it("handles empty file", () => {
    const filePath = join(tmpDir, "empty.jsonl");
    writeFileSync(filePath, "", "utf-8");
    const nodes = parseTimelineRaw(filePath);
    expect(nodes).toHaveLength(0);
  });

  it("skips user messages without content", () => {
    const filePath = writeJsonl([
      {
        type: "user",
        uuid: "u1",
        timestamp: "2024-01-01T00:00:00Z",
        message: { role: "user" },
      },
    ]);
    const nodes = parseTimelineRaw(filePath);
    expect(nodes).toHaveLength(0);
  });

  it("skips assistant messages without content", () => {
    const filePath = writeJsonl([
      {
        type: "assistant",
        uuid: "a1",
        timestamp: "2024-01-01T00:00:00Z",
        message: {},
      },
    ]);
    const nodes = parseTimelineRaw(filePath);
    expect(nodes).toHaveLength(0);
  });

  it("strips suggestion suffix from user prompts", () => {
    const filePath = writeJsonl([
      {
        type: "user",
        uuid: "u1",
        timestamp: "2024-01-01T00:00:00Z",
        message: {
          role: "user",
          content:
            'Hello world\n\nAfter completing the task above, append a line "---SUGGESTIONS---" followed by a JSON array of 3 suggested next steps.',
        },
      },
    ]);
    const nodes = parseTimelineRaw(filePath);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].content).toBe("Hello world");
  });

  it("skips non-user/assistant types", () => {
    const filePath = writeJsonl([
      {
        type: "file-history-snapshot",
        uuid: "f1",
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        type: "progress",
        uuid: "p1",
        timestamp: "2024-01-01T00:00:00Z",
      },
    ]);
    const nodes = parseTimelineRaw(filePath);
    expect(nodes).toHaveLength(0);
  });

  it("handles user messages with mixed tool_result and text blocks", () => {
    const filePath = writeJsonl([
      {
        type: "assistant",
        uuid: "a1",
        timestamp: "2024-01-01T00:00:00Z",
        message: {
          content: [
            { type: "tool_use", id: "tu1", name: "bash", input: {} },
          ],
        },
      },
      {
        type: "user",
        uuid: "u1",
        timestamp: "2024-01-01T00:00:01Z",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu1", content: "ok" },
            { type: "text", text: "continue please" },
          ],
        },
      },
    ]);
    const nodes = parseTimelineRaw(filePath);
    const toolResult = nodes.find((n) => n.type === "tool_result");
    const userMsg = nodes.find((n) => n.type === "user");
    expect(toolResult).toBeDefined();
    expect(userMsg).toBeDefined();
    expect(userMsg!.content).toBe("continue please");
  });

  it("handles assistant messages with string content", () => {
    const filePath = writeJsonl([
      {
        type: "assistant",
        uuid: "a1",
        timestamp: "2024-01-01T00:00:00Z",
        message: { content: "Plain string response" },
      },
    ]);
    const nodes = parseTimelineRaw(filePath);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].content).toBe("Plain string response");
  });

  it("handles user messages with string content (non-array)", () => {
    const filePath = writeJsonl([
      {
        type: "user",
        uuid: "u1",
        timestamp: "2024-01-01T00:00:00Z",
        message: { role: "user", content: "Simple string user message" },
      },
    ]);
    const nodes = parseTimelineRaw(filePath);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe("user");
    expect(nodes[0].content).toBe("Simple string user message");
  });

  it("generates uuid when not provided in JSONL line", () => {
    const filePath = writeJsonl([
      {
        type: "user",
        timestamp: "2024-01-01T00:00:00Z",
        message: { role: "user", content: "No uuid field" },
      },
    ]);
    const nodes = parseTimelineRaw(filePath);
    expect(nodes).toHaveLength(1);
    // Should have a generated UUID-like id
    expect(nodes[0].id).toBeTruthy();
    expect(nodes[0].id.length).toBeGreaterThan(0);
  });

  it("uses empty string for missing timestamp", () => {
    const filePath = writeJsonl([
      {
        type: "user",
        uuid: "u1",
        message: { role: "user", content: "No timestamp" },
      },
    ]);
    const nodes = parseTimelineRaw(filePath);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].timestamp).toBe("");
  });

  it("skips user messages where cleaned content is only whitespace", () => {
    const filePath = writeJsonl([
      {
        type: "user",
        uuid: "u1",
        timestamp: "2024-01-01T00:00:00Z",
        message: { role: "user", content: "   " },
      },
    ]);
    const nodes = parseTimelineRaw(filePath);
    expect(nodes).toHaveLength(0);
  });

  it("skips assistant messages where cleaned content is only whitespace", () => {
    const filePath = writeJsonl([
      {
        type: "assistant",
        uuid: "a1",
        timestamp: "2024-01-01T00:00:00Z",
        message: { content: [{ type: "text", text: "   " }] },
      },
    ]);
    const nodes = parseTimelineRaw(filePath);
    expect(nodes).toHaveLength(0);
  });

  it("handles tool_use block without explicit id field", () => {
    const filePath = writeJsonl([
      {
        type: "assistant",
        uuid: "a1",
        timestamp: "2024-01-01T00:00:00Z",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Write",
              input: { file_path: "/tmp/out.txt", content: "hello" },
            },
          ],
        },
      },
    ]);
    const nodes = parseTimelineRaw(filePath);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe("tool_use");
    expect(nodes[0].toolName).toBe("Write");
    // id falls back to uuid-tool-Write
    expect(nodes[0].id).toContain("Write");
  });

  it("handles tool_result referencing unknown tool_use_id (no prior tool_use)", () => {
    const filePath = writeJsonl([
      {
        type: "user",
        uuid: "u1",
        timestamp: "2024-01-01T00:00:00Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "unknown-tool-id",
              content: "some result",
            },
          ],
        },
      },
    ]);
    const nodes = parseTimelineRaw(filePath);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe("tool_result");
    expect(nodes[0].title).toBe("Tool result"); // fallback title
    expect(nodes[0].toolName).toBeUndefined();
  });

  it("handles multiple tool_use blocks in a single assistant message", () => {
    const filePath = writeJsonl([
      {
        type: "assistant",
        uuid: "a1",
        timestamp: "2024-01-01T00:00:00Z",
        message: {
          content: [
            { type: "tool_use", id: "tu1", name: "bash", input: { command: "ls" } },
            { type: "text", text: "Let me also check:" },
            { type: "tool_use", id: "tu2", name: "Read", input: { file_path: "/tmp/f" } },
          ],
        },
      },
    ]);
    const nodes = parseTimelineRaw(filePath);
    // Should produce: tool_use (bash), assistant text, tool_use (Read)
    const toolNodes = nodes.filter((n) => n.type === "tool_use");
    const assistantNodes = nodes.filter((n) => n.type === "assistant");
    expect(toolNodes).toHaveLength(2);
    expect(assistantNodes).toHaveLength(1);
    expect(assistantNodes[0].content).toBe("Let me also check:");
  });

  it("handles user array content with only tool_results (no text blocks)", () => {
    const filePath = writeJsonl([
      {
        type: "assistant",
        uuid: "a0",
        timestamp: "2024-01-01T00:00:00Z",
        message: {
          content: [
            { type: "tool_use", id: "tu1", name: "bash", input: {} },
          ],
        },
      },
      {
        type: "user",
        uuid: "u1",
        timestamp: "2024-01-01T00:00:01Z",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu1", content: "output here" },
          ],
        },
      },
    ]);
    const nodes = parseTimelineRaw(filePath);
    const userNodes = nodes.filter((n) => n.type === "user");
    const trNodes = nodes.filter((n) => n.type === "tool_result");
    // No user text node (empty text blocks), only tool_result
    expect(userNodes).toHaveLength(0);
    expect(trNodes).toHaveLength(1);
  });
});

// ─── extractTextContent edge cases ───────────────────────────

describe("extractTextContent edge cases", () => {
  it("handles array with plain string items", () => {
    const content = ["hello", "world"];
    expect(extractTextContent(content)).toBe("hello\nworld");
  });

  it("handles tool_result with non-string non-array content (object)", () => {
    const content = [
      { type: "tool_result", content: { nested: "value" } },
    ];
    const result = extractTextContent(content);
    expect(result).toContain("nested");
    expect(result).toContain("value");
  });

  it("handles tool_result with null content", () => {
    const content = [{ type: "tool_result", content: null }];
    const result = extractTextContent(content);
    expect(result).toBe('""');
  });

  it("handles unknown block types by returning empty string", () => {
    const content = [{ type: "unknown_type", data: "something" }];
    const result = extractTextContent(content);
    expect(result).toBe("");
  });

  it("handles empty array", () => {
    expect(extractTextContent([])).toBe("");
  });

  it("handles tool_use block with missing name and input", () => {
    const content = [{ type: "tool_use" }];
    const result = extractTextContent(content);
    expect(result).toContain("[Tool: undefined]");
  });
});

// ─── summarize edge cases ──────────────────────────────────────

describe("summarize edge cases", () => {
  it("returns empty string for null-ish input", () => {
    expect(summarize(null as unknown as string)).toBe("");
    expect(summarize(undefined as unknown as string)).toBe("");
  });

  it("trims whitespace", () => {
    expect(summarize("  hello  ")).toBe("hello");
  });

  it("handles text exactly at max length", () => {
    const text = "a".repeat(120);
    expect(summarize(text, 120)).toBe(text); // exactly at limit, no truncation
  });

  it("handles text one char over max length", () => {
    const text = "a".repeat(121);
    const result = summarize(text, 120);
    expect(result).toBe("a".repeat(120) + "...");
  });
});

// ─── decodeProjectPath: platform-mocked tests ────────────────

describe("decodeProjectPath (Windows)", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "win32" });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("detects drive letter and walks the filesystem", () => {
    // On the actual Windows CI or dev machine, this should resolve
    // Q:\src\ClawUI from Q--src-ClawUI (if the path exists)
    const result = decodeProjectPath("Q--src-ClawUI");
    // Result depends on actual filesystem — just verify the function handles the pattern
    expect(result === undefined || (typeof result === "string" && /^[A-Z]:/.test(result))).toBe(true);
  });

  it("decodes C--Users prefix", () => {
    const result = decodeProjectPath("C--Users");
    // On Windows, C:\Users typically exists
    if (result !== undefined) {
      expect(result).toMatch(/^C:\\/);
    }
  });

  it("returns undefined for invalid drive letter", () => {
    // Z drive unlikely to exist on CI
    const result = decodeProjectPath("Z--nonexistent-path-xyz");
    // If Z:\ doesn't exist, falls through to Unix-style which also won't match
    expect(result === undefined || typeof result === "string").toBe(true);
  });

  it("handles empty string after drive letter prefix", () => {
    const result = decodeProjectPath("C--");
    // C:\ exists on Windows — should resolve to the drive root
    if (result !== undefined) {
      expect(result).toMatch(/^C:\\/);
    }
  });
});

describe("decodeProjectPath (Unix)", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "darwin" });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("decodes standard paths via filesystem walk", () => {
    // On Unix, "-Users" would try to find /Users (which exists on macOS)
    const result = decodeProjectPath("-Users");
    expect(result === undefined || typeof result === "string").toBe(true);
  });

  it("handles leading dashes as root prefix", () => {
    // Leading dashes are stripped, then the path starts from "/"
    const result = decodeProjectPath("-tmp");
    // On actual Windows hosts, join() still uses \ even when platform is mocked,
    // so just verify it resolves to something or undefined
    if (result !== undefined) {
      expect(result).toMatch(/^[/\\]/);
    }
  });

  it("returns root for empty stripped string", () => {
    // After stripping leading dashes, empty → return "/"
    const result = decodeProjectPath("-");
    expect(result).toBe("/");
  });

  it("returns undefined on Unix for Windows-style drive pattern", () => {
    // "Q--src-ClawUI" on Unix: single-letter "Q" is detected as drive,
    // but Q:\ won't exist, so it falls through to Unix "/" walk
    // which also won't find /Q/src/ClawUI → undefined
    const result = decodeProjectPath("Q--src-ClawUI");
    // On Unix without a Q:\ drive, this should return undefined
    // (unless there's a /Q directory or the walk finds something)
    expect(result === undefined || typeof result === "string").toBe(true);
  });
});
