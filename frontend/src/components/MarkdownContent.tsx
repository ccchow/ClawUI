"use client";

import React, { useState, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark, oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import { useTheme } from "next-themes";
import type { Components } from "react-markdown";

/** Resolve image URLs: relative /api/ paths get the API base prepended */
function resolveImageUrl(src: string): string {
  if (src.startsWith("/api/")) {
    const port = process.env.NEXT_PUBLIC_API_PORT || "3001";
    return typeof window !== "undefined"
      ? `${window.location.protocol}//${window.location.hostname}:${port}${src}`
      : src;
  }
  return src;
}

function CopyButton({
  text,
  title,
  ariaLabel,
  className = "",
}: {
  text: string;
  title: string;
  ariaLabel?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {
        /* clipboard not available */
      });
  }, [text]);

  return (
    <button
      onClick={handleCopy}
      title={title}
      aria-label={copied ? "Copied" : (ariaLabel ?? title)}
      className={`opacity-70 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity p-1.5 sm:p-1 rounded hover:bg-bg-hover ${className}`}
    >
      {copied ? (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-accent-green"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-text-muted"
        >
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  );
}

function CodeBlock({
  children,
  className: codeClassName,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const { resolvedTheme } = useTheme();
  const match = /language-(\w+)/.exec(codeClassName || "");
  const lang = match ? match[1] : undefined;
  const code = String(children).replace(/\n$/, "");

  return (
    <div className="relative group">
      <div className="absolute top-1.5 right-2 flex items-center gap-2 z-10">
        {lang && (
          <span className="text-[10px] text-text-muted uppercase tracking-wide">
            {lang}
          </span>
        )}
        <CopyButton text={code} title="Copy to clipboard" />
      </div>
      <SyntaxHighlighter
        style={resolvedTheme === "dark" ? oneDark : oneLight}
        language={lang}
        PreTag="div"
        customStyle={{
          margin: 0,
          borderRadius: "0.5rem",
          padding: "0.75rem",
          paddingRight: "5rem",
          fontSize: "13px",
          lineHeight: "1.625",
          background: "rgb(var(--bg-tertiary))",
          border: "1px solid rgb(var(--border-primary))",
        }}
        codeTagProps={{
          style: {
            fontFamily: '"SF Mono", "Fira Code", "Cascadia Code", monospace',
          },
        }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
}

function useMarkdownComponents(): Components {
  return {
    // Fenced code blocks: <pre> extracts the code child and renders CodeBlock
    pre({ children }) {
      const child = React.Children.toArray(children)[0];
      if (React.isValidElement(child)) {
        const props = child.props as {
          className?: string;
          children?: React.ReactNode;
        };
        return (
          <CodeBlock className={props.className}>{props.children}</CodeBlock>
        );
      }
      return <pre>{children}</pre>;
    },

    // Inline code only — fenced blocks are handled by pre() above
    code({ children }) {
      return (
        <code className="px-1.5 py-0.5 rounded bg-bg-tertiary text-accent-blue text-[13px] font-mono">
          {children}
        </code>
      );
    },

    // Headings
    h1({ children }) {
      return <h1 className="text-lg font-bold">{children}</h1>;
    },
    h2({ children }) {
      return <h2 className="text-base font-bold">{children}</h2>;
    },
    h3({ children }) {
      return <h3 className="text-sm font-semibold">{children}</h3>;
    },
    h4({ children }) {
      return (
        <h4 className="text-sm font-medium text-text-secondary">{children}</h4>
      );
    },
    h5({ children }) {
      return (
        <h5 className="text-sm font-medium text-text-secondary">{children}</h5>
      );
    },
    h6({ children }) {
      return (
        <h6 className="text-sm font-medium text-text-secondary">{children}</h6>
      );
    },

    // Paragraphs
    p({ children }) {
      return (
        <p className="text-text-secondary whitespace-pre-wrap break-words">
          {children}
        </p>
      );
    },

    // Lists
    ul({ children }) {
      return (
        <ul className="space-y-1 pl-5 list-disc text-text-secondary marker:text-text-muted">
          {children}
        </ul>
      );
    },
    ol({ children }) {
      return (
        <ol className="space-y-1 pl-5 list-decimal text-text-secondary marker:text-text-muted">
          {children}
        </ol>
      );
    },

    // Blockquote
    blockquote({ children }) {
      return (
        <blockquote className="border-l-2 border-accent-blue/40 pl-3 text-text-secondary italic">
          {children}
        </blockquote>
      );
    },

    // Horizontal rule
    hr() {
      return <hr className="border-border-primary" />;
    },

    // Links — sanitize unsafe URLs
    a({ href, children }) {
      const isSafe = href
        ? /^(https?:\/\/|\/|#|mailto:)/i.test(href)
        : false;
      return (
        <a
          href={isSafe ? href : "#"}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent-blue hover:underline"
        >
          {children}
        </a>
      );
    },

    // Images — resolve /api/ paths
    img({ src, alt }) {
      return (
        <img
          src={src ? resolveImageUrl(src) : undefined}
          alt={alt || ""}
          className="max-w-full rounded-lg border border-border-primary my-1 max-h-[400px] object-contain"
        />
      );
    },

    // Inline formatting
    strong({ children }) {
      return (
        <strong className="font-semibold text-text-primary">{children}</strong>
      );
    },
    em({ children }) {
      return <em className="italic text-text-secondary">{children}</em>;
    },
    del({ children }) {
      return (
        <del className="text-text-muted line-through">{children}</del>
      );
    },

    // GFM tables
    table({ children }) {
      return (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">{children}</table>
        </div>
      );
    },
    thead({ children }) {
      return (
        <thead className="bg-bg-tertiary text-text-primary">{children}</thead>
      );
    },
    th({ children }) {
      return (
        <th className="border border-border-primary px-3 py-1.5 text-left text-xs font-semibold uppercase tracking-wide">
          {children}
        </th>
      );
    },
    td({ children }) {
      return (
        <td className="border border-border-primary px-3 py-1.5 text-text-secondary">
          {children}
        </td>
      );
    },

    // GFM task list items
    li({ children, ...props }) {
      const isTask = (props as Record<string, unknown>).className === "task-list-item";
      if (isTask) {
        return <li className="list-none -ml-5">{children}</li>;
      }
      return <li>{children}</li>;
    },

    // GFM task list checkbox
    input({ checked, ...rest }) {
      return (
        <input
          type="checkbox"
          checked={checked}
          readOnly
          className="mr-1.5 accent-accent-blue"
          {...rest}
        />
      );
    },
  };
}

export function MarkdownContent({
  content,
  maxHeight = "600px",
  className = "",
}: {
  content: string;
  maxHeight?: string | "none";
  className?: string;
}) {
  const [copiedAll, setCopiedAll] = useState(false);
  const components = useMarkdownComponents();

  const handleCopyAll = useCallback(() => {
    navigator.clipboard
      .writeText(content)
      .then(() => {
        setCopiedAll(true);
        setTimeout(() => setCopiedAll(false), 2000);
      })
      .catch(() => {
        /* clipboard not available */
      });
  }, [content]);

  if (!content.trim()) return null;

  const heightStyle = maxHeight === "none" ? undefined : { maxHeight };
  const showCopyAll = content.length >= 50;

  return (
    <div className="relative group/md">
      {showCopyAll && (
        <button
          onClick={handleCopyAll}
          title="Copy all content"
          aria-label={copiedAll ? "Copied" : "Copy all content"}
          className="absolute top-1 right-1 z-10 opacity-70 sm:opacity-0 sm:group-hover/md:opacity-100 transition-opacity p-1.5 sm:p-1 rounded hover:bg-bg-hover"
        >
          {copiedAll ? (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-accent-green"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-text-muted"
            >
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          )}
        </button>
      )}
      <div
        className={`markdown-content space-y-3 text-sm text-text-primary leading-relaxed ${maxHeight !== "none" ? "overflow-y-auto" : ""} ${className}`}
        style={heightStyle}
      >
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
          {content}
        </ReactMarkdown>
      </div>
    </div>
  );
}
