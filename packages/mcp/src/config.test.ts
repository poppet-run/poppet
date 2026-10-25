import { ConfigProvider, Effect, Schema } from "effect";
import { describe, expect, test } from "vitest";

import { MCPServers, mcpServers } from "#src/config";

describe("config.ts", () => {
  test("when MCP configuration duplicates IDs or expands permissions or embeds secrets, rejects it and unknown fields", async () => {
    const server = {
      id: "local",
      enabled: true,
      command: "/usr/bin/example",
      args: [],
      tools: ["read"],
    };

    for (const servers of [
      [server, server],
      [{ ...server, scheduledTools: ["write"] }],
      [{ ...server, environment: { TOKEN: "secret-literal" } }],
    ]) {
      expect(Schema.is(MCPServers)(servers)).toBe(false);
    }

    await expect(
      Effect.runPromise(
        mcpServers.pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({
              mcpServers: JSON.stringify([{ ...server, token: "secret-literal" }]),
            }),
          ),
        ),
      ),
    ).rejects.toHaveProperty("_tag", "ConfigError");
  });
});
