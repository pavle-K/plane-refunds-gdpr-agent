// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  {
    // web/ is a separate frontend project (its own package.json, tsconfig,
    // React/browser-global setup) — linted via `cd web && npm run typecheck`,
    // not this root config, which has no React/browser environment configured
    // and would otherwise also try to lint web/dist's built, minified output.
    ignores: ["dist/**", "node_modules/**", "src/db/migrations/**", "web/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  eslintConfigPrettier,
);
