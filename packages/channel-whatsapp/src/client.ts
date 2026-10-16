import { ChannelError, type IncomingMessage } from "@poppet/gateway";
import {
  makeWASocket,
  DisconnectReason,
  jidNormalizedUser,
  type ConnectionState,
  type UserFacingSocketConfig,
  type WAMessage,
  type WASocket,
} from "baileys";
import { Context, Deferred, Effect, Layer, Option, Queue, Schema } from "effect";

import { openWhatsAppAuth } from "#src/auth";
import type { WhatsAppSettings } from "#src/settings";

export type WhatsAppSocket = Pick<
  WASocket,
  "ev" | "user" | "end" | "sendMessage" | "sendPresenceUpdate"
> & {
  readonly signalRepository: {
    readonly lidMapping: Pick<WASocket["signalRepository"]["lidMapping"], "getPNForLID">;
  };
};

export type SocketFactory = (config: UserFacingSocketConfig) => WhatsAppSocket;

export const quietLogger: NonNullable<UserFacingSocketConfig["logger"]> = {
  level: "silent",
  child: () => quietLogger,
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const Disconnect = Schema.Struct({ output: Schema.Struct({ statusCode: Schema.Number }) });

const phoneJid = (phone: string) => `${phone}@s.whatsapp.net`;

/** Owns one scoped socket at a time, with protected SDK state and bounded receive buffering. */
const makeWhatsAppClient = (
  dataDirectory: string,
  settings: WhatsAppSettings,
  createSocket: SocketFactory = makeWASocket,
  onQr?: (qr: string) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const updates = yield* Queue.make<Partial<ConnectionState>>();
    const messages = yield* Queue.make<IncomingMessage>({ capacity: 64, strategy: "dropping" });
    const linked = Deferred.makeUnsafe<void, ChannelError>();

    const auth = yield* openWhatsAppAuth(dataDirectory, () => {
      Queue.offerUnsafe(updates, { connection: "close" });
    });

    let current: WhatsAppSocket | null = null;
    let connected = false;
    // QR pairing saves the linked identity without setting the phone-code registration flag.
    let needsPairing = !auth.state.creds.me?.id;

    let error: string | null = needsPairing
      ? "Run gateway whatsapp pair in an interactive terminal."
      : null;

    let dropped = 0;
    let ignored = 0;

    const unavailable = () =>
      new ChannelError({
        reason: "unavailable",
        message: error ?? "WhatsApp is disconnected; waiting for reconnect.",
      });

    const socket = () => {
      if (!connected || current === null || auth.failed()) throw unavailable();

      if (jidNormalizedUser(current.user?.id ?? "") !== phoneJid(settings.accountPhone))
        throw new ChannelError({
          reason: "configuration",
          message: "The linked WhatsApp account does not match the configured phone number.",
        });

      return current;
    };

    const save = (update: Parameters<typeof auth.saveCreds>[0]) => {
      try {
        auth.saveCreds(update);
      } catch {
        Queue.offerUnsafe(updates, { connection: "close" });
      }
    };

    const connection = (update: Partial<ConnectionState>) => {
      Queue.offerUnsafe(updates, update);
    };

    const run = Effect.gen(function* () {
      let failures = 0;
      let resetInvalidSession = false;

      for (;;) {
        if (auth.failed()) {
          error = "WhatsApp credential storage failed. Stop the worker and inspect local storage.";
          yield* Deferred.fail(linked, unavailable());
          yield* Effect.never;
        }

        if (!auth.state.creds.me?.id && onQr === undefined) {
          needsPairing = true;
          yield* Effect.never;
        }

        let terminal = false;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const inflight = new Set<Promise<void>>();
            let active = true;
            let receive = Promise.resolve();

            const receiving = (event: { messages: WAMessage[] }) => {
              for (const message of event.messages) {
                if (inflight.size >= 64) {
                  dropped++;
                  continue;
                }

                const pending = receive
                  .then(() => normalize(message))
                  .then((input) => {
                    if (!active || input === null) return;

                    if (!Queue.offerUnsafe(messages, input)) dropped++;

                    return undefined;
                  })
                  .catch(() => {
                    ignored++;
                  })
                  .finally(() => {
                    inflight.delete(pending);
                  });

                receive = pending;
                inflight.add(pending);
              }
            };

            const normalize = async (message: WAMessage): Promise<IncomingMessage | null> => {
              const client = current;
              const key = message.key;
              const raw = key.remoteJid;
              const id = key.id;

              if (
                !client ||
                !connected ||
                !raw ||
                !id ||
                id.length > 128 ||
                key.participant ||
                !/@(?:s\.whatsapp\.net|lid)$/.test(raw)
              ) {
                ignored++;

                return null;
              }

              let remote = jidNormalizedUser(raw);

              if (remote.endsWith("@lid"))
                remote = jidNormalizedUser(
                  (await client.signalRepository.lidMapping.getPNForLID(remote)) ?? "",
                );

              if (
                remote !== phoneJid(settings.ownerPhone) ||
                (key.fromMe && settings.accountPhone !== settings.ownerPhone) ||
                auth.isOutgoing(id)
              ) {
                ignored++;

                return null;
              }

              const content = message.message;
              const text = content?.conversation ?? content?.extendedTextMessage?.text;

              if (!text?.trim() || text.length > 8192 || content?.protocolMessage) {
                ignored++;

                return null;
              }

              return {
                messageId: id,
                scopeId: settings.accountPhone,
                parentId: settings.ownerPhone,
                conversationId: settings.ownerPhone,
                senderId: settings.ownerPhone,
                text: text.trim(),
                mentioned: false,
              };
            };

            const client = yield* Effect.acquireRelease(
              Effect.try({
                try: () =>
                  createSocket({
                    auth: auth.state,
                    logger: quietLogger,
                    markOnlineOnConnect: false,
                    syncFullHistory: false,
                    shouldSyncHistoryMessage: () => false,
                    shouldIgnoreJid: (jid) => !/@(?:s\.whatsapp\.net|lid)$/.test(jid),
                    emitOwnEvents: false,
                    maxMsgRetryCount: 0,
                    enableAutoSessionRecreation: false,
                    enableRecentMessageCache: false,
                    getMessage: async () => undefined,
                    connectTimeoutMs: 15000,
                    defaultQueryTimeoutMs: 15000,
                  }),
                catch: () => unavailable(),
              }),
              (owned) =>
                Effect.promise(async () => {
                  active = false;
                  connected = false;
                  owned.ev.off("creds.update", save);
                  owned.ev.off("connection.update", connection);
                  owned.ev.off("messages.upsert", receiving);

                  try {
                    await owned.end(undefined);
                  } finally {
                    await Promise.allSettled(inflight);

                    if (current === owned) current = null;
                  }
                }),
            );

            current = client;
            client.ev.on("creds.update", save);
            client.ev.on("connection.update", connection);
            // shortcut: SDK receipts precede durable acceptance; use a transport with deferred acknowledgements if lossless ingress is required.
            client.ev.on("messages.upsert", receiving);

            for (;;) {
              const update = yield* Queue.take(updates);

              if (auth.failed()) {
                terminal = true;
                error =
                  "WhatsApp credential storage failed. Stop the worker and inspect local storage.";
                break;
              }

              if (update.qr) {
                needsPairing = true;

                if (onQr) yield* onQr(update.qr);
                else {
                  terminal = true;
                  error = "Run gateway whatsapp pair in an interactive terminal.";
                  break;
                }
              }

              if (update.connection === "open") {
                if (jidNormalizedUser(client.user?.id ?? "") !== phoneJid(settings.accountPhone)) {
                  error = "The linked WhatsApp account does not match the configured phone number.";
                  terminal = true;

                  if (onQr) auth.reset();
                  yield* Deferred.fail(
                    linked,
                    new ChannelError({ reason: "configuration", message: error }),
                  );
                  break;
                }

                save({});

                if (auth.failed()) continue;
                connected = true;
                needsPairing = false;
                error = null;
                failures = 0;
                yield* Deferred.succeed(linked, undefined);
              }

              if (update.connection === "close") {
                connected = false;
                const reason = Schema.decodeUnknownOption(Disconnect)(update.lastDisconnect?.error);
                const code = Option.isSome(reason) ? reason.value.output.statusCode : 0;

                const invalidSession = [
                  DisconnectReason.badSession,
                  DisconnectReason.multideviceMismatch,
                ].includes(code);

                if (
                  code === DisconnectReason.loggedOut ||
                  (onQr !== undefined && invalidSession && !resetInvalidSession)
                ) {
                  resetInvalidSession = true;
                  auth.reset();
                  needsPairing = true;
                  error =
                    "WhatsApp was unlinked. Run gateway whatsapp pair in an interactive terminal.";
                  terminal = onQr === undefined;
                } else if (
                  [
                    DisconnectReason.badSession,
                    DisconnectReason.connectionReplaced,
                    DisconnectReason.multideviceMismatch,
                    DisconnectReason.forbidden,
                  ].includes(code)
                ) {
                  terminal = true;
                  error =
                    "WhatsApp requires attention. Stop other clients and relink this device if its session is invalid.";
                } else error = "WhatsApp disconnected; waiting for reconnect.";
                break;
              }
            }
          }),
        );

        if (terminal) {
          yield* Deferred.fail(
            linked,
            new ChannelError({
              reason: "configuration",
              message: error ?? "WhatsApp requires pairing.",
            }),
          );
          yield* Effect.never;
        }

        yield* Effect.sleep(Math.min(1000 * 2 ** Math.min(failures++, 5), 30000));
      }
    }).pipe(
      Effect.catch(() =>
        Effect.sync(() => {
          connected = false;
          error = "WhatsApp could not connect. Stop the worker and inspect its protected settings.";
        }).pipe(Effect.andThen(Deferred.fail(linked, unavailable())), Effect.andThen(Effect.never)),
      ),
    );

    yield* run.pipe(Effect.forkScoped);

    return {
      auth,
      messages,
      socket,
      linked: Deferred.await(linked),
      status: Effect.sync(() => ({
        adapter: "whatsapp",
        account: settings.accountPhone,
        connected,
        needsPairing,
        error,
        dropped,
        ignored,
      })),
    };
  });

export class WhatsAppClient extends Context.Service<
  WhatsAppClient,
  Effect.Success<ReturnType<typeof makeWhatsAppClient>>
>()("poppet/WhatsAppClient") {}

export const WhatsAppClientLive = (
  dataDirectory: string,
  settings: WhatsAppSettings,
  createSocket: SocketFactory = makeWASocket,
  onQr?: (qr: string) => Effect.Effect<void>,
) => Layer.effect(WhatsAppClient, makeWhatsAppClient(dataDirectory, settings, createSocket, onQr));
