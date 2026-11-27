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
        "Sign-ins are saved immediately; other changes are saved after you review them.",
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

    const promptDrafts = promptGateways(gateways).pipe(
      Effect.provideService(GatewayEnvironment, environment),
    );

    let chosen = sections.includes("provider")
      ? yield* step("provider").pipe(Effect.andThen(promptProvider(context, config)))
      : null;

    let drafts = sections.includes("gateways")
      ? yield* step("gateways").pipe(Effect.andThen(promptDrafts))
      : [];

    while (chosen !== null || drafts.length > 0) {
      const width = Math.max(8, ...drafts.map(({ name }) => name.length));

      const lines: Array<{ readonly label: string; readonly value: string }> = drafts.map(
        ({ name, draft }) => ({ label: name, value: draft?.summary ?? "unchanged" }),
      );

      if (chosen !== null) {
        const unchanged = chosen.provider === file.provider && chosen.model === file.model;

        lines.unshift({
          label: "Provider",
          value: `${chosen.provider}, model ${chosen.model}${unchanged ? " (unchanged)" : ""}`,
        });
      }

      yield* heading("Review");
      yield* Console.log(
        lines.map(({ label, value }) => `  ${label.padEnd(width)}  ${value}`).join("\n"),
      );

      const next = yield* Prompt.Select({
        message: "Save these changes?",
        choices: [
          { title: "Save", value: "save" as const },
          ...(chosen === null
            ? []
            : [{ title: "Change the provider and model", value: "provider" as const }]),
          ...(sections.includes("gateways")
            ? [{ title: "Change the gateways", value: "gateways" as const }]
            : []),
          { title: "Cancel without saving", value: "cancel" as const },
        ],
      });

      if (next === "save") {
        break;
      }

      if (next === "cancel") {
        return yield* Effect.fail(
          new UsageError({ message: "Setup cancelled without saving configuration." }),
        );
      }

      if (next === "provider" && chosen !== null) {
        chosen = yield* promptProvider(context, chosen);
      } else {
        drafts = yield* promptDrafts;
      }
    }

    if (chosen !== null) {
      const { provider, model } = chosen;
      yield* updateConfigFile(config.dataDirectory, (current) => ({ ...current, provider, model }));
      yield* Console.log(`Saved provider ${provider} and model ${model} to ${path}.`);
    }

    for (const { name, draft } of drafts) {
      yield* Console.log(
        draft === null ? `${name} configuration left unchanged.` : yield* draft.save,
      );
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

const interactive = (context: CLIContext, only: SetupSection | null) =>
  Effect.suspend(() =>
    process.stdin.isTTY && process.stdout.isTTY
      ? runSetup(context, only).pipe(Effect.provideService(CredentialInput, terminalKeyInput))
      : Effect.fail(
          new UsageError({
            message:
              "Setup needs an interactive terminal. Use provider login in a terminal for credentials; use gateway discord setup and config.json for scripted configuration.",
          }),
        ),
  );

export const setupCommand = (context: CLIContext) =>
  Command.make("setup", {}, () => interactive(context, null)).pipe(
    Command.withDescription(
      "Set up a provider, model, messaging gateways, and the background worker",
    ),
    Command.withSubcommands(
      (["provider", "gateways", "worker"] as const).map((section) =>
        Command.make(section, {}, () => interactive(context, section)).pipe(
          Command.withDescription(`Set up only the ${sectionTitles[section].toLowerCase()}`),
        ),
      ),
    ),
  );
