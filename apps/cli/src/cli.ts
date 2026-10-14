import type { AgentError } from "@poppet/agent";
import { AppConfig } from "@poppet/config";
import {
  CredentialInput,
  Model,
  Provider,
  ProviderConnection,
  verifyModel,
  type ProviderRegistration,
  type ProviderError,
} from "@poppet/provider";
import { Store, type StoreError } from "@poppet/store";
import { Console, Data, Effect, type Config } from "effect";

import { readHiddenKey, readKeyStdin } from "#src/api-key-input";
import { parseAuthCommand, type AuthCommand } from "#src/auth-command";
import {
  inspectChat,
  parseChatCommand,
  prepareChat,
  sendChat,
  writeChatText,
  type ChatWriter,
} from "#src/chat";
import { providers } from "#src/providers";
import { findProvider, runtimeLayers } from "#src/runtime";

class UsageError extends Data.TaggedError("UsageError")<{
  readonly message: string;
}> {}

const help = (registered: ReadonlyArray<ProviderRegistration>) => `Poppet

Usage: bun run start [command]

Commands:
  config    Show validated configuration
  store status             Open/migrate the conversation store and show counts
  chat new [--coding] <message>  Start a session with the configured provider/model
  chat send <session> <message> Continue a saved session
  chat sessions            List sessions
  chat show <session>      Show messages and run outcomes
  auth login [provider] [--consent | --key-stdin]  Sign in or save an API key
  auth status [provider]   Show connection status without secrets
  auth models [provider]   List available models
  auth verify [model]      Verify inference and a local tool round trip
  auth logout [provider]   Clear the selected provider

Auth accepts --provider <id> for any action, overriding POPPET_PROVIDER.
Providers: ${registered.map((entry) => entry.id).join(", ")}.
${registered.map((entry) => `${entry.name}: ${entry.authentication.help}`).join("\n")}
  provider models          List supported models for the configured provider
  provider verify          Verify the configured provider/model with a local tool
  --help    Show this help

Notes tools, memory, and scheduled tasks are planned next.`;

const showConfig = Effect.gen(function* () {
  yield* Console.log(JSON.stringify(yield* AppConfig, null, 2));
});

export const makeCLI = (
  registered: ReadonlyArray<ProviderRegistration>,
  write: ChatWriter = writeChatText,
) => {
  const runtime = runtimeLayers(registered);

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

      if (command.consent && !entry.authentication.consent)
        return yield* Effect.fail(
          new UsageError({
            message: `${entry.name} does not support --consent. ${entry.authentication.help}`,
          }),
        );

      return yield* Effect.gen(function* () {
        if (command.action === "models") {
          const provider = yield* Provider;
          yield* Console.log(JSON.stringify(yield* provider.models, null, 2));

          return;
        }

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

  return (
    args: ReadonlyArray<string>,
  ): Effect.Effect<
    void,
    Config.ConfigError | ProviderError | StoreError | UsageError | AgentError
  > => {
    // Help works before configuration or credential storage is opened.
    if (args.length === 0 || (args.length === 1 && (args[0] === "--help" || args[0] === "-h")))
      return Console.log(help(registered));

    if (args.length === 1 && args[0] === "config")
      return showConfig.pipe(Effect.provide(runtime.config));

    if (args.length === 2 && args[0] === "store" && args[1] === "status")
      return Effect.gen(function* () {
        const store = yield* Store;
        yield* Console.log(JSON.stringify(yield* store.status, null, 2));
      }).pipe(Effect.provide(runtime.store));

    if (args.length === 2 && args[0] === "provider" && args[1] === "models")
      return Effect.gen(function* () {
        const provider = yield* Provider;
        yield* Console.log(JSON.stringify(yield* provider.models, null, 2));
      }).pipe(Effect.provide(runtime.provider));

    if (args.length === 2 && args[0] === "provider" && args[1] === "verify")
      return Effect.gen(function* () {
        const model = yield* Model;
        yield* verifyModel(model);
        yield* Console.log(
          `Provider verification passed with ${model.description.provider}/${model.description.id}. Completed inference and one local tool round trip.`,
        );
      }).pipe(Effect.provide(runtime.model));

    if (args[0] === "auth") {
      const command = parseAuthCommand(args.slice(1));

      if (command !== null) return runAuth(command).pipe(Effect.provide(runtime.config));
    }

    if (args[0] === "chat") {
      const command = parseChatCommand(args.slice(1));

      if (command !== null) {
        if (command.action === "show" || command.action === "sessions")
          return inspectChat(command).pipe(Effect.provide(runtime.store));
        const selected = command;

        return Effect.gen(function* () {
          const submission = yield* prepareChat(selected);

          return yield* sendChat(submission, write).pipe(Effect.provide(runtime.chat));
        }).pipe(Effect.provide(runtime.config));
      }
    }

    return Effect.fail(new UsageError({ message: "Unknown command. Run bun run start --help." }));
  };
};

export const run = makeCLI(providers);
