import { ChannelError, MessagingChannel, type IncomingMessage } from "@poppet/gateway";
import {
  ChannelType,
  Client,
  DiscordAPIError,
  Events,
  GatewayIntentBits,
  MessageType,
  PermissionFlagsBits,
  Options,
  RateLimitError,
  type Message,
  type MessageCreateOptions,
} from "discord.js";
import { Deferred, Effect, Layer, Queue, Redacted, Stream } from "effect";

import { approvalActions, approvalComponents } from "#src/approvals";
import type { DiscordSettings } from "#src/settings";

const discordFailure = (cause: unknown, sending = false) =>
  cause instanceof ChannelError
    ? cause
    : new ChannelError({
        reason:
          cause instanceof RateLimitError
            ? "unavailable"
            : cause instanceof DiscordAPIError && cause.status < 500
              ? "permission"
              : sending
                ? "uncertain"
                : "unavailable",
        message:
          "Discord operation failed. Check the bot connection, Message Content intent, and thread permissions.",
        retryAfterMs:
          cause instanceof RateLimitError ? Math.max(cause.retryAfter, cause.timeToReset) : 0,
      });

// Discord counts UTF-16 code units; never cut an astral character to meet its 100-unit limit.
const threadName = (title: string) => {
  let name = "";

  for (const character of title) {
    if (name.length + character.length > 100) break;
    name += character;
  }

  return name || "New conversation";
};

