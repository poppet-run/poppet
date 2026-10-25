import { fileURLToPath } from "node:url";

import { runIsolated } from "./isolated";

await runIsolated([
  process.execPath,
  "test",
  "--no-env-file",
  "--no-install",
  "--no-orphans",
  "--preload",
  fileURLToPath(new URL("./setup.ts", import.meta.url)),
  ...Bun.argv.slice(2),
]);
