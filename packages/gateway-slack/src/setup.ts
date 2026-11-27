import { SlackConfiguration, readConfigFile } from "@poppet/config";
import { promptSecret } from "@poppet/credentials/input";
import { GatewayEnvironment, GatewayError, pickSetupId, recoverSetupCheck } from "@poppet/gateway";
import type { GatewayPromptSetup } from "@poppet/gateway";
import type { Redacted } from "effect";
import { Console, Effect, Result, Schema } from "effect";
import { Prompt } from "effect/cli";

import { slackProbe } from "#src/probe";
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

const check = (bot: Redacted.Redacted<string>, app: Redacted.Redacted<string>) =>
  Effect.all({
    bot: slackProbe(bot, app).bot.pipe(Effect.result),
    app: slackProbe(bot, app).appToken.pipe(Effect.result),
  });

const prompt = Effect.gen(function* () {
  const { dataDirectory } = yield* GatewayEnvironment;

  const saved = yield* loadSlackSettings(dataDirectory).pipe(
    Effect.catch(() =>
      Console.log("Setup cannot read the saved Slack settings and will replace them.").pipe(
        Effect.as(null),
      ),
    ),
  );

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

  let replaceToken =
    saved === null ||
    (yield* Prompt.Confirm({ message: "Replace the saved Slack tokens?", initial: false }));

  const promptTokens = Effect.all([
    promptSecret(
      "Slack bot token, starting xoxb- (OAuth & Permissions)",
      "Enter a nonempty bot token without whitespace, up to 8192 characters.",
    ),
    promptSecret(
      "Slack app token, starting xapp-, with connections:write (Basic Information > App-Level Tokens)",
      "Enter a nonempty app token without whitespace, up to 8192 characters.",
    ),
  ]);

  let [token, appToken]: readonly [Redacted.Redacted<string>, Redacted.Redacted<string>] =
    replaceToken || saved === null ? yield* promptTokens : [saved.token, saved.appToken];

  let checks: Effect.Success<ReturnType<typeof check>> = yield* check(token, appToken);

  while (Result.isFailure(checks.bot) || Result.isFailure(checks.app)) {
    yield* Console.log(
      [checks.bot, checks.app]
        .flatMap((result) => (Result.isFailure(result) ? [result.failure.message] : []))
        .join("\n"),
    );

    const next = yield* recoverSetupCheck("Slack");

    if (next === "skip") {
      return null;
    }

    if (next === "continue") {
      yield* Console.log(
        "Setup will save the tokens unchecked; run poppet doctor once the worker is running.",
      );

      break;
    }

    replaceToken = true;
    [token, appToken] = yield* promptTokens;
    checks = yield* check(token, appToken);
  }

  const probe = slackProbe(token, appToken);
  const { bot } = checks;
  const checked = Result.isSuccess(bot) && Result.isSuccess(checks.app);

  if (Result.isSuccess(bot)) {
    yield* Console.log(
      `Slack accepted the bot token for ${bot.success.user} in ${bot.success.team} (${bot.success.team_id}).`,
    );
  }

  const ownerId = yield* id(
    "Your Slack user ID (your profile > More > Copy member ID)",
    defaults?.ownerId,
    SlackConfiguration.fields.ownerId,
    "Enter a Slack user ID starting with U or W.",
  );

  const teamId =
    Result.isSuccess(bot) && Schema.is(SlackConfiguration.fields.teamId)(bot.success.team_id)
      ? bot.success.team_id
      : yield* id(
          "Workspace ID (the T... part of app.slack.com/client/T.../ in a browser)",
          defaults?.teamId,
          SlackConfiguration.fields.teamId,
          "Enter a Slack workspace ID starting with T.",
        );

  const lookup = Result.isSuccess(bot) ? yield* probe.memberChannels.pipe(Effect.result) : null;
  const channels = lookup !== null && Result.isSuccess(lookup) ? lookup.success : [];

  if (lookup !== null && Result.isFailure(lookup)) {
    yield* Console.log(`${lookup.failure.message} Enter the home channel ID instead.`);
  } else if (lookup !== null && channels.length === 0) {
    yield* Console.log(
      "Setup found no channel with the bot in it. Invite it with /invite in the home channel, or enter the ID.",
    );
  }

  const homeChannelId = yield* pickSetupId(
    "Home channel for scheduled results and notifications",
    channels,
    defaults?.homeChannelId,
    id(
      "Home channel ID for scheduled results and notifications (channel details > About, at the bottom)",
      defaults?.homeChannelId,
      SlackConfiguration.fields.homeChannelId,
      "Enter a Slack channel ID starting with C or G.",
    ),
  );

  return {
    summary: [
      `owner ${ownerId}, workspace ${teamId}, home channel ${homeChannelId}`,
      `tokens ${replaceToken ? "replaced" : "kept"}`,
      checked && Result.isSuccess(bot) ? `checked as ${bot.success.user}` : "not checked",
    ].join(", "),
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
  firstMessage: "Mention the bot in a channel to start a thread",
} satisfies GatewayPromptSetup;
