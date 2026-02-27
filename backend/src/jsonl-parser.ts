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
  agentType?: string;
}

export interface ProjectInfo {
  id: string;
  name: string;
  path: string;
  sessionCount: number;
  agentType?: string;
}

const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

/**
 * Decode a Claude project directory name back to the original filesystem path.
 *
 * Claude CLI encodes paths by replacing both '/' and '.' (leading dot in hidden
 * dirs) with '-'. This makes naive decoding ambiguous — e.g., a hyphen in a
 * directory name is indistinguishable from a path separator. This function uses
 * filesystem lookups to reconstruct the actual path via backtracking.
 *
 * Examples:
 *   -Users-leizhou-Git-ClawUI           → /Users/leizhou/Git/ClawUI
 *   -Users-leizhou--openclaw-workspace  → /Users/leizhou/.openclaw/workspace
 *   -Users-leizhou-Git-my-project       → /Users/leizhou/Git/my-project
 */
const decodeProjectPathCache = new Map<string, string | undefined>();

export function decodeProjectPath(encoded: string): string | undefined {
  const cached = decodeProjectPathCache.get(encoded);
  if (cached !== undefined) return cached;

  const stripped = encoded.replace(/^-+/, "");
  if (!stripped) {
    const root = process.platform === "win32" ? undefined : "/";
    decodeProjectPathCache.set(encoded, root);
    return root;
  }

  const parts = stripped.split("-");

  // Detect Windows drive letter: first part is a single letter (e.g., "C")
  // The encoded form of "C:\Users\foo" is "C--Users-foo"
  // After stripping leading "-" from "C--Users-foo" we get parts: ["C", "", "Users", "foo"]
  // But if original was "C--Users-foo", stripped is "C--Users-foo", parts are ["C", "", "Users", "foo"]
  // The empty part signals the backslash separator after the drive letter colon.
  if (parts[0].length === 1 && /^[A-Za-z]$/.test(parts[0])) {
    const driveLetter = parts[0].toUpperCase();
    const driveRoot = `${driveLetter}:\\`;
    if (existsSync(driveRoot)) {
      // Skip the empty part after drive letter (from the `:` → `-` encoding)
      const startIdx = (parts.length > 1 && parts[1] === "") ? 2 : 1;
      const result = walkFs(driveRoot, parts, startIdx);
      decodeProjectPathCache.set(encoded, result);
      return result;
    }
  }

  // Unix path: start from /
  const result = walkFs("/", parts, 0);
  decodeProjectPathCache.set(encoded, result);
  return result;
}

/**
 * Recursively reconstruct a filesystem path from dash-separated parts.
 * Tries progressively longer segments (to handle hyphens in directory names)
 * and also tries prepending '.' (to handle hidden directories encoded as --).
 */
function walkFs(current: string, parts: string[], startIdx: number): string | undefined {
  if (startIdx >= parts.length) return current;

  // Consecutive empty parts (from -- in encoded name) signal a dot-prefixed directory
  let dotPrefix = "";
  let actualStart = startIdx;
  while (actualStart < parts.length && parts[actualStart] === "") {
    dotPrefix += ".";
    actualStart++;
  }

  if (actualStart >= parts.length) return undefined;

  // Try progressively longer segments (longest first for greedy match)
  for (let endIdx = parts.length; endIdx > actualStart; endIdx--) {
    const segment = dotPrefix + parts.slice(actualStart, endIdx).join("-");

    const testPath = join(current, segment);
    if (existsSync(testPath)) {
      const result = walkFs(testPath, parts, endIdx);
      if (result) return result;
    }
  }

  // If we had a dotPrefix, also try interpreting the empty parts as regular
  // hyphen boundaries (fallback for edge cases)
  if (dotPrefix) {
    for (let endIdx = parts.length; endIdx > startIdx; endIdx--) {
      const segment = parts.slice(startIdx, endIdx).join("-");
      const testPath = join(current, segment);
      if (existsSync(testPath)) {
        const result = walkFs(testPath, parts, endIdx);
        if (result) return result;
      }
    }
  }

  return undefined;
}

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
      // Use filesystem-aware decoding first
      const decoded = decodeProjectPath(entry.name);
      if (decoded && existsSync(decoded)) return decoded;
      // Fallback: return undefined rather than an invalid path
      return undefined;
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
 * Parse a JSONL file directly by path or from pre-read content (avoids double file read).
 */
