"use client";

import type { TimelineNode } from "@/lib/api";
import { TimelineNodeComponent, ToolPairNode } from "./TimelineNode";

export interface DisplayItem {
  kind: "single" | "tool_pair";
  key: string;
  node?: TimelineNode;
  toolUse?: TimelineNode;
  toolResult?: TimelineNode;
}

/** Group consecutive tool_use + tool_result into pairs */
function groupNodes(nodes: TimelineNode[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  let i = 0;

  while (i < nodes.length) {
    const curr = nodes[i];

    // Check if current is tool_use and next is its matching tool_result
    if (
      curr.type === "tool_use" &&
      i + 1 < nodes.length &&
      nodes[i + 1].type === "tool_result" &&
      nodes[i + 1].toolUseId === curr.toolUseId
    ) {
      items.push({
        kind: "tool_pair",
        key: `pair-${curr.id}`,
        toolUse: curr,
        toolResult: nodes[i + 1],
      });
      i += 2;
    } else {
      items.push({
        kind: "single",
        key: curr.id,
        node: curr,
      });
      i += 1;
    }
  }

  return items;
}

export function Timeline({ nodes }: { nodes: TimelineNode[] }) {
  if (nodes.length === 0) {
    return (
      <div className="text-center py-16 text-text-muted">
        No messages in this session
      </div>
    );
  }

  const grouped = groupNodes(nodes);

  return (
    <div className="relative">
      {/* Vertical line */}
      <div className="absolute left-5 top-0 bottom-0 w-px bg-border-primary" />

      <div className="space-y-1">
        {[...grouped].reverse().map((item) =>
          item.kind === "tool_pair" ? (
            <ToolPairNode
              key={item.key}
              toolUse={item.toolUse!}
              toolResult={item.toolResult!}
            />
          ) : (
            <TimelineNodeComponent key={item.key} node={item.node!} />
          )
        )}
      </div>
    </div>
  );
}
