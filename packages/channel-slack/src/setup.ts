import { SlackConfiguration, readConfigFile } from "@poppet/config";
import { promptSecret } from "@poppet/credentials/input";
import { ChannelEnvironment, ChannelError } from "@poppet/gateway";
import { Console, Effect, Schema } from "effect";
import { Prompt } from "effect/cli";

import { loadSlackSettings, saveSlackSettings } from "#src/settings";

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

export const promptSlackSetup = Effect.gen(function* () {
  if (!(yield* Prompt.Confirm({ message: "Configure Slack?", initial: false }))) return null;

  const { dataDirectory } = yield* ChannelEnvironment;
  const saved = yield* loadSlackSettings(dataDirectory);

  const { file } = yield* readConfigFile(dataDirectory).pipe(
    Effect.mapError(
      () =>
        new ChannelError({
          reason: "configuration",
          message: "Cannot read Slack configuration from config.json.",
        }),
    ),
  );

  const defaults = file.slack ?? saved;

  yield* Console.log(
    "Copy IDs from your Slack workspace. Only the configured owner can invoke Poppet; channel members can read its replies.",
  );

  const ownerId = yield* id(
    "Your Slack user ID",
    defaults?.ownerId,
    SlackConfiguration.fields.ownerId,
    "Enter a Slack user ID starting with U or W.",
  );

  const teamId = yield* id(
    "Workspace ID",
    defaults?.teamId,
    SlackConfiguration.fields.teamId,
    "Enter a Slack workspace ID starting with T.",
  );

  const homeChannelId = yield* id(
    "Home channel ID (default destination for scheduled results and notifications)",
    defaults?.homeChannelId,
    SlackConfiguration.fields.homeChannelId,
    "Enter a Slack channel ID starting with C or G.",
  );

  const replaceToken =
    saved === null ||
    (yield* Prompt.Confirm({ message: "Replace the saved Slack tokens?", initial: false }));

  const token = replaceToken
    ? yield* promptSecret(
        "Slack bot token",
        "Enter a nonempty bot token without whitespace, up to 8192 characters.",
      )
    : saved.token;

  const appToken = replaceToken
    ? yield* promptSecret(
        "Slack app token",
        "Enter a nonempty app token without whitespace, up to 8192 characters.",
      )
    : saved.appToken;

  return saveSlackSettings(dataDirectory, {
    ownerId,
    teamId,
    homeChannelId,
    token,
    appToken,
  }).pipe(
    Effect.as(`Saved Slack owner ${ownerId}, workspace ${teamId}, home channel ${homeChannelId}.`),
  );
});
