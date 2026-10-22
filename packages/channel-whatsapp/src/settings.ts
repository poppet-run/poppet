import { channelSettings } from "@poppet/gateway";
import { Schema } from "effect";

/** International phone digits, without a plus sign, device suffix, or WhatsApp JID. */
export const WhatsAppPhone = Schema.String.check(Schema.isPattern(/^[1-9]\d{6,14}$/));

export const WhatsAppSettings = Schema.Struct({
  version: Schema.Literal(1),
  accountPhone: WhatsAppPhone,
  ownerPhone: WhatsAppPhone,
});

export type WhatsAppSettings = typeof WhatsAppSettings.Type;

const store = channelSettings("whatsapp", "WhatsApp", WhatsAppSettings);

export const loadWhatsAppSettings = store.load;

export const saveWhatsAppSettings = store.save;
