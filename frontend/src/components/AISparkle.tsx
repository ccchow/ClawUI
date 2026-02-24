"use client";

/**
 * AISparkle — animated sparkle icon for AI-triggered loading states.
 * Replaces traditional spinners on buttons that invoke AI agents
 * (Smart Enrich, Generate Nodes, Run, Reevaluate, etc.).
 */
export function AISparkle({
  size = "sm",
  className = "",
}: {
  size?: "xs" | "sm" | "md";
  className?: string;
}) {
  const sizeMap = { xs: "w-3 h-3", sm: "w-3.5 h-3.5", md: "w-4 h-4" };
  return (
    <svg
      className={`${sizeMap[size]} animate-ai-sparkle ${className}`}
      viewBox="0 0 24 24"
      fill="currentColor"
    >
      {/* Four-point sparkle star */}
      <path d="M12 2L13.09 8.26L18 6L14.74 10.91L21 12L14.74 13.09L18 18L13.09 15.74L12 22L10.91 15.74L6 18L9.26 13.09L3 12L9.26 10.91L6 6L10.91 8.26L12 2Z" />
    </svg>
  );
}
