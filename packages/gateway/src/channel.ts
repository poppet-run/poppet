import { Context, Data, Effect, Schema, Stream } from "effect";

export class ChannelError extends Data.TaggedError("ChannelError")<{
  readonly reason: "unavailable" | "permission" | "uncertain" | "configuration" | "overloaded";
  readonly message: string;
  readonly retryAfterMs?: number;
}> {}

const ExternalId = Schema.NonEmptyString.check(Schema.isMaxLength(128));

export const IncomingMessage = Schema.Struct({
  messageId: ExternalId,
  scopeId: ExternalId,
  parentId: ExternalId,
  conversationId: Schema.NullOr(ExternalId),
  senderId: ExternalId,
  text: Schema.String.check(Schema.isMaxLength(8192)),
  mentioned: Schema.Boolean,
});

export type IncomingMessage = typeof IncomingMessage.Type;

export interface ChannelPolicy {
  readonly ownerId: string;
  readonly scopeId: string;
  readonly parentIds: ReadonlyArray<string>;
}

export class MessagingChannel extends Context.Service<
  MessagingChannel,
  {
    readonly id: string;
    readonly accountId: string;
    readonly policy: ChannelPolicy;
    readonly messages: Stream.Stream<IncomingMessage, ChannelError>;
    readonly conversation: (message: IncomingMessage) => Effect.Effect<string, ChannelError>;
    readonly checkAccess: (
      message: IncomingMessage,
      conversationId: string,
    ) => Effect.Effect<void, ChannelError>;
    readonly typing: (conversationId: string) => Effect.Effect<void, ChannelError>;
    readonly mark: (
      message: IncomingMessage,
      state: "working" | "completed" | "stopped",
    ) => Effect.Effect<void, ChannelError>;
    readonly send: (
      conversationId: string,
      text: string,
      nonce: string,
    ) => Effect.Effect<string, ChannelError>;
    readonly status: Effect.Effect<Schema.JsonObject>;
    readonly textLimit: number;
  }
>()("poppet/MessagingChannel") {}
