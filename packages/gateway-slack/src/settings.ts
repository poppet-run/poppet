import { SlackConfiguration } from "@poppet/config";
import { configuredGatewaySettings } from "@poppet/gateway";
import { Schema } from "effect";

const Token = Schema.RedactedFromValue(Schema.String.check(Schema.isPattern(/^\S{1,8192}$/)));

export const SlackSettings = Schema.Struct({
  ...SlackConfiguration.fields,
  token: Token,
  appToken: Token,
});

export type SlackSettings = typeof SlackSettings.Type;

const Credentials = Schema.Struct({ token: Token, appToken: Token });

const settings = configuredGatewaySettings("slack", "Slack", SlackConfiguration, Credentials);
export const saveSlackSettings = settings.save;
export const loadSlackSettings = settings.load;
