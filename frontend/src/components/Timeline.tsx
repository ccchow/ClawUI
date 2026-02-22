"use client";

import { useState, useMemo } from "react";
import type { TimelineNode } from "@/lib/api";
import { TimelineNodeComponent, ToolPairNode } from "./TimelineNode";

export interface DisplayItem {
  kind: "single" | "tool_pair";
  key: string;
  node?: TimelineNode;
  toolUse?: TimelineNode;
  toolResult?: TimelineNode;
  timestamp: string;
}

/** Group consecutive tool_use + tool_result into pairs */
function groupNodes(nodes: TimelineNode[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  let i = 0;

  while (i < nodes.length) {
    const curr = nodes[i];

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
        timestamp: curr.timestamp,
      });
      i += 2;
    } else {
      items.push({
        kind: "single",
        key: curr.id,
        node: curr,
        timestamp: curr.timestamp,
      });
      i += 1;
    }
  }

  return items;
}

// --- Time-based grouping ---

interface TimeGroup {
  id: string;
  label: string;
  relativeLabel: string;
  items: DisplayItem[];
  startTime: Date;
  endTime: Date;
  defaultCollapsed: boolean;
}

function getTimeGroups(items: DisplayItem[]): TimeGroup[] {
  if (items.length === 0) return [];

  const now = new Date();
  const groups: TimeGroup[] = [];
  let currentItems: DisplayItem[] = [items[0]];
  let currentStart = new Date(items[0].timestamp);

  // Adaptive gap threshold:
  // - Messages within last hour: split every 10 min gap
  // - Messages 1-24h old: split every 30 min gap
  // - Older: split every 1 hour gap
  function getGapThreshold(timestamp: Date): number {
    const ageMs = now.getTime() - timestamp.getTime();
    const ageHours = ageMs / (1000 * 60 * 60);
    if (ageHours < 1) return 10 * 60 * 1000;   // 10 min
    if (ageHours < 24) return 30 * 60 * 1000;  // 30 min
    return 60 * 60 * 1000;                       // 1 hour
  }

  for (let i = 1; i < items.length; i++) {
    const prevTime = new Date(items[i - 1].timestamp);
    const currTime = new Date(items[i].timestamp);
    const gapMs = Math.abs(currTime.getTime() - prevTime.getTime());
    const GAP_THRESHOLD = getGapThreshold(currTime);

    if (gapMs > GAP_THRESHOLD) {
      // Finalize current group
      const endTime = new Date(items[i - 1].timestamp);
      groups.push(makeGroup(currentItems, currentStart, endTime, now));
      currentItems = [items[i]];
      currentStart = currTime;
    } else {
      currentItems.push(items[i]);
    }
  }

  // Finalize last group
  const endTime = new Date(items[items.length - 1].timestamp);
  groups.push(makeGroup(currentItems, currentStart, endTime, now));

  // Collapse all groups except the most recent one
  if (groups.length > 1) {
    for (let i = 0; i < groups.length - 1; i++) {
      groups[i].defaultCollapsed = true;
    }
  }

  return groups;
}

function makeGroup(
  items: DisplayItem[],
  startTime: Date,
  endTime: Date,
  now: Date
): TimeGroup {
  const ageMs = now.getTime() - endTime.getTime();
  const ageHours = ageMs / (1000 * 60 * 60);

  // Format time label
  const timeStr = formatTimeRange(startTime, endTime);
  const relLabel = formatRelative(endTime, now);

  // Collapse logic: not the most recent group → collapsed
  // (will be overridden after all groups are created)
  const defaultCollapsed = false;

  // Summary of node types
  const typeCounts: Record<string, number> = {};
  for (const item of items) {
    const type = item.kind === "tool_pair" ? "tool" : (item.node?.type || "unknown");
    typeCounts[type] = (typeCounts[type] || 0) + 1;
  }
  const summary = Object.entries(typeCounts)
    .map(([t, c]) => `${c} ${t}`)
    .join(", ");

  return {
    id: `group-${startTime.getTime()}`,
    label: `${timeStr} · ${items.length} nodes · ${summary}`,
    relativeLabel: relLabel,
    items,
    startTime,
    endTime,
    defaultCollapsed,
  };
}

function formatTimeRange(start: Date, end: Date): string {
  const opts: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };
  const startStr = start.toLocaleTimeString([], opts);
  const endStr = end.toLocaleTimeString([], opts);

  if (start.toDateString() !== end.toDateString()) {
    const dateOpts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
    return `${start.toLocaleDateString([], dateOpts)} ${startStr} — ${end.toLocaleDateString([], dateOpts)} ${endStr}`;
  }

  if (startStr === endStr) return startStr;
  return `${startStr} — ${endStr}`;
}

