import { styleText } from "node:util";

import { AppConfig, readConfigFile, updateConfigFile } from "@poppet/config";
import { GatewayEnvironment } from "@poppet/gateway";
import { CredentialInput } from "@poppet/provider";
import { Console, Effect } from "effect";
import { Command, Prompt } from "effect/cli";

import { terminalKeyInput } from "#src/api-key-input";
import type { CLIContext } from "#src/commands/context";
import { UsageError } from "#src/commands/errors";
import { describeGateways, gatewayStates, promptGateways } from "#src/commands/setup/gateways";
import { promptProvider } from "#src/commands/setup/provider";
import { describeWorker, setupWorker, workerState } from "#src/commands/setup/worker";

const heading = (text: string) => Console.log(`\n${styleText("bold", text)}`);

export type SetupSection = "provider" | "gateways" | "worker";

const sectionTitles = {
  provider: "Provider and model",
  gateways: "Messaging gateways",
  worker: "Background worker",
} satisfies Record<SetupSection, string>;

const chooseSections = (only: SetupSection | null, rerun: boolean, hasGateways: boolean) =>
  Effect.gen(function* () {
    const everything: ReadonlyArray<SetupSection> = hasGateways
      ? ["provider", "gateways", "worker"]
      : ["provider", "worker"];

    if (only === "gateways" && !hasGateways) {
      return yield* Effect.fail(
        new UsageError({ message: "No installed gateway supports interactive setup." }),
      );
    }

    if (only !== null) {
      return only === "worker" ? [only] : [only, "worker" as const];
    }

    if (!rerun) {
      return everything;
    }

    return yield* Prompt.Select<ReadonlyArray<SetupSection>>({
      message: "What do you want to set up?",
      choices: [
        { title: "Everything", value: everything },
        { title: "Provider and model", value: ["provider", "worker"] },
        ...(hasGateways
          ? [{ title: "Messaging gateways", value: ["gateways", "worker"] as const }]
          : []),
        { title: "Background worker", value: ["worker"] },
        { title: "Nothing, keep the current setup", value: [] },
      ],
    });
  });

export const runSetup = (context: CLIContext, only: SetupSection | null = null) =>
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

    const sections = yield* chooseSections(only, file.provider !== undefined, gateways.length > 0);

    if (sections.length === 0) {
      yield* Console.log("Setup left everything unchanged.");

      return;
    }

    const step = (section: SetupSection) =>
      heading(
        `Step ${sections.indexOf(section) + 1} of ${sections.length}: ${sectionTitles[section]}`,
      );

    const chosen = sections.includes("provider")
      ? yield* step("provider").pipe(Effect.andThen(promptProvider(context, config)))
      : null;

    const saves = sections.includes("gateways")
      ? yield* step("gateways").pipe(
          Effect.andThen(promptGateways(gateways)),
          Effect.provideService(GatewayEnvironment, environment),
        )
      : [];

    if (chosen !== null) {
      yield* updateConfigFile(config.dataDirectory, (current) => ({ ...current, ...chosen }));
      yield* Console.log(`Saved provider ${chosen.provider} and model ${chosen.model} to ${path}.`);
    }

    for (const { name, save } of saves) {
      yield* Console.log(save === null ? `${name} configuration left unchanged.` : yield* save);
    }

    yield* step("worker");
    yield* Console.log("Setup has not tested live inference or messaging connections.");
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
