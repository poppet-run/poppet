import { defineConfig } from "oxlint";

export default defineConfig({
  plugins: ["eslint", "typescript", "unicorn", "oxc", "import", "promise"],
  categories: {
    correctness: "error",
    suspicious: "error",
    perf: "warn",
  },
  options: {
    typeAware: true,
  },
  env: {
    builtin: true,
    es2020: true,
  },
  ignorePatterns: [
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
    // Type-aware rules with existing findings stay visible until they are cleaned up.
    "typescript/consistent-return": "warn",
    "typescript/no-base-to-string": "warn",
    "typescript/no-misused-spread": "warn",
    "typescript/no-unnecessary-boolean-literal-compare": "warn",
    "typescript/no-unnecessary-type-arguments": "warn",
    "typescript/no-unnecessary-type-assertion": "warn",
    "typescript/no-unnecessary-type-conversion": "warn",
    "typescript/no-unnecessary-type-parameters": "warn",
    "typescript/no-unsafe-enum-assignment": "warn",
    "typescript/no-unsafe-type-assertion": "warn",
    "typescript/restrict-template-expressions": "warn",
    "typescript/unbound-method": "warn",
    "oxc/no-accumulating-spread": "error",
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
