"use client";

const statusColors: Record<string, string> = {
  pending: "bg-text-muted",
  queued: "bg-accent-amber animate-pulse",
  running: "bg-accent-blue animate-pulse",
  done: "bg-accent-green",
  failed: "bg-accent-red",
  blocked: "bg-accent-amber",
  skipped: "bg-text-muted/50",
  draft: "bg-text-muted",
  approved: "bg-accent-blue/70",
  paused: "bg-accent-amber/70",
};

const statusLabels: Record<string, string> = {
  pending: "Pending",
  running: "Running",
  done: "Completed",
  failed: "Failed",
  blocked: "Blocked",
  skipped: "Skipped",
  queued: "Waiting in queue",
  draft: "Draft",
  approved: "Approved",
  paused: "Paused",
};

export function StatusIndicator({
  status,
  size = "md",
}: {
  status: string;
  size?: "sm" | "md";
}) {
  const sizeClass = size === "sm" ? "w-2 h-2" : "w-2.5 h-2.5";
  const colorClass = statusColors[status] ?? "bg-gray-400";
  const label = statusLabels[status] ?? status;

  return (
    <span
      role="img"
      aria-label={label}
      className={`inline-block rounded-full flex-shrink-0 ${sizeClass} ${colorClass}`}
      title={label}
    />
  );
}
