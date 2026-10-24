import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { DiscordConfiguration, readConfigFile, updateConfigFile } from "@poppet/config";
import { acquireOwnerLock } from "@poppet/credentials/lock";
import { ChannelError, channelSettings } from "@poppet/gateway";
import { Effect, Schema } from "effect";

const Token = Schema.RedactedFromValue(Schema.String.check(Schema.isPattern(/^\S{1,8192}$/)));

/** Runtime policy and credentials, combined only after both sources validate. */
export const DiscordSettings = Schema.Struct({
  ...DiscordConfiguration.fields,
  token: Token,
});

export type DiscordSettings = typeof DiscordSettings.Type;

const Credentials = Schema.Struct({ token: Token });

const credentials = channelSettings("discord", "Discord", Credentials);

const failure = () =>
  new ChannelError({
    reason: "configuration",
    message:
      "Cannot load Discord configuration or credentials. Check config.json and run gateway discord setup again.",
  });

export const saveDiscordSettings = (directory: string, settings: DiscordSettings) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () => mkdir(directory, { recursive: true, mode: 0o700 }),
        catch: failure,
      });
      yield* acquireOwnerLock(join(directory, "discord-config.lock"));

      const policy = yield* Schema.decodeUnknownEffect(DiscordConfiguration)(settings);
      // Validate the existing file before replacing credentials.
      yield* readConfigFile(directory);
      yield* credentials.save(directory, {
        token: settings.token,
      });
      yield* updateConfigFile(directory, (file) => ({ ...file, discord: policy }));
    }),
  ).pipe(Effect.mapError(failure), Effect.uninterruptible);

export const loadDiscordSettings = (directory: string) =>
  Effect.gen(function* () {
    const saved = yield* credentials.load(directory);

    if (saved === null) return null;

    const { file } = yield* readConfigFile(directory);

    if (file.discord === undefined) return null;

    return { ...file.discord, token: saved.token };
  }).pipe(Effect.mapError(failure));
