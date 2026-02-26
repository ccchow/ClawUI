"use client";

import { useState, type FormEvent } from "react";

interface PromptInputProps {
  disabled: boolean;
  loading: boolean;
  onSubmit: (prompt: string) => void;
}

export function PromptInput({ disabled, loading, onSubmit }: PromptInputProps) {
  const [value, setValue] = useState("");

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSubmit(trimmed);
    setValue("");
  };

  return (
    <form onSubmit={handleSubmit} className="flex gap-2">
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Enter a custom prompt to continue this session..."
        disabled={disabled}
        className="flex-1 px-4 py-3 rounded-xl bg-bg-secondary border border-border-primary text-text-primary placeholder:text-text-muted text-sm focus:outline-none focus:border-accent-blue focus:ring-1 focus:ring-accent-blue/30 disabled:opacity-40"
      />
      <button
        type="submit"
        disabled={disabled || !value.trim()}
        className="px-6 py-3 rounded-xl bg-accent-blue text-white text-sm font-medium hover:bg-accent-blue/80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
      >
        {loading ? (
          <>
            <span className="animate-spin h-4 w-4 border-2 border-current border-t-transparent rounded-full" />
            Running...
          </>
        ) : (
          "Run"
        )}
      </button>
    </form>
  );
}
