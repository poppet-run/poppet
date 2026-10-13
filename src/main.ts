import { BunRuntime } from "@effect/platform-bun";
import { Console, Effect } from "effect";

import { run } from "./cli.ts";

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
