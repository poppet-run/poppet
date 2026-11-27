import { GatewayError, GatewayFetch } from "@poppet/gateway";
import { Effect, Redacted, Schema } from "effect";

const Reply = Schema.Struct({ ok: Schema.Boolean, error: Schema.optional(Schema.String) });

const failure = (method: string, error: string | null) =>
  new GatewayError({
    reason: error === null ? "unavailable" : "permission",
    message:
      error === null
        ? "Slack could not be reached."
        : `Slack refused ${method} with ${error}. Check the token and the app's scopes.`,
  });

const call = <S extends Schema.Top>(
  method: string,
  token: Redacted.Redacted<string>,
  schema: S,
  init: { readonly method: "GET" | "POST"; readonly query?: Record<string, string> },
) =>
  Effect.gen(function* () {
    const fetch = yield* GatewayFetch;
    const query = new URLSearchParams(init.query).toString();

    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(`https://slack.com/api/${method}${query === "" ? "" : `?${query}`}`, {
          method: init.method,
          headers: { Authorization: `Bearer ${Redacted.value(token)}` },
          signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        }),
      catch: () => failure(method, null),
    });

    const body = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: () => failure(method, `HTTP ${response.status}`),
    });

    const reply = yield* Schema.decodeUnknownEffect(Reply)(body).pipe(
      Effect.mapError(() => failure(method, `HTTP ${response.status}`)),
    );

    if (!reply.ok) {
      return yield* Effect.fail(failure(method, reply.error ?? "an unknown error"));
    }

    return yield* Schema.decodeUnknownEffect(schema)(body).pipe(
      Effect.mapError(() => failure(method, "an unexpected reply")),
    );
  });

/** Read-only Slack Web API calls that setup uses to check tokens and offer IDs. */
export const slackProbe = (
  token: Redacted.Redacted<string>,
  appToken: Redacted.Redacted<string>,
) => ({
  bot: call(
    "auth.test",
    token,
    Schema.Struct({ team_id: Schema.String, team: Schema.String, user: Schema.String }),
    { method: "GET" },
  ),
  appToken: call("apps.connections.open", appToken, Schema.Struct({}), { method: "POST" }),
  memberChannels: call(
    "conversations.list",
    token,
    Schema.Struct({
      channels: Schema.Array(
        Schema.Struct({ id: Schema.String, name: Schema.String, is_member: Schema.Boolean }),
      ),
    }),
    {
      method: "GET",
      query: { types: "public_channel,private_channel", exclude_archived: "true", limit: "200" },
    },
  ).pipe(
    Effect.map(({ channels }) =>
      channels
        .filter(({ is_member }) => is_member)
        .map(({ id, name }) => ({ id, name: `#${name}` })),
    ),
  ),
});
