import { readConfigFile } from "@poppet/config";
import { promptSecret } from "@poppet/credentials/input";
import { ChannelEnvironment, ChannelError } from "@poppet/gateway";
import { Console, Effect } from "effect";
import { Prompt } from "effect/cli";

import { loadSlackSettings, saveSlackSettings } from "#src/settings";

const id = (message: string, value: string | undefined) =>
  Prompt.String({
    message,
    default: value ?? "",
    validate: (input) =>
      /^[A-Z][A-Z0-9]+$/.test(input) ? Effect.succeed(input) : Effect.fail("Enter a Slack ID."),
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

  const ownerId = yield* id("Your Slack user ID", defaults?.ownerId);
  const teamId = yield* id("Workspace ID", defaults?.teamId);

  const homeChannelId = yield* id(
    "Home channel ID (default destination for scheduled results and notifications)",
    defaults?.homeChannelId,
  );

  const replaceToken =
    saved === null ||
    (yield* Prompt.Confirm({ message: "Replace the saved bot token?", initial: false }));

  const token = replaceToken
    ? yield* promptSecret(
        "Slack bot token",
        "Enter a nonempty bot token without whitespace, up to 8192 characters.",
      )
    : saved.token;

  const appToken = replaceToken
    ? yield* promptSecret("Slack app token", "Enter an app token without whitespace.")
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
