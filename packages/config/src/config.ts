import { join, resolve } from "node:path";

import { ProviderId } from "@poppet/provider";
import { Config, Context, Effect, Layer, Option, Schema } from "effect";

import {
  ConfigSourceLive,
  ConfigText,
  dataDirectory as configuredDataDirectory,
} from "#src/source";

export { ConfigSource, dataDirectory } from "#src/source";

export { BrowserSettings, browserSettings } from "@poppet/browser/config";

export { ComputerSettings, computerSettings } from "@poppet/computer-use/config";

/** Search stays opt-in independently of the selected inference provider. */
export const webSearchEnabled = Config.Boolean("POPPET_WEB_SEARCH").pipe(Config.withDefault(false));

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

/** Reads configuration, resolves directory paths, and validates configured provider selection. */
export const loadConfig = (defaultProvider: ProviderId, providers: ReadonlyArray<ProviderId>) =>
  Effect.gen(function* () {
    const applicationName = yield* Config.schema(ConfigText, "POPPET_APP_NAME").pipe(
      Config.withDefault("Poppet"),
    );

    const dataDirectory = yield* configuredDataDirectory;

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
    Layer.provideMerge(ConfigSourceLive),
  );
