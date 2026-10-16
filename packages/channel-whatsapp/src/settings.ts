import { ChannelError, loadChannelSettings, saveChannelSettings } from "@poppet/gateway";
import { Effect, Schema } from "effect";

/** International phone digits, without a plus sign, device suffix, or WhatsApp JID. */
export const WhatsAppPhone = Schema.String.check(Schema.isPattern(/^[1-9]\d{6,14}$/));

export const WhatsAppSettings = Schema.Struct({
  version: Schema.Literal(1),
  accountPhone: WhatsAppPhone,
  ownerPhone: WhatsAppPhone,
});

export type WhatsAppSettings = typeof WhatsAppSettings.Type;

const SavedSettings = Schema.fromJsonString(WhatsAppSettings);

const failure = () =>
  new ChannelError({
    reason: "configuration",
    message: "Invalid protected WhatsApp settings. Run gateway whatsapp setup again.",
  });

export const loadWhatsAppSettings = (dataDirectory: string) =>
  Effect.gen(function* () {
    const text = yield* loadChannelSettings(dataDirectory, "whatsapp");

    return text === null
      ? null
      : yield* Schema.decodeUnknownEffect(SavedSettings, { onExcessProperty: "error" })(text);
  }).pipe(Effect.mapError(failure));

export const saveWhatsAppSettings = (dataDirectory: string, settings: WhatsAppSettings) =>
  Schema.encodeEffect(SavedSettings)(settings).pipe(
    Effect.flatMap((text) => saveChannelSettings(dataDirectory, "whatsapp", text)),
    Effect.mapError(failure),
  );
