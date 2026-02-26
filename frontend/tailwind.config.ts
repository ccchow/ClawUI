import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: {
          primary: "rgb(var(--bg-primary) / <alpha-value>)",
          secondary: "rgb(var(--bg-secondary) / <alpha-value>)",
          tertiary: "rgb(var(--bg-tertiary) / <alpha-value>)",
          hover: "rgb(var(--bg-hover) / <alpha-value>)",
        },
        accent: {
          blue: "rgb(var(--accent-blue) / <alpha-value>)",
          purple: "rgb(var(--accent-purple) / <alpha-value>)",
          green: "rgb(var(--accent-green) / <alpha-value>)",
          amber: "rgb(var(--accent-amber) / <alpha-value>)",
          red: "rgb(var(--accent-red) / <alpha-value>)",
        },
        text: {
          primary: "rgb(var(--text-primary) / <alpha-value>)",
          secondary: "rgb(var(--text-secondary) / <alpha-value>)",
          muted: "rgb(var(--text-muted) / <alpha-value>)",
        },
        border: {
          primary: "rgb(var(--border-primary) / <alpha-value>)",
          hover: "rgb(var(--border-hover) / <alpha-value>)",
        },
      },
    },
  },
  plugins: [],
};

export default config;
