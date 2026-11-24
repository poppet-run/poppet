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
    // apps/web uses Preact (HTML attributes like `class`, no React Compiler), Effect code uses `.use()` / `.catch()`,
    // and runtime narrowing legitimately uses `instanceof` for Web APIs (Request, URLSearchParams) and error/transport classes.
    "@nkzw/no-instanceof": "off",
    "react/immutability": "off",
    "react/no-unknown-property": "off",
    "react-hooks/rules-of-hooks": "off",
    "unicorn/catch-error-name": ["error", { ignore: ["^cause$"] }],
    "unicorn/prefer-top-level-await": "off",

    // Project anti-slop and Effect rules.
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-runtime-typeof": "error",
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-parameters": "error",
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
      // Standalone hook scripts write protocol JSON and refusal messages to stdio.
      files: ["tools/hooks/**/*.ts"],
      rules: { "no-console": "off" },
    },
    {
      // Enforce hook rules in the Preact web app without triggering on Effect `.use()` elsewhere.
      // Allow async store handlers on JSX attributes (errors are handled inside the store).
      files: ["apps/web/**/*.{ts,tsx}"],
      rules: {
        "react-hooks/rules-of-hooks": "error",
        "typescript/no-misused-promises": ["error", { checksVoidReturn: { attributes: false } }],
      },
    },
    {
      // Bun types its async matchers, such as `expect(...).rejects`, as returning void.
      // Match @cloudflare/oxlint-config's relaxed test overrides for JSON.parse and test doubles.
      files: ["**/*.test.ts", "**/*.test.tsx"],
      rules: {
        "typescript/await-thenable": "off",
        "typescript/no-unsafe-call": "off",
        "typescript/no-unsafe-return": "off",
        "typescript/no-unsafe-type-assertion": "off",
      },
    },
    {
      // Proxy wrapper around Bun.spawn / Bun.spawnSync overloads.
      files: ["tools/testing/setup.ts"],
      rules: {
        "typescript/no-unsafe-argument": "off",
        "typescript/no-unsafe-assignment": "off",
        "typescript/no-unsafe-call": "off",
        "typescript/no-unsafe-member-access": "off",
        "typescript/no-unsafe-return": "off",
        "typescript/no-unsafe-type-assertion": "off",
      },
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
