import type { ChatFailure } from "@poppet/agent";
import { AppConfig } from "@poppet/config";
import {
  ChannelEnvironment,
  ChannelError,
  ChannelInput,
  type ChannelRegistration,
  Gateway,
  GatewayLive,
  GatewayRepository,
  GatewayRepositoryLive,
} from "@poppet/gateway";
import { DeliveryDestination, StoreError, reportAs } from "@poppet/store";
import {
  Cause,
  Clock,
  Console,
  Context,
  Effect,
  Layer,
  Option,
  Redacted,
  Result,
  Schema,
} from "effect";

/** Runs configured messaging gateways and combines their connection and delivery status. */
export class MessagingWorker extends Context.Service<
  MessagingWorker,
  {
    readonly resolveDestination: (
      adapter: string,
      conversationId: string | null,
    ) => Effect.Effect<DeliveryDestination, ChannelError>;
    readonly run: Effect.Effect<void, ChatFailure | ChannelError>;
    readonly status: Effect.Effect<Schema.JsonObject, StoreError | ChannelError>;
  }
>()("poppet/MessagingWorker") {}

export const validateChannels = (registered: ReadonlyArray<ChannelRegistration>) => {
  const ids = new Set<string>();

  for (const entry of registered) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(entry.id))
      throw new Error(`Invalid channel ID: ${entry.id}`);

    if (ids.has(entry.id)) throw new Error(`Duplicate channel registration: ${entry.id}`);
    ids.add(entry.id);
  }
};

const loadChannels = (registered: ReadonlyArray<ChannelRegistration>) =>
  AppConfig.use(({ dataDirectory }) =>
    Effect.forEach(registered, (entry) =>
      entry.load.pipe(
        Effect.provideService(ChannelEnvironment, { dataDirectory }),
        Effect.result,
        Effect.map((loaded) => ({ entry, loaded })),
      ),
    ),
  );

const counts = (repo: GatewayRepository["Service"]) =>
  repo
    .status()
    .pipe(
      reportAs(
        () => new StoreError({ reason: "storage", message: "Cannot read messaging status." }),
      ),
    );

/** Restart counts and the latest failure an adapter recovered from, for status output. */
export interface AdapterHealth {
  restarts: number;
  lastError: string | null;
}

const maxRestartDelay = 300_000;

// An adapter that ran this long is considered healthy again, so its backoff starts over.
const healthyAfter = 600_000;

/**
 * Restarts one adapter after failures with exponential backoff, so it cannot stop other
 * adapters or the scheduler. Interruption and storage failures still stop the worker.
 */
export const superviseAdapter = <E>(
  id: string,
  run: Effect.Effect<void, E>,
  health: AdapterHealth,
) => {
  const attempt = (failures: number): Effect.Effect<void, E> =>
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis;

      return yield* run.pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const error = Option.getOrNull(Cause.findErrorOption(cause));

            if (Cause.hasInterrupts(cause) || error instanceof StoreError)
              return yield* Effect.failCause(cause);
            const ranFor = (yield* Clock.currentTimeMillis) - startedAt;
            const attempts = ranFor >= healthyAfter ? 0 : failures;
            const delay = Math.min(1000 * 2 ** attempts, maxRestartDelay);

            health.restarts++;
            health.lastError =
              error instanceof Error ? error.message : "The adapter stopped unexpectedly.";

            if (error === null) yield* Console.error(Cause.pretty(cause));
            yield* Console.error(
              `Messaging adapter ${id} stopped: ${health.lastError} Restarting in ${delay / 1000} seconds.`,
            );
            yield* Effect.sleep(delay);

            return yield* attempt(attempts + 1);
          }),
        ),
      );
    });

  return attempt(0);
};

const disabledWorker = (entry: ChannelRegistration, error?: string) => {
  const status = { id: entry.id, name: entry.name, enabled: false };

  return {
    resolveDestination: null,
    run: Effect.never,
    status: Effect.succeed(error === undefined ? status : { ...status, error }),
  };
};

export const MessagingWorkerLive = (registered: ReadonlyArray<ChannelRegistration>) =>
  Layer.effect(
    MessagingWorker,
    Effect.gen(function* () {
      const configured = yield* loadChannels(registered);
      const repo = yield* GatewayRepository;

      const workers = yield* Effect.forEach(configured, ({ entry, loaded }) =>
        Effect.gen(function* () {
          if (Result.isFailure(loaded)) return disabledWorker(entry, loaded.failure.message);

          if (loaded.success === null) return disabledWorker(entry);

          // Each adapter needs its own gateway; the agent and store remain shared.
          const context = yield* Layer.build(
            GatewayLive.pipe(Layer.provide(loaded.success), Layer.fresh),
          ).pipe(Effect.result);

          if (Result.isFailure(context)) return disabledWorker(entry, context.failure.message);

          const gateway = Context.get(context.success, Gateway);
          const health: AdapterHealth = { restarts: 0, lastError: null };

          return {
            resolveDestination: gateway.resolveDestination,
            run: superviseAdapter(entry.id, gateway.run, health),
            status: gateway.connectionStatus.pipe(
              Effect.map((status) => ({
                ...status,
                id: entry.id,
                name: entry.name,
                enabled: true,
                restarts: health.restarts,
                lastError: health.lastError,
              })),
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
                new ChannelError({
                  reason: "configuration",
                  message:
                    "Configure and enable the messaging adapter before selecting a destination.",
                }),
              );
        },
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
            ...(yield* counts(repo)),
          };
        }),
      };
    }),
  ).pipe(Layer.provide(GatewayRepositoryLive));

export const stoppedMessagingStatus = (registered: ReadonlyArray<ChannelRegistration>) =>
  Effect.gen(function* () {
    const configured = yield* loadChannels(registered);
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
      ...(yield* counts(repo)),
    };
  });

const readSecret = Effect.tryPromise({
  try: async () => {
    let value = "";

    for await (const part of Bun.stdin.stream()) {
      value += new TextDecoder().decode(part);

      if (value.length > 8194) throw new Error("Secret too long");
    }

    return Redacted.make(value.replace(/\r?\n$/, ""));
  },
  catch: () =>
    new ChannelError({
      reason: "configuration",
      message: "Cannot read a channel secret from stdin, or it exceeds 8192 characters.",
    }),
});

export const setupChannel = (
  registered: ReadonlyArray<ChannelRegistration>,
  args: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const entry = registered.find((candidate) => candidate.id === args[0]);

    if (entry === undefined)
      return yield* Effect.fail(
        new ChannelError({
          reason: "configuration",
          message: `Choose a registered channel: ${registered.map((candidate) => candidate.id).join(", ")}.`,
        }),
      );
    const config = yield* AppConfig;

    const message = yield* entry
      .setup(args.slice(1))
      .pipe(
        Effect.provideService(ChannelEnvironment, { dataDirectory: config.dataDirectory }),
        Effect.provideService(ChannelInput, { readSecret }),
      );

    yield* Console.log(message);
  });
