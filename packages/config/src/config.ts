import { ProviderId } from "@poppet/provider";
import { Config, Context, Effect, Layer, Option, Schema } from "effect";

import {
  ConfigSourceLive,
  ConfigText,
  dataDirectory as configuredDataDirectory,
} from "#src/source";

export {
  ConfigIdentity,
  ConfigSource,
  ConfigSourceLive,
  dataDirectory,
  DiscordConfiguration,
  readConfigFile,
  updateConfigFile,
} from "#src/source";

/** Extra installed gateway registration entry points, alongside bundled Discord. */
export const gatewayPackages = Config.schema(
  Schema.fromJsonString(Schema.Array(ConfigText)),
  "gatewayPackages",
).pipe(Config.withDefault([]));

/** Minutes after a missed recurring task time during which it still runs once. */
export const taskCatchUpMinutes = Config.schema(
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1440 })),
  "catchUpMinutes",
).pipe(Config.withDefault(60));

/** Search stays opt-in independently of the selected inference provider. */
export const webSearchEnabled = Config.Boolean("webSearch").pipe(Config.withDefault(false));

export const webSearchProvider = Config.schema(
  Schema.Literals(["brave", "kagi"]),
  "webSearchProvider",
).pipe(Config.withDefault("brave"));

/** Resolved host paths and default model selection for new sessions. */
export interface Settings {
  readonly applicationName: string;
  readonly dataDirectory: string;
  readonly provider: ProviderId;
  readonly model: string | null;
}

/** Supplies host configuration without requiring consumers to read environment variables. */
export class AppConfig extends Context.Service<AppConfig, Settings>()("poppet/AppConfig") {}

/** Reads configuration, resolves directory paths, and validates configured provider selection. */
export const loadConfig = (defaultProvider: ProviderId, providers: ReadonlyArray<ProviderId>) =>
  Effect.gen(function* () {
    const applicationName = yield* Config.schema(ConfigText, "applicationName").pipe(
      Config.withDefault("Poppet"),
    );

    const dataDirectory = yield* configuredDataDirectory;

    const provider = yield* Config.schema(
      ProviderId.check(
        Schema.makeFilter((id) => providers.includes(id) || "Choose a registered provider."),
      ),
      "provider",
    ).pipe(Config.withDefault(defaultProvider));

    const model = yield* Config.schema(ConfigText, "model").pipe(
      Config.option,
      Config.map(Option.getOrNull),
    );

    return { applicationName, dataDirectory, provider, model } satisfies Settings;
  });

export const makeAppConfigLive = (
  defaultProvider: ProviderId,
  providers: ReadonlyArray<ProviderId>,
) =>
  Layer.effect(AppConfig, loadConfig(defaultProvider, providers)).pipe(
    Layer.provideMerge(ConfigSourceLive),
  );
