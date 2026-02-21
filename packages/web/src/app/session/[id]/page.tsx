"use client";

import { use, useEffect, useRef } from "react";
import Link from "next/link";
import { useStore } from "@/lib/store";
import { useWebSocket } from "@/hooks/useWebSocket";
import { StatusIndicator } from "@/components/StatusIndicator";
import { ApprovalCard } from "@/components/ApprovalCard";
import { InputCard } from "@/components/InputCard";
import { ConnectionStatus } from "@/components/ConnectionStatus";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export default function SessionDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { sendAction } = useWebSocket();
  const session = useStore((s) => s.sessions[id]);
  const resolveA2UI = useStore((s) => s.resolveA2UI);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new text
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [session?.textBuffer]);

  if (!session) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-8">
        <Link href="/">
          <Button variant="ghost" size="sm" className="mb-4">
            &larr; Back
          </Button>
        </Link>
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <p className="text-muted-foreground text-sm">
            Session <code className="font-mono">{id.slice(0, 8)}...</code> not found.
          </p>
          <p className="text-muted-foreground/60 text-xs mt-2">
            It may have ended or not started yet.
          </p>
        </div>
      </main>
    );
  }

  const handleApproval = (action: string) => {
    sendAction({
      session_id: id,
      action_type: action.toLowerCase() === "approve" ? "APPROVE" : "REJECT",
      payload: action.toLowerCase() === "approve",
    });
    resolveA2UI(id);
  };

  const handleInput = (value: string) => {
    sendAction({
      session_id: id,
      action_type: "PROVIDE_INPUT",
      payload: value,
    });
    resolveA2UI(id);
  };

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/">
            <Button variant="ghost" size="sm">
              &larr; Back
            </Button>
          </Link>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-bold">{session.agentName}</h1>
              <StatusIndicator status={session.status} />
            </div>
            <p className="text-xs text-muted-foreground font-mono">
              {session.sessionId}
            </p>
          </div>
        </div>
        <ConnectionStatus />
      </div>

      {session.currentStep && (
        <div className="mb-4">
          <Badge variant="secondary">{session.currentStep}</Badge>
        </div>
      )}

      {/* Text output with typewriter effect */}
      <div
        ref={scrollRef}
        className="mb-4 h-[50vh] overflow-y-auto rounded-lg border border-border/50 bg-black/30 p-4 font-mono text-sm leading-relaxed"
      >
        {session.textBuffer ? (
          session.textBuffer.split("\n").map((line, i) => (
            <div key={i} className={line ? "text-foreground" : "h-2"}>
              {line}
            </div>
          ))
        ) : (
          <p className="text-muted-foreground">Waiting for output...</p>
        )}
      </div>

      {/* A2UI Renderer */}
      {session.status === "waiting" && session.pendingA2UI && (
        <div className="mb-4">
          {renderA2UI(session.pendingA2UI, handleApproval, handleInput)}
        </div>
      )}

      {/* Generic waiting state without A2UI */}
      {session.status === "waiting" && !session.pendingA2UI && session.waitingReason && (
        <div className="mb-4">
          <InputCard
            title={session.waitingReason}
            onSubmit={handleInput}
          />
        </div>
      )}

      {/* Finished state */}
      {session.status === "finished" && (
        <div className="rounded-lg border border-border/50 bg-muted/30 p-4 text-center text-sm text-muted-foreground">
          Session ended &mdash;{" "}
          <span
            className={
              session.finishedStatus === "success"
                ? "text-green-400"
                : "text-red-400"
            }
          >
            {session.finishedStatus}
          </span>
        </div>
      )}
    </main>
  );
}

function renderA2UI(
  a2ui: { component: string; props: Record<string, unknown> },
  onApproval: (action: string) => void,
  onInput: (value: string) => void
) {
  switch (a2ui.component) {
    case "ApprovalCard":
      return (
        <ApprovalCard
          title={(a2ui.props.title as string) ?? "Action Required"}
          command={a2ui.props.command as string | undefined}
          actions={(a2ui.props.actions as string[]) ?? ["Approve", "Reject"]}
          onAction={onApproval}
        />
      );
    case "InputCard":
      return (
        <InputCard
          title={(a2ui.props.title as string) ?? "Input Required"}
          placeholder={a2ui.props.placeholder as string | undefined}
          onSubmit={onInput}
        />
      );
    default:
      return (
        <div className="rounded-lg border border-border/50 bg-muted/30 p-4 text-sm">
          <p className="text-muted-foreground">
            Unknown component: <code>{a2ui.component}</code>
          </p>
          <pre className="mt-2 text-xs text-muted-foreground/60">
            {JSON.stringify(a2ui.props, null, 2)}
          </pre>
        </div>
      );
  }
}
