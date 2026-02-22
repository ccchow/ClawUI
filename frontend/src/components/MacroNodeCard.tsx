"use client";

import { useState } from "react";
import Link from "next/link";
import { type MacroNode, runNode } from "@/lib/api";
import { StatusIndicator } from "./StatusIndicator";

export function MacroNodeCard({
  node,
  index,
  total,
  blueprintId,
  onRefresh,
}: {
  node: MacroNode;
  index: number;
  total: number;
  blueprintId?: string;
  onRefresh?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [running, setRunning] = useState(false);
  const isLast = index === total - 1;
  const canRun = blueprintId && (node.status === "pending" || node.status === "failed");

  const handleRun = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!blueprintId || running) return;
    setRunning(true);
    // Fire and forget — don't await the long-running execution
    // The parent page polls for status updates
    runNode(blueprintId, node.id)
      .catch(() => {})
      .finally(() => {
        setRunning(false);
        onRefresh?.();
      });
    // Trigger immediate refresh so parent starts polling
    setTimeout(() => onRefresh?.(), 1000);
  };

  return (
    <div className="flex gap-3">
      {/* Left: status dot + connector line */}
      <div className="flex flex-col items-center pt-4">
        <StatusIndicator status={running ? "running" : node.status} />
        {!isLast && (
          <div className="w-px flex-1 bg-border-primary mt-1" />
        )}
      </div>

      {/* Card */}
      <div
        className="flex-1 mb-2 rounded-xl border border-border-primary bg-bg-secondary hover:border-border-hover transition-colors cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        {/* Collapsed header */}
        <div className="p-4 flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-xs text-text-muted font-mono">
                #{index + 1}
              </span>
              <span className="font-medium text-text-primary truncate">
                {node.title}
              </span>
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-bg-tertiary text-text-muted capitalize">
                {running ? "running" : node.status}
              </span>
            </div>
            {!expanded && node.description && (
              <p className="text-sm text-text-muted mt-1 line-clamp-1">
                {node.description}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {canRun && (
              <button
                onClick={handleRun}
                disabled={running}
                className="px-2.5 py-1 rounded-lg bg-accent-green/20 text-accent-green text-xs font-medium hover:bg-accent-green/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
              >
                {running ? (
                  <>
                    <span className="inline-block w-3 h-3 border-2 border-accent-green/30 border-t-accent-green rounded-full animate-spin" />
                    Running...
                  </>
                ) : (
                  <>&#9654; Run</>
                )}
              </button>
            )}
            {node.executions.length > 0 && (
              <span className="text-xs text-text-muted">
                {node.executions.length} exec{node.executions.length !== 1 ? "s" : ""}
              </span>
            )}
            <span className={`text-text-muted text-xs transition-transform ${expanded ? "rotate-180" : ""}`}>
              ▼
            </span>
          </div>
        </div>

        {/* Expanded details */}
        {expanded && (
          <div className="px-4 pb-4 border-t border-border-primary pt-3 space-y-3">
            {node.description && (
              <p className="text-sm text-text-secondary whitespace-pre-wrap">
                {node.description}
              </p>
            )}

            {node.prompt && (
              <div>
                <h4 className="text-xs text-text-muted mb-1">Prompt</h4>
                <p className="text-sm text-text-secondary bg-bg-tertiary rounded-lg p-2 whitespace-pre-wrap font-mono text-xs">
                  {node.prompt}
                </p>
              </div>
            )}

            {/* Artifacts */}
            {(node.inputArtifacts.length > 0 || node.outputArtifacts.length > 0) && (
              <div>
                <h4 className="text-xs text-text-muted mb-1">Artifacts</h4>
                <div className="space-y-1">
                  {node.inputArtifacts.map((a) => (
                    <div key={a.id} className="text-xs text-text-secondary flex items-center gap-1.5">
                      <span className="text-accent-blue">&#8592;</span>
                      <span className="capitalize">{a.type.replace(/_/g, " ")}</span>
                    </div>
                  ))}
                  {node.outputArtifacts.map((a) => (
                    <div key={a.id} className="text-xs text-text-secondary flex items-center gap-1.5">
                      <span className="text-accent-green">&#8594;</span>
                      <span className="capitalize">{a.type.replace(/_/g, " ")}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Executions */}
            {node.executions.length > 0 && (
              <div>
                <h4 className="text-xs text-text-muted mb-1">Executions</h4>
                <div className="space-y-1">
                  {node.executions.map((exec) => (
                    <div key={exec.id} className="flex items-center gap-2 text-xs">
                      <StatusIndicator status={exec.status} size="sm" />
                      <span className="text-text-secondary capitalize">{exec.type}</span>
                      <span className="text-text-muted">·</span>
                      <span className="text-text-muted">{exec.status}</span>
                      {exec.sessionId && (
                        <Link
                          href={`/session/${exec.sessionId}`}
                          className="text-accent-blue hover:underline ml-auto"
                          onClick={(e) => e.stopPropagation()}
                        >
                          session {exec.sessionId.slice(0, 8)}
                        </Link>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {node.error && (
              <div className="text-sm text-accent-red bg-accent-red/10 rounded-lg p-2">
                {node.error}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
