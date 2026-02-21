"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  getTimeline,
  getSuggestions,
  runPrompt,
  type TimelineNode,
  type Suggestion,
} from "@/lib/api";
import { Timeline } from "@/components/Timeline";
import { SuggestionButtons } from "@/components/SuggestionButtons";
import { PromptInput } from "@/components/PromptInput";

export default function SessionPage() {
  const { id } = useParams<{ id: string }>();

  const [nodes, setNodes] = useState<TimelineNode[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    getTimeline(id)
      .then((n) => {
        setNodes(n);
        setLoading(false);
      })
      .catch((e) => {
        setError(e.message);
        setLoading(false);
      });
  }, [id]);

  const loadSuggestions = useCallback(() => {
    setSuggestionsLoading(true);
    getSuggestions(id)
      .then((s) => {
        setSuggestions(s);
        setSuggestionsLoading(false);
      })
      .catch(() => {
        setSuggestionsLoading(false);
      });
  }, [id]);

  const handleRun = async (prompt: string) => {
    setRunning(true);
    try {
      const { result } = await runPrompt(id, prompt);
      // Append result as a new assistant node
      setNodes((prev) => [
        ...prev,
        {
          id: `run-${Date.now()}`,
          type: "user" as const,
          timestamp: new Date().toISOString(),
          title: prompt.slice(0, 120),
          content: prompt,
        },
        {
          id: `result-${Date.now()}`,
          type: "assistant" as const,
          timestamp: new Date().toISOString(),
          title: result.slice(0, 120),
          content: result,
        },
      ]);
      // Clear suggestions after running
      setSuggestions([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  if (error && nodes.length === 0) {
    return (
      <div className="text-center py-20">
        <p className="text-accent-red text-lg mb-2">Failed to load session</p>
        <p className="text-text-muted text-sm">{error}</p>
        <Link href="/" className="text-accent-blue text-sm mt-4 inline-block hover:underline">
          Back to sessions
        </Link>
      </div>
    );
  }

  return (
    <div className="pb-48">
      {/* Header */}
      <div className="mb-6">
        <Link
          href="/"
          className="text-sm text-text-muted hover:text-text-secondary transition-colors mb-2 inline-block"
        >
          ← Back to sessions
        </Link>
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold">Session</h1>
          <span className="text-sm text-text-muted font-mono">{id.slice(0, 8)}</span>
          <span className="text-xs text-text-muted">
            {nodes.length} nodes
          </span>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-accent-blue border-t-transparent" />
        </div>
      ) : (
        <>
          <Timeline nodes={nodes} />

          {/* Action area */}
          <div className="mt-8 space-y-4">
            <SuggestionButtons
              suggestions={suggestions}
              loading={suggestionsLoading}
              disabled={running}
              onSelect={handleRun}
              onLoad={loadSuggestions}
            />

            <PromptInput
              disabled={running}
              loading={running}
              onSubmit={handleRun}
            />
          </div>

          {error && (
            <div className="mt-4 p-3 rounded-lg bg-accent-red/10 border border-accent-red/20 text-accent-red text-sm">
              {error}
            </div>
          )}
        </>
      )}
    </div>
  );
}
