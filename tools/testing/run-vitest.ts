import { fileURLToPath } from "node:url";

import { runIsolated } from "./isolated";

// Vitest runs inside Bun because the code under test uses Bun's runtime APIs.
await runIsolated([
  process.execPath,
  "--bun",
  "--no-env-file",
  "--no-install",
  fileURLToPath(new URL("../../node_modules/vitest/vitest.mjs", import.meta.url)),
  "run",
  ...Bun.argv.slice(2),
]);
