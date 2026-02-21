"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

interface ApprovalCardProps {
  title: string;
  command?: string;
  actions: string[];
  onAction: (action: string) => void;
}

export function ApprovalCard({ title, command, actions, onAction }: ApprovalCardProps) {
  return (
    <Card className="border-yellow-500/50 bg-yellow-500/5">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm text-yellow-400">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {command && (
          <code className="block rounded bg-black/40 px-3 py-2 text-xs font-mono text-red-400">
            {command}
          </code>
        )}
        <div className="flex gap-2">
          {actions.map((action) => (
            <Button
              key={action}
              variant={action.toLowerCase() === "approve" ? "default" : "destructive"}
              size="sm"
              onClick={() => onAction(action)}
            >
              {action}
            </Button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
