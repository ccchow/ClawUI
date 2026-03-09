"use client";

import { useState, useRef, useEffect, useCallback, useMemo, Fragment } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  type AutopilotLogEntry,
  type AutopilotMessage,
  type BlueprintStatus,
  type ExecutionMode,
  fetchAutopilotLog,
  getBlueprintMessages,
  sendBlueprintMessage,
  updateBlueprint,
  runAllNodes,
} from "@/lib/api";
import { usePollingInterval } from "@/lib/polling-utils";
import { useVirtualizer } from "@tanstack/react-virtual";
import { BlueprintSuggestions } from "./BlueprintSuggestions";
import { MarkdownContent } from "./MarkdownContent";

interface BlueprintChatProps {
  blueprintId: string;
  executionMode: ExecutionMode | undefined;
  blueprintStatus: BlueprintStatus;
  pauseReason?: string;
  isReevaluating: boolean;
  isRunning: boolean;
  hasNodes: boolean;
  onReevaluateAll: () => void;
  onUpdate: (patch: { executionMode?: ExecutionMode; status?: string }) => void;
  onInvalidate: () => void;
  onBroadcast: (type: string) => void;
  onScrollToNode?: (nodeId: string) => void;
}

// ─── Unified chat item ────────────────────────────────────────

type ChatItem =
  | { kind: "user-message"; id: string; content: string; createdAt: string }
  | { kind: "system-message"; id: string; content: string; createdAt: string }
  | { kind: "assistant-message"; id: string; content: string; createdAt: string }
  | { kind: "log-entry"; id: string; entry: AutopilotLogEntry; createdAt: string }
  | { kind: "pause"; id: string; reason: string; createdAt: string };

// ─── Helpers ──────────────────────────────────────────────────

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function absoluteTime(dateStr: string): string {
  const d = new Date(dateStr);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function statusIcon(result: string | undefined): { icon: string; color: string } {
  if (!result) return { icon: "\u2713", color: "text-accent-green" };
  const r = result.toLowerCase();
  if (r.includes("error") || r.includes("fail")) return { icon: "\u2715", color: "text-accent-red" };
  if (r.includes("retry") || r.includes("resume") || r.includes("continuation")) return { icon: "\u21BB", color: "text-accent-blue" };
  if (r.includes("warn") || r.includes("pause") || r.includes("skip")) return { icon: "\u26A0", color: "text-accent-amber" };
  return { icon: "\u2713", color: "text-accent-green" };
}

function extractNodeId(reason: string): string | null {
  const match = reason.match(/node[:\s]+([a-f0-9-]{8,})/i);
  return match ? match[1] : null;
}

function getDateKey(dateStr: string): string {
  const d = new Date(dateStr);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatDateLabel(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();

  const dateDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const diffDays = Math.round((today.getTime() - dateDay.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";

  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const label = `${months[date.getMonth()]} ${date.getDate()}`;
  return date.getFullYear() === now.getFullYear() ? label : `${label}, ${date.getFullYear()}`;
}

// ─── Virtual scrolling ──────────────────────────────────────

export const VIRTUALIZATION_THRESHOLD = 100;

type DisplayItem =
  | { type: "separator"; label: string; key: string }
  | { type: "chat"; item: ChatItem; key: string };

// ─── Sticky date separator ──────────────────────────────────

function DateSeparator({ label }: { label: string }) {
  return (
    <div className="sticky top-0 z-10 flex justify-center py-1.5 -mx-4 px-4 bg-bg-primary">
      <span className="text-[11px] font-medium text-text-muted bg-bg-tertiary px-3 py-0.5 rounded-full">
        {label}
      </span>
    </div>
  );
}

// ─── Log entry row (left-aligned) ─────────────────────────────

function LogEntryBubble({ entry }: { entry: AutopilotLogEntry }) {
  const { icon, color } = statusIcon(entry.result);
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] lg:max-w-[70%]">
        <div className="flex items-start gap-2 rounded-xl bg-bg-secondary border border-border-primary px-3 py-2">
          <span className={`${color} text-sm flex-shrink-0 pt-0.5`}>{icon}</span>
          <div className="flex-1 min-w-0">
            <span className="font-medium text-sm text-text-primary block truncate">
              {entry.action}
            </span>
            {entry.decision && (
              <p
                className={`text-text-secondary text-xs mt-0.5 ${expanded ? "" : "line-clamp-2"}`}
                onClick={() => setExpanded((v) => !v)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setExpanded((v) => !v); }}
              >
                {entry.decision}
              </p>
            )}
          </div>
        </div>
        <span
          className="text-[10px] text-text-muted ml-3 mt-0.5 block"
          title={absoluteTime(entry.createdAt)}
        >
          {relativeTime(entry.createdAt)}
        </span>
      </div>
    </div>
  );
}

// ─── User message bubble (right-aligned) ──────────────────────

function UserMessageBubble({ content, createdAt }: { content: string; createdAt: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] lg:max-w-[70%]">
        <div className="rounded-xl bg-accent-blue/10 border border-accent-blue/20 px-3 py-2">
          <MarkdownContent content={content} maxHeight="none" className="text-sm" />
        </div>
        <span
          className="text-[10px] text-text-muted mr-3 mt-0.5 block text-right"
          title={absoluteTime(createdAt)}
        >
          {relativeTime(createdAt)}
        </span>
      </div>
    </div>
  );
}

