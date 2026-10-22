import { BunRuntime } from "@effect/platform-bun";
import { ConfigProvider, Console, Effect } from "effect";

import { run } from "#src/cli";

// Execute the CLI at the process boundary. BunRuntime handles interruption
// and runs the cleanup registered by scoped resources.
BunRuntime.runMain(
  run(Bun.argv.slice(2)).pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromEnv({ preserveEmptyStrings: true }),
    ),
    Effect.catch((error) =>
      Effect.gen(function* () {
        yield* Console.error(error.message);
        process.exitCode = 1;
      }),
    ),
  ),
);
