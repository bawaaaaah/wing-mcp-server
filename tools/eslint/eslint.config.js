// Flat-config port of the maintainer's usual .eslintrc.json, for ESLint 10 + typescript-eslint 8.
//
// Lives in its own workspace (tools/eslint) because typescript-eslint's type-aware rules need
// TypeScript's JavaScript API, which the TypeScript 7 native compiler this repository builds with
// does not ship; this workspace carries TypeScript 6 for them. The root eslint.config.js only
// re-exports this file, so `npm run lint` / `eslint .` work from the repository root as usual.
//
// What changed from the .eslintrc.json, and why:
// - Rules typescript-eslint 8 removed are mapped to their successors: ban-types →
//   no-wrapper-object-types + no-unsafe-function-type, no-empty-interface → no-empty-object-type,
//   no-var-requires → no-require-imports; no-parameter-properties had no effect ("off") and is gone.
//   id-blacklist → id-denylist, eslint-plugin-import → eslint-plugin-import-x (ESLint 10 support).
// - The formatting rules typescript-eslint dropped (quotes, semi, member-delimiter-style,
//   comma-dangle, keyword-spacing, plus the core ones ESLint deprecated) come from @stylistic.
// - Three style rules are set to what this codebase already does rather than what the .eslintrc
//   asked for, because adopting them would rewrite nearly every file for no behavioural gain:
//   comma-dangle (the code has ~2,000 trailing commas; "always-multiline" instead of "never"),
//   explicit-member-accessibility (the code never writes `public`; "no-public" instead of
//   "explicit") and member-delimiter-style (type literals use ";" like interfaces do). Flip them
//   back and run `eslint --fix` in a dedicated commit if you want the original style.
// - `quotes` allows another quote where double quotes would need escaping (avoidEscape).
// - `no-invalid-this` uses the TypeScript-aware extension, and is off in tests: mocha hands its
//   context to `function () { this.timeout(…) }` callbacks by design. `no-empty-function` is off in
//   tests too, where fakes are empty methods on purpose.

