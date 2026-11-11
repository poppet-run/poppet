import { SlackConfiguration } from "@poppet/config";
import { configuredChannelSettings } from "@poppet/gateway";
import { Schema } from "effect";

const Token = Schema.RedactedFromValue(Schema.String.check(Schema.isPattern(/^\S{1,8192}$/)));

/** Runtime policy and credentials, combined only after both sources validate. */
export const SlackSettings = Schema.Struct({
  ...SlackConfiguration.fields,
  token: Token,
  appToken: Token,
});

export type SlackSettings = typeof SlackSettings.Type;

const Credentials = Schema.Struct({ token: Token, appToken: Token });

const settings = configuredChannelSettings("slack", "Slack", SlackConfiguration, Credentials);
export const saveSlackSettings = settings.save;
export const loadSlackSettings = settings.load;
