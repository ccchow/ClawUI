"use client";

import { ROLE_COLORS, ROLE_FALLBACK_COLORS } from "./role-colors";

const ROLE_LABELS: Record<string, string> = {
  sde: "SDE",
  qa: "QA",
  pm: "PM",
};

/** Small pill badge showing role type with color coding */
export function RoleBadge({
  roleId,
  size = "sm",
}: {
  roleId: string;
  size?: "xs" | "sm";
}) {
  const colors = ROLE_COLORS[roleId] ?? ROLE_FALLBACK_COLORS;
  const label = ROLE_LABELS[roleId] ?? roleId.toUpperCase();
  const sizeClass = size === "xs" ? "text-[10px] px-1.5 py-0.5" : "text-xs px-2 py-0.5";

  return (
    <span className={`inline-flex items-center gap-1 rounded-full border font-medium ${sizeClass} ${colors.bg} ${colors.text} ${colors.border}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${colors.dot}`} />
      {label}
    </span>
  );
}
