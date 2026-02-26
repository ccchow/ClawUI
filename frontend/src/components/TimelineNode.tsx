"use client";

import { useState } from "react";
import type { TimelineNode } from "@/lib/api";
import { updateNodeMeta } from "@/lib/api";
import { MarkdownContent } from "./MarkdownContent";

const ICON_MAP: Record<TimelineNode["type"], string> = {
  user: "👤",
  assistant: "🤖",
  tool_use: "🔧",
  tool_result: "📋",
  error: "⚠️",
  system: "⚙️",
};

const COLOR_MAP: Record<TimelineNode["type"], string> = {
  user: "border-accent-blue bg-accent-blue/5",
  assistant: "border-accent-purple bg-accent-purple/5",
  tool_use: "border-accent-amber bg-accent-amber/5",
  tool_result: "border-accent-green bg-accent-green/5",
  error: "border-accent-red bg-accent-red/5",
  system: "border-text-muted bg-bg-tertiary",
};

const DOT_COLOR: Record<TimelineNode["type"], string> = {
  user: "bg-accent-blue",
  assistant: "bg-accent-purple",
  tool_use: "bg-accent-amber",
  tool_result: "bg-accent-green",
  error: "bg-accent-red",
  system: "bg-text-muted",
};

const BADGE_COLOR: Record<string, string> = {
  Read: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30",
  Write: "bg-orange-500/15 text-orange-700 dark:text-orange-400 border-orange-500/30",
  Edit: "bg-sky-500/15 text-sky-700 dark:text-sky-400 border-sky-500/30",
  Bash: "bg-violet-500/15 text-violet-700 dark:text-violet-400 border-violet-500/30",
  Grep: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400 border-yellow-500/30",
  Glob: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400 border-yellow-500/30",
  WebFetch: "bg-cyan-500/15 text-cyan-700 dark:text-cyan-400 border-cyan-500/30",
  WebSearch: "bg-cyan-500/15 text-cyan-700 dark:text-cyan-400 border-cyan-500/30",
  Task: "bg-pink-500/15 text-pink-700 dark:text-pink-400 border-pink-500/30",
  TodoWrite: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-400 border-indigo-500/30",
};

const DEFAULT_BADGE = "bg-text-muted/15 text-text-secondary border-text-muted/30";

function formatTimestamp(ts: string): string {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "";
  }
}

/** Extract a one-line readable summary from tool input JSON */
function toolInputSummary(toolName: string, rawInput: string): string | null {
  try {
    const input = JSON.parse(rawInput);

    switch (toolName) {
      case "Read":
        return input.file_path || input.relative_path || null;
      case "Write":
        return input.file_path ? `→ ${input.file_path}` : null;
      case "Edit":
        return input.file_path
          ? `${input.file_path} (${input.old_string ? "replace" : "edit"})`
          : null;
      case "Bash":
        return input.command
          ? input.command.length > 120
            ? input.command.slice(0, 120) + "..."
            : input.command
          : null;
      case "Grep":
        return input.pattern
          ? `/${input.pattern}/${input.path ? ` in ${input.path}` : ""}`
          : null;
      case "Glob":
        return input.pattern || null;
      case "WebFetch":
        return input.url || null;
      case "WebSearch":
        return input.query || null;
      case "Task":
        return input.description || input.prompt?.slice(0, 80) || null;
      case "TodoWrite":
        if (Array.isArray(input.todos)) {
          const active = input.todos.find(
            (t: { status?: string }) => t.status === "in_progress"
          );
          return active?.content || `${input.todos.length} items`;
        }
        return null;
      default:
        // Try common field names
        return (
          input.file_path ||
          input.path ||
          input.command ||
          input.query ||
          input.pattern ||
          input.name ||
          null
        );
    }
  } catch {
    return null;
  }
}

function CollapsibleSection({
  label,
  content,
  defaultOpen = false,
}: {
  label: string;
  content: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="border border-border-primary rounded-md overflow-hidden">
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-text-muted hover:bg-bg-hover/50 transition-colors"
      >
        <svg className={`w-3 h-3 transition-transform ${open ? "rotate-90" : ""}`} viewBox="0 0 16 16" fill="currentColor">
          <path d="M6.427 4.427l3.396 3.396a.25.25 0 010 .354l-3.396 3.396A.25.25 0 016 11.396V4.604a.25.25 0 01.427-.177z" />
        </svg>
        <span>{label}</span>
        <span className="ml-auto opacity-50">{content.length} chars</span>
      </button>
      {open && (
        <pre className="px-3 py-2 text-sm text-text-primary whitespace-pre-wrap break-words overflow-x-auto max-h-[500px] overflow-y-auto border-t border-border-primary bg-bg-primary/50">
          {content}
        </pre>
      )}
    </div>
  );
}

