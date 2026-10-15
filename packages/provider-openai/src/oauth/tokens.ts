import { Redacted, Schema } from "effect";

import { resource, Secret } from "#src/connection";

/** Token-endpoint fields; refresh replies may omit unchanged credentials and scope. */
export const TokenReply = Schema.Struct({
  access_token: Schema.optionalKey(Secret),
  refresh_token: Schema.optionalKey(Secret),
  id_token: Schema.optionalKey(Secret),
  token_type: Schema.optionalKey(Schema.Literal("Bearer")),
  expires_in: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  scope: Schema.optionalKey(Schema.String),
});

export type TokenReply = typeof TokenReply.Type;

export const refreshBody = (token: Redacted.Redacted<string>, clientId: string) =>
  new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: Redacted.value(token),
    resource,
  });
