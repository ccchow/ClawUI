"use client";

import type { Suggestion } from "@/lib/api";

interface SuggestionButtonsProps {
  suggestions: Suggestion[];
  loading: boolean;
  disabled: boolean;
  onSelect: (prompt: string) => void;
  onLoad: () => void;
}

export function SuggestionButtons({
  suggestions,
  loading,
  disabled,
  onSelect,
  onLoad,
}: SuggestionButtonsProps) {
  if (suggestions.length === 0) {
    return (
      <button
        onClick={onLoad}
        disabled={loading || disabled}
        className="w-full px-4 py-3 rounded-xl border border-dashed border-border-primary text-text-secondary text-sm hover:border-accent-purple hover:text-accent-purple transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {loading ? (
          <span className="flex items-center justify-center gap-2">
            <span className="animate-spin h-4 w-4 border-2 border-accent-purple border-t-transparent rounded-full" />
            Generating suggestions...
          </span>
        ) : (
          "✨ Get AI suggestions for next steps"
        )}
      </button>
    );
  }

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
