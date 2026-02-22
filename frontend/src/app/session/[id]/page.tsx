"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  getTimeline,
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

  const handleRun = async (prompt: string) => {
    setRunning(true);
    setError(null);
    console.log("[ClawUI] Starting run:", { sessionId: id, prompt: prompt.slice(0, 50) });
    const startTime = Date.now();
    try {
      const url = `http://localhost:3001/api/sessions/${id}/run`;
      console.log("[ClawUI] POST", url);
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const elapsed = Date.now() - startTime;
      console.log("[ClawUI] Response received:", { status: res.status, elapsed: `${elapsed}ms` });
      
      if (!res.ok) {
        const body = await res.text();
        console.error("[ClawUI] API error:", body);
        throw new Error(`API error ${res.status}: ${body}`);
      }

      const data = await res.json();
      console.log("[ClawUI] Parsed response:", { 
        outputLen: data.output?.length, 
        suggestionsCount: data.suggestions?.length,
        outputPreview: data.output?.slice(0, 100),
      });

      // Append prompt + result as new timeline nodes
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
          title: (data.output || "").slice(0, 120),
          content: data.output || "(empty response)",
        },
      ]);
      // Update suggestions from the same response
      setSuggestions(data.suggestions || []);
    } catch (e) {
      const elapsed = Date.now() - startTime;
      console.error("[ClawUI] Run failed:", { elapsed: `${elapsed}ms`, error: e });
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      console.log("[ClawUI] Run complete, setting running=false");
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
              disabled={running}
              onSelect={handleRun}
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
