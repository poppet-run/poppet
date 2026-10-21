import { isAbsolute } from "node:path";

import { Config, ConfigProvider, Effect, Schema } from "effect";

const Executable = Schema.NonEmptyString.check(
  Schema.isTrimmed(),
  Schema.isMaxLength(4096),
  Schema.makeFilter((value) => isAbsolute(value) && !value.includes("\0")),
);

export const ComputerSettings = Schema.Struct({
  enabled: Schema.Boolean,
  command: Schema.optionalKey(Executable),
}).check(
  Schema.makeFilter(
    (settings) =>
      !settings.enabled ||
      settings.command !== undefined ||
      "Enabled computer access requires an absolute installed command.",
  ),
);

export type ComputerSettings = typeof ComputerSettings.Type;

export const computerSettings = Config.String("POPPET_COMPUTER").pipe(
  Config.withDefault('{"enabled":false}'),
  Effect.flatMap((json) =>
    Schema.decodeUnknownEffect(Schema.fromJsonString(ComputerSettings), {
      onExcessProperty: "error",
    })(json),
  ),
  Effect.mapError(
    () =>
      new Config.ConfigError(
        new ConfigProvider.SourceError({
          message: "Invalid POPPET_COMPUTER. See docs/computer-use.md.",
        }),
      ),
  ),
);

export const computerFileValue = (settings: ComputerSettings | undefined) =>
  settings === undefined ? undefined : JSON.stringify(settings);
