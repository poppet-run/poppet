import { type Config, Console, Data, Effect } from "effect";

import { AppConfig, AppConfigLive } from "./config.ts";

class UsageError extends Data.TaggedError("UsageError")<{
  readonly message: string;
}> {}

const help = `Poppet

Usage: bun run start [command]

Commands:
  config    Show validated configuration
  --help    Show this help

ChatGPT sign-in, chat, memory, and scheduled tasks are planned next.`;

const showConfig = Effect.gen(function* () {
  const config = yield* AppConfig;
  yield* Console.log(JSON.stringify(config, null, 2));
});

export const run = (
  args: ReadonlyArray<string>,
): Effect.Effect<void, UsageError | Config.ConfigError> => {
  if (args.length === 0 || (args.length === 1 && (args[0] === "--help" || args[0] === "-h"))) {
    return Console.log(help);
  }

  if (args.length === 1 && args[0] === "config") {
    return showConfig.pipe(Effect.provide(AppConfigLive));
  }

  return Effect.fail(new UsageError({ message: "Unknown command. Run bun run start --help." }));
};
