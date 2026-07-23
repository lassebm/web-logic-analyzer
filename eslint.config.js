import js from "@eslint/js";
import ts from "typescript-eslint";
import svelte from "eslint-plugin-svelte";
import prettier from "eslint-config-prettier";
import globals from "globals";
import svelteConfig from "./svelte.config.js";

export default ts.config(
  // Base recommended rule sets (best-practice presets, not hand-picked rules).
  js.configs.recommended,
  ...ts.configs.recommended,
  ...svelte.configs.recommended,
  // Turn off stylistic rules that Prettier owns.
  prettier,
  ...svelte.configs.prettier,

  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      // Allow intentionally-unused bindings prefixed with `_` (e.g. `{#each xs as _, i}`).
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },

  // Let the Svelte parser hand <script lang="ts"> blocks to the TS parser.
  {
    files: ["**/*.svelte"],
    languageOptions: {
      // Pass the Svelte config so the plugin knows the project is in runes mode.
      parserOptions: { parser: ts.parser, svelteConfig },
    },
  },

  {
    ignores: ["dist/", "coverage/", "node_modules/", "**/*.fw"],
  },
);
