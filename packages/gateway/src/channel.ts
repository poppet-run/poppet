import { Context, Data, Effect, Schema, Stream } from "effect";

/** An adapter failure; uncertain means a remote action may already have taken effect. */
export class ChannelError extends Data.TaggedError("ChannelError")<{
  readonly reason: "unavailable" | "permission" | "uncertain" | "configuration" | "overloaded";
  readonly message: string;
  readonly retryAfterMs?: number;
}> {}

const ExternalId = Schema.NonEmptyString.check(Schema.isMaxLength(128));

/** Adapter-normalized input with source IDs retained for authorization and deduplication. */
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

/** The owner and remote scope allowed to submit requests. */
export interface ChannelPolicy {
  readonly ownerId: string;
  readonly scopeId: string;
}

/** Remote messaging operations supplied by an adapter; the gateway owns queueing and inference. */
export class MessagingChannel extends Context.Service<
  MessagingChannel,
  {
    readonly id: string;
    /** Resolves the authenticated account without blocking connection status during login. */
    readonly accountId: Effect.Effect<string, ChannelError>;
    readonly policy: ChannelPolicy;
    /** Default destination for proactive messages, if configured. */
    readonly homeConversationId?: string;
    readonly messages: Stream.Stream<IncomingMessage, ChannelError>;
    /** Finds or creates the remote conversation for a source message. */
    readonly conversation: (message: IncomingMessage) => Effect.Effect<string, ChannelError>;
    /** Rechecks current authorization and remote permissions before execution or delivery. */
    readonly checkAccess: (
      message: IncomingMessage,
      conversationId: string,
    ) => Effect.Effect<void, ChannelError>;
    /** Resolves an existing destination's parent; the gateway rechecks its policy and access. */
    readonly destination: (conversationId: string) => Effect.Effect<string, ChannelError>;
    readonly typing: (conversationId: string) => Effect.Effect<void, ChannelError>;
    /** Updates a source message's progress indicator; the gateway treats failures as best effort. */
    readonly mark: (
      message: IncomingMessage,
      state: "working" | "completed" | "stopped",
    ) => Effect.Effect<void, ChannelError>;
    /** Sends one text chunk with a stable nonce and returns its remote message ID. */
    readonly send: (
      conversationId: string,
      text: string,
      nonce: string,
    ) => Effect.Effect<string, ChannelError>;
    readonly status: Effect.Effect<Schema.JsonObject>;
    readonly textLimit: number;
    /** Naming for conversations whose creation ownership the adapter can prove. */
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
      /** Rechecks access and the expected name immediately before the remote update. */
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
