import { describe, expect, test } from "bun:test";

import { Schema } from "effect";

import { DeliveryDestination } from "#src/schema";

describe("DeliveryDestination", () => {
  test("when a Slack destination refers to a thread, accepts its conversation ID", () => {
    expect(
      Schema.is(DeliveryDestination)({
        adapter: "slack",
        account: "U123",
        ownerId: "U456",
        scopeId: "T123",
        parentId: "C123",
        conversationId: "C123:1700000000.000100",
      }),
    ).toBe(true);
  });
});
