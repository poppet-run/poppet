import { describe, expect, test } from "bun:test";

import { APIConnectionError, APIError, APIUserAbortError } from "openai";

import { routerFailure, routerOptions } from "#src/protocol";

describe("routerFailure", () => {
  test("when the connection drops or is aborted, reports it as temporary or interrupted", () => {
    expect(routerFailure(new APIConnectionError({ message: "reset" })).reason).toBe("temporary");
    expect(routerFailure(new APIUserAbortError()).reason).toBe("interrupted");
  });

  test("when OpenRouter reports payment or upstream failures, classifies them before status rules", () => {
    expect(routerFailure(new APIError(402, undefined, undefined, new Headers())).reason).toBe(
      "quota",
    );
    expect(
      routerFailure(new APIError(401, { code: "provider_error" }, "", new Headers())).reason,
    ).toBe("temporary");
  });
});

describe("routerOptions", () => {
  test("when a fragment omits index, format, and data, preserves the matching signed reasoning block", () => {
    const continuation = routerOptions.continuation!();
    continuation.append({
      reasoning_details: [
        { type: "reasoning.text", index: 0, id: "r1", format: "anthropic-claude-v1", text: "One " },
        {
          type: "reasoning.text",
          index: 1,
          id: "r2",
          format: "anthropic-claude-v1",
          text: "Other",
        },
      ],
    });
    continuation.append({
      reasoning_details: [
        {
          type: "reasoning.text",
          index: null,
          id: "r1",
          format: null,
          data: null,
          summary: null,
          text: "block",
          signature: "signed",
        },
      ],
    });
    expect(continuation.save()).toMatchObject({
      reasoningDetails: [
        {
          id: "r1",
          index: 0,
          format: "anthropic-claude-v1",
          text: "One block",
          signature: "signed",
        },
        { id: "r2", index: 1, text: "Other" },
      ],
    });
  });
});
