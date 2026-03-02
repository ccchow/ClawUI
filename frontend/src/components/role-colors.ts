/** Semantic color tokens per role — single source of truth */
export const ROLE_COLORS: Record<string, { bg: string; text: string; border: string; dot: string }> = {
  sde: {
    bg: "bg-accent-blue/15",
    text: "text-accent-blue",
    border: "border-accent-blue/30",
    dot: "bg-accent-blue",
  },
  qa: {
    bg: "bg-accent-green/15",
    text: "text-accent-green",
    border: "border-accent-green/30",
    dot: "bg-accent-green",
  },
  pm: {
    bg: "bg-accent-purple/15",
    text: "text-accent-purple",
    border: "border-accent-purple/30",
    dot: "bg-accent-purple",
  },
};

export const ROLE_FALLBACK_COLORS = {
  bg: "bg-accent-amber/15",
  text: "text-accent-amber",
  border: "border-accent-amber/30",
  dot: "bg-accent-amber",
};