import stylistic from "@stylistic/eslint-plugin";
import importX from "eslint-plugin-import-x";
import globals from "globals";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tseslint from "typescript-eslint";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "lib/**",
      "coverage/**",
      ".nyc_output/**",
      "**/*.js",
      "**/*.mjs",
      "**/*.cjs",
      "**/tsconfig*.json",
    ],
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    extends: [...tseslint.configs.recommendedTypeChecked],
    plugins: {
      "@stylistic": stylistic,
      "import-x": importX,
    },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node, ...globals.es2021 },
      parserOptions: {
        projectService: { allowDefaultProject: ["web/vite.config.ts"] },
        tsconfigRootDir: repoRoot,
      },
    },
    rules: {
      // Off, not because it is wrong in general but because its verdict comes from TypeScript 6
      // while the code is compiled by TypeScript 7: the two infer some types differently, and an
      // assertion TypeScript 6 calls unnecessary can be one TypeScript 7 needs (its autofix broke
      // `npm run typecheck` when tried).
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/adjacent-overload-signatures": "error",
      "@typescript-eslint/array-type": ["warn", { default: "array" }],
      "@typescript-eslint/no-wrapper-object-types": "warn",
      "@typescript-eslint/no-unsafe-function-type": "warn",
      "@typescript-eslint/consistent-type-assertions": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", disallowTypeAnnotations: false, fixStyle: "separate-type-imports" },
      ],
      "@typescript-eslint/dot-notation": "error",
      "@typescript-eslint/explicit-member-accessibility": ["error", { accessibility: "no-public" }],
      "@typescript-eslint/explicit-module-boundary-types": ["error", { allowArgumentsExplicitlyTypedAsAny: true }],
      "@stylistic/member-delimiter-style": [
        "error",
        {
          multiline: { delimiter: "semi", requireLast: true },
          singleline: { delimiter: "semi", requireLast: false },
        },
      ],
      "@typescript-eslint/naming-convention": "off",
      "@typescript-eslint/no-empty-function": "warn",
      "@typescript-eslint/no-empty-object-type": "warn",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-import-type-side-effects": "error",
      "@typescript-eslint/no-inferrable-types": "off",
      "@typescript-eslint/no-misused-new": "error",
      "@typescript-eslint/no-namespace": "off",
      "@typescript-eslint/no-shadow": ["error", { hoist: "all" }],
      "@typescript-eslint/no-unused-expressions": "warn",
      "@typescript-eslint/no-unused-vars": ["error", { vars: "all", argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-use-before-define": "off",
      "@typescript-eslint/no-require-imports": "error",
      "@typescript-eslint/prefer-for-of": "off",
      "@typescript-eslint/prefer-function-type": "warn",
      "@typescript-eslint/prefer-namespace-keyword": "warn",
      // Double quotes, as asked — but a string that contains one may use another quote (or a
      // template literal) instead of a wall of backslashes, which is what the code already does.
      "@stylistic/quotes": ["error", "double", { avoidEscape: true, allowTemplateLiterals: "avoidEscape" }],
      "@typescript-eslint/require-await": "off",
      "@stylistic/semi": "error",
      "@typescript-eslint/triple-slash-reference": ["error", { path: "always", types: "prefer-import", lib: "always" }],
      "@typescript-eslint/unbound-method": "error",
      "@typescript-eslint/unified-signatures": "error",
      "@stylistic/comma-dangle": ["error", "always-multiline"],
      "@stylistic/keyword-spacing": "warn",
      "import-x/no-extraneous-dependencies": [
        "error",
        {
          devDependencies: ["**/*.test.ts", "**/*.spec.ts", "test/**", "scripts/**", "**/vite.config.ts"],
          optionalDependencies: false,
          peerDependencies: false,
        },
      ],
      complexity: "off",
      "constructor-super": "error",
      "dot-notation": "off",
      eqeqeq: ["error", "smart"],
      "guard-for-in": "off",
      "id-denylist": ["error", "any", "Number", "number", "String", "string", "Boolean", "boolean", "Undefined", "undefined"],
      "id-match": "error",
      "max-classes-per-file": "off",
      "@stylistic/new-parens": "error",
      "no-bitwise": "warn",
      "no-caller": "error",
      "no-cond-assign": "warn",
      "no-console": "off",
      "no-debugger": "error",
      "no-empty": "off",
      "no-empty-function": "off",
      "no-eval": "error",
      "no-fallthrough": "off",
      "no-invalid-this": "off",
      "@typescript-eslint/no-invalid-this": "error",
      "no-irregular-whitespace": "error",
      "no-new-wrappers": "error",
      "no-shadow": "off",
      "no-throw-literal": "error",
      "@stylistic/no-trailing-spaces": "error",
      "no-undef-init": "error",
      "no-underscore-dangle": "off",
      "no-unsafe-finally": "error",
      "no-unused-expressions": "off",
      "no-unused-labels": "error",
      "no-unused-vars": "off",
      "no-use-before-define": "off",
      "no-var": "error",
      "object-shorthand": "off",
      "one-var": ["error", "never"],
      "prefer-arrow-callback": "warn",
      "prefer-const": "error",
      quotes: "off",
      radix: "error",
      "require-await": "off",
      semi: "off",
      "comma-dangle": "off",
      "@stylistic/spaced-comment": ["warn", "always", { markers: ["/"] }],
      "use-isnan": "warn",
      "valid-typeof": "off",
      "@stylistic/eol-last": "error",
    },
  },
  {
    files: ["web/src/**/*.ts", "web/src/**/*.tsx"],
    languageOptions: { globals: { ...globals.browser, ...globals.es2021 } },
  },
  {
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-invalid-this": "off",
      // Fakes and stubs are empty methods by nature.
      "@typescript-eslint/no-empty-function": "off",
      // chai's property assertions (`expect(x).to.be.undefined;`) are expressions by design.
      "@typescript-eslint/no-unused-expressions": "off",
    },
  },
);
