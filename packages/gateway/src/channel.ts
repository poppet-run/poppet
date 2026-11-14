import { Context, Data, Effect, Schema, Stream } from "effect";

export class ChannelError extends Data.TaggedError("ChannelError")<{
  readonly reason: "unavailable" | "permission" | "uncertain" | "configuration" | "overloaded";
  readonly message: string;
  readonly retryAfterMs?: number;
}> {}

const ExternalId = Schema.NonEmptyString.check(Schema.isMaxLength(128));

export const IncomingAttachment = Schema.Struct({
  id: ExternalId,
  name: Schema.NonEmptyString.check(Schema.isMaxLength(1024)),
  size: Schema.optionalKey(Schema.Natural),
  ref: Schema.NonEmptyString.check(Schema.isMaxLength(4096)),
});

export type IncomingAttachment = typeof IncomingAttachment.Type;

export const IncomingMessage = Schema.Struct({
  messageId: ExternalId,
  scopeId: ExternalId,
  parentId: ExternalId,
  conversationId: Schema.NullOr(ExternalId),
  senderId: ExternalId,
  text: Schema.String.check(Schema.isMaxLength(8192)),
  mentioned: Schema.Boolean,
  attachments: Schema.optionalKey(Schema.Array(IncomingAttachment).check(Schema.isMaxLength(10))),
});

export type IncomingMessage = typeof IncomingMessage.Type;

export interface ChannelPolicy {
  readonly ownerId: string;
  readonly scopeId: string;
}

export type ApprovalState = "approved" | "denied" | "expired" | "cancelled" | "unavailable";

export interface ApprovalAction {
  readonly requestId: string;
  readonly decision: "approve" | "deny";
  readonly source: IncomingMessage;
  readonly reply: (text: string) => Effect.Effect<void, ChannelError>;
}

export class MessagingChannel extends Context.Service<
  MessagingChannel,
  {
    readonly id: string;
    readonly accountId: Effect.Effect<string, ChannelError>;
    readonly policy: ChannelPolicy;
    readonly homeConversationId?: string;
    readonly messages: Stream.Stream<IncomingMessage, ChannelError>;
    readonly checkAccess: (
      message: IncomingMessage,
      conversationId: string,
    ) => Effect.Effect<void, ChannelError>;
    readonly destination: (conversationId: string) => Effect.Effect<string, ChannelError>;
    readonly typing: (conversationId: string) => Effect.Effect<void, ChannelError>;
    readonly mark: (
      message: IncomingMessage,
      state: "working" | "completed" | "stopped",
    ) => Effect.Effect<void, ChannelError>;
    readonly download?: (
      attachment: IncomingAttachment,
      maxBytes: number,
    ) => Effect.Effect<Uint8Array, ChannelError>;
    readonly send: (
      conversationId: string,
      text: string,
      nonce: string,
    ) => Effect.Effect<string, ChannelError>;
    readonly approvals?: {
      readonly actions: Stream.Stream<ApprovalAction, ChannelError>;
      readonly send: (
        conversationId: string,
        text: string,
        nonce: string,
        requestId: string,
      ) => Effect.Effect<string, ChannelError>;
      readonly update: (
        conversationId: string,
        messageId: string,
        requestId: string,
        state: ApprovalState,
      ) => Effect.Effect<void, ChannelError>;
    };
    readonly status: Effect.Effect<Schema.JsonObject>;
    readonly textLimit: number;
    readonly naming: {
      readonly sanitize: (title: string) => string;
      readonly conversation: (
        message: IncomingMessage,
        title: string,
      ) => Effect.Effect<
        { readonly id: string; readonly managedName: string | null },
        ChannelError
      >;
      readonly current: (
        message: IncomingMessage,
        id: string,
      ) => Effect.Effect<string, ChannelError>;
      readonly rename: (
        message: IncomingMessage,
        id: string,
        expected: string,
        title: string,
      ) => Effect.Effect<string | null, ChannelError>;
      readonly changes: Stream.Stream<string>;
    };
  }
>()("poppet/MessagingChannel") {}
