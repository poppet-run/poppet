import { describe, expect, test } from "bun:test";

import { ConfigProvider, Effect, Exit, Schema } from "effect";

import { MCPServers, mcpServers } from "#src/config";

const decode = (servers: ReadonlyArray<object>) =>
  mcpServers.pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown({ mcpServers: JSON.stringify(servers) }),
    ),
  );

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

  test("when an HTTP server is configured, accepts https or loopback http and OAuth, and rejects secrets in the URL, managed headers, OAuth beside an Authorization header, and stdio fields", async () => {
    const server = { id: "remote", enabled: true, url: "https://mcp.example.com/mcp", tools: [] };

    const accepted: object[] = [];

    for (const url of [
      "https://mcp.example.com/mcp?team=1",
      "http://127.0.0.1:8080/mcp",
      "http://[::1]/mcp",
    ]) {
      accepted.push({ ...server, url });
    }

    accepted.push(
      { ...server, oauth: {} },
      {
        ...server,
        headers: { "X-Team": { env: "TEAM" } },
        oauth: {
          clientId: "registered",
          clientSecret: { credential: "remote-secret" },
          scopes: ["read", "offline_access"],
          callbackPort: 1455,
        },
      },
    );

    const rejected: object[] = [];

    for (const url of [
      "http://mcp.example.com/mcp",
      "https://user:secret@mcp.example.com/mcp",
      "https://mcp.example.com/mcp#token",
      "file:///tmp/mcp",
      "/mcp",
    ]) {
      rejected.push({ ...server, url });
    }

    rejected.push(
      { ...server, headers: { "Mcp-Session-Id": { env: "SESSION" } } },
      { ...server, headers: { Authorization: "Bearer secret-literal" } },
      { ...server, headers: { "X-Key": { env: "A" }, "x-key": { env: "B" } } },
      { ...server, command: "/usr/bin/example", args: [] },
      { ...server, headers: { authorization: { credential: "remote" } }, oauth: {} },
      { ...server, oauth: { clientSecret: { credential: "remote-secret" } } },
      { ...server, oauth: { clientId: "registered", clientSecret: "secret-literal" } },
      { ...server, oauth: { callbackPort: 80 } },
      { id: "local", enabled: true, command: "/usr/bin/example", args: [], tools: [], oauth: {} },
    );

    const exits = await Effect.runPromise(
      Effect.forEach([...accepted, ...rejected], (entry) => Effect.exit(decode([entry]))),
    );

    expect(exits.map(Exit.isSuccess)).toEqual([
      ...accepted.map(() => true),
      ...rejected.map(() => false),
    ]);
  });
});
