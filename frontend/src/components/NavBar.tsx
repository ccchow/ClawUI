"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { redeployStable, getDevStatus, getGlobalStatus } from "@/lib/api";
import type { GlobalQueueInfo, GlobalQueueTask } from "@/lib/api";
import { AISparkle } from "./AISparkle";

const navItems = [
  { href: "/blueprints", label: "Blueprints" },
  { href: "/sessions", label: "Sessions" },
];

const typeColors: Record<string, string> = {
  running: "bg-accent-blue/20 text-accent-blue",
  run: "bg-accent-blue/20 text-accent-blue",
  reevaluate: "bg-accent-amber/20 text-accent-amber",
  enrich: "bg-accent-green/20 text-accent-green",
  generate: "bg-accent-purple/20 text-accent-purple",
  split: "bg-accent-purple/20 text-accent-purple",
};

function TaskRow({ task }: { task: GlobalQueueTask }) {
  const color = typeColors[task.type] ?? "bg-white/10 text-text-muted";
  const nodeTitle = task.nodeTitle || "Blueprint task";
  const blueprintTitle = task.blueprintTitle || task.blueprintId.slice(0, 8);

  const nodeHref = task.nodeId
    ? `/blueprints/${task.blueprintId}/nodes/${task.nodeId}`
    : `/blueprints/${task.blueprintId}`;

  return (
    <div className="flex items-start gap-2 px-3 py-2 border-b border-white/5 last:border-b-0">
      <div className="min-w-0 flex-1">
        <Link
          href={nodeHref}
          className="text-xs font-medium text-text-primary truncate block hover:text-accent-blue transition-colors"
        >
          {nodeTitle}
        </Link>
        <div className="flex items-center gap-1.5 mt-0.5">
          <span className="text-[10px] text-text-muted truncate">{blueprintTitle}</span>
          {task.sessionId && (
            <Link
              href={`/session/${task.sessionId}`}
              className="flex items-center gap-0.5 text-[10px] text-accent-blue hover:text-accent-blue/80 transition-colors flex-shrink-0"
              aria-label="View session"
            >
              <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="4 17 10 11 4 5" />
                <line x1="12" y1="19" x2="20" y2="19" />
              </svg>
              session
            </Link>
          )}
        </div>
      </div>
      <span className={`flex-shrink-0 mt-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium ${color}`}>
        {task.type}
      </span>
    </div>
  );
}