export const discordChannelLayer = (
  settings: DiscordSettings,
  createClient = () =>
    new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      allowedMentions: { parse: [], repliedUser: false },
      makeCache: Options.cacheWithLimits({ MessageManager: 0 }),
      rest: {
        retries: 0,
        timeout: 10000,
        // Let the SDK retry the limited reaction without replaying the entire state change.
        rejectOnRateLimit: ({ route }) => !route.includes("/reactions/"),
      },
    }),
) =>
  Layer.effect(
    MessagingChannel,
    Effect.gen(function* () {
      const messages = yield* Queue.make<IncomingMessage>({ capacity: 64, strategy: "dropping" });
      const nameChanges = yield* Queue.make<string>({ capacity: 64, strategy: "dropping" });
      let connectionError: string | null = null;
      let dropped = 0;

      const client = yield* Effect.acquireRelease(Effect.sync(createClient), (owned) =>
        Effect.promise(() => owned.destroy()),
      );

      const identity = yield* Deferred.make<string>();

      const reportError = (error: ChannelError) =>
        Effect.sync(() => {
          connectionError = error.message;
        });

      const actions = yield* approvalActions(client, settings, () => {
        connectionError = "Discord approval interaction failed.";
      });

      const requireReady = () => {
        if (!client.isReady())
          throw new ChannelError({
            reason: "unavailable",
            message: "Discord is disconnected.",
          });

        return client.user.id;
      };

      const incoming = (message: Message) => {
        if (
          !client.isReady() ||
          !message.inGuild() ||
          message.author.bot ||
          message.webhookId !== null ||
          message.author.id !== settings.ownerId ||
          message.guildId !== settings.guildId ||
          ![MessageType.Default, MessageType.Reply].includes(message.type)
        )
          return;
        const thread = message.channel.isThread();

        if (!thread && message.channel.type !== ChannelType.GuildText) return;
        const parentId = thread ? message.channel.parentId : message.channelId;

        if (parentId === null) return;
        const botId = client.user.id;
        const mentioned = message.mentions.users.has(botId);

        const text = message.content
          .replaceAll(`<@${botId}>`, "")
          .replaceAll(`<@!${botId}>`, "")
          .trim();

        if (!text || text.length > 8192) return;

        if (
          !Queue.offerUnsafe(messages, {
            messageId: message.id,
            scopeId: message.guildId,
            parentId,
            conversationId: thread ? message.channelId : null,
            senderId: message.author.id,
            text,
            mentioned,
          })
        )
          dropped++;
      };

      client.on(Events.MessageCreate, incoming);
      client.on(Events.ThreadUpdate, (before, after) => {
        if (before.name !== after.name) Queue.offerUnsafe(nameChanges, after.id);
      });
      client.on(Events.Error, () => {
        connectionError = "Discord connection failed. Check credentials and intents.";
      });
      client.on(Events.ShardError, () => {
        connectionError = "Discord connection interrupted; reconnecting.";
      });
      client.on(Events.ShardDisconnect, (event) => {
        connectionError =
          event.code === 4014
            ? "Enable the Message Content intent for this bot."
            : "Discord disconnected; waiting for reconnect.";
      });
      client.on(Events.ClientReady, (connected) => {
        Deferred.doneUnsafe(identity, Effect.succeed(connected.user.id));
        connectionError = null;
      });

      const login = Effect.tryPromise({
        try: () => client.login(Redacted.value(settings.token)),
        catch: discordFailure,
      }).pipe(
        Effect.andThen(Effect.never),
        Effect.catch(() =>
          Effect.gen(function* () {
            connectionError = "Discord login failed. Check credentials and Message Content intent.";
            yield* Effect.sleep("30 seconds");
          }),
        ),
        Effect.forever,
      );

      yield* login.pipe(Effect.forkScoped);

      // A text channel or thread in the configured server; null for anything else.
      const guildChannel = async (id: string, force = false) => {
        const channel = await client.channels.fetch(id, { force });

        if (channel === null || (channel.type !== ChannelType.GuildText && !channel.isThread()))
          return null;

        return channel.guildId === settings.guildId ? channel : null;
      };

      const checkAccess = (message: IncomingMessage, conversationId: string) =>
        Effect.tryPromise({
          try: async () => {
            const botId = requireReady();
            const target = await guildChannel(conversationId, true);

            const parent =
              conversationId === message.parentId
                ? target
                : await client.channels.fetch(message.parentId, { force: true });

            if (
              target === null ||
              parent?.type !== ChannelType.GuildText ||
              parent.guildId !== settings.guildId ||
              message.scopeId !== settings.guildId ||
              message.senderId !== settings.ownerId ||
              (target.isThread()
                ? target.parentId !== message.parentId || target.locked
                : target.id !== message.parentId) ||
              !target
                .permissionsFor(botId)
                ?.has([
                  PermissionFlagsBits.ViewChannel,
                  PermissionFlagsBits.ReadMessageHistory,
                  target.isThread()
                    ? PermissionFlagsBits.SendMessagesInThreads
                    : PermissionFlagsBits.SendMessages,
                ])
            )
              throw new ChannelError({
                reason: "permission",
                message: "Discord channel access is missing or the thread is locked.",
              });
          },
          catch: discordFailure,
        }).pipe(Effect.tapError(reportError));

      const conversation = (message: IncomingMessage, title: string) =>
        Effect.tryPromise({
          try: async () => {
            const botId = requireReady();

            if (message.conversationId !== null)
              return { id: message.conversationId, managedName: null };
            const parent = await client.channels.fetch(message.parentId, { force: true });

            if (
              parent?.type !== ChannelType.GuildText ||
              parent.guildId !== settings.guildId ||
              !parent
                .permissionsFor(botId)
                ?.has([
                  PermissionFlagsBits.ViewChannel,
                  PermissionFlagsBits.ReadMessageHistory,
                  PermissionFlagsBits.CreatePublicThreads,
                ])
            )
              throw new ChannelError({
                reason: "permission",
                message: "Discord needs permission to create and read threads.",
              });

            const source = await parent.messages.fetch({
              message: message.messageId,
              force: true,
            });

            if (source.author.id !== settings.ownerId || source.webhookId !== null)
              throw new ChannelError({
                reason: "permission",
                message: "Cannot create a thread for this message.",
              });

            // Discord assigns the source message's ID to its thread, so this recovers lost create replies.
            const thread = source.hasThread
              ? await client.channels.fetch(source.id, { force: true })
              : await source.startThread({ name: threadName(title), autoArchiveDuration: 1440 });

            if (!thread?.isThread())
              throw new ChannelError({
                reason: "unavailable",
                message: "Cannot find the Discord thread.",
              });

            // Source ID plus bot ownership proves creation even after a lost acknowledgement.
            return {
              id: thread.id,
              managedName:
                thread.ownerId === botId && thread.id === source.id ? threadName(title) : null,
            };
          },
          catch: discordFailure,
        }).pipe(Effect.tapError(reportError));

      const send = (conversationId: string, text: string, nonce: string, requestId?: string) =>
        Effect.tryPromise({
          try: async () => {
            requireReady();
            const target = await guildChannel(conversationId);

            if (target === null)
              throw new ChannelError({
                reason: "permission",
                message: "Discord text channel or thread is unavailable.",
              });

            const options: MessageCreateOptions = {
              content: text,
              nonce,
              enforceNonce: true,
              allowedMentions: { parse: [], repliedUser: false },
            };

            if (requestId) options.components = approvalComponents(requestId);

            return (await target.send(options)).id;
          },
          catch: (cause) => discordFailure(cause, true),
        });

      return {
        id: "discord",
        accountId: Deferred.await(identity),
        policy: {
          ownerId: settings.ownerId,
          scopeId: settings.guildId,
        },
        homeConversationId: settings.homeChannelId,
        messages: Stream.fromQueue(messages),
        textLimit: 2000,
        status: Effect.sync(() => ({
          adapter: "discord",
          account: client.user?.id ?? null,
          connected: client.isReady(),
          error: connectionError,
          dropped,
        })),
        checkAccess,
        destination: (conversationId) =>
          Effect.tryPromise({
            try: async () => {
              if (!/^[0-9]{1,20}$/.test(conversationId))
                throw new ChannelError({
                  reason: "configuration",
                  message: "Choose a numeric Discord channel or thread ID of at most 20 digits.",
                });

              requireReady();
              const target = await guildChannel(conversationId, true);

              if (target === null || (target.isThread() && !target.parentId))
                throw new ChannelError({
                  reason: "permission",
                  message:
                    "Choose an existing text channel or thread in the configured Discord server.",
                });

              return target.isThread() ? target.parentId! : target.id;
            },
            catch: discordFailure,
          }),
        mark: (message, state) =>
          Effect.tryPromise({
            try: async () => {
              requireReady();

              const channel = await guildChannel(message.conversationId ?? message.parentId);

              if (channel === null)
                throw new ChannelError({
                  reason: "permission",
                  message: "Cannot mark this message.",
                });

              const source = await channel.messages.fetch({
                message: message.messageId,
                force: true,
              });

              if (source.author.id !== settings.ownerId || source.webhookId !== null)
                throw new ChannelError({
                  reason: "permission",
                  message: "Cannot mark this message.",
                });

              if (state === "working") {
                await source.react("👀");
              } else {
                if (state === "completed") await source.react("✅");
                // Remove only our reaction, even when fetched reaction metadata is stale.
                await client.rest.delete(
                  `/channels/${source.channelId}/messages/${source.id}/reactions/${encodeURIComponent("👀")}/@me`,
                );
              }
            },
            catch: discordFailure,
          }),
        typing: (conversationId) =>
          Effect.tryPromise({
            try: async () => {
              requireReady();
              const thread = await client.channels.fetch(conversationId);

              if (thread?.isThread()) await thread.sendTyping();
            },
            catch: discordFailure,
          }),
        conversation: (message) =>
          conversation(message, "New conversation").pipe(Effect.map((result) => result.id)),
        naming: {
          sanitize: threadName,
          conversation,
          changes: Stream.fromQueue(nameChanges),
          current: (message, id) =>
            checkAccess(message, id).pipe(
              Effect.andThen(
                Effect.tryPromise({
                  try: async () => {
                    const thread = await client.channels.fetch(id, { force: true });

                    if (!thread?.isThread())
                      throw new ChannelError({
                        reason: "permission",
                        message: "Discord thread no longer exists.",
                      });

                    return thread.name;
                  },
                  catch: discordFailure,
                }),
              ),
            ),
          rename: (message, id, expected, title) =>
            checkAccess(message, id).pipe(
              Effect.andThen(
                Effect.tryPromise({
                  try: async () => {
                    const botId = requireReady();
                    const thread = await client.channels.fetch(id, { force: true });

                    if (!thread?.isThread() || thread.ownerId !== botId || thread.locked)
                      throw new ChannelError({
                        reason: "permission",
                        message: "Cannot rename this Discord thread.",
                      });

                    if (thread.name !== expected) return null;

                    return (await thread.setName(threadName(title))).name;
                  },
                  catch: (cause) => discordFailure(cause, true),
                }),
              ),
            ),
        },
        send,
        approvals: {
          actions,
          send,
          update: (conversationId, messageId, requestId, state) =>
            Effect.tryPromise({
              try: async () => {
                const botId = requireReady();
                const target = await guildChannel(conversationId);

                if (target === null)
                  throw new ChannelError({
                    reason: "permission",
                    message: "Approval conversation is unavailable.",
                  });
                const prompt = await target.messages.fetch({ message: messageId, force: true });

                if (prompt.author.id !== botId || prompt.webhookId !== null)
                  throw new ChannelError({
                    reason: "permission",
                    message: "Cannot update this approval message.",
                  });

                await prompt.edit({
                  components: approvalComponents(requestId, state),
                  allowedMentions: { parse: [], repliedUser: false },
                });
              },
              catch: (cause) => discordFailure(cause, true),
            }),
        },
      } satisfies MessagingChannel["Service"];
    }),
  );
