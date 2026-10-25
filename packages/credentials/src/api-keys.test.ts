import {
  chmod,
  link,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CredentialInput,
  Provider,
  ProviderConnection,
  ProviderEnvironment,
} from "@poppet/provider";
import { ConfigProvider, Effect, Layer, Redacted } from "effect";
import { describe, expect, test } from "vitest";

import { ApiKeyStore, ApiKeyStoreLive, apiKeyProvider, loadApiKey } from "#src/api-keys";
import { acquireOwnerLock } from "#src/lock";

import { makeFIFO } from "../../../tools/testing/fifo";

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

describe("ApiKeyStore", () => {
  test("when loading inference keys, prefers environment keys over saved keys and rejects empty overrides", async () => {
    const store = await harness();

    try {
      await store.run((keys) => keys.write("test-provider", Redacted.make("router-key")));

      const load = (environment: Record<string, string> = {}) =>
        Effect.runPromise(
          loadApiKey("test-provider", "TEST_PROVIDER_KEY").pipe(
            Effect.provideService(ProviderEnvironment, {
              applicationName: "Test",
              dataDirectory: store.directory,
            }),
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              ConfigProvider.fromEnv({ env: environment, preserveEmptyStrings: true }),
            ),
          ),
        );

      expect(Redacted.value(await load())).toBe("router-key");
      expect(Redacted.value(await load({ TEST_PROVIDER_KEY: "environment-key" }))).toBe(
        "environment-key",
      );
      await expect(load({ TEST_PROVIDER_KEY: "" })).rejects.toMatchObject({
        reason: "authentication",
      });
    } finally {
      await store.close();
    }
  });

  test("when provider IDs are unsafe, rejects them before touching credential files", async () => {
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

  test("when provider keys are replaced or removed, keeps other providers separate and files private", async () => {
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
    "when credentials are %s, rejects them without overwriting and repairs file permissions",
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

  test("when credential paths are symlinked or another writer owns them, rejects access without touching unrelated data", async () => {
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
      // A competing writer holds the exclusive lock for the whole write.
      await Effect.runPromise(
        Effect.scoped(
          acquireOwnerLock(join(auth, "test-provider.lock")).pipe(
            Effect.andThen(
              Effect.promise(async () => {
                await expect(
                  store.run((keys) =>
                    keys.write("test-provider", Redacted.make("replacement-key")),
                  ),
                ).rejects.toMatchObject({ reason: "authentication" });
              }),
            ),
          ),
        ),
      );
      expect(await readFile(target, "utf8")).toBe("leave this alone");
      await rm(auth, { recursive: true });
      await symlink(target, auth);
      await expect(store.run((keys) => keys.read("test-provider"))).rejects.toMatchObject({
        reason: "authentication",
      });
    } finally {
      await store.close();
    }
  });

  test.each(["hardlink", "fifo"])(
    "when credentials are stored in a %s, rejects access before changing permissions",
    async (kind) => {
      const store = await harness();

      try {
        await store.run((keys) => keys.write("test-provider", Redacted.make("router-key")));
        const path = join(store.directory, "auth/test-provider.json");
        const target = join(store.directory, "unrelated");
        await writeFile(target, "leave this alone", { mode: 0o644 });
        await rm(path);

        if (kind === "hardlink") await link(target, path);
        else makeFIFO(path);

        await expect(store.run((keys) => keys.read("test-provider"))).rejects.toMatchObject({
          reason: "authentication",
        });
        expect(await readFile(target, "utf8")).toBe("leave this alone");
        expect((await stat(target)).mode & 0o777).toBe(0o644);
      } finally {
        await store.close();
      }
    },
  );
});

describe("apiKeyProvider", () => {
  test("when login saves a key and logout follows, enables then removes inference access", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-api-key-provider-"));
    const keys: string[] = [];

    const { registration } = apiKeyProvider({
      id: "test-provider",
      name: "Test provider",
      environment: "TEST_PROVIDER_KEY",
      make: (key) => ({
        id: "test-provider",
        models: key.pipe(
          Effect.tap((value) => Effect.sync(() => keys.push(Redacted.value(value)))),
          Effect.as([]),
        ),
        resolve: () => Effect.die("No model resolution expected"),
      }),
    });

    try {
      const [provider, connection] = await Effect.runPromise(
        Effect.all([Provider, ProviderConnection]).pipe(
          Effect.provide(registration.layer),
          Effect.provideService(ProviderEnvironment, {
            applicationName: "Test",
            dataDirectory: directory,
          }),
        ),
      );

      expect(await Effect.runPromise(connection.status)).toMatchObject({ connected: false });
      await Effect.runPromise(
        connection.login({ keyStdin: true }).pipe(
          Effect.provideService(CredentialInput, {
            readKey: () => Effect.succeed(Redacted.make("saved-key")),
          }),
        ),
      );
      expect(await Effect.runPromise(connection.status)).toMatchObject({
        connected: true,
        source: "stored",
      });
      await Effect.runPromise(provider.models);
      expect(keys).toContain("saved-key");
      await Effect.runPromise(connection.logout);
      expect(await Effect.runPromise(connection.status)).toMatchObject({ connected: false });
      await expect(Effect.runPromise(provider.models)).rejects.toMatchObject({
        reason: "authentication",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
