"use client";

import React, { useState, useCallback } from "react";

/**
 * Lightweight markdown renderer — no external deps.
 * Handles: code blocks, inline code, headings, bold, italic, links, lists.
 */

interface Block {
  type: "code" | "heading" | "list" | "paragraph";
  content: string;
  lang?: string;
  level?: number; // heading level 1-6
  ordered?: boolean;
  items?: string[];
}

function parseBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block: ```lang ... ```
    if (line.trimStart().startsWith("```")) {
      const lang = line.trimStart().slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      blocks.push({ type: "code", content: codeLines.join("\n"), lang });
      continue;
    }

    // Heading: # ... through ######
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      blocks.push({
        type: "heading",
        level: headingMatch[1].length,
        content: headingMatch[2],
      });
      i++;
      continue;
    }

    // List: collect consecutive list items
    const ulMatch = line.match(/^(\s*)[*\-+]\s+(.*)$/);
    const olMatch = line.match(/^(\s*)\d+[.)]\s+(.*)$/);
    if (ulMatch || olMatch) {
      const ordered = !!olMatch;
      const items: string[] = [];
      while (i < lines.length) {
        const lm = ordered
          ? lines[i].match(/^(\s*)\d+[.)]\s+(.*)$/)
          : lines[i].match(/^(\s*)[*\-+]\s+(.*)$/);
        if (!lm) break;
        items.push(lm[2]);
        i++;
      }
      blocks.push({ type: "list", content: "", ordered, items });
      continue;
    }

    // Blank line — skip
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph: collect consecutive non-special lines
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].trimStart().startsWith("```") &&
      !lines[i].match(/^#{1,6}\s+/) &&
      !lines[i].match(/^(\s*)[*\-+]\s+/) &&
      !lines[i].match(/^(\s*)\d+[.)]\s+/)
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      blocks.push({ type: "paragraph", content: paraLines.join("\n") });
    }
  }

  return blocks;
}

/** Parse inline markdown: bold, italic, inline code, links */
function renderInline(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // Combined regex for inline patterns
  // Order matters: code first (to avoid bold/italic inside code), then bold, italic, links
  const pattern =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = pattern.exec(text)) !== null) {
    // Text before match
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    const m = match[0];

    if (match[1]) {
      // Inline code: `code`
      nodes.push(
        <code
          key={key++}
          className="px-1.5 py-0.5 rounded bg-bg-tertiary text-accent-blue text-[13px] font-mono"
        >
          {m.slice(1, -1)}
        </code>
      );
    } else if (match[2]) {
      // Bold: **text**
      nodes.push(
        <strong key={key++} className="font-semibold text-text-primary">
          {m.slice(2, -2)}
        </strong>
      );
    } else if (match[3]) {
      // Italic: *text*
      nodes.push(
        <em key={key++} className="italic text-text-secondary">
          {m.slice(1, -1)}
        </em>
      );
    } else if (match[4]) {
      // Link: [text](url)
      const linkMatch = m.match(/\[([^\]]+)\]\(([^)]+)\)/);
      if (linkMatch) {
        nodes.push(
          <a
            key={key++}
            href={linkMatch[2]}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent-blue hover:underline"
          >
            {linkMatch[1]}
          </a>
        );
      }
    }

    lastIndex = match.index + m.length;
  }

  // Remaining text
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

function CodeBlock({ content, lang }: { content: string; lang?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [content]);

  return (
    <div className="relative group">
      <div className="absolute top-1.5 right-2 flex items-center gap-2">
        {lang && (
          <span className="text-[10px] text-text-muted uppercase tracking-wide">
            {lang}
          </span>
        )}
        <button
          onClick={handleCopy}
          title="Copy to clipboard"
          className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-white/10"
        >
          {copied ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-text-muted">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          )}
        </button>
      </div>
      <pre className="rounded-lg bg-[#0f0f1a] border border-border-primary p-3 pr-20 overflow-x-auto text-[13px] leading-relaxed font-mono text-text-secondary">
        {content}
      </pre>
    </div>
  );
}

export function MarkdownContent({ content }: { content: string }) {
  const blocks = parseBlocks(content);

  return (
    <div className="space-y-3 text-sm text-text-primary leading-relaxed max-h-[600px] overflow-y-auto">
      {blocks.map((block, i) => {
        switch (block.type) {
          case "code":
            return <CodeBlock key={i} content={block.content} lang={block.lang} />;

          case "heading": {
            const Tag = `h${block.level}` as keyof React.JSX.IntrinsicElements;
            const sizeClass =
              block.level === 1
                ? "text-lg font-bold"
                : block.level === 2
                  ? "text-base font-bold"
                  : block.level === 3
                    ? "text-sm font-semibold"
                    : "text-sm font-medium text-text-secondary";
            return (
              <Tag key={i} className={sizeClass}>
                {renderInline(block.content)}
              </Tag>
            );
          }

          case "list": {
            const ListTag = block.ordered ? "ol" : "ul";
            return (
              <ListTag
                key={i}
                className={`space-y-1 pl-5 ${
                  block.ordered ? "list-decimal" : "list-disc"
                } text-text-secondary marker:text-text-muted`}
              >
                {block.items?.map((item, j) => (
                  <li key={j}>{renderInline(item)}</li>
                ))}
              </ListTag>
            );
          }

          case "paragraph":
          default:
            return (
              <p key={i} className="text-text-secondary whitespace-pre-wrap break-words">
                {renderInline(block.content)}
              </p>
            );
        }
      })}
    </div>
  );
}
