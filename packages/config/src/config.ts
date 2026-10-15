import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { ProviderId } from "@poppet/provider";
import { Config, ConfigProvider, Context, Effect, Layer, Option, Schema } from "effect";

/** Resolved host paths and default model selection for new sessions. */
export interface Settings {
  readonly applicationName: string;
  readonly dataDirectory: string;
  readonly notesDirectory: string;
  readonly provider: ProviderId;
  readonly model: string | null;
}

/** Supplies host configuration without requiring consumers to read environment variables. */
export class AppConfig extends Context.Service<AppConfig, Settings>()("poppet/AppConfig") {}

const ConfigText = Schema.NonEmptyString.check(Schema.isTrimmed());

/** Reads configuration, resolves directory paths, and validates configured provider selection. */
export const loadConfig = (defaultProvider: ProviderId, providers: ReadonlyArray<ProviderId>) =>
  Effect.gen(function* () {
    const applicationName = yield* Config.schema(ConfigText, "POPPET_APP_NAME").pipe(
      Config.withDefault("Poppet"),
    );

    const dataDirectory = yield* Config.schema(ConfigText, "POPPET_DATA_DIR").pipe(
      Config.withDefault(join(homedir(), ".config", "poppet")),
      Config.map((directory) => resolve(directory)),
    );

    const notesDirectory = yield* Config.schema(ConfigText, "POPPET_NOTES_DIR").pipe(
      Config.withDefault(join(dataDirectory, "notes")),
      Config.map((directory) => resolve(directory)),
    );

    const provider = yield* Config.schema(
      ProviderId.check(
        Schema.makeFilter((id) => providers.includes(id) || "Choose a registered provider."),
      ),
      "POPPET_PROVIDER",
    ).pipe(Config.withDefault(defaultProvider));

    const model = yield* Config.schema(ConfigText, "POPPET_MODEL").pipe(
      Config.option,
      Config.map(Option.getOrNull),
    );

    return { applicationName, dataDirectory, notesDirectory, provider, model } satisfies Settings;
  });

export const makeAppConfigLive = (
  defaultProvider: ProviderId,
  providers: ReadonlyArray<ProviderId>,
) =>
  Layer.effect(AppConfig, loadConfig(defaultProvider, providers)).pipe(
    // Preserve empty environment values so validation rejects them instead of
    // treating them as missing and silently choosing a default.
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ preserveEmptyStrings: true }))),
  );
