import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { FailureReason } from "./plan-db.js";

export interface TimelineNode {
  id: string;
  type: "user" | "assistant" | "tool_use" | "tool_result" | "error" | "system";
  timestamp: string;
  title: string;
  content: string;
  toolName?: string;
  toolInput?: string;
  toolResult?: string;
  toolUseId?: string;
}

export interface SessionMeta {
  sessionId: string;
  projectId: string;
  projectName: string;
  timestamp: string;
  nodeCount: number;
  slug?: string;
  cwd?: string;
}

export interface ProjectInfo {
  id: string;
  name: string;
  path: string;
  sessionCount: number;
}

const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

/**
 * Look up the original working directory for a session by finding which project contains it.
 * Returns the decoded project path (e.g., "/Users/you/Git/MyProject").
 */
export function getSessionCwd(sessionId: string): string | undefined {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return undefined;
  const entries = readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const jsonlPath = join(CLAUDE_PROJECTS_DIR, entry.name, `${sessionId}.jsonl`);
    if (existsSync(jsonlPath)) {
      const decoded = "/" + entry.name.replace(/-/g, "/").replace(/^\/+/, "");
      return decoded;
    }
  }
  return undefined;
}

const SUGGESTION_MARKER = "---SUGGESTIONS---";
const SUGGESTION_SUFFIX_PATTERN = /\n\nAfter completing the task above, append a line "---SUGGESTIONS---".*$/s;

/** Strip the appended suggestion suffix from user prompts and suggestion JSON from assistant output */
export function cleanContent(text: string, type: string): string {
  if (!text) return text;
  if (type === "user") {
    return text.replace(SUGGESTION_SUFFIX_PATTERN, "").trim();
  }
  if (type === "assistant") {
    const idx = text.lastIndexOf(SUGGESTION_MARKER);
    if (idx !== -1) return text.substring(0, idx).trim();
  }
  return text;
}

export function summarize(text: string, maxLen = 120): string {
  if (!text) return "";
  const oneLine = text.replace(/\n/g, " ").trim();
  return oneLine.length > maxLen
    ? oneLine.slice(0, maxLen) + "..."
    : oneLine;
}

export function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block.type === "text") return block.text || "";
        if (block.type === "thinking") return `[Thinking] ${block.thinking || ""}`;
        if (block.type === "tool_use")
          return `[Tool: ${block.name}] ${JSON.stringify(block.input || {}).slice(0, 200)}`;
        if (block.type === "tool_result") {
          const resultContent = block.content;
          if (typeof resultContent === "string") return resultContent;
          if (Array.isArray(resultContent)) {
            return resultContent
              .map((r: { type?: string; text?: string }) =>
                r.type === "text" ? r.text || "" : ""
              )
              .join("\n");
          }
          return JSON.stringify(resultContent || "").slice(0, 500);
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return JSON.stringify(content || "").slice(0, 500);
}

/**
 * Parse a JSONL file directly by path (for db.ts to call without searching).
 */
export function parseTimelineRaw(filePath: string): TimelineNode[] {
  const raw = readFileSync(filePath, "utf-8");
  const lines = raw.trim().split("\n");
  const nodes: TimelineNode[] = [];
  const toolUseMap = new Map<string, { name: string; input: unknown }>();

  for (const line of lines) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    const type = obj.type as string;
    const timestamp = (obj.timestamp as string) || "";
    const uuid = (obj.uuid as string) || crypto.randomUUID();

    if (type === "user") {
      const msg = obj.message as { role?: string; content?: unknown } | undefined;
      if (!msg?.content) continue;

      const content = msg.content;

      if (Array.isArray(content)) {
        const toolResults = content.filter(
          (b: { type?: string }) => b.type === "tool_result"
        );
        const textBlocks = content.filter(
          (b: { type?: string }) => b.type !== "tool_result"
        );

        for (const tr of toolResults) {
          const toolUseId = tr.tool_use_id as string;
          const toolInfo = toolUseMap.get(toolUseId);
          const resultText = extractTextContent(tr.content);

          nodes.push({
            id: `${uuid}-tr-${toolUseId}`,
            type: "tool_result",
            timestamp,
            title: toolInfo
              ? `${toolInfo.name} result`
              : "Tool result",
            content: resultText,
            toolName: toolInfo?.name,
            toolResult: resultText,
            toolUseId,
          });
        }

        const userText = textBlocks
          .map((b: { type?: string; text?: string }) =>
            b.type === "text" ? b.text || "" : ""
          )
          .filter(Boolean)
          .join("\n");

        const cleanUser = cleanContent(userText, "user");
        if (cleanUser.trim()) {
          nodes.push({
            id: uuid,
            type: "user",
            timestamp,
            title: summarize(cleanUser),
            content: cleanUser,
          });
        }
      } else {
        const text = cleanContent(extractTextContent(content), "user");
        if (text.trim()) {
          nodes.push({
            id: uuid,
            type: "user",
            timestamp,
            title: summarize(text),
            content: text,
          });
        }
      }
    } else if (type === "assistant") {
      const msg = obj.message as { content?: unknown } | undefined;
      if (!msg?.content) continue;

      const content = msg.content;
      if (Array.isArray(content)) {
        let assistantText = "";

        for (const block of content) {
          if (block.type === "text") {
            assistantText += (block.text || "") + "\n";
          } else if (block.type === "tool_use") {
            toolUseMap.set(block.id, {
              name: block.name,
              input: block.input,
            });

            const inputStr = JSON.stringify(block.input || {}, null, 2);
            nodes.push({
              id: block.id || `${uuid}-tool-${block.name}`,
              type: "tool_use",
              timestamp,
              title: `${block.name}`,
              content: inputStr,
              toolName: block.name,
              toolInput: inputStr,
              toolUseId: block.id,
            });
          }
        }

        const cleanAssistant = cleanContent(assistantText.trim(), "assistant");
        if (cleanAssistant.trim()) {
          nodes.push({
            id: uuid,
            type: "assistant",
            timestamp,
            title: summarize(cleanAssistant),
            content: cleanAssistant,
          });
        }
      } else {
        const text = cleanContent(extractTextContent(content), "assistant");
        if (text.trim()) {
          nodes.push({
            id: uuid,
            type: "assistant",
            timestamp,
            title: summarize(text),
            content: text,
          });
        }
      }
    }
  }

  return nodes;
}

