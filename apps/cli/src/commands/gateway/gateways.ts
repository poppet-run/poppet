import type { ChatFailure } from "@poppet/agent";
import { AppConfig } from "@poppet/config";
import {
  Gateway,
  GatewayEnvironment,
  GatewayError,
  GatewayInput,
  GatewayLive,
  GatewayRepository,
  GatewayRepositoryLive,
} from "@poppet/gateway";
import type { GatewayRegistration } from "@poppet/gateway";
import { timeoutSeconds } from "@poppet/io";
import type { DeliveryDestination } from "@poppet/store";
import { StoreError } from "@poppet/store";
import type { Schema } from "effect";
import { Cause, Clock, Console, Context, Effect, Layer, Option, Redacted, Result } from "effect";

export class MessagingWorker extends Context.Service<
  MessagingWorker,
  {
    readonly resolveDestination: (
      adapter: string,
      conversationId: string | null,
    ) => Effect.Effect<DeliveryDestination, GatewayError>;
    readonly homeDestination: Effect.Effect<DeliveryDestination | null, GatewayError>;
    readonly run: Effect.Effect<void, ChatFailure | GatewayError>;
    readonly status: Effect.Effect<Schema.JsonObject, StoreError | GatewayError>;
  }
>()("poppet/MessagingWorker") {}

export const validateGateways = (registered: ReadonlyArray<GatewayRegistration>) => {
  const ids = new Set<string>();

  for (const entry of registered) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(entry.id)) {
      throw new Error(`Invalid gateway ID: ${entry.id}`);
    }

    if (ids.has(entry.id)) {
      throw new Error(`Duplicate gateway registration: ${entry.id}`);
    }

    ids.add(entry.id);
  }
};

const loadGateways = (registered: ReadonlyArray<GatewayRegistration>) =>
  AppConfig.use(({ dataDirectory }) =>
    Effect.forEach(registered, (entry) =>
      entry.load.pipe(
        Effect.provideService(GatewayEnvironment, { dataDirectory }),
        Effect.result,
        Effect.map((loaded) => ({ entry, loaded })),
      ),
    ),
  );

export interface AdapterHealth {
  restarts: number;
  lastError: string | null;
}

const healthyAfter = 600_000;

export const superviseAdapter = <E>(
  id: string,
  run: Effect.Effect<void, E>,
  health: AdapterHealth,
) => {
  const attempt = (failures: number): Effect.Effect<void, E> =>
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis;

      const restart = (message: string, cause?: Cause.Cause<E>) =>
        Effect.gen(function* () {
          const ranFor = (yield* Clock.currentTimeMillis) - startedAt;
          const attempts = ranFor >= healthyAfter ? 0 : failures;
          const maxDelay = (yield* timeoutSeconds("gatewayRestartMaxSeconds")) * 1000;
          const delay = Math.min(1000 * 2 ** attempts, maxDelay);

          health.restarts++;
          health.lastError = message;

          yield* Effect.logError(
            "messaging adapter stopped",
            ...(cause === undefined ? [] : [cause]),
          ).pipe(
            Effect.annotateLogs({
              adapter: id,
              error: health.lastError,
              restart_in_ms: delay,
            }),
          );
          yield* Effect.sleep(delay);

          return yield* attempt(attempts + 1);
        });

      return yield* run.pipe(
        Effect.matchCauseEffect({
          onSuccess: () => restart("The adapter stopped unexpectedly."),
          onFailure: (cause) => {
            const error = Option.getOrNull(Cause.findErrorOption(cause));

            if (Cause.hasInterrupts(cause) || error instanceof StoreError) {
              return Effect.failCause(cause);
            }

            return restart(
              error instanceof Error ? error.message : "The adapter stopped unexpectedly.",
              error === null ? cause : undefined,
            );
          },
        }),
      );
    });

  return attempt(0);
};

const disabledWorker = (entry: GatewayRegistration, error?: string) => {
  const status = { id: entry.id, name: entry.name, enabled: false };

  return {
    resolveDestination: null,
    run: Effect.never,
    status: Effect.succeed(error === undefined ? status : { ...status, error }),
  };
};

