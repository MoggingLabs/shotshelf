// @ts-check
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

/**
 * Lint rules chosen to catch the mistakes this codebase has actually made,
 * rather than to enforce a house style — formatting arguments are not worth a
 * gate, and correctness ones are.
 *
 * The type-aware rules are the reason this is worth running at all: floating
 * promises and unawaited async work are exactly the shape of the bugs that
 * shipped here, where a `void invoke(...)` that should have been awaited left
 * state half-applied.
 */
export default defineConfig(
  {
    ignores: [
      "dist",
      // The review council runs each seat in a throwaway worktree under here.
      // They are clones of this repository, so linting them lints everything
      // twice — and their transient probe files are not ours to judge.
      ".claude/worktrees",
      "src-tauri",
      "test-results",
      "playwright-report",
      "node_modules",
      // Build scripts that only run under Node and are not part of the app's
      // TS project. `check-commands.mjs` is deliberately NOT here: it is a
      // gate, and a gate nobody checks is a gate that can quietly stop biting.
      "scripts/prepare-sidecar.mjs",
      "scripts/build-release.mjs",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // `eslint.config.js` is not in the TS project and does not need to be.
        projectService: {
          allowDefaultProject: [
            "eslint.config.js",
            "scripts/check-commands.mjs",
            "scripts/check-references.mjs",
            "scripts/check-dirs.mjs",
            "scripts/rust-source.mjs",
            "scripts/rust-source.test.mjs",
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Event handlers are the dominant shape in this codebase — `() =>
      // handlers.remove(id)` — and wrapping every one in braces to discard a
      // void the caller never looks at is noise, not safety.
      "@typescript-eslint/no-confusing-void-expression": "off",

      // `el<HTMLButtonElement>("#id")` is a single-use type parameter and so
      // technically an unchecked cast. It is also the standard shape of a DOM
      // query helper, and the alternative — casting at every call site — moves
      // the same assumption somewhere less visible.
      "@typescript-eslint/no-unnecessary-type-parameters": "off",

      // Dead code is a stated requirement, so unused anything is an error.
      // The TS compiler already refuses unused locals and parameters; this
      // covers imports and caught errors it does not.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", caughtErrors: "all", caughtErrorsIgnorePattern: "^_" },
      ],

      // `void promise` is deliberate and common here: fire-and-forget IPC whose
      // failure is already handled inside the bridge. Requiring the marker
      // keeps the deliberate ones distinguishable from the forgotten ones.
      "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: true }],

      // Template literals of unknown values are how "[object Object]" reaches
      // a tooltip. Numbers and booleans are fine.
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true },
      ],

      // The DOM API surface is full of nullable returns and this codebase
      // handles them explicitly; non-null assertions hide the ones it does not.
      "@typescript-eslint/no-non-null-assertion": "error",

      "no-console": ["error", { allow: ["error", "warn", "info"] }],
      eqeqeq: ["error", "always"],
      "prefer-const": "error",
      "no-var": "error",
    },
  },
  {
    // Node build scripts: globals the browser config does not declare, and
    // JSDoc-free JS where the type-aware rules have nothing to work with.
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { console: "readonly", process: "readonly" } },
    rules: {
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },
  {
    // `node:test` returns a promise per test and is designed to be called
    // without awaiting — the runner collects them. Flagging every case would
    // mean a `void` in front of all of them for no benefit.
    files: ["**/*.test.ts"],
    rules: { "@typescript-eslint/no-floating-promises": "off" },
  },
  {
    // Tests reach into the page and assert on values the types cannot know,
    // and a non-null assertion after an explicit `not.toBeNull()` is clearer
    // than re-narrowing. The harness is evaluated in the browser, where the
    // project's DOM types do not apply cleanly.
    files: ["tests/**/*.ts", "**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-empty-function": "off",
    },
  },
);
