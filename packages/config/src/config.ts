import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { ProviderId } from "@poppet/provider";
import { Config, ConfigProvider, Context, Effect, Layer, Option, Schema } from "effect";

export interface Settings {
  readonly applicationName: string;
  readonly dataDirectory: string;
  readonly notesDirectory: string;
  readonly provider: ProviderId;
  readonly model: string | null;
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

  const provider = yield* Config.schema(ProviderId, "POPPET_PROVIDER").pipe(
    Config.withDefault("openai-chatgpt"),
  );

  const model = yield* Config.schema(ConfigText, "POPPET_MODEL").pipe(
    Config.option,
    Config.map(Option.getOrNull),
  );

  return { applicationName, dataDirectory, notesDirectory, provider, model } satisfies Settings;
});

export const AppConfigLive = Layer.effect(AppConfig, loadConfig).pipe(
  // Preserve empty environment values so validation rejects them instead of
  // treating them as missing and silently choosing a default.
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ preserveEmptyStrings: true }))),
);
