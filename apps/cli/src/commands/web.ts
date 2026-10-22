import { Effect } from "effect";
import { Command, Flag } from "effect/cli";

import type { CLIContext } from "#src/commands/context";
import { manageWebSearch } from "#src/web-search";

export const webCommand = (context: CLIContext) => {
  const { runtime } = context;

  return Command.make("web").pipe(
    Command.withDescription("Manage Brave Search credentials"),
    Command.withSubcommands([
      Command.make(
        "login",
        {
          keyStdin: Flag.Boolean("key-stdin").pipe(
            Flag.withDescription("Read the search API key from stdin"),
            Flag.atMost(1),
            Flag.map(([value = false]) => value),
          ),
        },
        ({ keyStdin }) =>
          manageWebSearch("login", keyStdin).pipe(
            Effect.provide([runtime.searchCredentials, runtime.config]),
          ),
      ).pipe(Command.withDescription("Save a Brave Search API key")),
      ...(["status", "logout"] as const).map((action) =>
        Command.make(action, {}, () =>
          manageWebSearch(action).pipe(Effect.provide([runtime.searchCredentials, runtime.config])),
        ).pipe(
          Command.withDescription(
            action === "status"
              ? "Show search setup without secrets"
              : "Remove the saved search key",
          ),
        ),
      ),
    ]),
  );
};
