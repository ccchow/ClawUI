"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  type Blueprint,
  type MacroNode,
  type NodeExecution,
  getBlueprint,
  getNodeExecutions,
  runNode,
} from "@/lib/api";
import { StatusIndicator } from "@/components/StatusIndicator";

function formatDuration(startedAt: string, completedAt?: string): string {
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}m ${secs}s`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

export default function NodeDetailPage() {
  const params = useParams();
  const blueprintId = params.id as string;
  const nodeId = params.nodeId as string;

  const [blueprint, setBlueprint] = useState<Blueprint | null>(null);
  const [node, setNode] = useState<MacroNode | null>(null);
  const [executions, setExecutions] = useState<NodeExecution[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [bp, execs] = await Promise.all([
        getBlueprint(blueprintId),
        getNodeExecutions(blueprintId, nodeId),
      ]);
      setBlueprint(bp);
      const found = bp.nodes.find((n) => n.id === nodeId) ?? null;
      setNode(found);
      setExecutions(execs);
      return found;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setLoading(false);
    }
  }, [blueprintId, nodeId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Auto-poll when node is running
  useEffect(() => {
    if (node?.status === "running") {
      pollRef.current = setInterval(() => {
        loadData();
      }, 5000);
    } else {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [node?.status, loadData]);

  const handleRun = async () => {
    if (running) return;
    setRunning(true);
    setError(null);
    runNode(blueprintId, nodeId)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => {
        setRunning(false);
        loadData();
      });
    setTimeout(() => loadData(), 1000);
  };

  if (loading) {
    return (
      <div className="text-center py-16 text-text-muted">Loading node...</div>
    );
  }

  if (error && !node) {
    return (
      <div className="text-center py-16 text-accent-red">
        Failed to load node: {error}
      </div>
    );
  }

  if (!node || !blueprint) {
    return (
      <div className="text-center py-16 text-text-muted">Node not found</div>
    );
  }

  const canRun = node.status === "pending" || node.status === "failed";
  const isRunning = running || node.status === "running";

  // Find dependency nodes from the blueprint
  const depNodes = node.dependencies
    .map((depId) => blueprint.nodes.find((n) => n.id === depId))
    .filter(Boolean) as MacroNode[];

  return (
    <div>
      <Link
        href={`/blueprints/${blueprintId}`}
        className="text-sm text-text-muted hover:text-text-secondary transition-colors mb-4 inline-block"
      >
        &#8592; Back to {blueprint.title}
      </Link>

      {/* Node Header */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <StatusIndicator status={isRunning ? "running" : node.status} />
          <h1 className="text-xl font-semibold">{node.title}</h1>
          <span className="text-xs px-2 py-0.5 rounded-full bg-bg-tertiary text-text-muted capitalize">
            {isRunning ? "running" : node.status}
          </span>
          {isRunning && (
            <span className="inline-block w-3 h-3 border-2 border-accent-blue/30 border-t-accent-blue rounded-full animate-spin" />
          )}
        </div>

        {node.description && (
          <p className="text-sm text-text-secondary whitespace-pre-wrap mb-3">
            {node.description}
          </p>
        )}

        {node.prompt && (
          <div className="mb-3">
            <h3 className="text-xs text-text-muted mb-1 font-medium uppercase tracking-wide">
              Prompt
            </h3>
            <pre className="text-sm text-text-secondary bg-bg-tertiary rounded-lg p-3 whitespace-pre-wrap font-mono text-xs overflow-x-auto">
              {node.prompt}
            </pre>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex gap-2">
          {canRun && (
            <button
              onClick={handleRun}
              disabled={isRunning}
              className="px-4 py-2 rounded-lg bg-accent-green text-white text-sm font-medium hover:bg-accent-green/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {isRunning ? (
                <>
                  <span className="inline-block w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Running...
                </>
              ) : (
                <>&#9654; Run</>
              )}
            </button>
          )}
          {node.status === "failed" && (
            <button
              onClick={handleRun}
              disabled={isRunning}
              className="px-4 py-2 rounded-lg border border-accent-orange text-accent-orange text-sm font-medium hover:bg-accent-orange/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Retry
            </button>
          )}
          {isRunning && (
            <span className="text-xs text-text-muted self-center">
              Auto-refreshing every 5s
            </span>
          )}
        </div>
      </div>

      {error && (
        <div className="text-sm text-accent-red bg-accent-red/10 rounded-lg p-3 mb-4">
          {error}
        </div>
      )}

      {node.error && (
        <div className="text-sm text-accent-red bg-accent-red/10 rounded-lg p-3 mb-4">
          <span className="font-medium">Error:</span> {node.error}
        </div>
      )}

      <div className="space-y-6">
        {/* Dependencies */}
        {depNodes.length > 0 && (
          <section>
            <h2 className="text-sm font-medium text-text-primary mb-2">
              Dependencies
            </h2>
            <div className="space-y-2">
              {depNodes.map((dep) => (
                <Link
                  key={dep.id}
                  href={`/blueprints/${blueprintId}/nodes/${dep.id}`}
                  className="flex items-center gap-3 p-3 rounded-lg border border-border-primary bg-bg-secondary hover:border-border-hover transition-colors"
                >
                  <StatusIndicator status={dep.status} size="sm" />
                  <span className="text-sm text-text-primary">{dep.title}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-bg-tertiary text-text-muted capitalize ml-auto">
                    {dep.status}
                  </span>
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* Input Artifacts */}
        {node.inputArtifacts.length > 0 && (
          <section>
            <h2 className="text-sm font-medium text-text-primary mb-2">
              Input Artifacts
            </h2>
            <div className="space-y-2">
              {node.inputArtifacts.map((a) => {
                const sourceNode = blueprint.nodes.find(
                  (n) => n.id === a.sourceNodeId
                );
                return (
                  <div
                    key={a.id}
                    className="rounded-lg border border-border-primary bg-bg-secondary p-3"
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-accent-blue">&#8592;</span>
                      <span className="text-xs font-medium text-text-secondary capitalize">
                        {a.type.replace(/_/g, " ")}
                      </span>
                      {sourceNode && (
                        <span className="text-xs text-text-muted">
                          from {sourceNode.title}
                        </span>
                      )}
                    </div>
                    {a.content && (
                      <pre className="text-xs text-text-muted bg-bg-tertiary rounded p-2 mt-1 whitespace-pre-wrap max-h-40 overflow-y-auto">
                        {a.content}
                      </pre>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Execution History */}
        <section>
          <h2 className="text-sm font-medium text-text-primary mb-2">
            Execution History
            {executions.length > 0 && (
              <span className="text-text-muted font-normal ml-1">
                ({executions.length})
              </span>
            )}
          </h2>
          {executions.length === 0 ? (
            <p className="text-sm text-text-muted py-4 text-center border border-dashed border-border-primary rounded-lg">
              No executions yet
            </p>
          ) : (
            <div className="space-y-2">
              {executions.map((exec) => (
                <div
                  key={exec.id}
                  className="rounded-lg border border-border-primary bg-bg-secondary p-3"
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <StatusIndicator status={exec.status} size="sm" />
                    <span className="text-xs font-medium text-text-secondary capitalize">
                      {exec.type}
                    </span>
                    <span className="text-xs text-text-muted capitalize">
                      {exec.status}
                    </span>
                    <span className="text-xs text-text-muted">
                      {formatDuration(exec.startedAt, exec.completedAt)}
                    </span>
                    {exec.sessionId && (
                      <Link
                        href={`/session/${exec.sessionId}`}
                        className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-accent-blue/15 text-accent-blue hover:bg-accent-blue/25 transition-colors text-xs font-medium"
                      >
                        <svg
                          className="w-3 h-3"
                          viewBox="0 0 16 16"
                          fill="currentColor"
                        >
                          <path d="M1.5 3A1.5 1.5 0 0 1 3 1.5h10A1.5 1.5 0 0 1 14.5 3v10a1.5 1.5 0 0 1-1.5 1.5H3A1.5 1.5 0 0 1 1.5 13V3zM3 2.5a.5.5 0 0 0-.5.5v10a.5.5 0 0 0 .5.5h10a.5.5 0 0 0 .5-.5V3a.5.5 0 0 0-.5-.5H3z" />
                          <path d="M4 5.5a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1-.5-.5zm0 2.5a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7A.5.5 0 0 1 4 8zm0 2.5a.5.5 0 0 1 .5-.5h4a.5.5 0 0 1 0 1h-4a.5.5 0 0 1-.5-.5z" />
                        </svg>
                        Session {exec.sessionId.slice(0, 8)}
                      </Link>
                    )}
                  </div>
                  <div className="text-[11px] text-text-muted mt-1">
                    Started {formatTime(exec.startedAt)}
                    {exec.completedAt && <> &middot; Completed {formatTime(exec.completedAt)}</>}
                  </div>
                  {exec.outputSummary && (
                    <pre className="text-xs text-text-muted bg-bg-tertiary rounded p-2 mt-2 whitespace-pre-wrap max-h-32 overflow-y-auto">
                      {exec.outputSummary}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Output Artifacts */}
        {node.outputArtifacts.length > 0 && (
          <section>
            <h2 className="text-sm font-medium text-text-primary mb-2">
              Output Artifacts
            </h2>
            <div className="space-y-2">
              {node.outputArtifacts.map((a) => {
                const targetNode = blueprint.nodes.find(
                  (n) => n.id === a.targetNodeId
                );
                return (
                  <div
                    key={a.id}
                    className="rounded-lg border border-border-primary bg-bg-secondary p-3"
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-accent-green">&#8594;</span>
                      <span className="text-xs font-medium text-text-secondary capitalize">
                        {a.type.replace(/_/g, " ")}
                      </span>
                      {targetNode && (
                        <span className="text-xs text-text-muted">
                          to {targetNode.title}
                        </span>
                      )}
                    </div>
                    {a.content && (
                      <pre className="text-xs text-text-muted bg-bg-tertiary rounded p-2 mt-1 whitespace-pre-wrap max-h-40 overflow-y-auto">
                        {a.content}
                      </pre>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
