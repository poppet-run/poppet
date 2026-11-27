import { GatewayError, GatewayFetch } from "@poppet/gateway";
import { Effect, Redacted, Schema } from "effect";

const api = "https://discord.com/api/v10";

const messages = new Map([
  [401, "Discord rejected the bot token."],
  [403, "The bot is not allowed to read this from Discord."],
]);

const failure = (status: number | null) =>
  new GatewayError({
    reason: status === 401 || status === 403 ? "permission" : "unavailable",
    message:
      status === null
        ? "Discord could not be reached."
        : (messages.get(status) ?? `Discord answered with HTTP ${status}.`),
  });

const Named = Schema.Struct({ id: Schema.String, name: Schema.String });

/** Read-only Discord REST calls that setup uses to check a bot token and offer IDs. */
export const discordProbe = (token: Redacted.Redacted<string>) => {
  const get = <S extends Schema.Top>(path: string, schema: S) =>
    Effect.gen(function* () {
      const fetch = yield* GatewayFetch;

      const response = yield* Effect.tryPromise({
        try: (signal) =>
          fetch(`${api}${path}`, {
            headers: { Authorization: `Bot ${Redacted.value(token)}` },
            signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
          }),
        catch: () => failure(null),
      });

      if (!response.ok) {
        return yield* Effect.fail(failure(response.status));
      }

      const body = yield* Effect.tryPromise({
        try: () => response.json(),
        catch: () => failure(response.status),
      });

      return yield* Schema.decodeUnknownEffect(schema)(body).pipe(
        Effect.mapError(() => failure(response.status)),
      );
    });

  return {
    bot: get("/users/@me", Schema.Struct({ id: Schema.String, username: Schema.String })),
    owner: get(
      "/oauth2/applications/@me",
      Schema.Struct({
        owner: Schema.optional(Schema.Struct({ id: Schema.String })),
        team: Schema.optional(Schema.NullOr(Schema.Struct({ owner_user_id: Schema.String }))),
      }),
    ).pipe(Effect.map(({ owner, team }) => team?.owner_user_id ?? owner?.id ?? null)),
    guilds: get("/users/@me/guilds", Schema.Array(Named)),
    textChannels: (guildId: string) =>
      get(
        `/guilds/${encodeURIComponent(guildId)}/channels`,
        Schema.Array(Schema.Struct({ ...Named.fields, type: Schema.Number })),
      ).pipe(Effect.map((channels) => channels.filter(({ type }) => type === 0 || type === 5))),
  };
};
