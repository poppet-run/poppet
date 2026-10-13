import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

import { AppConfig, AppConfigLive } from "@poppet/config";
import { ProviderError } from "@poppet/provider";
import { Config, ConfigProvider, Context, Effect, Layer, Option, Redacted, Schema } from "effect";

export const ApiKeyProvider = Schema.Literals(["opencode-go", "openrouter"]);

export type ApiKeyProvider = typeof ApiKeyProvider.Type;

export const ApiKey = Schema.RedactedFromValue(
  Schema.NonEmptyString.check(Schema.isPattern(/^\S{1,8192}$/)),
);

interface StoreOperations {
  readonly read: (
    provider: ApiKeyProvider,
  ) => Effect.Effect<Redacted.Redacted<string> | null, ProviderError>;
  readonly write: (
    provider: ApiKeyProvider,
    key: Redacted.Redacted<string>,
  ) => Effect.Effect<void, ProviderError>;
  readonly remove: (provider: ApiKeyProvider) => Effect.Effect<void, ProviderError>;
}

export class ApiKeyStore extends Context.Service<ApiKeyStore, StoreOperations>()(
  "poppet/ApiKeyStore",
) {}

const MissingFile = Schema.Struct({ code: Schema.Literal("ENOENT") });

const SavedKey = Schema.fromJsonString(
  Schema.Struct({ version: Schema.Literal(1), provider: ApiKeyProvider, key: ApiKey }),
);

const storageError = (provider: ApiKeyProvider) =>
  new ProviderError({
    provider,
    reason: "authentication",
    message: `Cannot read or write Poppet's protected ${provider} credentials.`,
  });

export const apiKeyEnvironment = (provider: ApiKeyProvider) =>
  provider === "openrouter" ? "POPPET_OPENROUTER_API_KEY" : "POPPET_OPENCODE_GO_API_KEY";

export const environmentApiKey = (provider: ApiKeyProvider) =>
  Config.schema(ApiKey, apiKeyEnvironment(provider)).pipe(
    Config.option,
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromEnv({ preserveEmptyStrings: true }),
    ),
    Effect.mapError(
      () =>
        new ProviderError({
          provider,
          reason: "authentication",
          message: `${apiKeyEnvironment(provider)} must contain a nonempty API key without whitespace.`,
        }),
    ),
  );

export const ApiKeyStoreLive = Layer.effect(
  ApiKeyStore,
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const directory = join(config.dataDirectory, "auth");
    const path = (provider: ApiKeyProvider) => join(directory, `${provider}.json`);

    const prepare = (provider: ApiKeyProvider, create: boolean) =>
      Effect.tryPromise({
        try: async () => {
          if (create) await mkdir(directory, { recursive: true, mode: 0o700 });

          const info = await lstat(directory).catch((cause: unknown) => {
            if (Schema.is(MissingFile)(cause)) return null;
            throw cause;
          });

          if (info === null) return false;

          if (!info.isDirectory() || info.isSymbolicLink())
            throw new Error("Invalid authentication directory");
          await chmod(directory, 0o700);

          return true;
        },
        catch: () => storageError(provider),
      });

    const locked = (provider: ApiKeyProvider, operation: Effect.Effect<void, ProviderError>) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* prepare(provider, true);
          const lock = join(directory, `${provider}.lock`);
          yield* Effect.acquireRelease(
            Effect.tryPromise({
              try: () => open(lock, "wx", 0o600),
              catch: () =>
                new ProviderError({
                  provider,
                  reason: "authentication",
                  message: `Another ${provider} auth command may be active. If no command is running, remove ${lock} and retry.`,
                }),
            }),
            (handle) =>
              Effect.promise(async () => {
                await handle.close();
                await unlink(lock);
              }),
          );
          yield* operation;
        }),
      );

    const read = (provider: ApiKeyProvider) =>
      Effect.gen(function* () {
        if (!(yield* prepare(provider, false))) return null;

        const contents = yield* Effect.tryPromise({
          try: async () => {
            const handle = await open(
              path(provider),
              constants.O_RDONLY | constants.O_NOFOLLOW,
            ).catch((cause: unknown) => {
              if (Schema.is(MissingFile)(cause)) return null;
              throw cause;
            });

            if (handle === null) return null;

            try {
              if (!(await handle.stat()).isFile()) throw new Error("Invalid credential file");
              await handle.chmod(0o600);

              return await handle.readFile("utf8");
            } finally {
              await handle.close();
            }
          },
          catch: () => storageError(provider),
        });

        if (contents === null) return null;

        const saved = yield* Schema.decodeUnknownEffect(SavedKey, { onExcessProperty: "error" })(
          contents,
        ).pipe(Effect.mapError(() => storageError(provider)));

        if (saved.provider !== provider) return yield* Effect.fail(storageError(provider));

        return saved.key;
      });

    const write = (provider: ApiKeyProvider, key: Redacted.Redacted<string>) =>
      locked(
        provider,
        Effect.tryPromise({
          try: async () => {
            const contents = Schema.encodeSync(SavedKey)({ version: 1, provider, key });
            const temporary = join(directory, `.${provider}-${randomUUID()}.tmp`);
            const handle = await open(temporary, "wx", 0o600);

            try {
              await handle.writeFile(contents, "utf8");
              await handle.sync();
              await handle.close();
              await rename(temporary, path(provider));
            } catch (cause) {
              await handle.close().catch(() => undefined);
              await unlink(temporary).catch(() => undefined);
              throw cause;
            }
          },
          catch: () => storageError(provider),
        }),
      ).pipe(Effect.uninterruptible);

    const remove = (provider: ApiKeyProvider) =>
      locked(
        provider,
        Effect.tryPromise({
          try: () =>
            unlink(path(provider)).catch((cause: unknown) => {
              if (!Schema.is(MissingFile)(cause)) throw cause;
            }),
          catch: () => storageError(provider),
        }),
      ).pipe(Effect.uninterruptible);

    return { read, write, remove } satisfies StoreOperations;
  }),
);

export const loadApiKey = (provider: ApiKeyProvider) =>
  Effect.gen(function* () {
    const environment = yield* environmentApiKey(provider);

    if (Option.isSome(environment)) return environment.value;

    const saved = yield* Effect.gen(function* () {
      const store = yield* ApiKeyStore;

      return yield* store.read(provider);
    }).pipe(
      Effect.provide(ApiKeyStoreLive.pipe(Layer.provide(AppConfigLive))),
      Effect.mapError((error) => (error instanceof ProviderError ? error : storageError(provider))),
    );

    if (saved !== null) return saved;

    return yield* Effect.fail(
      new ProviderError({
        provider,
        reason: "authentication",
        message: `Run auth login ${provider} or set ${apiKeyEnvironment(provider)}.`,
      }),
    );
  });
