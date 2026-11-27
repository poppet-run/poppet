import { describe, expect, test } from "bun:test";

import { oauthFetch } from "#src/oauth/oauth-network";

describe("oauthFetch", () => {
  test.each([
    "http://localhost:8080/token",
    "https://localhost/token",
    "https://127.0.0.1/token",
    "https://10.0.0.2/token",
    "https://[::ffff:127.0.0.1]/token",
  ])(
    "when a remote MCP server points OAuth to %s, blocks the request before connecting",
    async (url) => {
      const fetch = oauthFetch(new URL("https://mcp.example.test"), new AbortController().signal);
      await expect(fetch(url)).rejects.toThrow("public HTTPS");
    },
  );
});
