import {
  ChannelEnvironment,
  ChannelError,
  ChannelInput,
  parseSetupFlags,
  type ChannelRegistration,
} from "@poppet/gateway";
import { Effect, Layer, Redacted, Schema } from "effect";

import { SlackSettings, loadSlackSettings, saveSlackSettings } from "#src/settings";
import { promptSlackSetup } from "#src/setup";

const setupHelp =
  "setup --owner-id <id> --team-id <id> --home-channel-id <id> [--bot-token <token>] [--app-token <token>]";

export const slack = {
  id: "slack",
  name: "Slack",
  promptSetup: promptSlackSetup,

  setupHelp,
  setup: (args) =>
    Effect.gen(function* () {
      const values = yield* parseSetupFlags(
        args,
        "slack",
        setupHelp,
        ["owner-id", "team-id", "home-channel-id"],
        ["bot-token", "app-token"],
      );

      const environment = yield* ChannelEnvironment;
      const input = yield* ChannelInput;
      let token = values["bot-token"];
      let appToken = values["app-token"];

      if (token === undefined || appToken === undefined) {
        const lines = Redacted.value(yield* input.readSecret).split(/\r?\n/);

        if (token === undefined && appToken === undefined) {
          token = lines[0];
          appToken = lines[1];
        } else if (token === undefined) token = lines[0];
        else appToken = lines[0];
      }

      const settings = yield* Schema.decodeUnknownEffect(SlackSettings)({
        ownerId: values["owner-id"],
        teamId: values["team-id"],
        homeChannelId: values["home-channel-id"],
        token,
        appToken,
      }).pipe(
        Effect.mapError(
          () =>
            new ChannelError({
              reason: "configuration",
              message: "Use valid Slack IDs and a nonempty bot token without whitespace.",
            }),
        ),
      );

      yield* saveSlackSettings(environment.dataDirectory, settings);

      return "Slack settings saved. Restart the worker to apply them. Only the configured owner can invoke Poppet; channel members can read its replies.";
    }),
  load: Effect.gen(function* () {
    const { dataDirectory } = yield* ChannelEnvironment;
    const settings = yield* loadSlackSettings(dataDirectory);

    if (settings === null) return null;

    return Layer.unwrap(
      Effect.tryPromise({
        try: () =>
          import("#src/channel").then(({ slackChannelLayer }) => slackChannelLayer(settings)),
        catch: () =>
          new ChannelError({
            reason: "configuration",
            message: "Cannot load Slack channel adapter.",
          }),
      }),
    );
  }),
} satisfies ChannelRegistration;
