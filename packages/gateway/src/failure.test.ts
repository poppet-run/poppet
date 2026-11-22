import { describe, expect, test } from "bun:test";

import { AgentError } from "@poppet/agent";
import { StoreError } from "@poppet/store";

import { ChannelError } from "#src/channel";
import { failureDecision } from "#src/failure";

const generic =
  "The request failed. Use /status in this conversation to inspect its session before sending a new request.";

describe("failureDecision", () => {
  test.each(["unavailable", "uncertain"] as const)(
    "when a channel is %s, retries for its matching backoff window",
    (reason) => {
      const error = new ChannelError({ reason, message: "Down" });

      expect(failureDecision(error, 0)).toEqual({ retryAfterMs: 1000, reply: generic });
      const limit = reason === "unavailable" ? 6 : 3;
      expect(failureDecision(error, limit - 1).retryAfterMs).toBe(1000 * 2 ** (limit - 1));
      expect(failureDecision(error, limit)).toEqual({ retryAfterMs: null, reply: generic });
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

  test.each(["command-approval-required", "mcp-approval-required"] as const)(
    "when a run stops with %s, passes its guidance through",
    (reason) => {
      const error = new AgentError({ reason, message: "Approval is required." });

      expect(failureDecision(error, 0)).toEqual({
        retryAfterMs: null,
        reply: "Approval is required.",
      });
    },
  );

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
