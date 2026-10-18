import { expect, test } from "bun:test";

import { ConfigProvider, Effect, Schema } from "effect";

import { MCPServers, mcpServers } from "#src/config";

test("MCP rejects duplicate IDs, permission expansion, secret literals and unknown override fields", async () => {
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
            POPPET_MCP_SERVERS: JSON.stringify([{ ...server, token: "secret-literal" }]),
          }),
        ),
      ),
    ),
  ).rejects.toHaveProperty("_tag", "ConfigError");
});
