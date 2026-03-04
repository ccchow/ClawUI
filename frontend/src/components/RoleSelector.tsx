"use client";

import { useState, useEffect } from "react";
import { type RoleInfo, fetchRoles } from "@/lib/api";
import { ROLE_COLORS, ROLE_FALLBACK_COLORS } from "./role-colors";

/** Multi-select toggle buttons for choosing roles */
export function RoleSelector({
  value,
  onChange,
  disabled = false,
  label,
  inherited = false,
}: {
  value: string[];
  onChange: (roles: string[]) => void;
  disabled?: boolean;
  /** Custom label. Pass `null` to hide the label entirely. */
  label?: string | null;
  /** When true, selected roles use muted styling to indicate they are inherited defaults, not explicit selections */
  inherited?: boolean;
}) {
  const [roles, setRoles] = useState<RoleInfo[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetchRoles()
      .then((r) => {
        setRoles(r);
        setLoaded(true);
      })
      .catch(() => {
        setLoaded(true);
      });
  }, []);

  if (!loaded || roles.length === 0) return null;

  const toggle = (roleId: string) => {
    if (disabled) return;
    const isSelected = value.includes(roleId);
    if (isSelected) {
      // Prevent deselecting all roles
      if (value.length <= 1) return;
      onChange(value.filter((r) => r !== roleId));
    } else {
      onChange([...value, roleId]);
    }
  };

  return (
    <div>
      {label !== null && (
        <div className="mb-1">
          <label className="block text-sm text-text-secondary">{label ?? "Roles"}</label>
          <span className="block text-xs text-text-muted">Default roles for plan generation and discussions. All roles can be assigned to any node.</span>
        </div>
      )}
      <div className="flex gap-2 flex-wrap">
        {roles.map((role) => {
          const colors = ROLE_COLORS[role.id] ?? ROLE_FALLBACK_COLORS;
          const selected = value.includes(role.id);
          return (
            <button
              key={role.id}
              type="button"
              disabled={disabled}
              onClick={() => toggle(role.id)}
              title={role.description}
              className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border text-sm font-medium transition-all active:scale-[0.97] ${
                selected
                  ? inherited
                    ? `bg-bg-tertiary ${colors.text} border-border-primary border-dashed opacity-60`
                    : `${colors.bg} ${colors.text} ${colors.border}`
                  : "bg-bg-tertiary text-text-secondary border-border-primary hover:bg-bg-hover"
              } ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
            >
              <span className={`w-2 h-2 rounded-full ${selected ? (inherited ? "bg-text-muted" : colors.dot) : "bg-text-muted"}`} />
              {role.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
