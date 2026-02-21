"use client";

import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatusIndicator } from "./StatusIndicator";
import type { SessionState } from "@/lib/store";

export function SessionCard({ session }: { session: SessionState }) {
  return (
    <Link href={`/session/${session.sessionId}`}>
      <Card className="cursor-pointer transition-colors hover:bg-accent/50 border-border/50">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-semibold">
              {session.agentName}
            </CardTitle>
            <StatusIndicator status={session.status} />
          </div>
          <p className="text-xs text-muted-foreground font-mono truncate">
            {session.sessionId.slice(0, 8)}...
          </p>
        </CardHeader>
        <CardContent className="pt-0">
          {session.currentStep && (
            <Badge variant="secondary" className="mb-2 text-xs">
              {session.currentStep}
            </Badge>
          )}
          {session.lastText && (
            <p className="text-xs text-muted-foreground line-clamp-2">
              {session.lastText}
            </p>
          )}
          {session.status === "waiting" && session.waitingReason && (
            <p className="text-xs text-yellow-400 mt-1 font-medium">
              {session.waitingReason}
            </p>
          )}
        </CardContent>
      </Card>
    </Link>
  );
}
