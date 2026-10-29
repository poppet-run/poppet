import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Schema } from "effect";

import { serveOAuth } from "../../../packages/mcp/src/test/oauth-server";

const invoke = async (directory: string, args: ReadonlyArray<string>, input: string | null) => {
  const subprocess = Bun.spawn([process.execPath, "apps/cli/src/main.ts", ...args], {
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    env: { PATH: process.env.PATH ?? "", POPPET_DATA_DIR: directory },
    stdin: input === null ? "ignore" : new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);

  return { output: stdout + stderr, exitCode };
};

const Request = Schema.Struct({ id: Schema.optionalKey(Schema.Json), method: Schema.String });

/** A Streamable HTTP server that accepts one bearer key, or challenges for OAuth without it. */
const serve = (key: string | null, beforeList?: () => Promise<void>) => {
  const tools = ["read", "write"];
  const authorizations: (string | null)[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const authorization = request.headers.get("authorization");
      authorizations.push(authorization);

      if (key === null || authorization !== `Bearer ${key}`)
        return new Response(null, {
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="${new URL(request.url).origin}/.well-known/oauth-protected-resource"`,
          },
        });

      if (request.method !== "POST") return new Response(null, { status: 405 });

      const message = Schema.decodeUnknownSync(Schema.fromJsonString(Request))(
        await request.text(),
      );

      if (message.id === undefined) return new Response(null, { status: 202 });

      const reply = (result: Schema.JsonObject) =>
        Response.json({ jsonrpc: "2.0", id: message.id!, result });

      if (message.method === "tools/list") await beforeList?.();

      return message.method === "initialize"
        ? reply({
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1" },
          })
        : reply({
            tools: tools.map((name) => ({
              name,
              inputSchema: { type: "object" },
            })),
          });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    authorizations,
    tools,
    stop: () => server.stop(true),
  };
};

const harness = async () => {
  const directory = await mkdtemp(join(tmpdir(), "poppet-mcp-setup-"));

  return {
    directory,
    config: async () => JSON.parse(await readFile(join(directory, "config.json"), "utf8")),
    close: () => rm(directory, { recursive: true, force: true }),
  };
};

describe("mcp add and remove", () => {
  test.concurrent("when an API-key server is added, saves the key apart from configuration without connecting", async () => {
    const state = await harness();
    const server = serve("mcp-flag-secret");

    try {
      const added = await invoke(
        state.directory,
        ["mcp", "add", "remote", server.url, "--auth", "api-key", "--api-key", "mcp-flag-secret"],
        null,
      );

      expect(added.exitCode).toBe(0);
      expect(added.output).toContain("mcp tools remote");
      expect(added.output).not.toContain("mcp-flag-secret");
      expect(server.authorizations).toEqual([]);
      expect((await state.config()).mcpServers).toEqual([
        {
          id: "remote",
          enabled: true,
          url: server.url,
          headers: { Authorization: { credential: "mcp-remote", prefix: "Bearer " } },
          tools: [],
        },
      ]);
      expect(await readFile(join(state.directory, "config.json"), "utf8")).not.toContain(
        "mcp-flag-secret",
      );
      expect(
        JSON.parse(await readFile(join(state.directory, "auth/mcp-remote.json"), "utf8")).key,
      ).toBe("mcp-flag-secret");

      const removed = await invoke(state.directory, ["mcp", "remove", "remote"], null);
      expect(removed.exitCode).toBe(0);
      expect((await state.config()).mcpServers).toEqual([]);
      expect(await readdir(join(state.directory, "auth"))).not.toContain("mcp-remote.json");
    } finally {
      await server.stop();
      await state.close();
    }
  });

  test.concurrent("when permissions change, discovers blocked tools and keeps scheduled access an explicit subset", async () => {
    const state = await harness();
    const server = serve("mcp-flag-secret");
    const run = (...args: string[]) => invoke(state.directory, ["mcp", ...args], null);

    try {
      expect(
        (
          await run(
            "add",
            "remote",
            server.url,
            "--auth",
            "api-key",
            "--api-key",
            "mcp-flag-secret",
          )
        ).exitCode,
      ).toBe(0);
      const listed = await run("tools", "remote");
      expect(listed.exitCode).toBe(0);
      expect(
        JSON.parse(listed.output).map(
          ({
            toolName,
            allowed,
            scheduled,
          }: {
            toolName: string;
            allowed: boolean;
            scheduled: boolean;
          }) => ({ toolName, allowed, scheduled }),
        ),
      ).toEqual([
        { toolName: "read", allowed: false, scheduled: false },
        { toolName: "write", allowed: false, scheduled: false },
      ]);
      expect(server.authorizations).toContain("Bearer mcp-flag-secret");
      expect((await run("allow", "remote", "read", "--scheduled")).exitCode).toBe(0);
      expect((await state.config()).mcpServers[0]).toMatchObject({
        tools: ["read"],
        scheduledTools: ["read"],
      });
      expect((await run("allow", "remote", "--all")).exitCode).toBe(0);
      expect((await state.config()).mcpServers[0]).toMatchObject({
        tools: ["read", "write"],
        scheduledTools: ["read"],
      });

      server.tools.push("new-tool");
      const refreshed = JSON.parse((await run("tools", "remote")).output);
      expect(
        refreshed.find((tool: { toolName: string }) => tool.toolName === "new-tool"),
      ).toMatchObject({ allowed: false, scheduled: false });
      expect((await run("deny", "remote", "read", "--scheduled")).exitCode).toBe(0);
      expect((await state.config()).mcpServers[0]).toMatchObject({
        tools: ["read", "write"],
        scheduledTools: [],
      });
      expect((await run("allow", "remote", "read", "read", "--scheduled")).exitCode).toBe(0);
      await server.stop();
      expect((await run("deny", "remote", "read")).exitCode).toBe(0);
      expect((await state.config()).mcpServers[0]).toMatchObject({
        tools: ["write"],
        scheduledTools: [],
      });
      expect((await run("allow", "remote", "--all")).exitCode).toBe(1);
      expect((await state.config()).mcpServers[0]).toMatchObject({
        tools: ["write"],
        scheduledTools: [],
      });
    } finally {
      await server.stop();
      await state.close();
    }
  }, 30_000);

  test.each([
    { name: "missing tool names", args: ["allow", "remote"] },
    { name: "unknown tool", args: ["allow", "remote", "missing"] },
    { name: "names with all", args: ["allow", "remote", "read", "--all"] },
    { name: "scheduled all", args: ["allow", "remote", "--all", "--scheduled"] },
    { name: "deny without names", args: ["deny", "remote"] },
    { name: "unknown server", args: ["allow", "missing", "read"] },
  ])("rejects $name without changing permissions", async ({ args }) => {
    const state = await harness();
    const server = serve("mcp-flag-secret");

    try {
      expect(
        (
          await invoke(
            state.directory,
            [
              "mcp",
              "add",
              "remote",
              server.url,
              "--auth",
              "api-key",
              "--api-key",
              "mcp-flag-secret",
            ],
            null,
          )
        ).exitCode,
      ).toBe(0);
      const before = await state.config();
      expect((await invoke(state.directory, ["mcp", ...args], null)).exitCode).toBe(1);
      expect(await state.config()).toEqual(before);
    } finally {
      await server.stop();
      await state.close();
    }
  });

  test.concurrent("when configuration changes during discovery, refuses to grant stale permissions", async () => {
    const state = await harness();

    const server = serve("mcp-flag-secret", async () => {
      const config = await state.config();
      config.mcpServers[0].enabled = false;
      await writeFile(join(state.directory, "config.json"), JSON.stringify(config));
    });

    try {
      const added = await invoke(
        state.directory,
        ["mcp", "add", "remote", server.url, "--auth", "api-key", "--api-key", "mcp-flag-secret"],
        null,
      );

      expect(added.exitCode).toBe(0);
      const allowed = await invoke(state.directory, ["mcp", "allow", "remote", "--all"], null);
      expect(allowed.exitCode).toBe(1);
      expect(allowed.output).toContain("configuration changed");
      expect((await state.config()).mcpServers[0]).toMatchObject({ enabled: false, tools: [] });
    } finally {
      await server.stop();
      await state.close();
    }
  });

  test.each([
    {
      name: "duplicate server",
      args: [
        "remote",
        "https://other.example/mcp",
        "--auth",
        "api-key",
        "--api-key",
        "unsaved-key",
      ],
      message: "already exists",
    },
    {
      name: "API key over HTTP",
      args: ["plain", "http://mcp.example/mcp", "--auth", "api-key", "--api-key", "unsaved-key"],
      message: "The server cannot be added",
    },
    {
      name: "removed scheduled-tool flag",
      args: ["subset", "https://mcp.example/mcp", "--auth", "none", "--scheduled-tool", "read"],
      message: "Unrecognized flag: --scheduled-tool",
    },
    {
      name: "removed all-tools flag",
      args: ["both", "https://mcp.example/mcp", "--auth", "none", "--all-tools"],
      message: "Unrecognized flag: --all-tools",
    },
  ])("rejects $name without saving configuration or a key", async ({ args, message }) => {
    const state = await harness();
    const existing = [{ id: "remote", enabled: true, url: "https://mcp.example/mcp", tools: [] }];
    await writeFile(join(state.directory, "config.json"), JSON.stringify({ mcpServers: existing }));

    try {
      const result = await invoke(state.directory, ["mcp", "add", ...args], null);

      expect(result.exitCode).toBe(1);
      expect(result.output).toContain(message);
      expect(result.output).not.toContain("unsaved-key");
      expect((await state.config()).mcpServers).toEqual(existing);
      expect(await readdir(state.directory)).not.toContain("auth");
    } finally {
      await state.close();
    }
  });

  test.concurrent("when API-key input is invalid or unavailable, leaves configuration and credentials untouched", async () => {
    const state = await harness();

    try {
      for (const { args, message } of [
        {
          args: ["--auth", "none", "--api-key", "unused-secret"],
          message: "--api-key applies only to --auth api-key",
        },
        {
          args: ["--auth", "api-key", "--api-key", "invalid secret"],
          message: "Enter a nonempty API key without whitespace",
        },
        {
          args: ["--auth", "api-key", "--api-key", ""],
          message: "Enter a nonempty API key without whitespace",
        },
        { args: ["--auth", "api-key"], message: "interactive terminal or --api-key" },
        { args: ["--auth", "api-key", "--key-stdin"], message: "Unrecognized flag: --key-stdin" },
      ]) {
        // oxlint-disable-next-line no-await-in-loop
        const result = await invoke(
          state.directory,
          ["mcp", "add", "remote", "https://mcp.example/mcp", ...args],
          null,
        );

        expect(result.exitCode).toBe(1);
        expect(result.output).toContain(message);
        expect(result.output).not.toContain("unused-secret");
        expect(result.output).not.toContain("invalid secret");
      }

      expect(await readdir(state.directory)).not.toContain("config.json");
      expect(await readdir(state.directory)).not.toContain("auth");
    } finally {
      await state.close();
    }
  });

  test.concurrent("when an OAuth server is added, separate login signs in through the printed link and later signs out and forgets the sign-in", async () => {
    const state = await harness();
    const server = serveOAuth();

    try {
      const added = await invoke(
        state.directory,
        ["mcp", "add", "remote", server.url, "--auth", "oauth"],
        null,
      );

      expect(added.exitCode).toBe(0);
      expect(added.output).toContain("mcp login remote");
      expect(await readdir(state.directory)).not.toContain("auth");
      expect(
        (await invoke(state.directory, ["mcp", "login", "remote", "--callback-port", "80"], null))
          .exitCode,
      ).toBe(1);

      const subprocess = Bun.spawn(
        [process.execPath, "apps/cli/src/main.ts", "mcp", "login", "remote", "--no-browser"],
        {
          cwd: fileURLToPath(new URL("../../..", import.meta.url)),
          env: { PATH: process.env.PATH ?? "", POPPET_DATA_DIR: state.directory },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      // Without a terminal nothing can be pasted, so the consenting browser reaches the listener.
      let output = "";
      let approved = false;
      const decoder = new TextDecoder();
      const reader = subprocess.stdout.getReader();

      while (true) {
        // oxlint-disable-next-line no-await-in-loop
        const { done, value } = await reader.read();

        if (done) break;
        output += decoder.decode(value);
        const link = /http:\/\/127\.0\.0\.1:\d+\/authorize\?\S+/.exec(output)?.[0];

        if (link !== undefined && !approved) {
          approved = true;
          // oxlint-disable-next-line no-await-in-loop
          await fetch(await server.approve(new URL(link)));
        }
      }

      expect(await subprocess.exited).toBe(0);
      expect(output).toContain("Signed in to MCP server remote.");

      expect((await state.config()).mcpServers[0].oauth).toEqual({});

      const record = await readFile(join(state.directory, "auth/mcp-oauth-remote.json"), "utf8");
      expect(record).toContain("access-");
      expect(await readFile(join(state.directory, "config.json"), "utf8")).not.toContain("access-");

      const status = JSON.parse((await invoke(state.directory, ["mcp", "servers"], null)).output);
      expect(status[0].signIn).toMatchObject({ signedIn: true, scopes: ["read"] });

      expect((await invoke(state.directory, ["mcp", "logout", "remote"], null)).exitCode).toBe(0);
      const after = JSON.parse((await invoke(state.directory, ["mcp", "servers"], null)).output);
      expect(after[0].signIn).toMatchObject({ signedIn: false });

      expect((await invoke(state.directory, ["mcp", "remove", "remote"], null)).exitCode).toBe(0);
      expect(await readdir(join(state.directory, "auth"))).not.toContain("mcp-oauth-remote.json");
    } finally {
      await server.stop();
      await state.close();
    }
  }, 15_000);
});
