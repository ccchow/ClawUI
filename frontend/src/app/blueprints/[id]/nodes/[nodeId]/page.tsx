"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  type Blueprint,
  type MacroNode,
  type NodeExecution,
  type PendingTask,
  getBlueprint,
  getNodeExecutions,
  getQueueStatus,
  runNode,
  updateMacroNode,
  enrichNode,
  reevaluateNode,
  recoverNodeSession,
  resumeNodeSession,
} from "@/lib/api";
import { StatusIndicator } from "@/components/StatusIndicator";
import { MarkdownContent } from "@/components/MarkdownContent";
import { MarkdownEditor } from "@/components/MarkdownEditor";
import { AISparkle } from "@/components/AISparkle";

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
  const [warning, setWarning] = useState<string | null>(null);
  const [depsExpanded, setDepsExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [saving, setSaving] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [reevaluating, setReevaluating] = useState(false);
  const [pendingTasks, setPendingTasks] = useState<PendingTask[]>([]);
  const [recovered, setRecovered] = useState(false);
  const [resumingExecId, setResumingExecId] = useState<string | null>(null);
  const [expandedInputs, setExpandedInputs] = useState<Set<string>>(new Set());
  const [collapsedOutputs, setCollapsedOutputs] = useState<Set<string>>(new Set());
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recoveryAttempted = useRef(false);

  const loadData = useCallback(async () => {
    try {
      const [bp, execs, queueInfo] = await Promise.all([
        getBlueprint(blueprintId),
        getNodeExecutions(blueprintId, nodeId),
        getQueueStatus(blueprintId),
      ]);
      setBlueprint(bp);
      const found = bp.nodes.find((n) => n.id === nodeId) ?? null;
      setNode(found);
      setExecutions(execs);
      setPendingTasks(queueInfo.pendingTasks);
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

  // Auto-recover lost sessions for nodes failed by server restart
  useEffect(() => {
    if (recoveryAttempted.current || !node || !executions.length) return;
    const isServerRestartError = node.error?.includes("Execution interrupted by server restart");
    const hasOrphanedExec = executions.some(
      (e) => e.status === "failed" && !e.sessionId &&
        e.outputSummary?.includes("Server restarted"),
    );
    if (isServerRestartError && hasOrphanedExec) {
      recoveryAttempted.current = true;
      recoverNodeSession(blueprintId, nodeId)
        .then((result) => {
          if (result.recovered) {
            setRecovered(true);
            loadData(); // Reload to show the recovered session links
          }
        })
        .catch(() => { /* silent — recovery is best-effort */ });
    }
  }, [node, executions, blueprintId, nodeId, loadData]);

  // Check for pending tasks on this node
  const reevaluateQueued = pendingTasks.some(
    (t) => t.nodeId === nodeId && t.type === "reevaluate"
  );
  const hasPendingTasks = pendingTasks.some((t) => t.nodeId === nodeId);

  // Auto-poll when node is running, queued, or has pending tasks (e.g. reevaluate queued)
  useEffect(() => {
    if (node?.status === "running" || node?.status === "queued" || hasPendingTasks) {
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
  }, [node?.status, hasPendingTasks, loadData]);

  const handleRun = async () => {
    if (running) return;
    setRunning(true);
    setWarning(null);
    runNode(blueprintId, nodeId)
      .catch((err) => {
        setWarning(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setRunning(false);
        loadData();
      });
  };

  const handleEnrich = async () => {
    if (!editTitle.trim()) return;
    setEnriching(true);
    try {
      const result = await enrichNode(blueprintId, {
        title: editTitle.trim(),
        description: editDesc.trim() || undefined,
      });
      setEditTitle(result.title);
      setEditDesc(result.description);
      // Auto-save enriched data to DB so it persists across page reloads
      if (node) {
        await updateMacroNode(blueprintId, node.id, {
          title: result.title,
          description: result.description,
        });
        setNode((prev) => prev ? { ...prev, title: result.title, description: result.description } : prev);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setEnriching(false);
    }
  };

  const handleReevaluate = async () => {
    if (reevaluating || reevaluateQueued) return;
    setReevaluating(true);
    try {
      await reevaluateNode(blueprintId, nodeId);
      // Fire-and-forget: result applied in background, polling will detect changes
      loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReevaluating(false);
    }
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
  const isQueued = node.status === "queued";
  const isRunning = running || node.status === "running";

  // Find dependency nodes from the blueprint
  const depNodes = node.dependencies
    .map((depId) => blueprint.nodes.find((n) => n.id === depId))
    .filter(Boolean) as MacroNode[];

  return (
    <div>
      <Link
        href={`/blueprints/${blueprintId}`}
        className="text-sm text-text-muted hover:text-text-secondary transition-colors mb-4 block truncate"
      >
        &#8592; Back to {blueprint.title}
      </Link>

      {/* Node Header */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2 min-w-0 overflow-hidden">
          <StatusIndicator status={isRunning ? "running" : reevaluateQueued ? "queued" : node.status} />
          {editing ? (
            <input
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              className="text-xl font-semibold flex-1 min-w-0 bg-bg-tertiary border border-accent-blue rounded-lg px-2 py-1 text-text-primary focus:outline-none"
              placeholder="Node title"
            />
          ) : (
            <h1
              className="text-xl font-semibold cursor-pointer hover:text-accent-blue transition-colors truncate min-w-0 flex-1"
              onClick={() => { setEditTitle(node.title); setEditDesc(node.description || ""); setEditing(true); }}
              title="Click to edit"
            >
              {node.title}
            </h1>
          )}
          <span className={`text-xs px-2 py-0.5 rounded-full capitalize flex-shrink-0 ${
            isQueued || reevaluateQueued ? "bg-accent-amber/20 text-accent-amber" : "bg-bg-tertiary text-text-muted"
          }`}>
            {isRunning ? "running" : reevaluateQueued ? "re-evaluating (queued)" : isQueued ? "queued" : node.status}
          </span>
          {isRunning && (
            <AISparkle size="sm" className="text-accent-blue" />
          )}
          {(isQueued || reevaluateQueued) && (
            <svg className="w-4 h-4 text-accent-amber animate-pulse flex-shrink-0" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 3.5a.5.5 0 0 0-1 0V8a.5.5 0 0 0 .252.434l3.5 2a.5.5 0 1 0 .496-.868L8 7.71V3.5z"/>
              <path d="M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16zm7-8A7 7 0 1 1 1 8a7 7 0 0 1 14 0z"/>
            </svg>
          )}
        </div>

        {editing ? (
          <div className="mb-3 space-y-2">
            <MarkdownEditor
              value={editDesc}
              onChange={setEditDesc}
              placeholder="Description (supports Markdown and image paste)"
              minHeight="120px"
            />
            <div className="flex gap-2 flex-wrap">
              <button
                onClick={async () => {
                  const trimmedTitle = editTitle.trim();
                  if (!trimmedTitle) return;
                  setSaving(true);
                  try {
                    const updates: Record<string, string> = {};
                    if (trimmedTitle !== node.title) updates.title = trimmedTitle;
                    if (editDesc !== (node.description || "")) updates.description = editDesc;
                    if (Object.keys(updates).length > 0) {
                      await updateMacroNode(blueprintId, node.id, updates);
                      setNode((prev) => prev ? { ...prev, ...updates } : prev);
                    }
                    setEditing(false);
                  } catch { /* ignore */ }
                  setSaving(false);
                }}
                disabled={!editTitle.trim() || saving}
                className="px-3 py-1.5 rounded-lg bg-accent-blue text-white text-xs font-medium hover:bg-accent-blue/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving ? "Saving..." : "Save"}
              </button>
              <button
                onClick={handleEnrich}
                disabled={!editTitle.trim() || enriching}
                className="px-3 py-1.5 rounded-lg bg-accent-purple text-white text-xs font-medium hover:bg-accent-purple/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {enriching ? (<><AISparkle size="xs" /> Enriching...</>) : "✨ Smart Enrich"}
              </button>
              <button
                onClick={() => setEditing(false)}
                className="px-3 py-1.5 rounded-lg border border-border-primary text-text-secondary text-xs hover:bg-bg-tertiary transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div
            className="text-sm mb-3 cursor-pointer hover:text-text-primary transition-colors"
            onClick={() => { setEditTitle(node.title); setEditDesc(node.description || ""); setEditing(true); }}
            title="Click to edit"
          >
            {node.description ? (
              <MarkdownContent content={node.description} />
            ) : (
              <span className="text-text-muted italic">Click to add description...</span>
            )}
          </div>
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
        <div className="flex gap-2 flex-wrap">
          {isQueued && (
            <span className="px-4 py-2 rounded-lg bg-accent-amber/20 text-accent-amber text-sm font-medium flex items-center gap-2">
              <svg className="w-4 h-4 animate-pulse" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 3.5a.5.5 0 0 0-1 0V8a.5.5 0 0 0 .252.434l3.5 2a.5.5 0 1 0 .496-.868L8 7.71V3.5z"/>
                <path d="M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16zm7-8A7 7 0 1 1 1 8a7 7 0 0 1 14 0z"/>
              </svg>
              Waiting in queue...
            </span>
          )}
          {canRun && (
            <button
              onClick={handleRun}
              disabled={isRunning}
              className="px-4 py-2 rounded-lg bg-accent-green text-white text-sm font-medium hover:bg-accent-green/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {isRunning ? (
                <>
                  <AISparkle size="sm" />
                  Running...
                </>
              ) : (
                <>&#9654; Run</>
              )}
            </button>
          )}
          {node.status === "pending" && (
            <button
              onClick={async () => {
                try {
                  await updateMacroNode(blueprintId, nodeId, { status: "done" });
                  loadData();
                } catch (err) {
                  setWarning(err instanceof Error ? err.message : String(err));
                }
              }}
              className="px-4 py-2 rounded-lg bg-green-600 text-white text-sm font-medium hover:bg-green-500 transition-colors flex items-center gap-2"
            >
              <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor">
                <path d="M13.485 1.929a.75.75 0 0 1 .086 1.056l-7.5 9a.75.75 0 0 1-1.107.048l-3.5-3.5a.75.75 0 1 1 1.061-1.061l2.905 2.905 6.999-8.399a.75.75 0 0 1 1.056-.086z" />
              </svg>
              Mark as Done
            </button>
          )}
          {node.status === "failed" && (
            <button
              onClick={handleRun}
              disabled={isRunning}
              className="px-4 py-2 rounded-lg border border-accent-amber text-accent-amber text-sm font-medium hover:bg-accent-amber/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Retry
            </button>
          )}
          {!isRunning && !isQueued && (
            <button
              onClick={handleReevaluate}
              disabled={reevaluating || reevaluateQueued}
              className="px-4 py-2 rounded-lg border border-accent-amber text-accent-amber text-sm font-medium hover:bg-accent-amber/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {reevaluating || reevaluateQueued ? (
                <>
                  <AISparkle size="sm" />
                  {reevaluateQueued ? "Re-evaluating (queued)..." : "Re-evaluating..."}
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 1 1 .908-.418A6 6 0 1 1 8 2v1z" />
                    <path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466z" />
                  </svg>
                  Re-evaluate
                </>
              )}
            </button>
          )}
          {warning && (
            <span
              className="text-accent-amber self-center cursor-help text-sm"
              title={warning}
            >
              &#9888;
            </span>
          )}
        </div>
        {warning && (
          <p className="text-xs text-accent-amber mt-2">{warning}</p>
        )}
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

      {recovered && (
        <div className="text-sm text-accent-green bg-accent-green/10 rounded-lg p-3 mb-4">
          Session recovered — a Claude Code session was found and linked to this node&apos;s execution.
        </div>
      )}

      <div className="space-y-6">
        {/* Dependencies (editable) */}
        <section>
          {blueprint.nodes.filter((n) => n.id !== node.id).length > 0 ? (
            <div>
              <button
                onClick={() => setDepsExpanded((v) => !v)}
                className="flex items-center gap-1 text-xs text-text-muted mb-1 hover:text-text-secondary transition-colors"
              >
                <span className={`transition-transform ${depsExpanded ? "rotate-90" : ""}`}>▶</span>
                Dependencies{depNodes.length > 0 && <span className="text-accent-blue ml-1">({depNodes.length} selected)</span>}
              </button>
              <div className={`flex gap-1.5 ${depsExpanded ? "flex-wrap" : "overflow-hidden max-h-[28px]"}`}>
                {blueprint.nodes
                  .filter((n) => n.id !== node.id)
                  .sort((a, b) => {
                    const aSelected = node.dependencies.includes(a.id) ? 0 : 1;
                    const bSelected = node.dependencies.includes(b.id) ? 0 : 1;
                    if (aSelected !== bSelected) return aSelected - bSelected;
                    return b.order - a.order;
                  })
                  .map((n) => {
                    const isDep = node.dependencies.includes(n.id);
                    return (
                      <button
                        key={n.id}
                        onClick={async () => {
                          const newDeps = isDep
                            ? node.dependencies.filter((d) => d !== n.id)
                            : [...node.dependencies, n.id];
                          try {
                            await updateMacroNode(blueprintId, node.id, { dependencies: newDeps });
                            setBlueprint((prev) => {
                              if (!prev) return prev;
                              return {
                                ...prev,
                                nodes: prev.nodes.map((nd) =>
                                  nd.id === node.id ? { ...nd, dependencies: newDeps } : nd
                                ),
                              };
                            });
                            setNode((prev) => prev ? { ...prev, dependencies: newDeps } : prev);
                          } catch { /* ignore */ }
                        }}
                        className={`flex-shrink-0 flex items-center gap-1.5 px-2 py-1 rounded-md text-xs border transition-colors ${
                          isDep
                            ? "border-accent-blue bg-accent-blue/20 text-accent-blue"
                            : "border-border-primary text-text-muted hover:border-border-hover"
                        }`}
                      >
                        <StatusIndicator status={n.status} size="sm" />
                        #{n.order + 1} {n.title.length > 30 ? n.title.slice(0, 30) + "…" : n.title}
                      </button>
                    );
                  })}
              </div>
            </div>
          ) : (
            <p className="text-xs text-text-muted">No other nodes to depend on.</p>
          )}
        </section>

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
                      <div className="text-xs bg-bg-tertiary rounded p-2 mt-1 max-h-96 overflow-y-auto [&_.space-y-3]:space-y-1.5 [&_.space-y-3]:max-h-none [&_.space-y-3]:text-xs">
                        <MarkdownContent content={a.content} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Execution History */}
        <section>
          <h2 className="text-sm font-medium text-text-primary mb-2 flex items-center gap-2">
            <span>
              Execution History
              {executions.length > 0 && (
                <span className="text-text-muted font-normal ml-1">
                  ({executions.length})
                </span>
              )}
            </span>
            {(isRunning || isQueued || hasPendingTasks) && (
              <span className="text-text-muted" title="Auto-refreshing every 5s">
                <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12a9 9 0 1 1-9-9" />
                  <polyline points="21 3 21 9 15 9" />
                </svg>
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
                      <>
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
                        {exec.status === "failed" &&
                          // Hide resume button if a continuation with the same session exists and hasn't failed
                          !executions.some(
                            (other) =>
                              other.id !== exec.id &&
                              other.sessionId === exec.sessionId &&
                              other.status !== "failed"
                          ) && (
                          <button
                            onClick={() => {
                              setResumingExecId(exec.id);
                              resumeNodeSession(blueprintId, nodeId, exec.id)
                                .catch((err) => setWarning(err instanceof Error ? err.message : String(err)))
                                .finally(() => {
                                  setResumingExecId(null);
                                  loadData();
                                });
                            }}
                            disabled={resumingExecId === exec.id || isRunning}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-green-600/15 text-green-500 hover:bg-green-600/25 transition-colors text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                            title="Resume this session"
                          >
                            {resumingExecId === exec.id ? (
                              <AISparkle size="xs" />
                            ) : (
                              <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
                                <path d="M4 2l10 6-10 6V2z" />
                              </svg>
                            )}
                          </button>
                        )}
                      </>
                    )}
                  </div>
                  {exec.failureReason && exec.status === "failed" && (
                    <div className={`flex items-center gap-1.5 mt-1.5 px-2 py-1 rounded text-xs font-medium ${
                      exec.failureReason === "context_exhausted"
                        ? "bg-orange-500/10 text-orange-400"
                        : exec.failureReason === "output_token_limit"
                        ? "bg-amber-500/10 text-amber-400"
                        : exec.failureReason === "timeout"
                        ? "bg-yellow-500/10 text-yellow-400"
                        : exec.failureReason === "hung"
                        ? "bg-purple-500/10 text-purple-400"
                        : "bg-accent-red/10 text-accent-red"
                    }`}>
                      {exec.failureReason === "context_exhausted" && (
                        <><span title="Context exhausted">&#x26A0;</span> Context exhausted — session ran out of context window space</>
                      )}
                      {exec.failureReason === "output_token_limit" && (
                        <><span title="Output token limit">&#x26A0;</span> Output token limit — response exceeded max output tokens</>
                      )}
                      {exec.failureReason === "timeout" && (
                        <><span title="Timeout">&#x23F1;</span> Timeout — execution exceeded the time limit</>
                      )}
                      {exec.failureReason === "hung" && (
                        <><span title="Hung">&#x1F6D1;</span> No output — Claude may have hung or stalled</>
                      )}
                      {exec.failureReason === "error" && (
                        <><span title="Error">&#x274C;</span> Error</>
                      )}
                    </div>
                  )}
                  <div className="text-[11px] text-text-muted mt-1">
                    Started {formatTime(exec.startedAt)}
                    {exec.completedAt && <> &middot; Completed {formatTime(exec.completedAt)}</>}
                  </div>
                  {exec.inputContext && (
                    <div className="mt-2">
                      <button
                        onClick={() => setExpandedInputs((prev) => {
                          const next = new Set(prev);
                          next.has(exec.id) ? next.delete(exec.id) : next.add(exec.id);
                          return next;
                        })}
                        className="flex items-center gap-1 text-xs text-text-muted hover:text-text-secondary transition-colors"
                      >
                        <span className={`transition-transform ${expandedInputs.has(exec.id) ? "rotate-90" : ""}`}>▶</span>
                        Prompt Sent
                      </button>
                      {expandedInputs.has(exec.id) && (
                        <div className="text-xs bg-bg-tertiary rounded p-2 mt-1 max-h-64 overflow-y-auto [&_.space-y-3]:space-y-1.5 [&_.space-y-3]:max-h-none [&_.space-y-3]:text-xs">
                          <MarkdownContent content={exec.inputContext} />
                        </div>
                      )}
                    </div>
                  )}
                  {exec.outputSummary && (
                    <div className="mt-2">
                      <button
                        onClick={() => setCollapsedOutputs((prev) => {
                          const next = new Set(prev);
                          next.has(exec.id) ? next.delete(exec.id) : next.add(exec.id);
                          return next;
                        })}
                        className="flex items-center gap-1 text-xs text-text-muted hover:text-text-secondary transition-colors"
                      >
                        <span className={`transition-transform ${!collapsedOutputs.has(exec.id) ? "rotate-90" : ""}`}>▶</span>
                        Output Summary
                      </button>
                      {!collapsedOutputs.has(exec.id) && (
                        <div className="text-xs bg-bg-tertiary rounded p-2 mt-1 max-h-64 overflow-y-auto [&_.space-y-3]:space-y-1.5 [&_.space-y-3]:max-h-none [&_.space-y-3]:text-xs">
                          <MarkdownContent content={exec.outputSummary} />
                        </div>
                      )}
                    </div>
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
                      <div className="text-xs bg-bg-tertiary rounded p-2 mt-1 max-h-96 overflow-y-auto [&_.space-y-3]:space-y-1.5 [&_.space-y-3]:max-h-none [&_.space-y-3]:text-xs">
                        <MarkdownContent content={a.content} />
                      </div>
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