// ─── System message ───────────────────────────────────────────

function SystemMessageBubble({ content, createdAt }: { content: string; createdAt: string }) {
  return (
    <div className="flex justify-center">
      <div className="max-w-[85%]">
        <div className="rounded-lg bg-bg-tertiary/50 border border-border-primary px-3 py-1.5 text-center">
          <MarkdownContent content={content} maxHeight="none" className="text-xs" />
        </div>
        <span
          className="text-[10px] text-text-muted mt-0.5 block text-center"
          title={absoluteTime(createdAt)}
        >
          {relativeTime(createdAt)}
        </span>
      </div>
    </div>
  );
}

// ─── Assistant message bubble (left-aligned) ─────────────────

function AssistantMessageBubble({ content, createdAt }: { content: string; createdAt: string }) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] lg:max-w-[70%]">
        <div className="rounded-xl bg-accent-green/10 border border-accent-green/20 px-3 py-2">
          <MarkdownContent content={content} maxHeight="none" className="text-sm" />
        </div>
        <span
          className="text-[10px] text-text-muted ml-3 mt-0.5 block"
          title={absoluteTime(createdAt)}
        >
          {relativeTime(createdAt)}
        </span>
      </div>
    </div>
  );
}

// ─── Pause system message with Resume ─────────────────────────

