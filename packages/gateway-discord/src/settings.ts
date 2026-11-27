import { DiscordConfiguration } from "@poppet/config";
import { configuredGatewaySettings } from "@poppet/gateway";
import { Schema } from "effect";

const Token = Schema.RedactedFromValue(Schema.String.check(Schema.isPattern(/^\S{1,8192}$/)));

export const DiscordSettings = Schema.Struct({
  ...DiscordConfiguration.fields,
  token: Token,
});

export type DiscordSettings = typeof DiscordSettings.Type;

const Credentials = Schema.Struct({ token: Token });

const settings = configuredGatewaySettings("discord", "Discord", DiscordConfiguration, Credentials);
export const saveDiscordSettings = settings.save;
export const loadDiscordSettings = settings.load;
export const removeDiscordSettings = settings.remove;
