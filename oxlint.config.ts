import { defineConfig } from "oxlint";

export default defineConfig({
  plugins: ["eslint", "typescript", "unicorn", "oxc", "import", "promise"],
  categories: {
    correctness: "error",
    suspicious: "error",
    perf: "warn",
  },
  env: {
    builtin: true,
    es2020: true,
  },
});