function PauseMessage({
  reason,
  createdAt,
  executionMode,
  blueprintId,
  onUpdate,
  onInvalidate,
  onBroadcast,
  onScrollToNode,
}: {
  reason: string;
  createdAt: string;
  executionMode: ExecutionMode | undefined;
  blueprintId: string;
  onUpdate: BlueprintChatProps["onUpdate"];
  onInvalidate: BlueprintChatProps["onInvalidate"];
  onBroadcast: BlueprintChatProps["onBroadcast"];
  onScrollToNode?: BlueprintChatProps["onScrollToNode"];
}) {
  const [resuming, setResuming] = useState(false);
  const isFsd = executionMode === "fsd";
  const modeLabel = isFsd ? "FSD" : "Autopilot";
  const relevantNodeId = extractNodeId(reason);

  const handleResume = async () => {
    setResuming(true);
    try {
      await updateBlueprint(blueprintId, { status: "running", pauseReason: "" });
      onUpdate({ status: "running" });
      await runAllNodes(blueprintId, { safeguardGrace: 5 });
      onBroadcast("autopilot_resume");
      onInvalidate();
    } catch {
      // revert
    } finally {
      setResuming(false);
    }
  };

  return (
    <div className="flex justify-center" role="alert" aria-live="assertive">
      <div className="max-w-[90%] lg:max-w-[75%] w-full">
        <div className="rounded-lg bg-accent-amber/10 border border-accent-amber/30 px-4 py-3">
          <div className="flex items-start gap-2 mb-2">
            <svg
              className="w-4 h-4 text-accent-amber flex-shrink-0 mt-0.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <div>
              <p className="text-sm font-medium text-text-primary">{modeLabel} Paused</p>
              <p className="text-xs text-text-secondary mt-1">{reason}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {relevantNodeId && onScrollToNode && (
              <button
                onClick={() => onScrollToNode(relevantNodeId)}
                className="text-xs text-accent-blue hover:text-accent-blue/80 transition-colors"
              >
                Review Issue
              </button>
            )}
            <button
              onClick={handleResume}
              disabled={resuming}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-accent-green/15 text-accent-green border border-accent-green/30 text-xs font-medium hover:bg-accent-green/25 transition-all active:scale-[0.97] disabled:opacity-disabled disabled:cursor-not-allowed"
            >
              {resuming ? "Resuming..." : `Resume ${modeLabel}`}
            </button>
          </div>
        </div>
        <span
          className="text-[10px] text-text-muted mt-0.5 block text-center"
          title={absoluteTime(createdAt)}
        >
          {relativeTime(createdAt)}
        </span>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────

export function BlueprintChat({
  blueprintId,
  executionMode,
  blueprintStatus,
  pauseReason,
  isReevaluating,
  isRunning,
  hasNodes,
  onReevaluateAll,
  onUpdate,
  onInvalidate,
  onBroadcast,
  onScrollToNode,
}: BlueprintChatProps) {
  const [messageText, setMessageText] = useState("");
  const [sending, setSending] = useState(false);
  const chatContainerRef = useRef<HTMLDivElement>(null);

  const isAutopilotActive =
    (executionMode === "autopilot" || executionMode === "fsd") &&
    blueprintStatus === "running";

  const isAutopilot = executionMode === "autopilot" || executionMode === "fsd";
  const isPaused = blueprintStatus === "paused" && !!pauseReason && isAutopilot;
  const isDraft = blueprintStatus === "draft";

  // ─── Polling intervals ────────────────────────────────────

  const logInterval = usePollingInterval(
    useCallback(() => (isAutopilotActive ? 5000 : isAutopilot ? 15000 : false), [isAutopilotActive, isAutopilot]),
  );

  const msgInterval = usePollingInterval(
    useCallback(() => (isAutopilotActive ? 5000 : 10000), [isAutopilotActive]),
  );

  // ─── Queries ──────────────────────────────────────────────

  const { data: logEntries = [] } = useQuery({
    queryKey: ["autopilot-log", blueprintId, "chat"],
    queryFn: () => fetchAutopilotLog(blueprintId, 50, 0),
    refetchInterval: logInterval,
  });

  const { data: messagesData, refetch: refetchMessages } = useQuery({
    queryKey: ["blueprint-messages", blueprintId],
    queryFn: () => getBlueprintMessages(blueprintId, 100, 0),
    refetchInterval: msgInterval,
  });

  const messages = messagesData?.messages ?? [];

  // ─── Merge into unified timeline ──────────────────────────

  const chatItems: ChatItem[] = useMemo(() => {
    const items: ChatItem[] = [];

    for (const msg of messages) {
      if (msg.role === "user") {
        items.push({ kind: "user-message", id: `msg-${msg.id}`, content: msg.content, createdAt: msg.createdAt });
      } else if (msg.role === "assistant") {
        items.push({ kind: "assistant-message", id: `msg-${msg.id}`, content: msg.content, createdAt: msg.createdAt });
      } else {
        items.push({ kind: "system-message", id: `msg-${msg.id}`, content: msg.content, createdAt: msg.createdAt });
      }
    }

    for (const entry of logEntries) {
      items.push({ kind: "log-entry", id: `log-${entry.id}`, entry, createdAt: entry.createdAt });
    }

    // Inject pause as a synthetic item at the current time
    if (isPaused && pauseReason) {
      items.push({ kind: "pause", id: "pause-current", reason: pauseReason, createdAt: new Date().toISOString() });
    }

    // Sort descending (newest first → newest at top)
    items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return items;
  }, [messages, logEntries, isPaused, pauseReason]);

  // ─── Virtual scrolling setup ─────────────────────────────

  const displayItems: DisplayItem[] = useMemo(() => {
    const result: DisplayItem[] = [];
    for (let i = 0; i < chatItems.length; i++) {
      const item = chatItems[i];
      const dateKey = getDateKey(item.createdAt);
      const prevDateKey = i > 0 ? getDateKey(chatItems[i - 1].createdAt) : null;
      if (dateKey !== prevDateKey) {
        result.push({ type: "separator", label: formatDateLabel(item.createdAt), key: `sep-${dateKey}-${i}` });
      }
      result.push({ type: "chat", item, key: item.id });
    }
    return result;
  }, [chatItems]);

  const shouldVirtualize = displayItems.length >= VIRTUALIZATION_THRESHOLD;

  const virtualizer = useVirtualizer({
    count: shouldVirtualize ? displayItems.length : 0,
    getScrollElement: () => chatContainerRef.current,
    estimateSize: (index) => (displayItems[index]?.type === "separator" ? 32 : 72),
    overscan: 15,
  });

  const renderChatItem = (item: ChatItem) => {
    switch (item.kind) {
      case "user-message":
        return <UserMessageBubble content={item.content} createdAt={item.createdAt} />;
      case "assistant-message":
        return <AssistantMessageBubble content={item.content} createdAt={item.createdAt} />;
      case "system-message":
        return <SystemMessageBubble content={item.content} createdAt={item.createdAt} />;
      case "log-entry":
        return <LogEntryBubble entry={item.entry} />;
      case "pause":
        return (
          <PauseMessage
            reason={item.reason}
            createdAt={item.createdAt}
            executionMode={executionMode}
            blueprintId={blueprintId}
            onUpdate={onUpdate}
            onInvalidate={onInvalidate}
            onBroadcast={onBroadcast}
            onScrollToNode={onScrollToNode}
          />
        );
      default:
        return null;
    }
  };

  // ─── Auto-scroll ──────────────────────────────────────────

  // Scroll to top when new items arrive (newest messages are at top)
  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop = 0;
    }
  }, [chatItems.length]);

  // ─── Send handler ─────────────────────────────────────────

  const handleSend = async () => {
    const text = messageText.trim();
    if (!text || sending || isDraft) return;
    setSending(true);
    try {
      await sendBlueprintMessage(blueprintId, text);
      setMessageText("");
      refetchMessages();
      onInvalidate();
    } catch {
      // non-critical
    } finally {
      setSending(false);
    }
  };

  // ─── Status indicator ─────────────────────────────────────

  const statusLabel = isAutopilotActive
    ? "Autopilot active"
    : isPaused
      ? "Autopilot paused"
      : "Manual mode";

  const statusDotColor = isAutopilotActive
    ? "bg-accent-green"
    : isPaused
      ? "bg-accent-amber"
      : "bg-text-muted";

  // ─── Render ───────────────────────────────────────────────

  return (
    <div className="rounded-xl border border-border-primary bg-bg-primary overflow-hidden flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border-primary bg-bg-secondary">
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          <span className="text-sm font-medium text-text-primary">Blueprint Chat</span>
          {/* Reevaluate All quick action */}
          {hasNodes && (
            <button
              onClick={onReevaluateAll}
              disabled={isRunning || isReevaluating}
              title={isReevaluating ? "AI is re-evaluating all nodes..." : isRunning ? "Cannot reevaluate while nodes are running" : "AI reads your codebase and updates all node titles, descriptions, and statuses"}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-accent-amber text-[11px] font-medium hover:bg-accent-amber/10 transition-all active:scale-[0.97] disabled:opacity-disabled disabled:cursor-not-allowed"
            >
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 2v6h-6" /><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M3 22v-6h6" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
              </svg>
              {isReevaluating ? "Reevaluating..." : "Reevaluate"}
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className={`w-1.5 h-1.5 rounded-full ${statusDotColor} ${isAutopilotActive ? "animate-pulse" : ""}`} />
          <span className="text-xs text-text-muted">{statusLabel}</span>
        </div>
      </div>

      {/* Chat messages */}
      <div
        ref={chatContainerRef}
        className="flex-1 overflow-y-auto px-4 py-3 min-h-[200px] max-h-[400px]"
      >
        {chatItems.length === 0 ? (
          <div className="text-center py-8 text-text-muted text-sm">
            {isAutopilot
              ? "Send a message to interact with autopilot. Log entries and responses will appear here."
              : "Send messages to queue instructions. They will be processed when autopilot is enabled."}
          </div>
        ) : shouldVirtualize ? (
          <div
            style={{
              height: virtualizer.getTotalSize(),
              width: "100%",
              position: "relative",
            }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const di = displayItems[virtualRow.index];
              return (
                <div
                  key={di.key}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                  className="pb-3"
                >
                  {di.type === "separator"
                    ? <DateSeparator label={di.label} />
                    : renderChatItem(di.item)}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="space-y-3">
            {chatItems.map((item, index) => {
              const dateKey = getDateKey(item.createdAt);
              const prevDateKey = index > 0 ? getDateKey(chatItems[index - 1].createdAt) : null;
              const showSeparator = dateKey !== prevDateKey;
              return (
                <Fragment key={item.id}>
                  {showSeparator && <DateSeparator label={formatDateLabel(item.createdAt)} />}
                  {renderChatItem(item)}
                </Fragment>
              );
            })}
          </div>
        )}
      </div>

      {/* Manual mode note */}
      {!isAutopilot && blueprintStatus !== "draft" && (
        <div className="px-4 py-1.5 bg-bg-tertiary/50 border-t border-border-primary">
          <p className="text-xs text-text-muted text-center">
            Manual mode &mdash; messages will be processed when autopilot is enabled
          </p>
        </div>
      )}

      {/* Suggestions (autopilot/fsd only) */}
      {isAutopilot && (
        <div className="px-4 py-2 border-t border-border-primary">
          <BlueprintSuggestions
            blueprintId={blueprintId}
            onSuggestionUsed={() => {
              refetchMessages();
              onInvalidate();
            }}
          />
        </div>
      )}

      {/* Chat input */}
      <div className="border-t border-border-primary px-4 py-3 bg-bg-secondary">
        <div className="flex items-end gap-2">
          <textarea
            value={messageText}
            onChange={(e) => setMessageText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            disabled={isDraft || sending}
            placeholder={
              isDraft
                ? "Approve the blueprint first to send messages..."
                : "Ask autopilot to generate nodes, enrich descriptions, or give feedback..."
            }
            rows={1}
            className="flex-1 px-3 py-2 rounded-lg bg-bg-tertiary text-text-primary text-sm placeholder:text-text-muted border border-border-primary focus:border-accent-blue/60 focus:outline-none resize-none max-h-24 overflow-y-auto disabled:opacity-disabled disabled:cursor-not-allowed"
          />
          <button
            onClick={handleSend}
            disabled={isDraft || sending || !messageText.trim()}
            title={isDraft ? "Approve the blueprint first" : sending ? "Sending..." : "Send message"}
            aria-label="Send message"
            className="p-2 rounded-lg bg-accent-blue text-white hover:bg-accent-blue/90 transition-all active:scale-[0.97] disabled:opacity-disabled disabled:cursor-not-allowed flex-shrink-0"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 2L11 13" /><path d="M22 2L15 22L11 13L2 9L22 2Z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
