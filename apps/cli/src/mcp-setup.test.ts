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
const serve = (key: string | null) => {
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

      return message.method === "initialize"
        ? reply({
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1" },
          })
        : reply({
            tools: ["read", "write"].map((name) => ({
              name,
              inputSchema: { type: "object" },
            })),
          });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    authorizations,
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
  test.concurrent("when an API-key server is added, saves the key apart from configuration and lists its tools", async () => {
    const state = await harness();
    const server = serve("mcp-stdin-secret");

    try {
      const added = await invoke(
        state.directory,
        [
          "mcp",
          "add",
          "remote",
          "--url",
          server.url,
          "--auth",
          "api-key",
          "--key-stdin",
          "--tool",
          "read",
        ],
        "mcp-stdin-secret\n",
      );

      expect(added.exitCode).toBe(0);
      expect(added.output).toContain("Available tools: read, write");
      expect(added.output).not.toContain("mcp-stdin-secret");
      expect(server.authorizations).toContain("Bearer mcp-stdin-secret");
      expect((await state.config()).mcpServers).toEqual([
        {
          id: "remote",
          enabled: true,
          url: server.url,
          headers: { Authorization: { credential: "mcp-remote", prefix: "Bearer " } },
          tools: ["read"],
        },
      ]);
      expect(await readFile(join(state.directory, "config.json"), "utf8")).not.toContain(
        "mcp-stdin-secret",
      );
      expect(
        JSON.parse(await readFile(join(state.directory, "auth/mcp-remote.json"), "utf8")).key,
      ).toBe("mcp-stdin-secret");

      const removed = await invoke(state.directory, ["mcp", "remove", "remote"], null);
      expect(removed.exitCode).toBe(0);
      expect((await state.config()).mcpServers).toEqual([]);
      expect(await readdir(join(state.directory, "auth"))).not.toContain("mcp-remote.json");
    } finally {
      await server.stop();
      await state.close();
    }
  });

  test.concurrent("when an entry is invalid or duplicated, saves neither configuration nor key", async () => {
    const state = await harness();
    const existing = [{ id: "remote", enabled: true, url: "https://mcp.example/mcp", tools: [] }];
    await writeFile(join(state.directory, "config.json"), JSON.stringify({ mcpServers: existing }));

    try {
      for (const args of [
        ["remote", "--url", "https://other.example/mcp", "--auth", "api-key", "--key-stdin"],
        ["plain", "--url", "http://mcp.example/mcp", "--auth", "api-key", "--key-stdin"],
        [
          "subset",
          "--url",
          "https://mcp.example/mcp",
          "--auth",
          "none",
          "--scheduled-tool",
          "read",
        ],
      ]) {
        // oxlint-disable-next-line no-await-in-loop
        const result = await invoke(state.directory, ["mcp", "add", ...args], "unsaved-key\n");
        expect(result.exitCode).toBe(1);
        expect(result.output).not.toContain("unsaved-key");
      }

      expect((await state.config()).mcpServers).toEqual(existing);
      expect(await readdir(state.directory)).not.toContain("auth");
    } finally {
      await state.close();
    }
  });

  test.concurrent("when a server challenges for OAuth, keeps the entry and suggests OAuth", async () => {
    const state = await harness();
    const server = serve(null);

    try {
      const added = await invoke(
        state.directory,
        ["mcp", "add", "remote", "--url", server.url, "--auth", "none"],
        null,
      );

      expect(added.exitCode).toBe(0);
      expect(added.output).toContain("requires OAuth sign-in");
      expect(added.output).toContain("No tools are allowed yet");
      expect((await state.config()).mcpServers).toHaveLength(1);
    } finally {
      await server.stop();
      await state.close();
    }
  });

  test.concurrent("when an OAuth server is added, signs in through the printed link and later signs out and forgets the sign-in", async () => {
    const state = await harness();
    const server = serveOAuth();

    try {
      const subprocess = Bun.spawn(
        [
          process.execPath,
          "apps/cli/src/main.ts",
          "mcp",
          "add",
          "remote",
          "--url",
          server.url,
          "--auth",
          "oauth",
          "--no-browser",
          "--tool",
          "read",
        ],
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
      expect(output).toContain("Available tools: read");
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
  });
});
