import type { Effect, Stream } from "effect";
import { Context, Data, Schema } from "effect";

export class GatewayError extends Data.TaggedError("GatewayError")<{
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

export interface GatewayPolicy {
  readonly ownerId: string;
  readonly scopeId: string;
}

export type ApprovalState = "approved" | "denied" | "expired" | "cancelled" | "unavailable";

export interface ApprovalAction {
  readonly requestId: string;
  readonly decision: "approve" | "deny";
  readonly source: IncomingMessage;
  readonly reply: (text: string) => Effect.Effect<void, GatewayError>;
}

export class GatewayAdapter extends Context.Service<
  GatewayAdapter,
  {
    readonly id: string;
    readonly accountId: Effect.Effect<string, GatewayError>;
    readonly policy: GatewayPolicy;
    readonly homeConversationId?: string;
    readonly messages: Stream.Stream<IncomingMessage, GatewayError>;
    readonly checkAccess: (
      message: IncomingMessage,
      conversationId: string,
    ) => Effect.Effect<void, GatewayError>;
    readonly destination: (conversationId: string) => Effect.Effect<string, GatewayError>;
    readonly typing: (conversationId: string) => Effect.Effect<void, GatewayError>;
    readonly mark: (
      message: IncomingMessage,
      state: "working" | "completed" | "stopped",
    ) => Effect.Effect<void, GatewayError>;
    readonly download?: (
      attachment: IncomingAttachment,
      maxBytes: number,
    ) => Effect.Effect<Uint8Array, GatewayError>;
    readonly send: (
      conversationId: string,
      text: string,
      nonce: string,
    ) => Effect.Effect<string, GatewayError>;
    readonly approvals?: {
      readonly actions: Stream.Stream<ApprovalAction, GatewayError>;
      readonly send: (
        conversationId: string,
        text: string,
        nonce: string,
        requestId: string,
      ) => Effect.Effect<string, GatewayError>;
      readonly update: (
        conversationId: string,
        messageId: string,
        requestId: string,
        state: ApprovalState,
      ) => Effect.Effect<void, GatewayError>;
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
        GatewayError
      >;
      readonly current: (
        message: IncomingMessage,
        id: string,
      ) => Effect.Effect<string, GatewayError>;
      readonly rename: (
        message: IncomingMessage,
        id: string,
        expected: string,
        title: string,
      ) => Effect.Effect<string | null, GatewayError>;
      readonly changes: Stream.Stream<string>;
    };
  }
>()("poppet/GatewayAdapter") {}