export function ToolPairNode({
  toolUse,
  toolResult,
}: {
  toolUse: TimelineNode;
  toolResult: TimelineNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const [bookmarked, setBookmarked] = useState(toolUse.bookmarked ?? false);
  const toolName = toolUse.toolName || "tool";
  const badgeColor = BADGE_COLOR[toolName] || DEFAULT_BADGE;
  const summary = toolInputSummary(toolName, toolUse.toolInput || "{}");

  const resultPreview =
    toolResult.content.length > 80
      ? toolResult.content.slice(0, 80).replace(/\n/g, " ") + "..."
      : toolResult.content.replace(/\n/g, " ");

  const handleBookmark = (e: React.MouseEvent) => {
    e.stopPropagation();
    const newVal = !bookmarked;
    setBookmarked(newVal);
    updateNodeMeta(toolUse.id, { bookmarked: newVal }).catch(() => setBookmarked(!newVal));
  };

  return (
    <div className="relative pl-12">
      {/* Timeline dot */}
      <div className="absolute left-[14px] top-4 w-3 h-3 rounded-full bg-accent-amber ring-2 ring-bg-primary z-10" />

      <div
        className={`rounded-lg border-l-2 p-3 cursor-pointer transition-all hover:bg-bg-hover/30 ${
          bookmarked
            ? "border-accent-amber bg-accent-amber/5"
            : "border-accent-amber bg-accent-amber/5"
        }`}
        onClick={() => setExpanded(!expanded)}
      >
        {/* Header */}
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <span className="text-sm">🔧</span>
          <span
            className={`text-xs font-semibold px-2 py-0.5 rounded-md border ${badgeColor}`}
          >
            {toolName}
          </span>
          <span className="text-xs text-text-muted ml-auto flex-shrink-0">
            {formatTimestamp(toolUse.timestamp)}
          </span>
          <button
            onClick={handleBookmark}
            className={`p-1 rounded transition-all active:scale-[0.9] ${
              bookmarked ? "text-accent-amber" : "text-text-muted/30 hover:text-accent-amber/60"
            }`}
            title={bookmarked ? "Remove bookmark" : "Bookmark"}
            aria-label={bookmarked ? "Remove bookmark" : "Bookmark"}
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill={bookmarked ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.5">
              <path d="M4 2h8a1 1 0 011 1v11.5l-5-3-5 3V3a1 1 0 011-1z" />
            </svg>
          </button>
          <svg className={`w-3 h-3 text-text-muted transition-transform ${expanded ? "rotate-90" : ""}`} viewBox="0 0 16 16" fill="currentColor">
            <path d="M6.427 4.427l3.396 3.396a.25.25 0 010 .354l-3.396 3.396A.25.25 0 016 11.396V4.604a.25.25 0 01.427-.177z" />
          </svg>
        </div>

        {/* Collapsed: summary + short result preview */}
        {!expanded && (
          <div className="space-y-0.5">
            {summary && (
              <p className="text-sm text-text-primary font-mono truncate">
                {summary}
              </p>
            )}
            <p className="text-xs text-text-muted truncate">
              → {resultPreview}
            </p>
          </div>
        )}

        {/* Expanded: input + output sections */}
        {expanded && (
          <div className="mt-2 space-y-2" onClick={(e) => e.stopPropagation()}>
            {summary && (
              <p className="text-sm text-text-primary font-mono bg-bg-primary/50 rounded px-2 py-1 border border-border-primary">
                {summary}
              </p>
            )}

            {toolUse.toolInput && (
              <CollapsibleSection
                label="Input"
                content={toolUse.toolInput}
              />
            )}

            <CollapsibleSection
              label="Output"
              content={toolResult.content}
              defaultOpen={toolResult.content.length < 2000}
            />
          </div>
        )}

        {/* Annotation */}
        {toolUse.annotation && (
          <p className="mt-2 text-xs text-accent-purple italic border-t border-border-primary pt-2">
            {toolUse.annotation}
          </p>
        )}
      </div>
    </div>
  );
}

export function TimelineNodeComponent({ node }: { node: TimelineNode }) {
  const [expanded, setExpanded] = useState(false);
  const [bookmarked, setBookmarked] = useState(node.bookmarked ?? false);
  const icon = ICON_MAP[node.type] || "❓";
  const colorClass = COLOR_MAP[node.type] || "border-border-primary";
  const dotColor = DOT_COLOR[node.type] || "bg-text-muted";

  const isThinking = node.type === "system" && node.title.includes("⏳");
  const isTool = node.type === "tool_use" || node.type === "tool_result";
  const isLong = node.content.length > 200;
  const showExpand = !isThinking && (isLong || node.toolInput || node.toolResult);

  const handleBookmark = (e: React.MouseEvent) => {
    e.stopPropagation();
    const newVal = !bookmarked;
    setBookmarked(newVal);
    updateNodeMeta(node.id, { bookmarked: newVal }).catch(() => setBookmarked(!newVal));
  };

  const summary =
    isTool && node.toolInput
      ? toolInputSummary(node.toolName || "", node.toolInput)
      : null;

  // Special rendering for thinking/running state
  if (isThinking) {
    return (
      <div className="relative pl-12">
        <div className="absolute left-[14px] top-4 w-3 h-3 rounded-full bg-accent-amber ring-2 ring-bg-primary z-10 animate-pulse" />
        <div className="rounded-lg border-l-2 border-accent-amber bg-accent-amber/5 p-4">
          <div className="flex items-center gap-3">
            <div className="animate-spin h-5 w-5 border-2 border-accent-amber border-t-transparent rounded-full" />
            <div>
              <p className="text-sm font-medium text-accent-amber">Claude Code is working...</p>
              <p className="text-xs text-text-muted mt-1 font-mono">{node.content.slice(0, 150)}</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative pl-12">
      {/* Timeline dot */}
      <div
        className={`absolute left-[14px] top-4 w-3 h-3 rounded-full ${dotColor} ring-2 ring-bg-primary z-10`}
      />

      <div
        className={`rounded-lg border-l-2 ${
          bookmarked ? "border-accent-amber bg-accent-amber/5" : colorClass
        } p-3 cursor-pointer transition-all hover:bg-bg-hover/30`}
        onClick={() => showExpand && setExpanded(!expanded)}
      >
        {/* Header */}
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <span className="text-sm">{icon}</span>

          {isTool && node.toolName ? (
            <span
              className={`text-xs font-semibold px-2 py-0.5 rounded-md border ${
                BADGE_COLOR[node.toolName] || DEFAULT_BADGE
              }`}
            >
              {node.toolName}
            </span>
          ) : (
            <span className="text-xs font-medium uppercase text-text-muted tracking-wide">
              {node.type.replace("_", " ")}
            </span>
          )}

          {node.type === "tool_result" && (
            <span className="text-[10px] uppercase tracking-wider text-text-muted">
              result
            </span>
          )}

          <span className="text-xs text-text-muted ml-auto flex-shrink-0">
            {formatTimestamp(node.timestamp)}
          </span>
          <button
            onClick={handleBookmark}
            className={`p-1 rounded transition-all active:scale-[0.9] ${
              bookmarked ? "text-accent-amber" : "text-text-muted/30 hover:text-accent-amber/60"
            }`}
            title={bookmarked ? "Remove bookmark" : "Bookmark"}
            aria-label={bookmarked ? "Remove bookmark" : "Bookmark"}
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill={bookmarked ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.5">
              <path d="M4 2h8a1 1 0 011 1v11.5l-5-3-5 3V3a1 1 0 011-1z" />
            </svg>
          </button>
          {showExpand && (
            <svg className={`w-3 h-3 text-text-muted transition-transform ${expanded ? "rotate-90" : ""}`} viewBox="0 0 16 16" fill="currentColor">
              <path d="M6.427 4.427l3.396 3.396a.25.25 0 010 .354l-3.396 3.396A.25.25 0 016 11.396V4.604a.25.25 0 01.427-.177z" />
            </svg>
          )}
        </div>

        {/* Collapsed: show summary or title */}
        {!expanded && (
          <div>
            {summary ? (
              <p className="text-sm text-text-primary font-mono truncate">
                {summary}
              </p>
            ) : (
              <p className="text-sm text-text-secondary line-clamp-2 break-words">
                {node.title}
              </p>
            )}
          </div>
        )}

        {/* Expanded content */}
        {expanded && (
          <div className="mt-2 space-y-2" onClick={(e) => e.stopPropagation()}>
            {/* For tool_use: show summary line + collapsible full input */}
            {node.type === "tool_use" && (
              <>
                {summary && (
                  <p className="text-sm text-text-primary font-mono bg-bg-primary/50 rounded px-2 py-1 border border-border-primary">
                    {summary}
                  </p>
                )}
                {node.toolInput && (
                  <CollapsibleSection
                    label="Full input"
                    content={node.toolInput}
                  />
                )}
              </>
            )}

            {/* For tool_result: show result content */}
            {node.type === "tool_result" && (
              <>
                {summary && (
                  <p className="text-xs text-text-muted font-mono mb-1">
                    {node.toolName}: {summary}
                  </p>
                )}
                <CollapsibleSection
                  label="Output"
                  content={node.content}
                  defaultOpen={node.content.length < 2000}
                />
              </>
            )}

            {/* For non-tool types: render markdown for assistant/user, plain for others */}
            {!isTool && (node.type === "assistant" || node.type === "user") && (
              <MarkdownContent content={node.content} />
            )}
            {!isTool && node.type !== "assistant" && node.type !== "user" && (
              <pre className="text-sm text-text-primary whitespace-pre-wrap break-words overflow-x-auto max-h-[600px] overflow-y-auto">
                {node.content}
              </pre>
            )}
          </div>
        )}

        {/* Annotation */}
        {node.annotation && (
          <p className="mt-2 text-xs text-accent-purple italic border-t border-border-primary pt-2">
            {node.annotation}
          </p>
        )}
      </div>
    </div>
  );
}
