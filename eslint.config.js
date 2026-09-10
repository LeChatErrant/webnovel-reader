import js from "@eslint/js";
import globals from "globals";
import prettier from "eslint-config-prettier";

// Flat ESLint config. Recommended rules only, plus a couple of relaxations that
// suit this codebase: unused args prefixed with `_` are intentional (caught
// errors we deliberately swallow), and empty catch blocks are how several
// best-effort paths signal "ignore".
export default [
  { ignores: ["dist/**", "dev-dist/**", "node_modules/**"] },
  js.configs.recommended,
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.browser, __APP_VERSION__: "readonly" },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", caughtErrors: "none" }],
      "no-empty": ["warn", { allowEmptyCatch: true }],
    },
  },
  {
    files: ["vite.config.js", "vitest.config.js", "eslint.config.js", "scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
    },
  },
  {
    files: ["test/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
    },
  },
  prettier,
];
