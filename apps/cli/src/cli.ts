import { AppConfig, AppConfigLive } from "@poppet/config";
import {
  ApiKeyStore,
  ApiKeyStoreLive,
  environmentApiKey,
  type ApiKeyProvider,
} from "@poppet/credentials";
import { Model, Provider, verifyModel, type ProviderError } from "@poppet/provider";
import { ChatGPTAuth, ChatGPTModel, type ConnectionError } from "@poppet/provider-openai";
import { type Config, Console, Data, Effect, Option } from "effect";

import { readHiddenKey, readKeyStdin } from "#src/api-key-input";
import { parseAuthCommand, type AuthCommand } from "#src/auth-command";
import {
  ChatGPTRuntime,
  ProviderRuntime,
  SelectedModelRuntime,
  selectProviderLayer,
} from "#src/runtime";

class UsageError extends Data.TaggedError("UsageError")<{
  readonly message: string;
}> {}

const help = `Poppet

Usage: bun run start [command]

Commands:
  config    Show validated configuration
  auth login [provider] [--consent | --key-stdin]  Sign in or save an API key
  auth status [provider]   Show connection status without secrets
  auth models [provider]   List available models
  auth verify [model]      Verify inference and a local tool round trip
  auth logout [provider]   Clear the selected provider

Auth accepts --provider <id> for any action, overriding POPPET_PROVIDER.
Providers: openai-chatgpt, opencode-go, openrouter.
--consent is for ChatGPT; --key-stdin is for API-key providers.
  provider models          List supported models for the configured provider
  provider verify          Verify the configured provider/model with a local tool
  --help    Show this help

Chat, memory, and scheduled tasks are planned next.`;

const showConfig = Effect.gen(function* () {
  const config = yield* AppConfig;
  yield* Console.log(JSON.stringify(config, null, 2));
});

export const runChatGPTAuth = (command: AuthCommand) =>
  Effect.gen(function* () {
    const auth = yield* ChatGPTAuth;
    const model = yield* ChatGPTModel;

    if (command.action === "login") {
      const status = yield* auth.login(command.consent);
      yield* Console.log(
        status.planUsage
          ? "Connected to ChatGPT. Plan usage is enabled; run auth verify --provider openai-chatgpt to check inference."
          : "Connected to ChatGPT. Plan usage was not granted; run auth login openai-chatgpt --consent to enable it.",
      );
    } else if (command.action === "status") {
      yield* Console.log(JSON.stringify(yield* auth.status, null, 2));
    } else if (command.action === "models") {
      yield* Console.log(JSON.stringify(yield* model.models, null, 2));
    } else if (command.action === "verify") {
      const verifiedModel = yield* model.verify(command.model);
      yield* Console.log(
        `ChatGPT subscription verification passed with ${verifiedModel}. Completed inference and one local tool round trip.`,
      );
    } else if (command.action === "logout") {
      const revoked = yield* auth.signOut;
      yield* Console.log(
        revoked
          ? "Signed out. Local tokens were cleared; the registration and host ID were retained."
          : "Local tokens were cleared, but remote revocation was not confirmed. Disconnect Poppet in ChatGPT Settings.",
      );
    }
  });

const runKeyAuth = (provider: ApiKeyProvider, command: AuthCommand) =>
  Effect.gen(function* () {
    const store = yield* ApiKeyStore;

    if (command.action === "login") {
      const key = command.keyStdin
        ? yield* readKeyStdin(provider)
        : yield* environmentApiKey(provider).pipe(
            Effect.flatMap(
              Option.match({ onSome: Effect.succeed, onNone: () => readHiddenKey(provider) }),
            ),
          );

      yield* store.write(provider, key);
      yield* Console.log(
        `API key saved for ${provider}. Run auth verify <model> --provider ${provider} to check access.`,
      );
    } else if (command.action === "status") {
      const environment = yield* environmentApiKey(provider);
      const saved = Option.isSome(environment) ? null : yield* store.read(provider);
      yield* Console.log(
        JSON.stringify(
          {
            provider,
            connected: Option.isSome(environment) || saved !== null,
            source: Option.isSome(environment) ? "environment" : saved !== null ? "stored" : null,
          },
          null,
          2,
        ),
      );
    } else if (command.action === "logout") {
      yield* store.remove(provider);
      yield* Console.log(
        `Saved ${provider} API key removed. An environment API key, if set, still overrides local storage. Remote keys are not revoked.`,
      );
    }
  });

const runAuth = (command: AuthCommand) =>
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const selected = command.provider ?? config.provider;

    if (selected === "openai-chatgpt") {
      if (command.keyStdin)
        return yield* Effect.fail(
          new UsageError({
            message: "--key-stdin is for OpenRouter and OpenCode Go. ChatGPT uses browser sign-in.",
          }),
        );

      return yield* runChatGPTAuth(command).pipe(Effect.provide(ChatGPTRuntime));
    }

    if (command.consent)
      return yield* Effect.fail(
        new UsageError({ message: "--consent is only supported for ChatGPT browser sign-in." }),
      );

    if (command.action === "models")
      return yield* Effect.gen(function* () {
        const provider = yield* Provider;
        yield* Console.log(JSON.stringify(yield* provider.models, null, 2));
      }).pipe(Effect.provide(selectProviderLayer(selected)));

    if (command.action === "verify") {
      const modelId = command.model ?? config.model;

      if (modelId === null)
        return yield* Effect.fail(
          new UsageError({
            message: "Choose a model with auth verify <model> or set POPPET_MODEL.",
          }),
        );

      return yield* Effect.gen(function* () {
        const provider = yield* Provider;
        const model = yield* provider.resolve(modelId);
        yield* verifyModel(model);
        yield* Console.log(
          `Provider verification passed with ${selected}/${model.description.id}. Completed inference and one local tool round trip.`,
        );
      }).pipe(Effect.provide(selectProviderLayer(selected)));
    }

    return yield* runKeyAuth(selected, command).pipe(Effect.provide(ApiKeyStoreLive));
  });

export const run = (
  args: ReadonlyArray<string>,
): Effect.Effect<void, UsageError | Config.ConfigError | ConnectionError | ProviderError> => {
  // Route help before providing any layers so it works even with invalid config
  // and does not open credential storage or acquire its lock.
  if (args.length === 0 || (args.length === 1 && (args[0] === "--help" || args[0] === "-h"))) {
    return Console.log(help);
  }

  if (args.length === 1 && args[0] === "config") {
    return showConfig.pipe(Effect.provide(AppConfigLive));
  }

  if (args.length === 2 && args[0] === "provider" && args[1] === "models")
    return Effect.gen(function* () {
      const provider = yield* Provider;
      yield* Console.log(JSON.stringify(yield* provider.models, null, 2));
    }).pipe(Effect.provide(ProviderRuntime));

  if (args.length === 2 && args[0] === "provider" && args[1] === "verify")
    return Effect.gen(function* () {
      const model = yield* Model;
      yield* verifyModel(model);
      yield* Console.log(
        `Provider verification passed with ${model.description.provider}/${model.description.id}. Completed inference and one local tool round trip.`,
      );
    }).pipe(Effect.provide(SelectedModelRuntime));

  if (args[0] === "auth") {
    const command = parseAuthCommand(args.slice(1));

    if (command !== null) return runAuth(command).pipe(Effect.provide(AppConfigLive));
  }

  return Effect.fail(new UsageError({ message: "Unknown command. Run bun run start --help." }));
};
