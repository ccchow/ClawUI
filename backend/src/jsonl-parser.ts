import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

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
 * Returns the decoded project path (e.g., "/Users/leizhou/Git/ClawUI").
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

function summarize(text: string, maxLen = 120): string {
  if (!text) return "";
  const oneLine = text.replace(/\n/g, " ").trim();
  return oneLine.length > maxLen
    ? oneLine.slice(0, maxLen) + "..."
    : oneLine;
}

function extractTextContent(content: unknown): string {
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

export function listProjects(): ProjectInfo[] {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return [];

  const entries = readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true });
  const projects: ProjectInfo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projPath = join(CLAUDE_PROJECTS_DIR, entry.name);
    const jsonlFiles = readdirSync(projPath).filter((f) => f.endsWith(".jsonl"));

    // Decode project name from directory name (e.g., "-Users-leizhou-Git-ClawUI" -> "/Users/leizhou/Git/ClawUI")
    const decodedPath = entry.name.replace(/-/g, "/");
    const projectName = decodedPath.split("/").filter(Boolean).slice(-2).join("/");

    projects.push({
      id: entry.name,
      name: projectName || entry.name,
      path: decodedPath,
      sessionCount: jsonlFiles.length,
    });
  }

  return projects.sort((a, b) => b.sessionCount - a.sessionCount);
}

export function listSessions(projectId: string): SessionMeta[] {
  const projDir = join(CLAUDE_PROJECTS_DIR, projectId);
  if (!existsSync(projDir)) return [];

  const jsonlFiles = readdirSync(projDir).filter((f) => f.endsWith(".jsonl"));
  const sessions: SessionMeta[] = [];

  // Decode project name
  const decodedPath = projectId.replace(/-/g, "/");
  const projectName = decodedPath.split("/").filter(Boolean).slice(-2).join("/");

  for (const file of jsonlFiles) {
    const sessionId = basename(file, ".jsonl");
    const filePath = join(projDir, file);
    const stat = statSync(filePath);

    // Quick scan: read first few and last few lines for metadata
    let nodeCount = 0;
    let timestamp = stat.mtime.toISOString();
    let slug: string | undefined;
    let cwd: string | undefined;

    try {
      const raw = readFileSync(filePath, "utf-8");
      const lines = raw.trim().split("\n");
      nodeCount = lines.filter((l) => {
        try {
          const obj = JSON.parse(l);
          return ["user", "assistant"].includes(obj.type);
        } catch {
          return false;
        }
      }).length;

      // Get metadata from first meaningful entry
      for (const line of lines.slice(0, 10)) {
        try {
          const obj = JSON.parse(line);
          if (obj.slug) slug = obj.slug;
          if (obj.cwd) cwd = obj.cwd;
          if (obj.timestamp && !timestamp) timestamp = obj.timestamp;
        } catch {
          // skip malformed lines
        }
      }

      // Get latest timestamp from last entries
      for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
        try {
          const obj = JSON.parse(lines[i]);
          if (obj.timestamp) {
            timestamp = obj.timestamp;
            break;
          }
        } catch {
          // skip
        }
      }
    } catch {
      // If file read fails, use stat
    }

    sessions.push({
      sessionId,
      projectId,
      projectName,
      timestamp,
      nodeCount,
      slug,
      cwd,
    });
  }

  return sessions.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
}

export function parseTimeline(sessionId: string): TimelineNode[] {
  // Find the session file across all projects
  const filePath = findSessionFile(sessionId);
  if (!filePath) return [];

  const raw = readFileSync(filePath, "utf-8");
  const lines = raw.trim().split("\n");
  const nodes: TimelineNode[] = [];

  // Collect tool_use blocks from assistant messages to correlate with tool_results
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

      // Check if content is array with tool_result blocks
      if (Array.isArray(content)) {
        const toolResults = content.filter(
          (b: { type?: string }) => b.type === "tool_result"
        );
        const textBlocks = content.filter(
          (b: { type?: string }) => b.type !== "tool_result"
        );

        // Add tool results as separate nodes
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

        // Add user text if present
        const userText = textBlocks
          .map((b: { type?: string; text?: string }) =>
            b.type === "text" ? b.text || "" : ""
          )
          .filter(Boolean)
          .join("\n");

        if (userText.trim()) {
          nodes.push({
            id: uuid,
            type: "user",
            timestamp,
            title: summarize(userText),
            content: userText,
          });
        }
      } else {
        const text = extractTextContent(content);
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
        // Process each block
        let assistantText = "";

        for (const block of content) {
          if (block.type === "text") {
            assistantText += (block.text || "") + "\n";
          } else if (block.type === "tool_use") {
            // Store for correlation with tool_result
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
          // Skip thinking blocks — they're internal
        }

        if (assistantText.trim()) {
          nodes.push({
            id: uuid,
            type: "assistant",
            timestamp,
            title: summarize(assistantText),
            content: assistantText.trim(),
          });
        }
      } else {
        const text = extractTextContent(content);
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
    // Skip file-history-snapshot, progress, queue-operation, system types
  }

  return nodes;
}

function findSessionFile(sessionId: string): string | null {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return null;

  const projects = readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true });
  for (const proj of projects) {
    if (!proj.isDirectory()) continue;
    const filePath = join(CLAUDE_PROJECTS_DIR, proj.name, `${sessionId}.jsonl`);
    if (existsSync(filePath)) return filePath;
  }
  return null;
}
