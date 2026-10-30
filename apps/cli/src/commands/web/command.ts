import { Effect } from "effect";
import { Command, Flag } from "effect/cli";

import type { CLIContext } from "#src/commands/context";
import { jsonFlag } from "#src/commands/flags";
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
      Command.make("status", { json: jsonFlag }, ({ json }) =>
        manageWebSearch("status", undefined, json).pipe(
          Effect.provide([runtime.searchCredentials, runtime.config]),
        ),
      ).pipe(Command.withDescription("Show search setup without secrets")),
      Command.make("logout", {}, () =>
        manageWebSearch("logout").pipe(Effect.provide([runtime.searchCredentials, runtime.config])),
      ).pipe(Command.withDescription("Remove the saved search key")),
    ]),
  );
};
