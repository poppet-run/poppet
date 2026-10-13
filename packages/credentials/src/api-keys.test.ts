import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { AppConfig } from "@poppet/config";
import { Effect, Layer, Redacted } from "effect";

import { ApiKeyStore, ApiKeyStoreLive } from "#src/api-keys";

const harness = async () => {
  const directory = await mkdtemp(join(tmpdir(), "poppet-api-keys-"));

  const runtime = ApiKeyStoreLive.pipe(
    Layer.provide(
      Layer.succeed(AppConfig, {
        applicationName: "Test",
        dataDirectory: directory,
        notesDirectory: join(directory, "notes"),
        provider: "openrouter",
        model: null,
      }),
    ),
  );

  return {
    directory,
    run: <A>(
      operation: (
        store: ApiKeyStore["Service"],
      ) => Effect.Effect<A, import("@poppet/provider").ProviderError>,
    ) =>
      Effect.runPromise(
        Effect.gen(function* () {
          return yield* operation(yield* ApiKeyStore);
        }).pipe(Effect.provide(runtime)),
      ),
    close: () => rm(directory, { recursive: true, force: true }),
  };
};

describe("API-key storage", () => {
  test("inference key loading uses saved keys, gives environment keys precedence, and rejects empty overrides", async () => {
    const store = await harness();

    try {
      await store.run((keys) => keys.write("openrouter", Redacted.make("router-key")));

      const program = `
        import { loadApiKey } from './src/api-keys.ts';
        import { Effect, Redacted } from 'effect';
        const result = await Effect.runPromise(loadApiKey('openrouter').pipe(Effect.match({
          onSuccess: key => ({ source: Redacted.value(key) === 'router-key' ? 'stored' : 'environment' }),
          onFailure: error => ({ reason: error.reason })
        })));
        console.log(JSON.stringify(result));
      `;

      const load = async (environment: Record<string, string>) => {
        const child = Bun.spawn([process.execPath, "-e", program], {
          cwd: fileURLToPath(new URL("..", import.meta.url)),
          env: { PATH: process.env.PATH ?? "", POPPET_DATA_DIR: store.directory, ...environment },
          stdout: "pipe",
          stderr: "pipe",
        });

        const output = await new Response(child.stdout).text();
        expect(await child.exited).toBe(0);
        expect(output).not.toContain("router-key");

        return JSON.parse(output);
      };

      expect(await load({})).toEqual({ source: "stored" });
      expect(await load({ POPPET_OPENROUTER_API_KEY: "environment-key" })).toEqual({
        source: "environment",
      });
      expect(await load({ POPPET_OPENROUTER_API_KEY: "" })).toEqual({ reason: "authentication" });
    } finally {
      await store.close();
    }
  });

  test("keeps provider keys separate across replacement and logout with protected permissions", async () => {
    const store = await harness();

    try {
      expect(await store.run((keys) => keys.read("openrouter"))).toBeNull();
      expect(await readdir(store.directory)).toEqual([]);
      await store.run((keys) => keys.write("openrouter", Redacted.make("router-key")));
      await store.run((keys) => keys.write("opencode-go", Redacted.make("go-key")));
      await store.run((keys) => keys.write("openrouter", Redacted.make("replacement-key")));
      const saved = await store.run((keys) => keys.read("openrouter"));
      expect(saved && Redacted.value(saved)).toBe("replacement-key");
      expect(JSON.stringify(saved)).not.toContain("replacement-key");
      expect((await stat(join(store.directory, "auth"))).mode & 0o777).toBe(0o700);
      expect((await stat(join(store.directory, "auth/openrouter.json"))).mode & 0o777).toBe(0o600);
      expect((await readdir(join(store.directory, "auth"))).toSorted()).toEqual([
        "opencode-go.json",
        "openrouter.json",
      ]);
      await store.run((keys) => keys.remove("openrouter"));
      expect(await store.run((keys) => keys.read("openrouter"))).toBeNull();
      const other = await store.run((keys) => keys.read("opencode-go"));
      expect(other && Redacted.value(other)).toBe("go-key");
    } finally {
      await store.close();
    }
  });

  test.each([
    ["corrupted", "bad-json"],
    ["foreign", JSON.stringify({ version: 1, provider: "opencode-go", key: "foreign-secret" })],
  ])(
    "rejects %s credentials without overwriting them and repairs file permissions",
    async (_label, contents) => {
      const store = await harness();

      try {
        await store.run((keys) => keys.write("openrouter", Redacted.make("router-key")));
        const path = join(store.directory, "auth/openrouter.json");
        await chmod(path, 0o644);
        await store.run((keys) => keys.read("openrouter"));
        expect((await stat(path)).mode & 0o777).toBe(0o600);

        await writeFile(path, contents);
        await expect(store.run((keys) => keys.read("openrouter"))).rejects.toMatchObject({
          reason: "authentication",
        });
        expect(await readFile(path, "utf8")).toBe(contents);
      } finally {
        await store.close();
      }
    },
  );

  test("rejects symlinks and competing writers without touching unrelated data", async () => {
    const store = await harness();

    try {
      await store.run((keys) => keys.write("openrouter", Redacted.make("router-key")));
      const auth = join(store.directory, "auth");
      const target = join(store.directory, "unrelated");
      await writeFile(target, "leave this alone", { mode: 0o644 });
      await rm(join(auth, "openrouter.json"));
      await symlink(target, join(auth, "openrouter.json"));
      await expect(store.run((keys) => keys.read("openrouter"))).rejects.toMatchObject({
        reason: "authentication",
      });
      expect(await readFile(target, "utf8")).toBe("leave this alone");
      expect((await stat(target)).mode & 0o777).toBe(0o644);
      await writeFile(join(auth, "openrouter.lock"), "another owner");
      await expect(
        store.run((keys) => keys.write("openrouter", Redacted.make("replacement-key"))),
      ).rejects.toMatchObject({ reason: "authentication" });
      expect(await readFile(join(auth, "openrouter.lock"), "utf8")).toBe("another owner");
      await rm(auth, { recursive: true });
      await symlink(target, auth);
      await expect(store.run((keys) => keys.read("openrouter"))).rejects.toMatchObject({
        reason: "authentication",
      });
    } finally {
      await store.close();
    }
  });
});
