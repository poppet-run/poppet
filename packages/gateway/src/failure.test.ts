import { AgentError } from "@poppet/agent";
import { StoreError } from "@poppet/store";
import { describe, expect, test } from "vitest";

import { ChannelError } from "#src/channel";
import { failureDecision } from "#src/failure";

const generic =
  "The request failed. Use /status in this conversation to inspect its session before sending a new request.";

describe("failureDecision", () => {
  test.each(["unavailable", "uncertain"] as const)(
    "when a channel is %s, retries with exponential backoff before the third attempt",
    (reason) => {
      const error = new ChannelError({ reason, message: "Down" });

      expect(failureDecision(error, 0)).toEqual({ retryAfterMs: 1000, reply: generic });
      expect(failureDecision(error, 2)).toEqual({ retryAfterMs: 4000, reply: generic });
      expect(failureDecision(error, 3)).toEqual({ retryAfterMs: null, reply: generic });
    },
  );

  test("when a channel asks to wait longer, retries after its delay", () => {
    const error = new ChannelError({ reason: "unavailable", message: "Slow", retryAfterMs: 9000 });

    expect(failureDecision(error, 1).retryAfterMs).toBe(9000);
  });

  test.each(["permission", "configuration", "overloaded"] as const)(
    "when a channel reports %s, fails with the generic reply",
    (reason) => {
      expect(failureDecision(new ChannelError({ reason, message: "No" }), 0)).toEqual({
        retryAfterMs: null,
        reply: generic,
      });
    },
  );

  test("when command approval fails, passes its message through", () => {
    const error = new AgentError({ reason: "command-approval-required", message: "Expired." });

    expect(failureDecision(error, 0)).toEqual({ retryAfterMs: null, reply: "Expired." });
  });

  test("when another agent error fails, uses the generic reply", () => {
    const error = new AgentError({ reason: "tool-permission", message: "Denied." });

    expect(failureDecision(error, 0).reply).toBe(generic);
  });

  test("when storage fails or no error is known, fails without a reply", () => {
    expect(failureDecision(new StoreError({ reason: "busy", message: "Busy" }), 0)).toEqual({
      retryAfterMs: null,
      reply: null,
    });
    expect(failureDecision(null, 0)).toEqual({ retryAfterMs: null, reply: null });
  });
});
