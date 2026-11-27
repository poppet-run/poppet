import { Provider, ProviderConnection, invalidRequest } from "@poppet/provider";
import type { ProviderId, ProviderRegistration } from "@poppet/provider";
import { Console, Effect } from "effect";
import { Prompt } from "effect/cli";

import type { CLIContext } from "#src/commands/context";
import { findProvider } from "#src/runtime";

const chooseModel = (
  entry: ProviderRegistration,
  saved: { readonly provider: ProviderId; readonly model: string | null },
) =>
  Effect.gen(function* () {
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
      return yield* Effect.fail(invalidRequest(entry.id, "The provider returned no models."));
    }

    let preferred = entry.id === saved.provider ? saved.model : null;

    for (;;) {
      const model = yield* Prompt.AutoComplete({
        message: "Model (type to filter)",
        choices: models.map((candidate) => ({
          title: `${candidate.name} (${candidate.id})`,
          value: candidate.id,
          selected: candidate.id === preferred,
        })),
      });

      if (
        !(yield* Prompt.Confirm({
          message: `Send ${model} a short test request? It uses a little of your quota.`,
          initial: true,
        }))
      ) {
        return model;
      }

      yield* Console.log(`Testing ${model}...`);

      const failure = yield* connection.verify(model).pipe(
        Effect.as(null),
        Effect.catch((error) => Effect.succeed(error.message)),
      );

      if (failure === null) {
        yield* Console.log(`${model} answered the test request.`);

        return model;
      }

      yield* Console.log(`The test request failed: ${failure}`);

      const next = yield* Prompt.Select({
        message: "What next?",
        choices: [
          { title: "Keep this model", value: "keep" as const },
          { title: "Choose another model", value: "choose" as const },
        ],
      });

      if (next === "keep") {
        return model;
      }

      preferred = model;
    }
  });

export const promptProvider = (
  context: CLIContext,
  saved: { readonly provider: ProviderId; readonly model: string | null },
) =>
  Effect.gen(function* () {
    let retry: ProviderId | null = null;

    for (;;) {
      const provider: ProviderId =
        retry ??
        (yield* Prompt.Select({
          message: "Provider",
          choices: context.registered.map((entry) => ({
            title: entry.name,
            value: entry.id,
            selected: entry.id === saved.provider,
          })),
        }));

      const entry: ProviderRegistration = yield* findProvider(provider, context.registered);

      const outcome = yield* chooseModel(entry, saved).pipe(
        Effect.provide(context.runtime.selectedProvider(provider)),
        Effect.map((model) => ({ model, error: null })),
        Effect.catchTag("ProviderError", (error) => Effect.succeed({ model: null, error })),
      );

      if (outcome.error === null) {
        return { provider, model: outcome.model };
      }

      yield* Console.log(outcome.error.message);

      const next: "retry" | "choose" | "quit" = yield* Prompt.Select({
        message: "What next?",
        choices: [
          { title: `Try ${entry.name} again`, value: "retry" as const },
          { title: "Choose another provider", value: "choose" as const },
          { title: "Quit setup", value: "quit" as const },
        ],
      });

      if (next === "quit") {
        return yield* Effect.fail(outcome.error);
      }

      retry = next === "retry" ? provider : null;
    }
  });
