"use client";

import { type MacroNode, type MacroNodeStatus } from "@/lib/api";

// --- Constants ---
const LANE_W = 14; // px per lane column
const DOT_AREA_W = 14; // px for the status dot area
const DOT_SIZE = 10; // StatusIndicator md size (w-2.5 = 10px)
const DOT_TOP = 25; // px from top to dot center (card border 1 + sm:p-4 16 + text offset 3 + half dot 5)
const LINE_W = 2.5; // line thickness

// --- Types ---

export interface DepLaneSegment {
  laneIndex: number;
  type: "top" | "bottom" | "pass";
  color: string;
  animate: boolean;
  isDestination?: boolean;
}

export interface DepRowLayout {
  segments: DepLaneSegment[];
  totalLanes: number;
}

// --- Color mapping ---

function statusToColor(status: MacroNodeStatus): string {
  switch (status) {
    case "done":
      return "#22c55e";
    case "running":
      return "#3b82f6";
    case "queued":
      return "#f59e0b";
    case "failed":
      return "#ef4444";
    case "blocked":
      return "#f59e0b";
    case "skipped":
      return "#64748b";
    default:
      return "#64748b";
  }
}

// --- Layout computation ---

export function computeDepLayout(
  allNodes: MacroNode[],
  displayedNodes: MacroNode[]
): DepRowLayout[] {
  if (displayedNodes.length === 0) return [];

  const nodeRowMap = new Map<string, number>();
  displayedNodes.forEach((n, i) => nodeRowMap.set(n.id, i));

  const nodeMap = new Map<string, MacroNode>();
  allNodes.forEach((n) => nodeMap.set(n.id, n));

  // Collect edges where both endpoints are visible
  interface Edge {
    topRow: number;
    bottomRow: number;
    destRow: number;
    lane: number;
    color: string;
    animate: boolean;
  }

  const edges: Edge[] = [];
  const completedStatuses = new Set<MacroNodeStatus>(['done', 'skipped']);

  for (const node of displayedNodes) {
    const targetRow = nodeRowMap.get(node.id)!;
    for (const depId of node.dependencies) {
      const sourceRow = nodeRowMap.get(depId);
      if (sourceRow === undefined) continue;

      const src = nodeMap.get(depId);
      if (!src || sourceRow === targetRow) continue;

      // Hide edges where both endpoints are completed — reduces visual clutter
      if (completedStatuses.has(src.status) && completedStatuses.has(node.status)) continue;

      edges.push({
        topRow: Math.min(sourceRow, targetRow),
        bottomRow: Math.max(sourceRow, targetRow),
        destRow: targetRow,
        lane: -1,
        color: statusToColor(src.status),
        animate: src.status === "running" || src.status === "queued",
      });
    }
  }

  if (edges.length === 0) {
    return displayedNodes.map(() => ({ segments: [], totalLanes: 0 }));
  }

  // Greedy lane assignment — longest spans first so they occupy
  // outer lanes (leftmost), shorter spans get inner lanes (closer to dot)
  edges.sort(
    (a, b) =>
      b.bottomRow - b.topRow - (a.bottomRow - a.topRow) || a.topRow - b.topRow
  );

  const laneRanges: [number, number][][] = [];

  for (const edge of edges) {
    let lane = -1;
    for (let l = 0; l < laneRanges.length; l++) {
      if (
        !laneRanges[l].some(
          ([t, b]) => edge.topRow < b && edge.bottomRow > t
        )
      ) {
        lane = l;
        break;
      }
    }
    if (lane === -1) {
      lane = laneRanges.length;
      laneRanges.push([]);
    }
    laneRanges[lane].push([edge.topRow, edge.bottomRow]);
    edge.lane = lane;
  }

  const totalLanes = laneRanges.length;

  // Build per-row layouts
  return displayedNodes.map((_, row) => {
    const segments: DepLaneSegment[] = [];
    for (const edge of edges) {
      if (row < edge.topRow || row > edge.bottomRow) continue;
      segments.push({
        laneIndex: edge.lane,
        type:
          row === edge.topRow
            ? "top"
            : row === edge.bottomRow
              ? "bottom"
              : "pass",
        color: edge.color,
        animate: edge.animate,
        isDestination: row === edge.destRow,
      });
    }
    return { segments, totalLanes };
  });
}

// --- Gutter Renderer ---

