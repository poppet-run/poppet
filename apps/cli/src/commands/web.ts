import { Effect } from "effect";
import { Command } from "effect/cli";

import type { CLIContext } from "#src/commands/context";
import { booleanFlag } from "#src/commands/flags";
import { manageWebSearch } from "#src/web-search";

export const webCommand = (context: CLIContext) => {
  const { runtime } = context;

  return Command.make("web").pipe(
    Command.withDescription("Manage credentials for the configured search provider"),
    Command.withSubcommands([
      Command.make(
        "login",
        {
          keyStdin: booleanFlag("key-stdin", "Read the search API key from stdin"),
        },
        ({ keyStdin }) =>
          manageWebSearch("login", keyStdin).pipe(
            Effect.provide([runtime.searchCredentials, runtime.config]),
          ),
      ).pipe(Command.withDescription("Save an API key for the configured search provider")),
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
