import { AppConfig } from "@poppet/config";
import {
  CredentialInput,
  Provider,
  ProviderConnection,
  ProviderId,
  type ProviderRegistration,
} from "@poppet/provider";
import { Console, Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import { terminalKeyInput } from "#src/api-key-input";
import type { CLIContext } from "#src/commands/context";
import { UsageError } from "#src/commands/errors";
import { booleanFlag } from "#src/commands/flags";
import { findProvider } from "#src/runtime";

const actions = ["login", "status", "models", "logout"] as const;

/** Parsed provider options, with a null provider left for configuration to resolve. */
interface ProviderCommand {
  readonly action: (typeof actions)[number];
  readonly provider: ProviderId | null;
  readonly keyStdin: boolean;
  readonly openBrowser: boolean;
  readonly callbackPort: number | null;
}

export const providerCommand = (context: CLIContext) => {
  const { runtime, registered } = context;

  const runProvider = (command: ProviderCommand) =>
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

      if ((!command.openBrowser || command.callbackPort !== null) && entry.authentication.apiKey)
        return yield* Effect.fail(
          new UsageError({
            message: `${entry.name} does not use browser sign-in. ${entry.authentication.help}`,
          }),
        );

      return yield* Effect.gen(function* () {
        if (command.action === "models") {
          const provider = yield* Provider;

          return yield* Console.log(JSON.stringify(yield* provider.models, null, 2));
        }

        const connection = yield* ProviderConnection;

        if (command.action === "login") yield* Console.log(yield* connection.login(command));
        else if (command.action === "status")
          yield* Console.log(JSON.stringify(yield* connection.status, null, 2));
        else if (command.action === "logout") yield* Console.log(yield* connection.logout);
      }).pipe(
        Effect.provide(runtime.selectedProvider(selected)),
        Effect.provideService(CredentialInput, terminalKeyInput),
      );
    });

  const providerHelp = describeProviders(registered);

  const providerCommands = actions.map((action) => {
    const targetArgument = Argument.String("provider").pipe(
      Argument.withDescription("Provider ID; defaults to the configured provider"),
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
            keyStdin: booleanFlag("key-stdin", "Read an API key from stdin"),
            browser: Flag.Boolean("browser").pipe(
              Flag.withDescription(
                "Open the system browser; --no-browser prints the link and accepts a pasted callback address",
              ),
              Flag.atMost(1),
              Flag.map(([value = true]) => value),
            ),
            callbackPort: Flag.Int("callback-port").pipe(
              Flag.withDescription(
                "Listen for the browser callback on this port, for SSH forwarding",
              ),
              Flag.atMost(1),
              Flag.map(([value]) => value ?? null),
            ),
          }
        : { target: targetArgument, provider: providerFlag };

    return Command.make(action, config, (input) =>
      Effect.gen(function* () {
        const target = Option.getOrNull(input.target);
        const provider = Option.getOrNull(input.provider);

        if (target !== null && provider !== null)
          return yield* Effect.fail(
            new UsageError({
              message: "Choose a provider either positionally or with --provider, not both.",
            }),
          );
        const selected = provider ?? target;

        if (selected !== null && !Schema.is(ProviderId)(selected))
          return yield* Effect.fail(new UsageError({ message: "Invalid provider ID." }));
        const callbackPort = input.callbackPort ?? null;

        if (callbackPort !== null && (callbackPort < 1 || callbackPort > 65535))
          return yield* Effect.fail(
            new UsageError({ message: "Choose a callback port from 1 to 65535." }),
          );
        yield* runProvider({
          action,
          provider: selected,
          keyStdin: input.keyStdin ?? false,
          openBrowser: input.browser ?? true,
          callbackPort,
        });
      }).pipe(Effect.provide(runtime.config)),
    ).pipe(
      Command.withDescription(
        {
          login: "Sign in or save an API key",
          status: "Show connection status without secrets",
          models: "List available models",
          logout: "Clear the selected provider's saved connection",
        }[action],
      ),
    );
  });

  return Command.make("provider").pipe(
    Command.withDescription(
      `Manage provider connections\n\n  Providers:\n  ${providerHelp.replaceAll("\n", "\n  ")}`,
    ),
    Command.withShortDescription("Manage provider connections"),
    Command.withSubcommands(providerCommands),
  );
};

const describeProviders = (registered: ReadonlyArray<ProviderRegistration>) =>
  registered.map((entry) => `${entry.id} (${entry.name}): ${entry.authentication.help}`).join("\n");
