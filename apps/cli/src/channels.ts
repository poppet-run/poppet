import type { ChatFailure } from "@poppet/agent";
import {
  DiscordSettings,
  loadDiscordSettings,
  saveDiscordSettings,
} from "@poppet/channel-discord/settings";
import { AppConfig } from "@poppet/config";
import {
  ChannelError,
  Gateway,
  GatewayLive,
  GatewayRepository,
  GatewayRepositoryLive,
} from "@poppet/gateway";
import { StoreError } from "@poppet/store";
import { Console, Context, Effect, Layer, Result, Schema } from "effect";

// The host registers channels here; the runner and scheduler never import their adapters.
export class MessagingWorker extends Context.Service<
  MessagingWorker,
  {
    readonly run: Effect.Effect<void, ChatFailure | ChannelError>;
    readonly status: Effect.Effect<Schema.JsonObject, StoreError | ChannelError>;
  }
>()("poppet/MessagingWorker") {}

export const MessagingWorkerLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const loaded = yield* loadDiscordSettings(config.dataDirectory).pipe(Effect.result);

    if (Result.isFailure(loaded))
      return Layer.succeed(MessagingWorker, {
        run: Effect.never,
        status: Effect.succeed({
          enabled: false,
          error: "Invalid Discord settings. Run gateway discord setup again.",
        }),
      });
    const settings = loaded.success;

    if (settings === null)
      return Layer.succeed(MessagingWorker, {
        run: Effect.never,
        status: Effect.succeed({ enabled: false }),
      });
    const { discordChannelLayer } = yield* Effect.promise(() => import("@poppet/channel-discord"));

    return Layer.effect(
      MessagingWorker,
      Effect.gen(function* () {
        const gateway = yield* Gateway;

        return {
          run: gateway.run,
          status: gateway.status.pipe(Effect.map((status) => ({ enabled: true, ...status }))),
        };
      }),
    ).pipe(
      Layer.provide(
        GatewayLive.pipe(
          Layer.provide(Layer.merge(discordChannelLayer(settings), GatewayRepositoryLive)),
        ),
      ),
    );
  }),
);

export const stoppedMessagingStatus = Effect.gen(function* () {
  const config = yield* AppConfig;
  const settings = yield* loadDiscordSettings(config.dataDirectory);
  const repo = yield* GatewayRepository;

  const counts = yield* Effect.try({
    try: () => repo.status(),
    catch: () => new StoreError({ reason: "storage", message: "Cannot read messaging status." }),
  });

  return { running: false, enabled: settings !== null, ...counts };
});

export const setupDiscord = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (args.length < 6 || args[0] !== "setup" || args.at(-1) !== "--key-stdin")
      return yield* Effect.fail(
        new ChannelError({
          reason: "configuration",
          message:
            "Use gateway discord setup <bot-id> <owner-id> <guild-id> <channel-id>... --key-stdin.",
        }),
      );
    const config = yield* AppConfig;

    const input = yield* Effect.tryPromise({
      try: async () => {
        let value = "";

        for await (const part of Bun.stdin.stream()) {
          value += new TextDecoder().decode(part);

          if (value.length > 8194) throw new Error("Token too long");
        }

        return value;
      },
      catch: () =>
        new ChannelError({
          reason: "configuration",
          message: "Cannot read the Discord token from stdin, or it exceeds 8192 characters.",
        }),
    });

    const settings = yield* Schema.decodeUnknownEffect(DiscordSettings)({
      version: 1,
      botId: args[1],
      ownerId: args[2],
      guildId: args[3],
      channelIds: args.slice(4, -1),
      token: input.replace(/\r?\n$/, ""),
    }).pipe(
      Effect.mapError(
        () =>
          new ChannelError({
            reason: "configuration",
            message: "Use numeric Discord IDs and a nonempty bot token without whitespace.",
          }),
      ),
    );

    yield* saveDiscordSettings(config.dataDirectory, settings);
    yield* Console.log(
      "Discord settings saved. Restart the worker to apply them. Only the configured owner can invoke Poppet; channel members can read its replies.",
    );
  });
