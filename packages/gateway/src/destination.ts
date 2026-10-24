import { DeliveryDestination } from "@poppet/store";
import { Effect, Schema } from "effect";

import { ChannelError, type MessagingChannel } from "#src/channel";

/** Resolves a proactive destination, defaulting to home, and rechecks its policy and access. */
export const resolveDestination = (
  channel: MessagingChannel["Service"],
  requested: string | null = null,
) =>
  Effect.gen(function* () {
    const conversationId = requested ?? channel.homeConversationId;

    if (conversationId === undefined)
      return yield* Effect.fail(
        new ChannelError({
          reason: "configuration",
          message: "Configure a home channel or select an explicit destination.",
        }),
      );

    const parentId = yield* channel.destination(conversationId);
    const account = yield* channel.accountId;

    const destination = yield* Schema.decodeUnknownEffect(DeliveryDestination)({
      adapter: channel.id,
      account,
      ownerId: channel.policy.ownerId,
      scopeId: channel.policy.scopeId,
      parentId,
      conversationId,
    }).pipe(
      Effect.mapError(
        () =>
          new ChannelError({
            reason: "configuration",
            message: "Invalid messaging destination.",
          }),
      ),
    );

    if (
      destination.ownerId !== channel.policy.ownerId ||
      destination.scopeId !== channel.policy.scopeId
    )
      return yield* Effect.fail(
        new ChannelError({
          reason: "permission",
          message: "The destination is outside the authorized messaging server.",
        }),
      );

    // checkAccess takes a source message; the owner posting in this destination stands in for one.
    yield* channel.checkAccess(
      {
        messageId: "scheduled-destination",
        senderId: destination.ownerId,
        scopeId: destination.scopeId,
        parentId,
        conversationId,
        text: "",
        mentioned: false,
      },
      conversationId,
    );

    return destination;
  });
