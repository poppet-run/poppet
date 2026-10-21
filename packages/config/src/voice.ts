import { Config, ConfigProvider, Effect, Schema } from "effect";

const Path = Schema.NonEmptyString.check(
  Schema.isTrimmed(),
  Schema.isPattern(/^\//),
  Schema.isMaxLength(4096),
  Schema.makeFilter((path) => !path.includes("\0")),
);

/** Audio stays on the host. Enabling requires explicit executable and model paths. */
export const VoiceSettings = Schema.Union([
  Schema.Struct({ enabled: Schema.Literal(false) }),
  Schema.Struct({
    enabled: Schema.Literal(true),
    ffmpeg: Path,
    whisper: Path,
    model: Path,
  }),
]);

export type VoiceSettings = typeof VoiceSettings.Type;

export const voiceSettings = Config.String("POPPET_VOICE").pipe(
  Config.withDefault('{"enabled":false}'),
  Effect.flatMap((json) =>
    Schema.decodeUnknownEffect(Schema.fromJsonString(VoiceSettings), { onExcessProperty: "error" })(
      json,
    ),
  ),
  Effect.mapError(
    () =>
      new Config.ConfigError(
        new ConfigProvider.SourceError({
          message: "Invalid POPPET_VOICE. See docs/configuration.md.",
        }),
      ),
  ),
);

export const voiceFileValue = (settings: VoiceSettings | undefined) =>
  settings === undefined ? undefined : JSON.stringify(settings);
