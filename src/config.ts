import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { Config, ConfigProvider, Context, Effect, Layer, Schema } from "effect";

export interface Settings {
  readonly applicationName: string;
  readonly dataDirectory: string;
  readonly notesDirectory: string;
}

export class AppConfig extends Context.Service<AppConfig, Settings>()("poppet/AppConfig") {}

const ConfigText = Schema.NonEmptyString.check(Schema.isTrimmed());

export const loadConfig = Effect.gen(function* () {
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

  return { applicationName, dataDirectory, notesDirectory } satisfies Settings;
});

export const AppConfigLive = Layer.effect(AppConfig, loadConfig).pipe(
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ preserveEmptyStrings: true }))),
);
