import { AppConfig } from "@poppet/config";
import {
  CredentialInput,
  ProviderConnection,
  ProviderId,
  type ProviderRegistration,
} from "@poppet/provider";
import { Console, Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import { readHiddenKey, readKeyStdin } from "#src/api-key-input";
import type { AuthCommand } from "#src/auth-command";
import type { CLIContext } from "#src/commands/context";
import { UsageError } from "#src/commands/errors";
import { showModels } from "#src/commands/provider";
import { findProvider } from "#src/runtime";

export const authCommand = (context: CLIContext) => {
  const { runtime, registered } = context;

  const runAuth = (command: AuthCommand) =>
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const selected = command.provider ?? config.provider;
      const entry = yield* findProvider(selected, registered);

      if (command.keyStdin && !entry.authentication.apiKey)
        return yield* Effect.fail(
          new UsageError({
            message: `${entry.name} does not support --key-stdin. ${entry.authentication.help}`,
          }),
        );

      return yield* Effect.gen(function* () {
        if (command.action === "models") return yield* showModels;

        const connection = yield* ProviderConnection;

        if (command.action === "login") yield* Console.log(yield* connection.login(command));
        else if (command.action === "status")
          yield* Console.log(JSON.stringify(yield* connection.status, null, 2));
        else if (command.action === "logout") yield* Console.log(yield* connection.logout);
        else if (command.action === "verify") {
          const model = yield* connection.verify(command.model ?? config.model);
          yield* Console.log(
            `Provider verification passed with ${selected}/${model}. Completed inference and one local tool round trip.`,
          );
        }
      }).pipe(
        Effect.provide(runtime.selectedProvider(selected)),
        Effect.provideService(CredentialInput, {
          readKey: (provider, stdin) => (stdin ? readKeyStdin(provider) : readHiddenKey(provider)),
        }),
      );
    });

  const providerHelp = describeProviders(registered);

  const authCommands = (["login", "status", "models", "verify", "logout"] as const).map(
    (action) => {
      const targetArgument = Argument.String(action === "verify" ? "model" : "provider").pipe(
        Argument.optional,
      );

      const providerFlag = Flag.String("provider").pipe(
        Flag.withSchema(ProviderId),
        Flag.withDescription("Override the configured provider"),
        Flag.atMost(1),
        Flag.map(([value]) => Option.fromUndefinedOr(value)),
      );

      const config =
        action === "login"
          ? {
              target: targetArgument,
              provider: providerFlag,
              keyStdin: Flag.Boolean("key-stdin").pipe(
                Flag.withDescription("Read an API key from stdin"),
                Flag.atMost(1),
                Flag.map(([value = false]) => value),
              ),
            }
          : { target: targetArgument, provider: providerFlag };

      return Command.make(action, config, (input) =>
        Effect.gen(function* () {
          const target = Option.getOrNull(input.target);
          const provider = Option.getOrNull(input.provider);

          if (action !== "verify" && target !== null && provider !== null)
            return yield* Effect.fail(
              new UsageError({
                message: "Choose a provider either positionally or with --provider, not both.",
              }),
            );
          const selected = action === "verify" ? provider : (provider ?? target);

          if (selected !== null && !Schema.is(ProviderId)(selected))
            return yield* Effect.fail(new UsageError({ message: "Invalid provider ID." }));
          yield* runAuth({
            action,
            provider: selected,
            model: action === "verify" ? target : null,
            keyStdin: input.keyStdin ?? false,
          });
        }).pipe(Effect.provide(runtime.config)),
      ).pipe(
        Command.withDescription(
          {
            login: "Sign in or save an API key",
            status: "Show connection status without secrets",
            models: "List available models",
            verify: "Verify inference and a local tool round trip",
            logout: "Clear the selected provider",
          }[action],
        ),
      );
    },
  );

  return Command.make("auth").pipe(
    Command.withDescription(`Manage provider connections\n\n${providerHelp}`),
    Command.withShortDescription("Manage provider connections"),
    Command.withSubcommands(authCommands),
  );
};

export const describeProviders = (registered: ReadonlyArray<ProviderRegistration>) =>
  registered.map((entry) => `${entry.id} (${entry.name}): ${entry.authentication.help}`).join("\n");
