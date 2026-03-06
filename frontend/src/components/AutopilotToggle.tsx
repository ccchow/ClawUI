"use client";

import { useState, useCallback } from "react";
import { type ExecutionMode, updateBlueprint } from "@/lib/api";

interface AutopilotToggleProps {
  blueprintId: string;
  executionMode: ExecutionMode | undefined;
  blueprintStatus: string;
  onUpdate: (patch: { executionMode: ExecutionMode }) => void;
}

export function AutopilotToggle({ blueprintId, executionMode, blueprintStatus, onUpdate }: AutopilotToggleProps) {
  const active = executionMode === "autopilot";
  const disabled = blueprintStatus === "draft";
  const [toggling, setToggling] = useState(false);

  const handleToggle = useCallback(async () => {
    if (disabled || toggling) return;
    const newMode: ExecutionMode = active ? "manual" : "autopilot";
    // Optimistic update
    onUpdate({ executionMode: newMode });
    setToggling(true);
    try {
      await updateBlueprint(blueprintId, { executionMode: newMode });
    } catch {
      // Revert on error
      onUpdate({ executionMode: active ? "autopilot" : "manual" });
    } finally {
      setToggling(false);
    }
  }, [blueprintId, active, disabled, toggling, onUpdate]);

  return (
    <button
      onClick={handleToggle}
      disabled={disabled || toggling}
      aria-pressed={active}
      title={
        disabled
          ? "Approve blueprint to enable autopilot"
          : active
            ? "Autopilot: AI agent drives execution using all available operations"
            : "Manual: you control execution"
      }
      className={`inline-flex items-center gap-2 px-3 py-1 rounded-full border text-sm font-medium cursor-pointer transition-all hover:opacity-80 active:scale-[0.98] ${
        disabled || toggling
          ? "opacity-disabled cursor-not-allowed"
          : active
            ? "bg-accent-green/15 text-accent-green border-accent-green/30"
            : "bg-bg-tertiary text-text-secondary border-border-primary"
      }`}
    >
      {toggling ? (
        <svg className="w-3 h-3 animate-spin" viewBox="0 0 12 12" fill="none" aria-label="Loading">
          <circle cx="6" cy="6" r="5" stroke="currentColor" strokeOpacity="0.3" strokeWidth="2" />
          <path d="M6 1a5 5 0 0 1 5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      ) : (
        <span
          className={`w-2 h-2 rounded-full ${
            active ? "bg-accent-green animate-pulse" : "bg-text-muted"
          }`}
        />
      )}
      {active ? "Autopilot" : "Manual"}
    </button>
  );
}
