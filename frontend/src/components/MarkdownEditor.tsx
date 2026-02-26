"use client";

import { useState, useRef, useCallback } from "react";
import { MarkdownContent } from "./MarkdownContent";

/**
 * Markdown editor with edit/preview toggle and clipboard image paste.
 * Drop-in replacement for plain textarea in description fields.
 */
export function MarkdownEditor({
  value,
  onChange,
  placeholder = "Description (supports Markdown and image paste)",
  minHeight = "60px",
  className = "",
  disabled = false,
  actions,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  minHeight?: string;
  className?: string;
  disabled?: boolean;
  actions?: React.ReactNode;
}) {
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [uploading, setUploading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const autoResize = useCallback((el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }, []);

  const insertAtCursor = useCallback(
    (text: string) => {
      const el = textareaRef.current;
      if (!el) {
        onChange(value + text);
        return;
      }
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const newValue = value.slice(0, start) + text + value.slice(end);
      onChange(newValue);
      // Restore cursor after the inserted text
      requestAnimationFrame(() => {
        el.selectionStart = el.selectionEnd = start + text.length;
        el.focus();
        autoResize(el);
      });
    },
    [value, onChange, autoResize]
  );

  const [pasteError, setPasteError] = useState<string | null>(null);

  const handlePaste = useCallback(
    async (e: React.ClipboardEvent) => {
      if (disabled) return;
      const items = e.clipboardData?.items;
      if (!items) return;

      for (const item of Array.from(items)) {
        if (item.type.startsWith("image/")) {
          e.preventDefault();
          const file = item.getAsFile();
          if (!file) continue;

          // 5MB size limit for pasted images
          if (file.size > 5 * 1024 * 1024) {
            setPasteError("Image too large (max 5MB)");
            setTimeout(() => setPasteError(null), 4000);
            return;
          }

          setUploading(true);
          setPasteError(null);
          try {
            const dataUrl = await fileToDataUrl(file);
            insertAtCursor(`![image](${dataUrl})`);
          } catch (err) {
            console.error("Image paste failed:", err);
            setPasteError("Failed to paste image");
            setTimeout(() => setPasteError(null), 4000);
          } finally {
            setUploading(false);
          }
          return; // Only handle first image
        }
      }
    },
    [disabled, insertAtCursor]
  );

  return (
    <div className={className} onClick={(e) => e.stopPropagation()}>
      {/* Mode toggle tabs */}
      <div className="flex items-center gap-1 mb-1 flex-wrap" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "edit"}
          onClick={() => setMode("edit")}
          className={`px-3 py-1.5 sm:px-2 sm:py-0.5 rounded-md text-[11px] font-medium transition-colors ${
            mode === "edit"
              ? "bg-bg-tertiary text-text-primary"
              : "text-text-muted hover:text-text-secondary"
          }`}
        >
          Edit
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "preview"}
          onClick={() => setMode("preview")}
          className={`px-3 py-1.5 sm:px-2 sm:py-0.5 rounded-md text-[11px] font-medium transition-colors ${
            mode === "preview"
              ? "bg-bg-tertiary text-text-primary"
              : "text-text-muted hover:text-text-secondary"
          }`}
        >
          Preview
        </button>
        {uploading && (
          <span className="text-[11px] text-accent-blue flex items-center gap-1">
            <span className="inline-block w-3 h-3 border-2 border-accent-blue/30 border-t-accent-blue rounded-full animate-spin" />
            Pasting image...
          </span>
        )}
        {pasteError && (
          <span className="text-[11px] text-accent-red animate-fade-in">
            {pasteError}
          </span>
        )}
        {actions && (
          <div className="flex items-center gap-2 ml-auto">
            {actions}
          </div>
        )}
      </div>

      {mode === "edit" ? (
        <textarea
          ref={(el) => {
            (textareaRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = el;
            if (el) autoResize(el);
          }}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            autoResize(e.target);
          }}
          onPaste={handlePaste}
          disabled={disabled}
          aria-label={placeholder}
          placeholder={placeholder}
          className={`w-full px-3 py-2 rounded-lg bg-bg-tertiary border border-border-primary text-text-primary placeholder:text-text-muted text-sm focus:outline-none focus:border-accent-blue focus:ring-1 focus:ring-accent-blue/30 resize-y font-mono${disabled ? " opacity-60 cursor-not-allowed" : ""}`}
          style={{ minHeight }}
        />
      ) : (
        <div
          className="w-full px-3 py-2 rounded-lg bg-bg-tertiary border border-border-primary text-sm overflow-auto"
          style={{ minHeight }}
        >
          {value.trim() ? (
            <MarkdownContent content={value} maxHeight="none" />
          ) : (
            <span className="text-text-muted italic">Nothing to preview</span>
          )}
        </div>
      )}
    </div>
  );
}

/** Convert a File to a data URL string */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
