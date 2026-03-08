"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type { BlueprintSuggestion } from "@/lib/api";
import {
  getBlueprintSuggestions,
  useBlueprintSuggestion,
} from "@/lib/api";

interface BlueprintSuggestionsProps {
  blueprintId: string;
  onSuggestionUsed?: (suggestion: BlueprintSuggestion) => void;
}

export function BlueprintSuggestions({
  blueprintId,
  onSuggestionUsed,
}: BlueprintSuggestionsProps) {
  const queryClient = useQueryClient();
  const [usingId, setUsingId] = useState<string | null>(null);

  const { data: suggestions } = useQuery({
    queryKey: ["blueprint", blueprintId, "suggestions"],
    queryFn: () => getBlueprintSuggestions(blueprintId),
    refetchInterval: 5000,
  });

  const visible = suggestions?.filter((s) => !s.used) ?? [];

  if (visible.length === 0) return null;

  async function handleClick(suggestion: BlueprintSuggestion) {
    setUsingId(suggestion.id);
    try {
      await useBlueprintSuggestion(blueprintId, suggestion.id);
      await queryClient.invalidateQueries({
        queryKey: ["blueprint", blueprintId, "suggestions"],
      });
      onSuggestionUsed?.(suggestion);
    } finally {
      setUsingId(null);
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-text-muted uppercase tracking-wide">
        Suggestions
      </p>
      <div className="flex flex-wrap gap-2">
        {visible.map((s) => (
          <button
            key={s.id}
            onClick={() => handleClick(s)}
            disabled={usingId !== null}
            title={
              usingId === s.id
                ? "Applying suggestion…"
                : usingId
                  ? "Another suggestion is being applied"
                  : s.description
            }
            className="text-left px-3 py-2 rounded-lg border border-border-secondary bg-bg-secondary text-text-primary text-sm hover:bg-bg-tertiary hover:border-accent-purple/40 transition-all active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {s.title}
          </button>
        ))}
      </div>
    </div>
  );
}
