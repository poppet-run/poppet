import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

import {
  CredentialInput,
  ProviderEnvironment,
  ProviderId,
  ProviderError,
  verifyModel,
  invalidRequest,
  type ConnectionOperations,
  type ProviderOperations,
} from "@poppet/provider";
import { Config, ConfigProvider, Context, Effect, Layer, Option, Redacted, Schema } from "effect";

import { acquireOwnerLock } from "#src/lock";

/** A nonempty key without whitespace, redacted in diagnostic output. */
export const ApiKey = Schema.RedactedFromValue(
  Schema.NonEmptyString.check(Schema.isPattern(/^\S{1,8192}$/)),
);

interface StoreOperations {
  /** Reads only this provider's saved key; null means none exists. */
  readonly read: (
    provider: ProviderId,
  ) => Effect.Effect<Redacted.Redacted<string> | null, ProviderError>;
  /** Atomically replaces this provider's saved key under its owner lock. */
  readonly write: (
    provider: ProviderId,
    key: Redacted.Redacted<string>,
  ) => Effect.Effect<void, ProviderError>;
  /** Removes the saved key if present; environment keys and remote credentials are unaffected. */
  readonly remove: (provider: ProviderId) => Effect.Effect<void, ProviderError>;
}

/** Protected API-key files kept separately for each provider. */
export class ApiKeyStore extends Context.Service<ApiKeyStore, StoreOperations>()(
  "poppet/ApiKeyStore",
) {}

const MissingFile = Schema.Struct({ code: Schema.Literal("ENOENT") });

const SavedKey = Schema.fromJsonString(
  Schema.Struct({ version: Schema.Literal(1), provider: ProviderId, key: ApiKey }),
);

const storageError = (provider: ProviderId) =>
  new ProviderError({
    provider,
    reason: "authentication",
    message: `Cannot read or write Poppet's protected ${provider} credentials.`,
  });

export const environmentApiKey = (provider: ProviderId, environment: string) =>
  Config.schema(ApiKey, environment).pipe(
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
          message: `${environment} must contain a nonempty API key without whitespace.`,
        }),
    ),
  );

export const ApiKeyStoreLive = Layer.effect(
  ApiKeyStore,
  Effect.gen(function* () {
    const config = yield* ProviderEnvironment;
    const directory = join(config.dataDirectory, "auth");
    const path = (provider: ProviderId) => join(directory, `${provider}.json`);

    const prepare = (provider: ProviderId, create: boolean) =>
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

    const locked = (provider: ProviderId, operation: Effect.Effect<void, ProviderError>) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* prepare(provider, true);
          const lock = join(directory, `${provider}.lock`);
          yield* acquireOwnerLock(lock).pipe(Effect.mapError(() => storageError(provider)));
          yield* operation;
        }),
      );

    const read = (provider: ProviderId) =>
      Effect.gen(function* () {
        yield* Schema.decodeUnknownEffect(ProviderId)(provider).pipe(
          Effect.mapError(() => storageError(provider)),
        );

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

    const write = (provider: ProviderId, key: Redacted.Redacted<string>) =>
      Schema.decodeUnknownEffect(ProviderId)(provider)
        .pipe(
          Effect.mapError(() => storageError(provider)),
          Effect.flatMap(() =>
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
            ),
          ),
        )
        .pipe(Effect.uninterruptible);

    const remove = (provider: ProviderId) =>
      Schema.decodeUnknownEffect(ProviderId)(provider)
        .pipe(
          Effect.mapError(() => storageError(provider)),
          Effect.flatMap(() =>
            locked(
              provider,
              Effect.tryPromise({
                try: () =>
                  unlink(path(provider)).catch((cause: unknown) => {
                    if (!Schema.is(MissingFile)(cause)) throw cause;
                  }),
                catch: () => storageError(provider),
              }),
            ),
          ),
        )
        .pipe(Effect.uninterruptible);

    return { read, write, remove } satisfies StoreOperations;
  }),
);

/** Prefers the environment key, then protected storage; a present but invalid key is an error. */
export const loadApiKey = (provider: ProviderId, environment: string) =>
  Effect.gen(function* () {
    const configured = yield* environmentApiKey(provider, environment);

    if (Option.isSome(configured)) return configured.value;

    const saved = yield* Effect.gen(function* () {
      const store = yield* ApiKeyStore;

      return yield* store.read(provider);
    }).pipe(
      Effect.provide(ApiKeyStoreLive),
      Effect.mapError((error) => (error instanceof ProviderError ? error : storageError(provider))),
    );

    if (saved !== null) return saved;

    return yield* Effect.fail(
      new ProviderError({
        provider,
        reason: "authentication",
        message: `Run auth login ${provider} or set ${environment}.`,
      }),
    );
  });

// Reusable API-key behavior receives all provider-specific settings from its owner.
export const makeApiKeyConnection = (provider: ProviderOperations, environment: string) =>
  Effect.gen(function* () {
    const store = yield* ApiKeyStore;
    const id = provider.id;

    return {
      login: (options) =>
        Effect.gen(function* () {
          const input = yield* CredentialInput;

          const key = options.keyStdin
            ? yield* input.readKey(id, true)
            : yield* environmentApiKey(id, environment).pipe(
                Effect.flatMap(
                  Option.match({ onSome: Effect.succeed, onNone: () => input.readKey(id, false) }),
                ),
              );

          yield* store.write(id, key);

          return `API key saved for ${id}. Run auth verify <model> --provider ${id} to check access.`;
        }),
      status: Effect.gen(function* () {
        const key = yield* environmentApiKey(id, environment);
        const saved = Option.isSome(key) ? null : yield* store.read(id);

        return {
          provider: id,
          connected: Option.isSome(key) || saved !== null,
          source: Option.isSome(key) ? "environment" : saved !== null ? "stored" : null,
        };
      }),
      logout: store
        .remove(id)
        .pipe(
          Effect.as(
            `Saved ${id} API key removed. An environment API key, if set, still overrides local storage. Remote keys are not revoked.`,
          ),
        ),
      verify: (modelId) =>
        Effect.gen(function* () {
          if (modelId === null)
            return yield* Effect.fail(
              invalidRequest(
                id,
                "Choose a model with auth verify <model>, config.json, or POPPET_MODEL.",
              ),
            );
          const model = yield* provider.resolve(modelId);

          if (model.description.provider !== id || model.description.id !== modelId)
            return yield* Effect.fail(
              invalidRequest(
                id,
                "The provider resolved a different model. No fallback is allowed.",
              ),
            );
          yield* verifyModel(model);

          return model.description.id;
        }),
    } satisfies ConnectionOperations;
  });