export const MessagingWorkerLive = (registered: ReadonlyArray<GatewayRegistration>) =>
  Layer.effect(
    MessagingWorker,
    Effect.gen(function* () {
      const configured = yield* loadGateways(registered);
      const repo = yield* GatewayRepository;

      const workers = yield* Effect.forEach(configured, ({ entry, loaded }) =>
        Effect.gen(function* () {
          if (Result.isFailure(loaded)) {
            return disabledWorker(entry, loaded.failure.message);
          }

          if (loaded.success === null) {
            return disabledWorker(entry);
          }

          const context = yield* Layer.build(
            GatewayLive.pipe(Layer.provide(loaded.success), Layer.fresh),
          ).pipe(Effect.result);

          if (Result.isFailure(context)) {
            return disabledWorker(entry, context.failure.message);
          }

          const gateway = Context.get(context.success, Gateway);
          const health: AdapterHealth = { restarts: 0, lastError: null };

          return {
            resolveDestination: gateway.resolveDestination,
            run: superviseAdapter(entry.id, gateway.run, health),
            status: gateway.connectionStatus.pipe(
              Effect.map((status) =>
                Object.assign({}, status, {
                  id: entry.id,
                  name: entry.name,
                  enabled: true,
                  restarts: health.restarts,
                  lastError: health.lastError,
                }),
              ),
            ),
          };
        }),
      );

      return {
        resolveDestination: (adapter, conversationId) => {
          const index = configured.findIndex(({ entry }) => entry.id === adapter);
          const resolve = workers[index]?.resolveDestination;

          return resolve
            ? resolve(conversationId)
            : Effect.fail(
                new GatewayError({
                  reason: "configuration",
                  message:
                    "Configure and enable the messaging adapter before selecting a destination.",
                }),
              );
        },
        homeDestination: Effect.gen(function* () {
          for (const worker of workers) {
            if (worker.resolveDestination === null) {
              continue;
            }

            const resolved = yield* worker.resolveDestination(null).pipe(Effect.result);

            if (Result.isSuccess(resolved)) {
              return resolved.success;
            }
          }

          return null;
        }),
        run:
          workers.length === 0
            ? Effect.never
            : Effect.forEach(workers, (worker) => worker.run, {
                concurrency: "unbounded",
                discard: true,
              }),
        status: Effect.gen(function* () {
          const channels = yield* Effect.forEach(workers, (worker) => worker.status);

          return {
            enabled: channels.some((channel) => channel.enabled),
            channels,
            ...(yield* repo.status()),
          };
        }),
      };
    }),
  ).pipe(Layer.provide(GatewayRepositoryLive));

export const stoppedMessagingStatus = (registered: ReadonlyArray<GatewayRegistration>) =>
  Effect.gen(function* () {
    const configured = yield* loadGateways(registered);
    const repo = yield* GatewayRepository;

    const channels = configured.map(({ entry, loaded }) =>
      Result.isFailure(loaded)
        ? { id: entry.id, name: entry.name, enabled: false, error: loaded.failure.message }
        : { id: entry.id, name: entry.name, enabled: loaded.success !== null },
    );

    return {
      running: false,
      enabled: channels.some((channel) => channel.enabled),
      channels,
      ...(yield* repo.status()),
    };
  });

const readSecret = Effect.tryPromise({
  try: async () => {
    let value = "";

    for await (const part of Bun.stdin.stream()) {
      value += new TextDecoder().decode(part);

      if (value.length > 8194) {
        throw new Error("Secret too long");
      }
    }

    return Redacted.make(value.replace(/\r?\n$/, ""));
  },
  catch: () =>
    new GatewayError({
      reason: "configuration",
      message: "Cannot read a gateway secret from stdin, or it exceeds 8192 characters.",
    }),
});

export const setupGateway = (
  registered: ReadonlyArray<GatewayRegistration>,
  args: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const entry = registered.find((candidate) => candidate.id === args[0]);

    if (entry === undefined) {
      return yield* Effect.fail(
        new GatewayError({
          reason: "configuration",
          message: `Choose a registered gateway: ${registered.map((candidate) => candidate.id).join(", ")}.`,
        }),
      );
    }

    const config = yield* AppConfig;

    const message = yield* entry
      .setup(args.slice(1))
      .pipe(
        Effect.provideService(GatewayEnvironment, { dataDirectory: config.dataDirectory }),
        Effect.provideService(GatewayInput, { readSecret }),
      );

    yield* Console.log(message);
  });
