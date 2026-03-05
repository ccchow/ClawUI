"use client";

import { useEffect, useRef, useCallback } from "react";

/**
 * Gesture color variant for inline confirmation strips.
 * Follows gesture color semantics: green=execution, purple=AI creation,
 * amber=review/reconsider, red=destructive, blue=state-transition.
 */
export type ConfirmationVariant = "amber" | "red" | "blue" | "purple" | "green";

const VARIANT_CLASSES: Record<ConfirmationVariant, { border: string; bg: string; text: string; btn: string }> = {
  amber: {
    border: "border-accent-amber/30",
    bg: "bg-accent-amber/10",
    text: "text-accent-amber",
    btn: "bg-accent-amber text-white hover:bg-accent-amber/90",
  },
  red: {
    border: "border-accent-red/30",
    bg: "bg-accent-red/10",
    text: "text-accent-red",
    btn: "bg-accent-red text-white hover:bg-accent-red/90",
  },
  blue: {
    border: "border-accent-blue/30",
    bg: "bg-accent-blue/10",
    text: "text-accent-blue",
    btn: "bg-accent-blue text-white hover:bg-accent-blue/90",
  },
  purple: {
    border: "border-accent-purple/30",
    bg: "bg-accent-purple/10",
    text: "text-accent-purple",
    btn: "bg-accent-purple text-white hover:bg-accent-purple/90",
  },
  green: {
    border: "border-accent-green/30",
    bg: "bg-accent-green/10",
    text: "text-accent-green",
    btn: "bg-accent-green text-white hover:bg-accent-green/90",
  },
};

interface ConfirmationStripProps {
  /** Text displayed as the confirmation prompt (e.g. "Reset to Approved?") */
  confirmLabel: string;
  /** Called when user clicks "Yes" */
  onConfirm: () => void;
  /** Called when user clicks "No" / cancels */
  onCancel: () => void;
  /** Gesture color variant */
  variant: ConfirmationVariant;
  /** Text for the confirm button (default: "Yes") */
  confirmText?: string;
  /** Text for the cancel button (default: "No") */
  cancelText?: string;
  /** Disable the confirm button (e.g. while an action is in progress) */
  disabled?: boolean;
  /** Stop click propagation on the container */
  stopPropagation?: boolean;
  /** Use span wrapper instead of div (for inline contexts) */
  inline?: boolean;
}

/**
 * Reusable inline confirmation strip component.
 * Renders a compact confirmation prompt with Yes/No buttons following
 * the gesture color semantics defined in FRONTEND-PATTERNS.md.
 */
export function ConfirmationStrip({
  confirmLabel,
  onConfirm,
  onCancel,
  variant,
  confirmText = "Yes",
  cancelText = "No",
  disabled = false,
  stopPropagation = false,
  inline = false,
}: ConfirmationStripProps) {
  const vc = VARIANT_CLASSES[variant];
  const Tag = inline ? "span" : "div";
  const confirmRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<Element | null>(null);

  // Save the element that had focus before the strip appeared (the trigger)
  // and auto-focus the confirm button
  useEffect(() => {
    triggerRef.current = document.activeElement;
    confirmRef.current?.focus();
  }, []);

  // Escape key dismisses the strip
  const handleCancel = useCallback(() => {
    triggerRef.current instanceof HTMLElement && triggerRef.current.focus();
    onCancel();
  }, [onCancel]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        handleCancel();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleCancel]);

  return (
    <Tag
      className={`flex items-center gap-1.5 px-2 py-0.5 rounded-lg border ${vc.border} ${vc.bg} animate-fade-in flex-shrink-0`}
      onClick={stopPropagation ? (e) => e.stopPropagation() : undefined}
    >
      <span className={`text-xs ${vc.text} whitespace-nowrap`}>{confirmLabel}</span>
      <button
        ref={confirmRef}
        onClick={onConfirm}
        disabled={disabled}
        className={`px-2 py-0.5 rounded-md ${vc.btn} text-xs font-medium active:scale-[0.97] transition-all disabled:opacity-40 disabled:cursor-not-allowed`}
      >
        {confirmText}
      </button>
      <button
        onClick={handleCancel}
        className="px-2 py-0.5 rounded-md text-text-muted text-xs hover:text-text-secondary transition-colors"
      >
        {cancelText}
      </button>
    </Tag>
  );
}
