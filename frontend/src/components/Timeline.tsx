"use client";

import type { TimelineNode } from "@/lib/api";
import { TimelineNodeComponent } from "./TimelineNode";

export function Timeline({ nodes }: { nodes: TimelineNode[] }) {
  if (nodes.length === 0) {
    return (
      <div className="text-center py-16 text-text-muted">
        No messages in this session
      </div>
    );
  }

  return (
    <div className="relative">
      {/* Vertical line */}
      <div className="absolute left-5 top-0 bottom-0 w-px bg-border-primary" />

      <div className="space-y-1">
        {[...nodes].reverse().map((node) => (
          <TimelineNodeComponent key={node.id} node={node} />
        ))}
      </div>
    </div>
  );
}