// ─── Session failure analysis ─────────────────────────────────

export interface SessionAnalysis {
  failureReason: FailureReason;
  detail: string;
  compactCount: number;
  peakTokens: number;
  lastApiError: string | null;
  messageCount: number;
}

/**
 * Analyze a session's JSONL file to detect why it may have failed.
 * Checks for: API errors (output token limit, content filter), context compaction events,
 * and high token usage that suggests context pressure.
 *
 * Returns null if the session file doesn't exist.
 */
export function analyzeSessionHealth(sessionId: string): SessionAnalysis | null {
  // Find the session file across all project dirs
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return null;

  let filePath: string | null = null;
  const entries = readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(CLAUDE_PROJECTS_DIR, entry.name, `${sessionId}.jsonl`);
    if (existsSync(candidate)) {
      filePath = candidate;
      break;
    }
  }

  if (!filePath) return null;

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  const lines = raw.trim().split("\n");
  let compactCount = 0;
  let peakTokens = 0;
  let lastApiError: string | null = null;
  let messageCount = 0;

  for (const line of lines) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    messageCount++;

    // Detect context compaction events
    if (obj.type === "system" && obj.subtype === "compact_boundary") {
      compactCount++;
      const meta = obj.compactMetadata as { preTokens?: number } | undefined;
      if (meta?.preTokens && meta.preTokens > peakTokens) {
        peakTokens = meta.preTokens;
      }
    }

    // Track API errors
    if (obj.isApiErrorMessage) {
      const msg = obj.message as { content?: unknown } | undefined;
      if (msg?.content) {
        const content = msg.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (typeof block === "object" && block !== null && "text" in block) {
              lastApiError = (block as { text: string }).text;
            }
          }
        } else if (typeof content === "string") {
          lastApiError = content;
        }
      }
    }

    // Track peak token usage from assistant messages
    if (obj.type === "assistant" && !obj.isApiErrorMessage) {
      const msg = obj.message as { usage?: Record<string, number> } | undefined;
      if (msg?.usage) {
        const total = (msg.usage.input_tokens || 0) + (msg.usage.cache_read_input_tokens || 0);
        if (total > peakTokens) {
          peakTokens = total;
        }
      }
    }
  }

  // Determine failure reason
  let failureReason: FailureReason = null;
  let detail = "";

  if (lastApiError) {
    if (lastApiError.includes("exceeded") && lastApiError.includes("output token maximum")) {
      failureReason = "output_token_limit";
      detail = `Session ended with output token limit error. ${lastApiError}`;
    } else if (lastApiError.includes("context") || lastApiError.includes("input") && lastApiError.includes("token")) {
      failureReason = "context_exhausted";
      detail = `Session ended with context error: ${lastApiError}`;
    } else {
      failureReason = "error";
      detail = `API error: ${lastApiError}`;
    }
  } else if (compactCount >= 3) {
    // Multiple compactions suggest heavy context pressure — session may have degraded
    failureReason = "context_exhausted";
    detail = `Session compacted ${compactCount} times (peak ${peakTokens} tokens). Context pressure likely degraded performance.`;
  }

  return {
    failureReason,
    detail,
    compactCount,
    peakTokens,
    lastApiError,
    messageCount,
  };
}
