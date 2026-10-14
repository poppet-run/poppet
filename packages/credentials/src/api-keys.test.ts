import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ProviderEnvironment } from "@poppet/provider";
import { Effect, Layer, Redacted } from "effect";

import { ApiKeyStore, ApiKeyStoreLive } from "#src/api-keys";

const harness = async () => {
  const directory = await mkdtemp(join(tmpdir(), "poppet-api-keys-"));

  const runtime = ApiKeyStoreLive.pipe(
    Layer.provide(
      Layer.succeed(ProviderEnvironment, {
        applicationName: "Test",
        dataDirectory: directory,
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
      await store.run((keys) => keys.write("test-provider", Redacted.make("router-key")));

      const program = `
        import { loadApiKey } from './src/api-keys.ts';
        import { Effect, Redacted } from 'effect';
        import { ProviderEnvironment } from '@poppet/provider';
        const result = await Effect.runPromise(loadApiKey('test-provider', 'TEST_PROVIDER_KEY').pipe(Effect.provideService(ProviderEnvironment, {applicationName: 'Test', dataDirectory: process.env.POPPET_DATA_DIR}), Effect.match({
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
      expect(await load({ TEST_PROVIDER_KEY: "environment-key" })).toEqual({
        source: "environment",
      });
      expect(await load({ TEST_PROVIDER_KEY: "" })).toEqual({ reason: "authentication" });
    } finally {
      await store.close();
    }
  });

  test("rejects unsafe provider IDs before creating or touching credential files", async () => {
    const store = await harness();

    try {
      await Promise.all(
        ["../outside", "nested/provider", "", "a".repeat(65)].flatMap((provider) => [
          expect(store.run((keys) => keys.read(provider))).rejects.toMatchObject({
            reason: "authentication",
          }),
          expect(
            store.run((keys) => keys.write(provider, Redacted.make("test-key"))),
          ).rejects.toMatchObject({ reason: "authentication" }),
          expect(store.run((keys) => keys.remove(provider))).rejects.toMatchObject({
            reason: "authentication",
          }),
        ]),
      );
      expect(await readdir(store.directory)).toEqual([]);
    } finally {
      await store.close();
    }
  });

  test("keeps provider keys separate across replacement and logout with protected permissions", async () => {
    const store = await harness();

    try {
      expect(await store.run((keys) => keys.read("test-provider"))).toBeNull();
      expect(await readdir(store.directory)).toEqual([]);
      await store.run((keys) => keys.write("test-provider", Redacted.make("router-key")));
      await store.run((keys) => keys.write("other-provider", Redacted.make("go-key")));
      await store.run((keys) => keys.write("test-provider", Redacted.make("replacement-key")));
      const saved = await store.run((keys) => keys.read("test-provider"));
      expect(saved && Redacted.value(saved)).toBe("replacement-key");
      expect(JSON.stringify(saved)).not.toContain("replacement-key");
      expect((await stat(join(store.directory, "auth"))).mode & 0o777).toBe(0o700);
      expect((await stat(join(store.directory, "auth/test-provider.json"))).mode & 0o777).toBe(
        0o600,
      );
      expect((await readdir(join(store.directory, "auth"))).toSorted()).toEqual([
        "other-provider.json",
        "other-provider.lock.sqlite",
        "test-provider.json",
        "test-provider.lock.sqlite",
      ]);
      await store.run((keys) => keys.remove("test-provider"));
      expect(await store.run((keys) => keys.read("test-provider"))).toBeNull();
      const other = await store.run((keys) => keys.read("other-provider"));
      expect(other && Redacted.value(other)).toBe("go-key");
    } finally {
      await store.close();
    }
  });

  test.each([
    ["corrupted", "bad-json"],
    ["foreign", JSON.stringify({ version: 1, provider: "other-provider", key: "foreign-secret" })],
  ])(
    "rejects %s credentials without overwriting them and repairs file permissions",
    async (_label, contents) => {
      const store = await harness();

      try {
        await store.run((keys) => keys.write("test-provider", Redacted.make("router-key")));
        const path = join(store.directory, "auth/test-provider.json");
        await chmod(path, 0o644);
        await store.run((keys) => keys.read("test-provider"));
        expect((await stat(path)).mode & 0o777).toBe(0o600);

        await writeFile(path, contents);
        await expect(store.run((keys) => keys.read("test-provider"))).rejects.toMatchObject({
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
      await store.run((keys) => keys.write("test-provider", Redacted.make("router-key")));
      const auth = join(store.directory, "auth");
      const target = join(store.directory, "unrelated");
      await writeFile(target, "leave this alone", { mode: 0o644 });
      await rm(join(auth, "test-provider.json"));
      await symlink(target, join(auth, "test-provider.json"));
      await expect(store.run((keys) => keys.read("test-provider"))).rejects.toMatchObject({
        reason: "authentication",
      });
      expect(await readFile(target, "utf8")).toBe("leave this alone");
      expect((await stat(target)).mode & 0o777).toBe(0o644);
      await writeFile(join(auth, "test-provider.lock"), "another owner");
      await expect(
        store.run((keys) => keys.write("test-provider", Redacted.make("replacement-key"))),
      ).rejects.toMatchObject({ reason: "authentication" });
      expect(await readFile(join(auth, "test-provider.lock"), "utf8")).toBe("another owner");
      await rm(auth, { recursive: true });
      await symlink(target, auth);
      await expect(store.run((keys) => keys.read("test-provider"))).rejects.toMatchObject({
        reason: "authentication",
      });
    } finally {
      await store.close();
    }
  });
});
