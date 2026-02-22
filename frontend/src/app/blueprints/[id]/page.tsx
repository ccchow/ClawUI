"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  type Blueprint,
  getBlueprint,
  approveBlueprint,
  updateBlueprint,
  createMacroNode,
  runAllNodes,
} from "@/lib/api";
import { StatusIndicator } from "@/components/StatusIndicator";
import { MacroNodeCard } from "@/components/MacroNodeCard";

export default function BlueprintDetailPage() {
  const params = useParams();
  const id = params.id as string;

  const [blueprint, setBlueprint] = useState<Blueprint | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Add node form
  const [showAddNode, setShowAddNode] = useState(false);
  const [nodeTitle, setNodeTitle] = useState("");
  const [nodeDescription, setNodeDescription] = useState("");
  const [addingNode, setAddingNode] = useState(false);

  const [approving, setApproving] = useState(false);
  const [runningAll, setRunningAll] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Editable description
  const [editingDesc, setEditingDesc] = useState(false);
  const [descValue, setDescValue] = useState("");
  const descRef = useRef<HTMLTextAreaElement>(null);

  const loadBlueprint = useCallback(() => {
    return getBlueprint(id)
      .then((bp) => {
        setBlueprint(bp);
        return bp;
      })
      .catch((err) => {
        setError(err.message);
        return null;
      })
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    loadBlueprint();
  }, [loadBlueprint]);

  // Auto-poll when blueprint is running
  useEffect(() => {
    if (blueprint?.status === "running") {
      pollRef.current = setInterval(() => {
        getBlueprint(id)
          .then((bp) => {
            setBlueprint(bp);
            if (bp.status !== "running") {
              // Stop polling when done/failed
              if (pollRef.current) clearInterval(pollRef.current);
              pollRef.current = null;
              setRunningAll(false);
            }
          })
          .catch(() => {});
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
  }, [blueprint?.status, id]);

  const handleApprove = async () => {
    setApproving(true);
    try {
      const updated = await approveBlueprint(id);
      setBlueprint(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setApproving(false);
    }
  };

  const handleRunAll = async () => {
    setRunningAll(true);
    setError(null);
    try {
      await runAllNodes(id);
      // Start polling — the useEffect above will handle it once status becomes "running"
      const bp = await getBlueprint(id);
      setBlueprint(bp);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRunningAll(false);
    }
  };

  const handleRefresh = () => {
    loadBlueprint();
  };

  const handleAddNode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nodeTitle.trim() || !blueprint) return;

    setAddingNode(true);
    try {
      const node = await createMacroNode(id, {
        title: nodeTitle.trim(),
        description: nodeDescription.trim() || undefined,
        order: blueprint.nodes.length,
      });
      setBlueprint((prev) =>
        prev ? { ...prev, nodes: [...prev.nodes, node] } : prev
      );
      setNodeTitle("");
      setNodeDescription("");
      setShowAddNode(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAddingNode(false);
    }
  };

  if (loading) {
    return (
      <div className="text-center py-16 text-text-muted">
        Loading blueprint...
      </div>
    );
  }

  if (error && !blueprint) {
    return (
      <div className="text-center py-16 text-accent-red">
        Failed to load blueprint: {error}
      </div>
    );
  }

  if (!blueprint) {
    return (
      <div className="text-center py-16 text-text-muted">
        Blueprint not found
      </div>
    );
  }

  const isRunning = blueprint.status === "running" || runningAll;
  const canRunAll = (blueprint.status === "approved" || blueprint.status === "failed" || blueprint.status === "paused")
    && blueprint.nodes.some((n) => n.status === "pending" || n.status === "failed");

  return (
    <div>
      <Link
        href="/blueprints"
        className="text-sm text-text-muted hover:text-text-secondary transition-colors mb-4 inline-block"
      >
        &#8592; Back to Blueprints
      </Link>

      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <StatusIndicator status={blueprint.status} />
          <h1 className="text-xl font-semibold">{blueprint.title}</h1>
          <span className="text-xs px-2 py-0.5 rounded-full bg-bg-tertiary text-text-muted capitalize">
            {blueprint.status}
          </span>
          {isRunning && (
            <span className="inline-block w-3 h-3 border-2 border-accent-blue/30 border-t-accent-blue rounded-full animate-spin" />
          )}
        </div>
        {editingDesc ? (
          <textarea
            ref={descRef}
            value={descValue}
            onChange={(e) => setDescValue(e.target.value)}
            onBlur={async () => {
              setEditingDesc(false);
              if (descValue !== (blueprint.description || "")) {
                try {
                  const updated = await updateBlueprint(id, { description: descValue });
                  setBlueprint(updated);
                } catch {
                  // revert
                }
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setEditingDesc(false);
                setDescValue(blueprint.description || "");
              }
            }}
            className="w-full text-sm px-3 py-2 rounded-lg bg-bg-tertiary border border-accent-blue text-text-primary placeholder:text-text-muted focus:outline-none resize-y min-h-[60px] mb-3"
            rows={2}
          />
        ) : (
          <p
            className="text-sm text-text-secondary mb-3 cursor-pointer hover:text-text-primary transition-colors"
            onClick={() => {
              setDescValue(blueprint.description || "");
              setEditingDesc(true);
              setTimeout(() => descRef.current?.focus(), 0);
            }}
            title="Click to edit"
          >
            {blueprint.description || <span className="text-text-muted italic">Click to add description...</span>}
          </p>
        )}
        {blueprint.projectCwd && (
          <p className="text-xs text-text-muted font-mono mb-3">
            {blueprint.projectCwd}
          </p>
        )}

        {/* Action buttons */}
        <div className="flex gap-2">
          {blueprint.status === "draft" && (
            <button
              onClick={handleApprove}
              disabled={approving}
              className="px-4 py-2 rounded-lg bg-accent-blue text-white text-sm font-medium hover:bg-accent-blue/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {approving ? "Approving..." : "Approve Plan"}
            </button>
          )}
          {canRunAll && (
            <button
              onClick={handleRunAll}
              disabled={isRunning}
              className="px-4 py-2 rounded-lg bg-accent-green text-white text-sm font-medium hover:bg-accent-green/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {isRunning ? (
                <>
                  <span className="inline-block w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Running...
                </>
              ) : (
                <>&#9654; Run All</>
              )}
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

      {/* Node chain */}
      {blueprint.nodes.length === 0 ? (
        <div className="text-center py-12 text-text-muted border border-dashed border-border-primary rounded-xl">
          <p className="mb-1">No nodes yet.</p>
          <p className="text-sm">Add your first task node to this blueprint.</p>
        </div>
      ) : (
        <div>
          {blueprint.nodes.map((node, i) => (
            <MacroNodeCard
              key={node.id}
              node={node}
              index={i}
              total={blueprint.nodes.length}
              blueprintId={blueprint.id}
              onRefresh={handleRefresh}
            />
          ))}
        </div>
      )}

      {/* Add Node */}
      <div className="mt-4">
        {showAddNode ? (
          <form
            onSubmit={handleAddNode}
            className="rounded-xl border border-border-primary bg-bg-secondary p-4 space-y-3"
          >
            <input
              type="text"
              value={nodeTitle}
              onChange={(e) => setNodeTitle(e.target.value)}
              placeholder="Node title"
              className="w-full px-3 py-2 rounded-lg bg-bg-tertiary border border-border-primary text-text-primary placeholder:text-text-muted text-sm focus:outline-none focus:border-accent-blue focus:ring-1 focus:ring-accent-blue/30"
              autoFocus
              required
            />
            <textarea
              value={nodeDescription}
              onChange={(e) => setNodeDescription(e.target.value)}
              placeholder="Description (optional)"
              rows={2}
              className="w-full px-3 py-2 rounded-lg bg-bg-tertiary border border-border-primary text-text-primary placeholder:text-text-muted text-sm focus:outline-none focus:border-accent-blue focus:ring-1 focus:ring-accent-blue/30 resize-y"
            />
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={!nodeTitle.trim() || addingNode}
                className="px-3 py-1.5 rounded-lg bg-accent-blue text-white text-sm hover:bg-accent-blue/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {addingNode ? "Adding..." : "Add Node"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowAddNode(false);
                  setNodeTitle("");
                  setNodeDescription("");
                }}
                className="px-3 py-1.5 rounded-lg border border-border-primary text-text-secondary text-sm hover:bg-bg-tertiary transition-colors"
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <button
            onClick={() => setShowAddNode(true)}
            className="w-full py-3 rounded-xl border border-dashed border-border-primary text-text-muted text-sm hover:border-border-hover hover:text-text-secondary hover:bg-bg-secondary transition-all"
          >
            + Add Node
          </button>
        )}
      </div>
    </div>
  );
}
