import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { SlackConfiguration, readConfigFile, updateConfigFile } from "@poppet/config";
import { acquireOwnerLock } from "@poppet/credentials/lock";
import { ChannelError, channelSettings } from "@poppet/gateway";
import { Effect, Schema } from "effect";

const Token = Schema.RedactedFromValue(Schema.String.check(Schema.isPattern(/^\S{1,8192}$/)));

/** Runtime policy and credentials, combined only after both sources validate. */
export const SlackSettings = Schema.Struct({
  ...SlackConfiguration.fields,
  token: Token,
  appToken: Token,
});

export type SlackSettings = typeof SlackSettings.Type;

const Credentials = Schema.Struct({ token: Token, appToken: Token });

const credentials = channelSettings("slack", "Slack", Credentials);

const failure = () =>
  new ChannelError({
    reason: "configuration",
    message:
      "Cannot load Slack configuration or credentials. Check config.json and run gateway slack setup again.",
  });

export const saveSlackSettings = (directory: string, settings: SlackSettings) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () => mkdir(directory, { recursive: true, mode: 0o700 }),
        catch: failure,
      });
      // The token and the policy live in separate files, each with its own lock. This lock keeps
      // two saves from interleaving them; a crash between the writes can still leave them apart.
      yield* acquireOwnerLock(join(directory, "slack-config.lock"));

      const policy = yield* Schema.decodeUnknownEffect(SlackConfiguration)(settings);
      // Validate the existing file before replacing credentials.
      yield* readConfigFile(directory);
      yield* credentials.save(directory, {
        token: settings.token,
        appToken: settings.appToken,
      });
      yield* updateConfigFile(directory, (file) => ({ ...file, slack: policy }));
    }),
  ).pipe(Effect.mapError(failure), Effect.uninterruptible);

export const loadSlackSettings = (directory: string) =>
  Effect.gen(function* () {
    const saved = yield* credentials.load(directory);

    if (saved === null) return null;

    const { file } = yield* readConfigFile(directory);

    if (file.slack === undefined) return null;

    return { ...file.slack, token: saved.token, appToken: saved.appToken };
  }).pipe(Effect.mapError(failure));
