import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["frontend/**", "**/dist/**", "**/node_modules/**", "**/.next/**"],
  },
  ...tseslint.configs.recommended,
  {
    files: ["backend/src/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
);
