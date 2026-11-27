import { styleText } from "node:util";

import { AppConfig, readConfigFile, updateConfigFile } from "@poppet/config";
import { GatewayEnvironment } from "@poppet/gateway";
import { CredentialInput } from "@poppet/provider";
import { Console, Effect } from "effect";
import { Command } from "effect/cli";

import { terminalKeyInput } from "#src/api-key-input";
import type { CLIContext } from "#src/commands/context";
import { UsageError } from "#src/commands/errors";
import { describeGateways, gatewayStates, promptGateways } from "#src/commands/setup/gateways";
import { promptProvider } from "#src/commands/setup/provider";
import { describeWorker, setupWorker, workerState } from "#src/commands/setup/worker";

const heading = (text: string) => Console.log(`\n${styleText("bold", text)}`);

export const runSetup = (context: CLIContext) =>
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const { path, file } = yield* readConfigFile(config.dataDirectory);
    const environment = { dataDirectory: config.dataDirectory };

    const gateways = yield* gatewayStates(context).pipe(
      Effect.provideService(GatewayEnvironment, environment),
    );

    const worker = yield* workerState(context, config.dataDirectory);

    yield* Console.log(
      [
        `Setting up ${path}`,
        `  Provider  ${file.provider === undefined ? "not chosen" : `${file.provider}, model ${file.model ?? "not chosen"}`}`,
        `  Gateways  ${describeGateways(gateways)}`,
        `  Worker    ${describeWorker(worker)}`,
        "Sign-ins are saved immediately; configuration is saved after the prompts.",
      ].join("\n"),
    );

    const steps = ["Provider and model", ...(gateways.length > 0 ? ["Messaging gateways"] : [])];

    const step = (index: number) =>
      heading(`Step ${index + 1} of ${steps.length + 1}: ${steps[index]}`);

    yield* step(0);
    const { provider, model } = yield* promptProvider(context, config);

    const saves =
      gateways.length === 0
        ? []
        : yield* step(1).pipe(
            Effect.andThen(promptGateways(gateways)),
            Effect.provideService(GatewayEnvironment, environment),
          );

    yield* updateConfigFile(config.dataDirectory, (current) => ({
      ...current,
      provider,
      model,
    }));
    yield* Console.log(`Saved provider ${provider} and model ${model} to ${path}.`);

    for (const { name, save } of saves) {
      if (save !== null) {
        yield* Console.log(yield* save);
      } else {
        yield* Console.log(`${name} configuration left unchanged.`);
      }
    }

    yield* Console.log("Setup has not tested live inference or messaging connections.");
    yield* heading(`Step ${steps.length + 1} of ${steps.length + 1}: Background worker`);
    yield* setupWorker(context, config.dataDirectory, worker);
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
        ? runSetup(context).pipe(Effect.provideService(CredentialInput, terminalKeyInput))
        : Effect.fail(
            new UsageError({
              message:
                "Setup needs an interactive terminal. Use provider login in a terminal for credentials; use gateway discord setup and config.json for scripted configuration.",
            }),
          ),
    ),
  ).pipe(
    Command.withDescription(
      "Set up a provider, model, messaging gateways, and the background worker",
    ),
  );
