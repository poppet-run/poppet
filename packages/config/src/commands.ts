import { ProviderId } from "@poppet/provider";
import { Config, ConfigProvider, Effect, Schema } from "effect";

const Executable = Schema.NonEmptyString.check(
  Schema.isPattern(/^\//),
  Schema.isMaxLength(4096),
  Schema.makeFilter((text) => !text.includes("\0") && text.isWellFormed()),
);

export const CommandSettings = Schema.Struct({
  enabled: Schema.Boolean,
  executables: Schema.Array(Executable).check(Schema.isMaxLength(32)),
  automaticReads: Schema.optionalKey(Schema.Boolean),
  reviewer: Schema.optionalKey(
    Schema.Struct({
      provider: ProviderId,
      model: Schema.NonEmptyString.check(Schema.isMaxLength(1024)),
    }),
  ),
});

export const commandSettings = Config.String("POPPET_COMMANDS").pipe(
  Config.withDefault('{"enabled":false,"executables":[]}'),
  Effect.flatMap((text) =>
    Schema.decodeUnknownEffect(Schema.fromJsonString(CommandSettings), {
      onExcessProperty: "error",
    })(text),
  ),
  Effect.mapError(
    () =>
      new Config.ConfigError(
        new ConfigProvider.SourceError({
          message: "Invalid POPPET_COMMANDS. See docs/commands.md.",
        }),
      ),
  ),
);
