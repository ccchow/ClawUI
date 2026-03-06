"use client";

import { useState } from "react";
import { type ExecutionMode, updateBlueprint, runAllNodes } from "@/lib/api";

interface PauseBannerProps {
  blueprintId: string;
  pauseReason: string;
  onUpdate: (patch: { executionMode?: ExecutionMode; status?: string }) => void;
  onInvalidate: () => void;
  onBroadcast: (type: string) => void;
  /** Scroll to a node card by ID */
  onScrollToNode?: (nodeId: string) => void;
}

/** Extract node ID from pause reason if it references one (e.g. "Node abc123 ...") */
function extractNodeId(reason: string): string | null {
  const match = reason.match(/node[:\s]+([a-f0-9-]{8,})/i);
  return match ? match[1] : null;
}

export function PauseBanner({
  blueprintId,
  pauseReason,
  onUpdate,
  onInvalidate,
  onBroadcast,
  onScrollToNode,
}: PauseBannerProps) {
  const [resuming, setResuming] = useState(false);

  const relevantNodeId = extractNodeId(pauseReason);

  const handleResume = async () => {
    setResuming(true);
    try {
      // Clear pause state and set status to running optimistically
      await updateBlueprint(blueprintId, { status: "running", pauseReason: "" });
      onUpdate({ status: "running" });
      // Grace period: skip safeguard checks for 5 iterations after user-initiated resume
      await runAllNodes(blueprintId, { safeguardGrace: 5 });
      onBroadcast("autopilot_resume");
      onInvalidate();
    } catch {
      // revert
    } finally {
      setResuming(false);
    }
  };

  const handleSwitchToManual = async () => {
    try {
      await updateBlueprint(blueprintId, { executionMode: "manual" });
      onUpdate({ executionMode: "manual" });
      onInvalidate();
    } catch {
      // non-critical
    }
  };

  return (
    <div role="alert" aria-live="assertive" className="bg-accent-amber/10 border border-accent-amber/30 rounded-lg p-4 mb-4">
      <div className="flex items-start gap-2 mb-3">
        <svg
          className="w-4 h-4 text-accent-amber flex-shrink-0 mt-0.5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        <div>
          <p className="text-sm font-medium text-text-primary">Autopilot Paused</p>
          <p className="text-xs text-text-secondary mt-1">{pauseReason}</p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        {relevantNodeId && onScrollToNode && (
          <button
            onClick={() => onScrollToNode(relevantNodeId)}
            className="text-xs text-accent-blue hover:text-accent-blue/80 transition-colors"
          >
            Review Issue
          </button>
        )}
        <button
          onClick={handleResume}
          disabled={resuming}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-accent-green/15 text-accent-green border border-accent-green/30 text-xs font-medium hover:bg-accent-green/25 transition-all active:scale-[0.97] disabled:opacity-disabled disabled:cursor-not-allowed"
        >
          {resuming ? "Resuming..." : "Resume Autopilot"}
        </button>
        <button
          onClick={handleSwitchToManual}
          className="text-xs text-text-secondary hover:text-text-primary transition-colors"
        >
          Switch to Manual
        </button>
      </div>
    </div>
  );
}
