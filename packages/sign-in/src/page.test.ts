import { describe, expect, test } from "bun:test";

import { callbackResponse } from "#src/page";

describe("callbackResponse", () => {
  test("when the confirmation message contains markup, displays it as text", async () => {
    const response = callbackResponse(true, "<strong>Saved & ready</strong>");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("<p>&lt;strong&gt;Saved &amp; ready&lt;/strong&gt;</p>");
    expect(body).not.toContain("<strong>");
  });
});
