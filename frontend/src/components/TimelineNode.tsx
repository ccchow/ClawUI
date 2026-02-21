"use client";

import { useState } from "react";
import type { TimelineNode } from "@/lib/api";

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

export function TimelineNodeComponent({ node }: { node: TimelineNode }) {
  const [expanded, setExpanded] = useState(false);
  const icon = ICON_MAP[node.type] || "❓";
  const colorClass = COLOR_MAP[node.type] || "border-border-primary";
  const dotColor = DOT_COLOR[node.type] || "bg-text-muted";

  const isLong = node.content.length > 200;
  const showExpand = isLong || node.toolInput || node.toolResult;

  return (
    <div className="relative pl-12">
      {/* Timeline dot */}
      <div
        className={`absolute left-[14px] top-4 w-3 h-3 rounded-full ${dotColor} ring-2 ring-bg-primary z-10`}
      />

      <div
        className={`rounded-lg border-l-2 ${colorClass} p-3 cursor-pointer transition-all hover:bg-bg-hover/30`}
        onClick={() => showExpand && setExpanded(!expanded)}
      >
        {/* Header */}
        <div className="flex items-center gap-2 mb-1">
          <span className="text-sm">{icon}</span>
          <span className="text-xs font-medium uppercase text-text-muted tracking-wide">
            {node.type === "tool_use"
              ? node.toolName || "tool"
              : node.type.replace("_", " ")}
          </span>
          <span className="text-xs text-text-muted ml-auto">
            {formatTimestamp(node.timestamp)}
          </span>
          {showExpand && (
            <span className="text-xs text-text-muted">
              {expanded ? "▼" : "▶"}
            </span>
          )}
        </div>

        {/* Title / collapsed view */}
        {!expanded && (
          <p className="text-sm text-text-secondary line-clamp-2 break-words">
            {node.title}
          </p>
        )}

        {/* Expanded content */}
        {expanded && (
          <div className="mt-2 space-y-2">
            <pre className="text-sm text-text-primary whitespace-pre-wrap break-words overflow-x-auto max-h-[600px] overflow-y-auto">
              {node.content}
            </pre>
            {node.toolResult && node.type === "tool_result" && (
              <div className="mt-2 pt-2 border-t border-border-primary">
                <span className="text-xs text-text-muted">Result:</span>
                <pre className="text-sm text-text-secondary whitespace-pre-wrap break-words mt-1 max-h-[400px] overflow-y-auto">
                  {node.toolResult}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
