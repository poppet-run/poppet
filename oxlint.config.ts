import cloudflare from "@cloudflare/oxlint-config";
import { defineConfig } from "oxlint";

export default defineConfig({
  extends: [cloudflare],
  env: cloudflare.env,
  options: {
    reportUnusedDisableDirectives: "error",
    typeAware: true,
  },
  ignorePatterns: [
    ...(cloudflare.ignorePatterns ?? []),
    ".agent/**",
    ".agents/**",
    ".claude/**",
    ".codex/**",
    ".continue/**",
    ".cursor/**",
    ".gemini/**",
    ".opencode/**",
    ".pi/**",
    ".roo/**",
    ".windsurf/**",
    "tools/oxlint/anti-slop/**",
  ],
  jsPlugins: [
    { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
    { name: "anti-slop-effect", specifier: "./tools/oxlint/anti-slop/effect/index.ts" },
  ],
  rules: {
    // Deduplicate rules already enforced by the vendored anti-slop plugin below.
    "quality/no-array-filter-map": "off",
    "quality/no-chained-type-assertions": "off",
    "quality/no-conditional-empty-object-spread": "off",
    "quality/no-known-value-widening": "off",
    "quality/no-object-parameters": "off",
    "quality/no-reduce-accumulator-copy": "off",
    "quality/no-reflect-apply": "off",
    "quality/no-reflect-get": "off",
    "quality/no-unknown-returns": "off",
    "quality/no-unknown-type-aliases": "off",
    "quality/no-unsafe-dictionary-type": "off",
    "quality/no-widen-then-assert": "off",

    // apps/web uses Preact (HTML attributes like `class`), and non-web Effect code uses `.use()`.
    "react/no-unknown-property": "off",
    "react-hooks/rules-of-hooks": "off",

    // Temporarily disabled during @cloudflare/oxlint-config migration; evaluate one rule per commit.
    "@nkzw/no-instanceof": "off",
    curly: "off",
    eqeqeq: "off",
    "import/consistent-type-specifier-style": "off",
    "import/no-namespace": "off",
    "no-console": "off",
    "no-empty": "off",
    "no-promise-executor-return": "off",
    "oxc/bad-bitwise-operator": "off",
    "react/button-has-type": "off",
    "react/immutability": "off",
    "typescript/array-type": "off",
    "typescript/consistent-type-imports": "off",
    "typescript/no-explicit-any": "off",
    "typescript/no-import-type-side-effects": "off",
    "typescript/no-misused-promises": "off",
    "typescript/no-misused-spread": "off",
    "typescript/no-non-null-assertion": "off",
    "typescript/no-unnecessary-type-assertion": "off",
    "typescript/no-unsafe-argument": "off",
    "typescript/no-unsafe-assignment": "off",
    "typescript/no-unsafe-call": "off",
    "typescript/no-unsafe-member-access": "off",
    "typescript/no-unsafe-return": "off",
    "typescript/no-unsafe-type-assertion": "off",
    "typescript/switch-exhaustiveness-check": "off",
    "typescript/unbound-method": "off",
    "typescript/use-unknown-in-catch-callback-variable": "off",
    "unicorn/catch-error-name": "off",
    "unicorn/no-hex-escape": "off",
    "unicorn/no-useless-promise-resolve-reject": "off",
    "unicorn/numeric-separators-style": "off",
    "unicorn/prefer-import-meta-properties": "off",
    "unicorn/prefer-single-call": "off",
    "unicorn/prefer-string-raw": "off",
    "unicorn/prefer-string-replace-all": "off",
    "unicorn/prefer-top-level-await": "off",

    // Project anti-slop and Effect rules.
    "anti-slop/no-array-filter-map": "error",
    "anti-slop/no-reduce-accumulator-copy": "error",
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-runtime-typeof": "error",
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-parameters": "error",
    "anti-slop/no-unknown-returns": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-unsafe-dictionary-type": "error",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/require-readable-spacing": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error",
    "anti-slop-effect/no-manual-effect-error-tag": "error",
    "anti-slop-effect/no-manual-tag-comparison": "error",
    "anti-slop-effect/no-manual-tagged-construction": "error",
    "anti-slop-effect/no-service-constructor-imports": "error",
    "anti-slop-effect/prefer-effect-match": "error",
  },
  overrides: [
    {
      // Enforce hook rules in the Preact web app without triggering on Effect `.use()` elsewhere.
      files: ["apps/web/**/*.{ts,tsx}"],
      rules: { "react-hooks/rules-of-hooks": "error" },
    },
    {
      // Bun types its async matchers, such as `expect(...).rejects`, as returning void.
      files: ["**/*.test.ts", "**/*.test.tsx"],
      rules: { "typescript/await-thenable": "off" },
    },
    {
      files: ["packages/**/*.ts", "apps/cli/src/**/*.ts"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              {
                group: ["@poppet/provider-*", "@poppet/provider-*/**"],
                message:
                  "Use the shared provider interface. Concrete providers may only be imported by the registration list.",
              },
              {
                group: ["@poppet/channel-*", "@poppet/channel-*/**"],
                message:
                  "Use the shared channel interface. Concrete channels may only be imported by the registration list.",
              },
            ],
          },
        ],
      },
    },
    {
      files: ["apps/cli/src/providers.ts", "apps/cli/src/commands/gateway/registry.ts"],
      rules: { "no-restricted-imports": "off" },
    },
    {
      files: ["packages/provider-openai/src/test/fixtures/**/*.ts"],
      rules: {
        "anti-slop-effect/no-service-constructor-imports": "off",
      },
    },
  ],
});
