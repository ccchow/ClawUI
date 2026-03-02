"use client";

import { createContext, useContext, useState, useCallback, useRef, useEffect } from "react";

export type ToastType = "success" | "error" | "info";

interface Toast {
  id: string;
  message: string;
  type: ToastType;
}

interface ToastContextValue {
  showToast: (message: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) return { showToast: () => {} }; // no-op outside provider
  return ctx;
}

const TOAST_DURATION = 3000;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [exiting, setExiting] = useState<Set<string>>(new Set());
  const nextId = useRef(0);

  const removeToast = useCallback((id: string) => {
    setExiting((prev) => new Set(prev).add(id));
    // Allow exit animation to play before removing from DOM
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
      setExiting((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, 200);
  }, []);

  const showToast = useCallback((message: string, type: ToastType = "success") => {
    const id = `toast-${++nextId.current}`;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => removeToast(id), TOAST_DURATION);
  }, [removeToast]);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {toasts.length > 0 && (
        <div className="fixed bottom-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-none max-w-sm">
          {toasts.map((toast) => (
            <ToastItem
              key={toast.id}
              toast={toast}
              isExiting={exiting.has(toast.id)}
              onDismiss={() => removeToast(toast.id)}
            />
          ))}
        </div>
      )}
    </ToastContext.Provider>
  );
}

function ToastItem({
  toast,
  isExiting,
  onDismiss,
}: {
  toast: Toast;
  isExiting: boolean;
  onDismiss: () => void;
}) {
  // Allow pointer events only on the toast itself
  const colorMap: Record<ToastType, string> = {
    success: "bg-accent-green/15 border-accent-green/30 text-accent-green",
    error: "bg-accent-red/15 border-accent-red/30 text-accent-red",
    info: "bg-accent-blue/15 border-accent-blue/30 text-accent-blue",
  };

  const iconMap: Record<ToastType, string> = {
    success: "\u2713",
    error: "\u2717",
    info: "\u2139",
  };

  // Progress bar for remaining time
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    requestAnimationFrame(() => setMounted(true));
  }, []);

  return (
    <div
      className={`relative pointer-events-auto border rounded-lg px-3 py-2 flex items-center gap-2 text-sm shadow-lg backdrop-blur-sm ${colorMap[toast.type]} ${isExiting ? "animate-toast-exit" : "animate-toast-enter"}`}
      role="status"
      aria-live="polite"
    >
      <span className="font-medium text-base flex-shrink-0">{iconMap[toast.type]}</span>
      <span className="flex-1 min-w-0">{toast.message}</span>
      <button
        onClick={onDismiss}
        className="flex-shrink-0 opacity-60 hover:opacity-100 transition-opacity text-xs ml-1"
        aria-label="Dismiss"
      >
        &times;
      </button>
      {/* Progress bar showing remaining time */}
      <div className="absolute bottom-0 left-0 right-0 h-0.5 rounded-b-lg overflow-hidden">
        <div
          className={`h-full bg-current opacity-30 ${mounted ? "transition-transform duration-[3000ms] ease-linear" : ""}`}
          style={{ transform: mounted ? "scaleX(0)" : "scaleX(1)", transformOrigin: "left" }}
        />
      </div>
    </div>
  );
}