export function parseTimelineRaw(filePathOrContent: string, rawContent?: string): TimelineNode[] {
  const raw = rawContent ?? readFileSync(filePathOrContent, "utf-8");
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

export type ContextPressure = "none" | "moderate" | "high" | "critical";

export interface SessionAnalysis {
  failureReason: FailureReason;
  detail: string;
  compactCount: number;
  peakTokens: number;
  lastApiError: string | null;
  messageCount: number;
  contextPressure: ContextPressure;
  /** True if the last event in the session was a compaction (session likely died at the context limit) */
  endedAfterCompaction: boolean;
  /** Number of successful assistant responses after the last compaction (0 = died immediately) */
  responsesAfterLastCompact: number;
}

/**
 * Analyze a session's JSONL file to detect why it may have failed.
 * Checks for: API errors (output token limit, content filter, overloaded),
 * context compaction events, token usage patterns, and whether the session
 * died right after hitting the context limit.
 *
 * Returns null if the session file doesn't exist.
 */
export function analyzeSessionHealth(sessionId: string, knownFilePath?: string): SessionAnalysis | null {
  let filePath: string | null = knownFilePath ?? null;

  // Only scan project dirs if no path was provided (P10 fix)
  if (!filePath) {
    if (!existsSync(CLAUDE_PROJECTS_DIR)) return null;
    const entries = readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = join(CLAUDE_PROJECTS_DIR, entry.name, `${sessionId}.jsonl`);
      if (existsSync(candidate)) {
        filePath = candidate;
        break;
      }
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
  let lastCompactLineIdx = -1;
  let responsesAfterLastCompact = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
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
      lastCompactLineIdx = i;
      responsesAfterLastCompact = 0;
      const meta = obj.compactMetadata as { preTokens?: number } | undefined;
      if (meta?.preTokens && meta.preTokens > peakTokens) {
        peakTokens = meta.preTokens;
      }
    }

    // Count successful assistant responses after the last compaction
    if (lastCompactLineIdx >= 0 && obj.type === "assistant" && !obj.isApiErrorMessage) {
      responsesAfterLastCompact++;
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

  // Did the session end right after (or during) a compaction?
  const endedAfterCompaction = lastCompactLineIdx >= 0 && responsesAfterLastCompact <= 1;

  // Determine context pressure level
  let contextPressure: ContextPressure = "none";
  if (compactCount >= 3 || (compactCount >= 2 && endedAfterCompaction)) {
    contextPressure = "critical";
  } else if (compactCount >= 2 || (compactCount >= 1 && peakTokens > 150_000)) {
    contextPressure = "high";
  } else if (compactCount >= 1 || peakTokens > 120_000) {
    contextPressure = "moderate";
  }

  // Determine failure reason
  let failureReason: FailureReason = null;
  let detail = "";

  if (lastApiError) {
    if (lastApiError.includes("exceeded") && lastApiError.includes("output token maximum")) {
      failureReason = "output_token_limit";
      detail = `Session ended with output token limit error. ${lastApiError}`;
    } else if (
      // Explicit context/input token errors
      (lastApiError.includes("context") && lastApiError.includes("token")) ||
      (lastApiError.includes("input") && lastApiError.includes("token")) ||
      lastApiError.includes("context window") ||
      lastApiError.includes("maximum context length") ||
      lastApiError.includes("context_length_exceeded") ||
      lastApiError.includes("max_tokens") ||
      // Overloaded API errors during context pressure
      (lastApiError.includes("overloaded") && compactCount >= 1)
    ) {
      failureReason = "context_exhausted";
      detail = `Session ended with context error: ${lastApiError}`;
    } else if (lastApiError.includes("overloaded")) {
      failureReason = "error";
      detail = `API overloaded: ${lastApiError}`;
    } else {
      failureReason = "error";
      detail = `API error: ${lastApiError}`;
    }
  } else if (endedAfterCompaction && compactCount >= 2) {
    // Session compacted multiple times and died right after the last compaction
    failureReason = "context_exhausted";
    detail = `Session compacted ${compactCount} times and ended immediately after the last compaction (peak ${peakTokens} tokens). Context was full.`;
  } else if (compactCount >= 3) {
    // Multiple compactions suggest heavy context pressure — session may have degraded
    failureReason = "context_exhausted";
    detail = `Session compacted ${compactCount} times (peak ${peakTokens} tokens). Context pressure likely degraded performance.`;
  } else if (compactCount >= 2 && peakTokens > 150_000) {
    // Two compactions with very high peak tokens
    failureReason = "context_exhausted";
    detail = `Session compacted ${compactCount} times with peak ${peakTokens} tokens — near context limit.`;
  }

  return {
    failureReason,
    detail,
    compactCount,
    peakTokens,
    lastApiError,
    messageCount,
    contextPressure,
    endedAfterCompaction,
    responsesAfterLastCompact,
  };
}
