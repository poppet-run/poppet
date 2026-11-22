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
  test("when a trailing accounting frame includes null optional delta fields, accepts it and rejects non-null content", () => {
    expect(
      routerOptions.isAccountingFrame?.(
        {
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              delta: { role: "assistant", content: "", refusal: null, reasoning: null },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 4 },
        },
        "stop",
      ),
    ).toBe(true);

    expect(
      routerOptions.isAccountingFrame?.(
        {
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              delta: { role: "assistant", content: "", reasoning: "extra" },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 4 },
        },
        "stop",
      ),
    ).toBe(false);
  });
});
