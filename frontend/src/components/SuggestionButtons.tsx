"use client";

import type { Suggestion } from "@/lib/api";

interface SuggestionButtonsProps {
  suggestions: Suggestion[];
  disabled: boolean;
  onSelect: (prompt: string) => void;
}

export function SuggestionButtons({
  suggestions,
  disabled,
  onSelect,
}: SuggestionButtonsProps) {
  if (suggestions.length === 0) return null;

  return (
    <div className="space-y-2">
      <p className="text-xs text-text-muted uppercase tracking-wide">
        Suggested next steps
      </p>
      <div className="grid gap-2 sm:grid-cols-3">
        {suggestions.map((s, i) => (
          <button
            key={i}
            onClick={() => onSelect(s.prompt)}
            disabled={disabled}
            className="text-left px-4 py-3 rounded-xl border border-border-primary bg-bg-secondary hover:bg-bg-tertiary hover:border-accent-purple/40 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <p className="text-sm font-medium text-text-primary mb-1">
              {s.title}
            </p>
            <p className="text-xs text-text-muted line-clamp-2">
              {s.description}
            </p>
          </button>
        ))}
      </div>
    </div>
  );
}
