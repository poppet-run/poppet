import { SlackConfiguration, readConfigFile } from "@poppet/config";
import { promptSecret } from "@poppet/credentials/input";
import { GatewayEnvironment, GatewayError } from "@poppet/gateway";
import type { GatewayPromptSetup } from "@poppet/gateway";
import { Console, Effect, Schema } from "effect";
import { Prompt } from "effect/cli";

import { loadSlackSettings, removeSlackSettings, saveSlackSettings } from "#src/settings";

const id = (
  message: string,
  value: string | undefined,
  schema: typeof SlackConfiguration.fields.ownerId,
  hint: string,
) =>
  Prompt.String({
    message,
    default: value ?? "",
    validate: (input) => (Schema.is(schema)(input) ? Effect.succeed(input) : Effect.fail(hint)),
  });

const prompt = Effect.gen(function* () {
  const { dataDirectory } = yield* GatewayEnvironment;
  const saved = yield* loadSlackSettings(dataDirectory);

  const { file } = yield* readConfigFile(dataDirectory).pipe(
    Effect.mapError(
      () =>
        new GatewayError({
          reason: "configuration",
          message: "Cannot read Slack configuration from config.json.",
        }),
    ),
  );

  const defaults = file.slack ?? saved;

  yield* Console.log(
    [
      "Create an app at https://api.slack.com/apps with Socket Mode on, add its bot scopes, install it, and invite it to the home channel.",
      "Guide, including the scopes Poppet needs: https://poppet.run/docs/gateways/slack/",
      "Only the configured owner can invoke Poppet; channel members can read its replies.",
    ].join("\n"),
  );

  const ownerId = yield* id(
    "Your Slack user ID (your profile > More > Copy member ID)",
    defaults?.ownerId,
    SlackConfiguration.fields.ownerId,
    "Enter a Slack user ID starting with U or W.",
  );

  const teamId = yield* id(
    "Workspace ID (the T... part of app.slack.com/client/T.../ in a browser)",
    defaults?.teamId,
    SlackConfiguration.fields.teamId,
    "Enter a Slack workspace ID starting with T.",
  );

  const homeChannelId = yield* id(
    "Home channel ID for scheduled results and notifications (channel details > About, at the bottom)",
    defaults?.homeChannelId,
    SlackConfiguration.fields.homeChannelId,
    "Enter a Slack channel ID starting with C or G.",
  );

  const replaceToken =
    saved === null ||
    (yield* Prompt.Confirm({ message: "Replace the saved Slack tokens?", initial: false }));

  const token = replaceToken
    ? yield* promptSecret(
        "Slack bot token, starting xoxb- (OAuth & Permissions)",
        "Enter a nonempty bot token without whitespace, up to 8192 characters.",
      )
    : saved.token;

  const appToken = replaceToken
    ? yield* promptSecret(
        "Slack app token, starting xapp-, with connections:write (Basic Information > App-Level Tokens)",
        "Enter a nonempty app token without whitespace, up to 8192 characters.",
      )
    : saved.appToken;

  return {
    summary: `owner ${ownerId}, workspace ${teamId}, home channel ${homeChannelId}, tokens ${replaceToken ? "replaced" : "kept"}`,
    save: saveSlackSettings(dataDirectory, {
      ownerId,
      teamId,
      homeChannelId,
      token,
      appToken,
    }).pipe(
      Effect.as(
        `Saved Slack owner ${ownerId}, workspace ${teamId}, home channel ${homeChannelId}.`,
      ),
    ),
  };
});

export const promptSlackSetup = {
  configured: GatewayEnvironment.use(({ dataDirectory }) =>
    loadSlackSettings(dataDirectory).pipe(Effect.map((saved) => saved !== null)),
  ),
  prompt,
  remove: GatewayEnvironment.use(({ dataDirectory }) =>
    removeSlackSettings(dataDirectory).pipe(
      Effect.as("Removed Slack settings and tokens. Restart the worker to disconnect Slack."),
    ),
  ),
} satisfies GatewayPromptSetup;
