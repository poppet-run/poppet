import { Context, Data, Effect, Schema, Stream } from "effect";

/** An adapter failure; uncertain means a remote action may already have taken effect. */
export class ChannelError extends Data.TaggedError("ChannelError")<{
  readonly reason:
    | "unavailable"
    | "permission"
    | "uncertain"
    | "configuration"
    | "overloaded"
    | "attachment";
  readonly message: string;
  readonly retryAfterMs?: number;
}> {}

const ExternalId = Schema.NonEmptyString.check(Schema.isMaxLength(128));

// Voice metadata remains decodable for saved inbox entries; new recordings are unsupported.
export const Attachment = Schema.Struct({
  kind: Schema.Literals(["document", "voice", "unsupported"]),
  fileId: Schema.NonEmptyString.check(Schema.isMaxLength(1024)),
  name: Schema.String.check(Schema.isMaxLength(120)),
  mime: Schema.String.check(Schema.isMaxLength(128)),
  size: Schema.optionalKey(Schema.Natural),
  duration: Schema.optionalKey(Schema.Natural),
});

export type Attachment = typeof Attachment.Type;

export const safeAttachmentName = (name: string) =>
  name
    .replaceAll("\\", "/")
    .split("/")
    .at(-1)!
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .slice(0, 120) || "Document";

/** Adapter-normalized input with source IDs retained for authorization and deduplication. */
export const IncomingMessage = Schema.Struct({
  messageId: ExternalId,
  scopeId: ExternalId,
  parentId: ExternalId,
  conversationId: Schema.NullOr(ExternalId),
  senderId: ExternalId,
  text: Schema.String.check(Schema.isMaxLength(8192)),
  mentioned: Schema.Boolean,
  attachment: Schema.optionalKey(Attachment),
});

export type IncomingMessage = typeof IncomingMessage.Type;

/** The owner, remote scope, and parent channels allowed to submit requests. */
export interface ChannelPolicy {
  readonly ownerId: string;
  readonly scopeId: string;
  readonly parentIds: ReadonlyArray<string>;
}

/** One polled update; null messages are deliberately ignored before advancing the cursor. */
export interface PolledMessage {
  readonly cursor: string;
  readonly message: IncomingMessage | null;
}

/** Remote messaging operations supplied by an adapter; the gateway owns queueing and inference. */
export class MessagingChannel extends Context.Service<
  MessagingChannel,
  {
    readonly id: string;
    readonly accountId: string;
    readonly policy: ChannelPolicy;
    readonly messages: Stream.Stream<IncomingMessage, ChannelError>;
    /** Pull-based adapters advance only after the gateway durably accepts each update. */
    readonly poll?: (
      cursor: string | null,
    ) => Effect.Effect<ReadonlyArray<PolledMessage>, ChannelError>;
    /** Finds or creates the remote conversation for a source message. */
    readonly conversation: (message: IncomingMessage) => Effect.Effect<string, ChannelError>;
    /** Rechecks current authorization and remote permissions before execution or delivery. */
    readonly checkAccess: (
      message: IncomingMessage,
      conversationId: string,
    ) => Effect.Effect<void, ChannelError>;
    /** Resolves an existing destination's parent; the gateway rechecks its policy and access. */
    readonly destination?: (conversationId: string) => Effect.Effect<string, ChannelError>;
    /** Resolves only the attachment reference from this authorized, saved message. */
    readonly download?: (
      message: IncomingMessage,
      maxBytes: number,
    ) => Effect.Effect<Uint8Array, ChannelError>;
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
    /** Optional naming for conversations whose creation ownership the adapter can prove. */
    readonly naming?: {
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
