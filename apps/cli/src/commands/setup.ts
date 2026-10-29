import { AppConfig, readConfigFile, updateConfigFile } from "@poppet/config";
import { ChannelEnvironment } from "@poppet/gateway";
import { CredentialInput, Provider, ProviderConnection, invalidRequest } from "@poppet/provider";
import { remoteTaskCommand } from "@poppet/tasks";
import { workerSocketPath } from "@poppet/worker";
import { Console, Effect, Schema } from "effect";
import { Command, Prompt } from "effect/cli";

import { readHiddenKey, readVisibleLine } from "#src/api-key-input";
import type { CLIContext } from "#src/commands/context";
import { UsageError } from "#src/commands/errors";
import { findProvider } from "#src/runtime";

const setupWorker = (context: CLIContext, directory: string) =>
  Effect.gen(function* () {
    const managed = yield* context.worker("status", directory);

    if (managed === null) {
      yield* Console.log("Start scheduling and messaging with: poppet worker run");

      return;
    }

    const status = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ installed: Schema.Boolean, active: Schema.Boolean }),
    )(managed).pipe(
      Effect.mapError(() => new UsageError({ message: "Unexpected worker status." })),
    );

    const running = yield* remoteTaskCommand(workerSocketPath(directory), { action: "status" });

    if (running !== null && !status.active) {
      yield* Console.log(
        "A foreground worker is running. Stop it and run poppet worker run again to apply these settings.",
      );

      return;
    }

    const action = status.installed ? "start" : "install";

    const message = status.active
      ? "Restart the worker to apply these settings? This can interrupt active runs."
      : status.installed
        ? "Start the installed worker for scheduling and messaging?"
        : "Install and start the login worker for scheduling and messaging?";

    if (yield* Prompt.Confirm({ message, initial: false })) {
      if (status.active) yield* context.worker("stop", directory);
      yield* Console.log(yield* context.worker(action, directory));
      yield* Console.log("Run poppet worker status to check readiness.");
    } else {
      yield* Console.log(
        status.active
          ? "Restart the worker when ready to apply these settings: poppet worker restart"
          : "Start scheduling and messaging when ready: poppet worker run",
      );
    }
  });

export const runSetup = (context: CLIContext) =>
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const { path } = yield* readConfigFile(config.dataDirectory);
    yield* Console.log(
      `Setting up ${path}. Sign-ins are saved immediately; configuration is saved after the prompts.`,
    );

    const selected = yield* Prompt.Select({
      message: "Provider",
      choices: context.registered.map((entry) => ({
        title: entry.name,
        value: entry.id,
        selected: entry.id === config.provider,
      })),
    });

    const entry = yield* findProvider(selected, context.registered);

    const model = yield* Effect.gen(function* () {
      const connection = yield* ProviderConnection;
      const status = yield* connection.status;

      if (
        status.connected !== true ||
        // The login worker does not inherit API keys from this shell.
        status.source === "environment" ||
        status.planUsage === false ||
        (yield* Prompt.Confirm({ message: `Reconnect ${entry.name}?`, initial: false }))
      ) {
        yield* Console.log(
          yield* connection.login({ keyStdin: false, openBrowser: true, callbackPort: null }),
        );
        yield* Console.log(`${entry.name} authentication saved.`);
      }

      const models = yield* (yield* Provider).models;

      if (models.length === 0)
        return yield* Effect.fail(invalidRequest(selected, "The provider returned no models."));

      return yield* Prompt.AutoComplete({
        message: "Model (type to filter)",
        choices: models.map((candidate) => ({
          title: `${candidate.name} (${candidate.id})`,
          value: candidate.id,
          selected: selected === config.provider && candidate.id === config.model,
        })),
      });
    }).pipe(Effect.provide(context.runtime.selectedProvider(selected)));

    const prompt = context.channels.find((channel) => channel.id === "discord")?.promptSetup;

    const saveDiscord =
      prompt === undefined
        ? null
        : yield* prompt.pipe(
            Effect.provideService(ChannelEnvironment, { dataDirectory: config.dataDirectory }),
          );

    yield* updateConfigFile(config.dataDirectory, (current) => ({
      ...current,
      provider: selected,
      model,
    }));
    yield* Console.log(`Saved provider ${selected} and model ${model} to ${path}.`);

    if (saveDiscord !== null) yield* Console.log(yield* saveDiscord);
    else yield* Console.log("Discord configuration left unchanged.");

    yield* Console.log("Setup has not tested live inference or the Discord connection.");
    yield* setupWorker(context, config.dataDirectory);
  }).pipe(
    Effect.catchTag("QuitError", () =>
      Effect.fail(new UsageError({ message: "Setup cancelled." })),
    ),
    Effect.onError(() => Console.error("Setup stopped. Completed steps above remain saved.")),
    Effect.provide(context.runtime.config),
  );

export const setupCommand = (context: CLIContext) =>
  Command.make("setup", {}, () =>
    Effect.suspend(() =>
      process.stdin.isTTY && process.stdout.isTTY
        ? runSetup(context).pipe(
            Effect.provideService(CredentialInput, {
              readKey: readHiddenKey,
              readLine: readVisibleLine,
            }),
          )
        : Effect.fail(
            new UsageError({
              message:
                "Setup needs an interactive terminal. For scripts, use provider login, gateway discord setup, and config.json.",
            }),
          ),
    ),
  ).pipe(Command.withDescription("Set up a provider, model, Discord, and the background worker"));
