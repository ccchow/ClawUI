"use client";

import { useState, useCallback } from "react";
import { type ExecutionMode, updateBlueprint } from "@/lib/api";

interface AutopilotToggleProps {
  blueprintId: string;
  executionMode: ExecutionMode | undefined;
  blueprintStatus: string;
  onUpdate: (patch: { executionMode: ExecutionMode }) => void;
}

const MODE_CYCLE: ExecutionMode[] = ["manual", "autopilot", "fsd"];

const MODE_CONFIG: Record<ExecutionMode, { label: string; title: string; dotClass: string; activeClass: string }> = {
  manual: {
    label: "Manual",
    title: "Manual: you control execution",
    dotClass: "bg-text-muted",
    activeClass: "bg-bg-tertiary text-text-secondary border-border-primary",
  },
  autopilot: {
    label: "Autopilot",
    title: "Autopilot: AI agent drives execution with safeguards",
    dotClass: "bg-accent-green animate-pulse",
    activeClass: "bg-accent-green/15 text-accent-green border-accent-green/30",
  },
  fsd: {
    label: "FSD",
    title: "FSD: Full Speed Drive — AI runs without safeguards for maximum throughput",
    dotClass: "bg-accent-amber animate-pulse",
    activeClass: "bg-accent-amber/15 text-accent-amber border-accent-amber/30",
  },
};

export function AutopilotToggle({ blueprintId, executionMode, blueprintStatus, onUpdate }: AutopilotToggleProps) {
  const currentMode = executionMode ?? "manual";
  const disabled = blueprintStatus === "draft";
  const [toggling, setToggling] = useState(false);

  const handleToggle = useCallback(async () => {
    if (disabled || toggling) return;
    const currentIndex = MODE_CYCLE.indexOf(currentMode);
    const newMode = MODE_CYCLE[(currentIndex + 1) % MODE_CYCLE.length];
    // Optimistic update
    onUpdate({ executionMode: newMode });
    setToggling(true);
    try {
      await updateBlueprint(blueprintId, { executionMode: newMode });
    } catch {
      // Revert on error
      onUpdate({ executionMode: currentMode });
    } finally {
      setToggling(false);
    }
  }, [blueprintId, currentMode, disabled, toggling, onUpdate]);

  const config = MODE_CONFIG[currentMode];

  return (
    <button
      onClick={handleToggle}
      disabled={disabled || toggling}
      aria-pressed={currentMode !== "manual"}
      title={
        disabled
          ? "Approve blueprint to enable autopilot"
          : config.title
      }
      className={`inline-flex items-center gap-2 px-3 py-1 rounded-full border text-sm font-medium cursor-pointer transition-all hover:opacity-80 active:scale-[0.98] ${
        disabled || toggling
          ? "opacity-disabled cursor-not-allowed"
          : config.activeClass
      }`}
    >
      {toggling ? (
        <svg className="w-3 h-3 animate-spin" viewBox="0 0 12 12" fill="none" aria-label="Loading">
          <circle cx="6" cy="6" r="5" stroke="currentColor" strokeOpacity="0.3" strokeWidth="2" />
          <path d="M6 1a5 5 0 0 1 5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      ) : (
        <span
          className={`w-2 h-2 rounded-full ${config.dotClass}`}
        />
      )}
      {config.label}
    </button>
  );
}
