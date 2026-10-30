import { Effect } from "effect";
import { Command, Flag } from "effect/cli";

import type { CLIContext } from "#src/commands/context";
import { manageWebSearch } from "#src/commands/web/search";

export const webCommand = (context: CLIContext) => {
  const { runtime } = context;

  return Command.make("web").pipe(
    Command.withDescription("Manage credentials for the configured search provider"),
    Command.withSubcommands([
      Command.make(
        "login",
        {
          apiKey: Flag.String("api-key").pipe(
            Flag.withDescription("Save the search API key"),
            Flag.atMost(1),
            Flag.map(([value]) => value),
          ),
        },
        ({ apiKey }) =>
          manageWebSearch("login", apiKey).pipe(
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
