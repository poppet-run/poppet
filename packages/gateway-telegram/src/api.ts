import { Redacted, Schema } from "effect";

/** A Bot API rejection; the description comes from Telegram and never contains the token. */
export class TelegramApiError extends Error {
  constructor(
    readonly code: number,
    readonly retryAfterMs: number,
    description: string,
  ) {
    super(description);
  }
}

const User = Schema.Struct({
  id: Schema.Number,
  is_bot: Schema.Boolean,
  username: Schema.optionalKey(Schema.String),
});

const Entity = Schema.Struct({
  type: Schema.String,
  offset: Schema.Number,
  length: Schema.Number,
  user: Schema.optionalKey(User),
});

const messageFields = {
  message_id: Schema.Number,
  message_thread_id: Schema.optionalKey(Schema.Number),
  is_topic_message: Schema.optionalKey(Schema.Boolean),
  chat: Schema.Struct({
    id: Schema.Number,
    type: Schema.String,
    is_forum: Schema.optionalKey(Schema.Boolean),
  }),
  from: Schema.optionalKey(User),
  sender_chat: Schema.optionalKey(Schema.Struct({ id: Schema.Number })),
  via_bot: Schema.optionalKey(User),
  text: Schema.optionalKey(Schema.String),
  entities: Schema.optionalKey(Schema.Array(Entity)),
  forum_topic_created: Schema.optionalKey(Schema.Struct({ name: Schema.String })),
  forum_topic_edited: Schema.optionalKey(
    Schema.Struct({ name: Schema.optionalKey(Schema.String) }),
  ),
};

export const Message = Schema.Struct({
  ...messageFields,
  reply_to_message: Schema.optionalKey(Schema.Struct(messageFields)),
});

export type Message = typeof Message.Type;

export const Me = Schema.Struct({ id: Schema.Number, username: Schema.String });

// Each update is decoded separately so one unexpected shape cannot stall the offset.
export const Updates = Schema.Array(
  Schema.Struct({ update_id: Schema.Number, message: Schema.optionalKey(Schema.Unknown) }),
);

export const Chat = Schema.Struct({
  id: Schema.Number,
  type: Schema.String,
  is_forum: Schema.optionalKey(Schema.Boolean),
});

export const ChatMember = Schema.Struct({
  status: Schema.String,
  can_send_messages: Schema.optionalKey(Schema.Boolean),
});

export const ForumTopic = Schema.Struct({ message_thread_id: Schema.Number, name: Schema.String });

export const Sent = Schema.Struct({ message_id: Schema.Number });

export const Done = Schema.Literal(true);

const Envelope = Schema.Struct({
  ok: Schema.Boolean,
  result: Schema.optionalKey(Schema.Unknown),
  error_code: Schema.optionalKey(Schema.Number),
  description: Schema.optionalKey(Schema.String),
  parameters: Schema.optionalKey(Schema.Struct({ retry_after: Schema.optionalKey(Schema.Number) })),
});

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** Calls Bot API methods with JSON bodies; callers decode only the fields they use. */
export const telegramApi =
  (token: Redacted.Redacted<string>, fetcher: Fetch, requestMs: number) =>
  async <S extends Schema.ConstraintDecoder<unknown>>(
    method: string,
    params: Schema.JsonObject,
    schema: S,
    signal: AbortSignal,
    timeoutMs = requestMs,
  ): Promise<S["Type"]> => {
    const response = await fetcher(
      `https://api.telegram.org/bot${Redacted.value(token)}/${method}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      },
    );

    const envelope = Schema.decodeUnknownSync(Envelope)(await response.json());

    if (!envelope.ok) {
      throw new TelegramApiError(
        envelope.error_code ?? response.status,
        (envelope.parameters?.retry_after ?? 0) * 1000,
        envelope.description ?? "Telegram rejected the request.",
      );
    }

    return Schema.decodeUnknownSync(schema)(envelope.result);
  };