function formatRelative(date: Date, now: Date): string {
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

// --- Filters ---

type FilterKey = "user" | "assistant" | "tool";

const FILTER_CONFIG: { key: FilterKey; label: string; icon: string; color: string; activeColor: string }[] = [
  { key: "user", label: "User", icon: "👤", color: "text-text-muted border-border-primary", activeColor: "text-accent-blue border-accent-blue bg-accent-blue/10" },
  { key: "assistant", label: "Assistant", icon: "🤖", color: "text-text-muted border-border-primary", activeColor: "text-accent-purple border-accent-purple bg-accent-purple/10" },
  { key: "tool", label: "Tool", icon: "🔧", color: "text-text-muted border-border-primary", activeColor: "text-accent-amber border-accent-amber bg-accent-amber/10" },
];

function getItemFilterKey(item: DisplayItem): FilterKey {
  if (item.kind === "tool_pair") return "tool";
  const type = item.node!.type;
  if (type === "tool_use" || type === "tool_result") return "tool";
  if (type === "assistant") return "assistant";
  return "user";
}

function countByFilter(grouped: DisplayItem[]): Record<FilterKey, number> {
  const counts: Record<FilterKey, number> = { user: 0, assistant: 0, tool: 0 };
  for (const item of grouped) {
    counts[getItemFilterKey(item)]++;
  }
  return counts;
}

// --- TimeGroupComponent ---

function TimeGroupSection({
  group,
  filters,
}: {
  group: TimeGroup;
  filters: Record<FilterKey, boolean>;
}) {
  const [collapsed, setCollapsed] = useState(group.defaultCollapsed);

  const filteredItems = useMemo(
    () => group.items.filter((item) => filters[getItemFilterKey(item)]),
    [group.items, filters]
  );

  if (filteredItems.length === 0) return null;

  return (
    <div className="mb-4">
      {/* Group header */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="flex items-center gap-2 w-full text-left py-2 px-3 rounded-lg hover:bg-bg-hover/30 transition-colors group"
      >
        <span className="text-xs text-text-muted font-mono">
          {collapsed ? "▶" : "▼"}
        </span>
        <div className="flex-1 flex items-center gap-2">
          <span className="text-xs font-medium text-text-secondary">
            {group.relativeLabel}
          </span>
          <span className="text-xs text-text-muted">
            {group.label}
          </span>
        </div>
        {collapsed && (
          <span className="text-xs text-text-muted bg-bg-tertiary px-2 py-0.5 rounded">
            {filteredItems.length} items
          </span>
        )}
      </button>

      {/* Group content */}
      {!collapsed && (
        <div className="space-y-1 mt-1">
          {filteredItems.map((item) =>
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
      )}
    </div>
  );
}

// --- Main Timeline ---

export function Timeline({ nodes }: { nodes: TimelineNode[] }) {
  const [filters, setFilters] = useState<Record<FilterKey, boolean>>({
    user: true,
    assistant: true,
    tool: true,
  });

  const grouped = useMemo(() => groupNodes(nodes), [nodes]);
  const counts = useMemo(() => countByFilter(grouped), [grouped]);
  const timeGroups = useMemo(() => getTimeGroups(grouped), [grouped]);

  if (nodes.length === 0) {
    return (
      <div className="text-center py-16 text-text-muted">
        No messages in this session
      </div>
    );
  }

  const toggleFilter = (key: FilterKey) => {
    setFilters((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const totalFiltered = grouped.filter((item) => filters[getItemFilterKey(item)]).length;

  return (
    <div>
      {/* Filter buttons */}
      <div className="flex items-center gap-2 mb-3">
        {FILTER_CONFIG.map((f) => (
          <button
            key={f.key}
            onClick={() => toggleFilter(f.key)}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs transition-all ${
              filters[f.key] ? f.activeColor : f.color + " opacity-50"
            }`}
          >
            <span>{f.icon}</span>
            <span>{f.label}</span>
            <span className="opacity-60">{counts[f.key]}</span>
          </button>
        ))}

        {totalFiltered !== grouped.length && (
          <span className="text-xs text-text-muted ml-auto">
            {totalFiltered} / {grouped.length}
          </span>
        )}

        <span className="text-xs text-text-muted ml-auto">
          {timeGroups.length} {timeGroups.length === 1 ? "segment" : "segments"}
        </span>
      </div>

      {/* Timeline with time groups */}
      <div className="relative">
        {/* Vertical line */}
        <div className="absolute left-5 top-0 bottom-0 w-px bg-border-primary" />

        {[...timeGroups].reverse().map((group) => (
          <TimeGroupSection
            key={group.id}
            group={group}
            filters={filters}
          />
        ))}
      </div>
    </div>
  );
}