const CURVE_R = 6; // base curve radius in px
const ARROW_LEN = 7; // arrowhead length in px
const ARROW_HALF_W = 4.5; // arrowhead half-width in px

export function DepGutter({
  layout,
  status,
  running,
  reevaluateQueued,
}: {
  layout: DepRowLayout;
  status: string;
  running?: boolean;
  reevaluateQueued?: boolean;
}) {
  const { segments, totalLanes } = layout;
  const gutterWidth = totalLanes * LANE_W + DOT_AREA_W;
  const dotCX = gutterWidth - DOT_AREA_W / 2;
  const effectiveStatus = running
    ? "running"
    : reevaluateQueued
      ? "queued"
      : status;
  const dotColor = statusToColor(effectiveStatus as MacroNodeStatus);
  const dotPulse = effectiveStatus === "running" || effectiveStatus === "queued";
  const dotR = DOT_SIZE / 2;

  return (
    <div
      className="relative flex-shrink-0 self-stretch"
      style={{ width: gutterWidth }}
    >
      {/* SVG layer for dependency connectors + status dot (same coordinate space = pixel-perfect alignment) */}
      <svg
        className="absolute inset-0 w-full h-full"
        style={{ pointerEvents: "none" }}
      >
        {segments.map((seg, i) => {
          const cx = seg.laneIndex * LANE_W + LANE_W / 2;
          const hDist = dotCX - cx;
          const r = Math.min(CURVE_R, hDist, DOT_TOP);
          const anim = seg.animate ? "animate-pulse" : undefined;

          if (seg.type === "pass") {
            return (
              <line
                key={i}
                x1={cx}
                y1={0}
                x2={cx}
                y2={999}
                stroke={seg.color}
                strokeWidth={LINE_W}
                strokeLinecap="round"
                className={anim}
              />
            );
          }

          if (seg.type === "top") {
            // Horizontal from dot center, curve down at lane, vertical to bottom
            const d = `M ${dotCX} ${DOT_TOP} L ${cx + r} ${DOT_TOP} Q ${cx} ${DOT_TOP} ${cx} ${DOT_TOP + r}`;
            // Arrow tip just left of the dot, pointing right toward dot
            const arrowX = dotCX - dotR - 1;
            return (
              <g key={i} className={anim}>
                <path
                  d={d}
                  stroke={seg.color}
                  strokeWidth={LINE_W}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                />
                <line
                  x1={cx}
                  y1={DOT_TOP + r}
                  x2={cx}
                  y2={999}
                  stroke={seg.color}
                  strokeWidth={LINE_W}
                  strokeLinecap="round"
                />
                {seg.isDestination && (
                  <polygon
                    points={`${arrowX},${DOT_TOP} ${arrowX - ARROW_LEN},${DOT_TOP - ARROW_HALF_W} ${arrowX - ARROW_LEN},${DOT_TOP + ARROW_HALF_W}`}
                    fill={seg.color}
                  />
                )}
              </g>
            );
          }

          // bottom: vertical from top, curve right to dot center
          const d = `M ${cx} ${DOT_TOP - r} Q ${cx} ${DOT_TOP} ${cx + r} ${DOT_TOP} L ${dotCX} ${DOT_TOP}`;
          // Arrow tip just left of the dot, pointing right toward dot
          const arrowX = dotCX - dotR - 1;
          return (
            <g key={i} className={anim}>
              <line
                x1={cx}
                y1={0}
                x2={cx}
                y2={DOT_TOP - r}
                stroke={seg.color}
                strokeWidth={LINE_W}
                strokeLinecap="round"
              />
              <path
                d={d}
                stroke={seg.color}
                strokeWidth={LINE_W}
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
              />
              {seg.isDestination && (
                <polygon
                  points={`${arrowX},${DOT_TOP} ${arrowX - ARROW_LEN},${DOT_TOP - ARROW_HALF_W} ${arrowX - ARROW_LEN},${DOT_TOP + ARROW_HALF_W}`}
                  fill={seg.color}
                />
              )}
            </g>
          );
        })}

        {/* Status dot — rendered in SVG for pixel-perfect alignment with lines */}
        <circle
          cx={dotCX}
          cy={DOT_TOP}
          r={dotR}
          fill={dotColor}
          fillOpacity={effectiveStatus === "skipped" ? 0.5 : 1}
          className={dotPulse ? "animate-pulse" : undefined}
        />
      </svg>
    </div>
  );
}
