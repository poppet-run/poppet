import { BunRuntime } from "@effect/platform-bun";
import { Console, Effect } from "effect";

import { run } from "./cli.ts";

// Execute the CLI at the process boundary. BunRuntime handles interruption
// and runs the cleanup registered by scoped resources.
BunRuntime.runMain(
  run(Bun.argv.slice(2)).pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        yield* Console.error(error.message);
        process.exitCode = 1;
      }),
    ),
  ),
);
