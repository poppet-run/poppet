import { DeliveryDestination } from "@poppet/store";
import { Effect, Schema } from "effect";

import { GatewayError } from "#src/adapter";
import type { GatewayAdapter } from "#src/adapter";

export const resolveDestination = (
  adapter: GatewayAdapter["Service"],
  requested: string | null = null,
) =>
  Effect.gen(function* () {
    const conversationId = requested ?? adapter.homeConversationId;

    if (conversationId === undefined) {
      return yield* Effect.fail(
        new GatewayError({
          reason: "configuration",
          message: "Configure a home channel or select an explicit destination.",
        }),
      );
    }

    const parentId = yield* adapter.destination(conversationId);
    const account = yield* adapter.accountId;

    const destination = yield* Schema.decodeUnknownEffect(DeliveryDestination)({
      adapter: adapter.id,
      account,
      ownerId: adapter.policy.ownerId,
      scopeId: adapter.policy.scopeId,
      parentId,
      conversationId,
    }).pipe(
      Effect.mapError(
        () =>
          new GatewayError({
            reason: "configuration",
            message: "Invalid messaging destination.",
          }),
      ),
    );

    if (
      destination.ownerId !== adapter.policy.ownerId ||
      destination.scopeId !== adapter.policy.scopeId
    ) {
      return yield* Effect.fail(
        new GatewayError({
          reason: "permission",
          message: "The destination is outside the authorized messaging server.",
        }),
      );
    }

    yield* adapter.checkAccess(
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
