"use client";

const statusColors: Record<string, string> = {
  pending: "bg-gray-400",
  running: "bg-blue-500 animate-pulse",
  done: "bg-green-500",
  failed: "bg-red-500",
  blocked: "bg-yellow-500",
  skipped: "bg-gray-300",
  draft: "bg-gray-400",
  approved: "bg-blue-400",
  paused: "bg-yellow-400",
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

  return (
    <span
      className={`inline-block rounded-full flex-shrink-0 ${sizeClass} ${colorClass}`}
      title={status}
    />
  );
}
