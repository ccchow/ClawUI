"use client";

import { useRef, useState, useCallback, type ReactNode } from "react";

const PULL_THRESHOLD = 80;

export function PullToRefresh({ children }: { children: ReactNode }) {
  const [pulling, setPulling] = useState(false);
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const startY = useRef(0);
  const isDragging = useRef(false);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    // Only trigger when scrolled to top
    if (window.scrollY > 0) return;
    startY.current = e.touches[0].clientY;
    isDragging.current = true;
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!isDragging.current) return;
    const currentY = e.touches[0].clientY;
    const distance = Math.max(0, currentY - startY.current);

    if (distance > 10) {
      setPulling(true);
      // Apply resistance curve
      setPullDistance(Math.min(distance * 0.4, 120));
    }
  }, []);

  const handleTouchEnd = useCallback(() => {
    if (!isDragging.current) return;
    isDragging.current = false;

    if (pullDistance >= PULL_THRESHOLD) {
      setRefreshing(true);
      setPullDistance(50);
      // Reload the page (reconnects WebSocket automatically)
      setTimeout(() => {
        window.location.reload();
      }, 300);
    } else {
      setPulling(false);
      setPullDistance(0);
    }
  }, [pullDistance]);

  return (
    <div
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* Pull indicator */}
      {pulling && (
        <div
          className="flex items-center justify-center overflow-hidden transition-[height] duration-150"
          style={{ height: pullDistance }}
        >
          <span
            className={`text-xs text-muted-foreground ${refreshing ? "animate-spin" : ""}`}
          >
            {refreshing
              ? "↻"
              : pullDistance >= PULL_THRESHOLD
                ? "↑ Release to refresh"
                : "↓ Pull to refresh"}
          </span>
        </div>
      )}
      {children}
    </div>
  );
}
