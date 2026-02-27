"use client";

import { useState, useEffect } from "react";
import { type AgentType, type AgentInfo, getAgents } from "@/lib/api";

/** Semantic color tokens per agent type */
export const AGENT_COLORS: Record<AgentType, { bg: string; text: string; border: string; dot: string }> = {
  claude: {
    bg: "bg-accent-purple/15",
    text: "text-accent-purple",
    border: "border-accent-purple/30",
    dot: "bg-accent-purple",
  },
  openclaw: {
    bg: "bg-accent-green/15",
    text: "text-accent-green",
    border: "border-accent-green/30",
    dot: "bg-accent-green",
  },
  pi: {
    bg: "bg-accent-blue/15",
    text: "text-accent-blue",
    border: "border-accent-blue/30",
    dot: "bg-accent-blue",
  },
};

export const AGENT_LABELS: Record<AgentType, string> = {
  claude: "Claude",
  openclaw: "OpenClaw",
  pi: "Pi Mono",
};

/** Small pill badge showing agent type with color coding */
export function AgentBadge({
  agentType,
  size = "sm",
}: {
  agentType: AgentType;
  size?: "xs" | "sm";
}) {
  const colors = AGENT_COLORS[agentType] ?? AGENT_COLORS.claude;
  const label = AGENT_LABELS[agentType] ?? agentType;
  const sizeClass = size === "xs" ? "text-[10px] px-1.5 py-0.5" : "text-xs px-2 py-0.5";

  return (
    <span className={`inline-flex items-center gap-1 rounded-full border font-medium ${sizeClass} ${colors.bg} ${colors.text} ${colors.border}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${colors.dot}`} />
      {label}
    </span>
  );
}

/** Dropdown selector for choosing an agent type */
export function AgentSelector({
  value,
  onChange,
  disabled = false,
  className = "",
}: {
  value?: AgentType;
  onChange: (agentType: AgentType) => void;
  disabled?: boolean;
  className?: string;
}) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    getAgents()
      .then((a) => {
        setAgents(a);
        setLoaded(true);
      })
      .catch(() => {
        setLoaded(true);
      });
  }, []);

  // Only show selector if multiple agents are available
  const availableAgents = agents.filter((a) => a.available);
  if (!loaded || availableAgents.length <= 1) return null;

  return (
    <div className={className}>
      <label className="block text-sm text-text-secondary mb-1">
        AI Agent
      </label>
      <div className="flex gap-2 flex-wrap">
        {agents.map((agent) => {
          const colors = AGENT_COLORS[agent.type] ?? AGENT_COLORS.claude;
          const selected = (value ?? "claude") === agent.type;
          return (
            <button
              key={agent.type}
              type="button"
              disabled={disabled || !agent.available}
              onClick={() => onChange(agent.type)}
              title={
                !agent.available
                  ? `${agent.name} binary not found`
                  : `Use ${agent.name} as the AI agent`
              }
              className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border text-sm font-medium transition-all active:scale-[0.97] ${
                selected
                  ? `${colors.bg} ${colors.text} ${colors.border}`
                  : "bg-bg-tertiary text-text-secondary border-border-primary hover:bg-bg-hover"
              } ${!agent.available ? "opacity-40 cursor-not-allowed" : ""} ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
            >
              <span className={`w-2 h-2 rounded-full ${agent.available ? colors.dot : "bg-text-muted"}`} />
              {agent.name}
              {agent.sessionCount > 0 && (
                <span className="text-xs opacity-60">({agent.sessionCount})</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