export function NavBar() {
  const pathname = usePathname();
  const router = useRouter();

  // Dev mode redeploy
  const [redeploying, setRedeploying] = useState(false);
  const [isDevMode, setIsDevMode] = useState(false);
  useEffect(() => {
    // Port-based detection (dev port !== 3000)
    if (typeof window !== "undefined") {
      const devPort = window.location.port !== "3000" && window.location.port !== "";
      if (devPort) {
        setIsDevMode(true);
        return;
      }
    }
    // Backend CLAWUI_DEV env var detection
    getDevStatus().then(({ devMode }) => {
      if (devMode) setIsDevMode(true);
    }).catch(() => { /* ignore */ });
  }, []);

  // Global execution status polling
  const [globalStatus, setGlobalStatus] = useState<GlobalQueueInfo | null>(null);
  const [showTooltip, setShowTooltip] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const pollGlobalStatus = useCallback(async () => {
    try {
      const status = await getGlobalStatus();
      setGlobalStatus(status);
    } catch {
      // Ignore errors — endpoint may not exist on older backends
    }
  }, []);

  useEffect(() => {
    pollGlobalStatus();

    const startPolling = () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      // Poll faster when active (5s), slower when idle (10s)
      const interval = globalStatus?.active ? 5000 : 10000;
      intervalRef.current = setInterval(pollGlobalStatus, interval);
    };

    startPolling();
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [pollGlobalStatus, globalStatus?.active]);

  const isActive = globalStatus?.active ?? false;
  const taskCount = globalStatus?.totalPending ?? 0;

  // Popover close on click-outside
  const popoverRef = useRef<HTMLDivElement>(null);
  const hideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showPopover = useCallback(() => {
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }
    setShowTooltip(true);
  }, []);

  const hidePopover = useCallback(() => {
    hideTimeoutRef.current = setTimeout(() => {
      setShowTooltip(false);
      hideTimeoutRef.current = null;
    }, 200);
  }, []);

  useEffect(() => {
    return () => {
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    if (!showTooltip) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setShowTooltip(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showTooltip]);

  // Click handler: navigate to session of first active task if available, otherwise blueprint
  const handleIndicatorClick = () => {
    if (!globalStatus?.tasks.length) return;
    const first = globalStatus.tasks[0];
    if (first.sessionId) {
      router.push(`/session/${first.sessionId}`);
    } else if (first.nodeId) {
      router.push(`/blueprints/${first.blueprintId}/nodes/${first.nodeId}`);
    } else {
      router.push(`/blueprints/${first.blueprintId}`);
    }
  };

  return (
    <header className="sticky top-0 z-50 border-b border-border-primary bg-bg-primary/80 backdrop-blur-sm">
      <div className="mx-auto max-w-5xl px-3 sm:px-4 py-3 flex items-center gap-2 sm:gap-3 flex-wrap">
        <Link href="/blueprints" className="flex items-center gap-2 hover:opacity-80 transition-opacity">
          <span className="text-xl">🐾</span>
          <span className="font-semibold text-lg hidden sm:inline">ClawUI</span>
        </Link>
        <nav className="flex items-center gap-1 ml-4">
          {navItems.map((item) => {
            const isNavActive =
              item.href === "/sessions"
                ? pathname.startsWith("/session")
                : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`px-3 py-2.5 sm:py-1.5 rounded-lg text-sm transition-all active:scale-[0.97] ${
                  isNavActive
                    ? "bg-bg-tertiary text-text-primary font-medium"
                    : "text-text-muted hover:text-text-secondary hover:bg-bg-secondary"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          {isActive && (
            <div
              ref={popoverRef}
              className="relative flex items-center"
              onMouseEnter={showPopover}
              onMouseLeave={hidePopover}
            >
              <button
                onClick={handleIndicatorClick}
                className="flex items-center gap-1.5 px-2 py-2.5 sm:py-1 rounded-lg text-accent-purple hover:bg-accent-purple/10 transition-all active:scale-[0.97]"
                aria-label={`${taskCount} AI task${taskCount !== 1 ? "s" : ""} running`}
              >
                <AISparkle size="xs" />
                <span className="text-xs font-medium">{taskCount}</span>
              </button>
              {showTooltip && globalStatus?.tasks && globalStatus.tasks.length > 0 && (
                <div className="absolute top-full right-0 pt-1.5 min-w-[280px] max-w-[400px] z-50 animate-fade-in">
                <div className="rounded-lg bg-bg-secondary border border-white/10 shadow-xl overflow-hidden">
                  <div className="px-3 py-2 border-b border-white/5 text-xs font-medium text-text-muted">
                    {taskCount} AI task{taskCount !== 1 ? "s" : ""}
                  </div>
                  <div className="max-h-[300px] overflow-y-auto">
                    {globalStatus.tasks.map((task, i) => (
                      <TaskRow key={`${task.blueprintId}-${task.nodeId ?? i}`} task={task} />
                    ))}
                  </div>
                </div>
                </div>
              )}
            </div>
          )}
          {isDevMode && (
            <button
              onClick={async () => {
                setRedeploying(true);
                try {
                  await redeployStable();
                } catch {
                  // non-critical
                } finally {
                  setRedeploying(false);
                }
              }}
              disabled={redeploying || isActive}
              className="flex-shrink-0 px-2.5 py-2.5 sm:py-1 rounded-lg text-xs font-medium transition-all active:scale-[0.97] disabled:opacity-40 disabled:cursor-not-allowed bg-accent-amber/20 text-accent-amber hover:bg-accent-amber/30 border border-accent-amber/30"
              title={isActive ? "Cannot redeploy while AI tasks are running" : "Redeploy & restart stable environment"}
            >
              {redeploying ? (
                <span className="flex items-center gap-1">
                  <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4 31.4" strokeLinecap="round" /></svg>
                  Deploying...
                </span>
              ) : (
                <span className="flex items-center gap-1">
                  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 2v6h-6" /><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M3 22v-6h6" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /></svg>
                  Redeploy
                </span>
              )}
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
