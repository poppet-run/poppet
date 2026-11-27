import { Provider, ProviderConnection, invalidRequest } from "@poppet/provider";
import type { ProviderId } from "@poppet/provider";
import { Console, Effect } from "effect";
import { Prompt } from "effect/cli";

import type { CLIContext } from "#src/commands/context";
import { findProvider } from "#src/runtime";

export const promptProvider = (
  context: CLIContext,
  saved: { readonly provider: ProviderId; readonly model: string | null },
) =>
  Effect.gen(function* () {
    const provider = yield* Prompt.Select({
      message: "Provider",
      choices: context.registered.map((entry) => ({
        title: entry.name,
        value: entry.id,
        selected: entry.id === saved.provider,
      })),
    });

    const entry = yield* findProvider(provider, context.registered);

    const model = yield* Effect.gen(function* () {
      const connection = yield* ProviderConnection;
      const status = yield* connection.status;

      if (
        status.connected !== true ||
        status.source === "environment" ||
        status.planUsage === false ||
        (yield* Prompt.Confirm({ message: `Reconnect ${entry.name}?`, initial: false }))
      ) {
        yield* Console.log(yield* connection.login({ openBrowser: true, callbackPort: null }));
        yield* Console.log(`${entry.name} authentication saved.`);
      }

      const models = yield* (yield* Provider).models;

      if (models.length === 0) {
        return yield* Effect.fail(invalidRequest(provider, "The provider returned no models."));
      }

      return yield* Prompt.AutoComplete({
        message: "Model (type to filter)",
        choices: models.map((candidate) => ({
          title: `${candidate.name} (${candidate.id})`,
          value: candidate.id,
          selected: provider === saved.provider && candidate.id === saved.model,
        })),
      });
    }).pipe(Effect.provide(context.runtime.selectedProvider(provider)));

    return { provider, model };
  });
