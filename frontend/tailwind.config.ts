import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: {
          primary: "#0a0a0f",
          secondary: "#12121a",
          tertiary: "#1a1a2e",
          hover: "#222238",
        },
        accent: {
          blue: "#3b82f6",
          purple: "#8b5cf6",
          green: "#22c55e",
          amber: "#f59e0b",
          red: "#ef4444",
        },
        text: {
          primary: "#e2e8f0",
          secondary: "#94a3b8",
          muted: "#64748b",
        },
        border: {
          primary: "#1e293b",
          hover: "#334155",
        },
      },
    },
  },
  plugins: [],
};

export default config;
