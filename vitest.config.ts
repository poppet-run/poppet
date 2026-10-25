import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/*/src/**/*.test.ts", "packages/*/src/**/*.test.ts"],
    setupFiles: ["./tools/testing/setup.ts"],
    pool: "forks",
  },
});
