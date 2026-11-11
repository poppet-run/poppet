import { ChannelError, MessagingChannel, type IncomingMessage } from "@poppet/gateway";
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { Deferred, Effect, Exit, Layer, Queue, Redacted, Schema, Stream } from "effect";

import type { SlackSettings } from "#src/settings";

export const parseConversation = (id: string) => {
  const match = /^([CG][A-Z0-9]+)(?::(\d+\.\d+))?$/.exec(id);

  if (!match)
    throw new ChannelError({
      reason: "configuration",
      message: "Use a Slack channel ID or channel:thread-timestamp.",
    });

  return { channel: match[1]!, ts: match[2] };
};

export const EventBody = Schema.Struct({
  team_id: Schema.String,
  event: Schema.Struct({
    type: Schema.Literals(["message", "app_mention"]),
    user: Schema.String,
    channel: Schema.String.check(Schema.isPattern(/^[CG][A-Z0-9]+$/)),
    ts: Schema.String.check(Schema.isPattern(/^\d+\.\d+$/)),
    thread_ts: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^\d+\.\d+$/))),
    text: Schema.optionalKey(Schema.String),
    bot_id: Schema.optionalKey(Schema.String),
    subtype: Schema.optionalKey(Schema.String),
    files: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          id: Schema.NonEmptyString,
          name: Schema.NonEmptyString,
          size: Schema.optionalKey(Schema.Natural),
        }),
      ),
    ),
  }),
});

export const incomingMessage = (
  body: typeof EventBody.Type,
  settings: SlackSettings,
  botId: string,
): IncomingMessage | null => {
  const { team_id, event } = body;

  if (
    !botId ||
    team_id !== settings.teamId ||
    event.user !== settings.ownerId ||
    event.bot_id ||
    (event.subtype !== undefined && event.subtype !== "file_share")
  )
    return null;
  const content = event.text ?? "";
  const text = content.replaceAll(`<@${botId}>`, "").trim();
  const attachments = (event.files ?? []).map((file) => Object.assign({ ref: file.id }, file));

  if ((!text && !attachments.length) || text.length > 8192 || attachments.length > 10) return null;

  return {
    messageId: `${event.channel}:${event.ts}`,
    scopeId: team_id,
    parentId: event.channel,
    conversationId: event.thread_ts ? `${event.channel}:${event.thread_ts}` : null,
    senderId: event.user,
    text,
    mentioned: content.includes(`<@${botId}>`),
    attachments,
  };
};

const failure = (cause: unknown, sending = false) => {
  if (cause instanceof ChannelError) return cause;

  const decoded = Schema.decodeUnknownExit(
    Schema.Struct({
      code: Schema.optionalKey(Schema.String),
      retryAfter: Schema.optionalKey(Schema.Number),
    }),
  )(cause);

  const error = Exit.isSuccess(decoded) ? decoded.value : {};

  return new ChannelError({
    reason:
      error.code === "slack_webapi_rate_limited_error"
        ? "unavailable"
        : error.code === "slack_webapi_platform_error"
          ? "permission"
          : sending
            ? "uncertain"
            : "unavailable",
    message: "Slack operation failed. Check credentials, scopes, and channel membership.",
    retryAfterMs: (error.retryAfter ?? 0) * 1000,
  });
};

export const slackChannelLayer = (settings: SlackSettings) =>
  Layer.effect(
    MessagingChannel,
    Effect.gen(function* () {
      const messages = yield* Queue.make<IncomingMessage>({ capacity: 64, strategy: "dropping" });
      const identity = yield* Deferred.make<string>();

      const web = new WebClient(Redacted.value(settings.token), {
        retryConfig: { retries: 0 },
        rejectRateLimitedCalls: true,
        timeout: 10000,
      });

      const socket = yield* Effect.acquireRelease(
        Effect.sync(() => new SocketModeClient({ appToken: Redacted.value(settings.appToken) })),
        (owned) =>
          Effect.promise(async () => {
            await owned.disconnect();
          }),
      );

      let connected = false;
      let botId = "";
      let error: string | null = null;
      let dropped = 0;
      socket.on("connected", () => {
        connected = true;
        error = null;
      });
      socket.on("disconnected", () => {
        connected = false;
      });
      socket.on("error", () => {
        error = "Slack connection interrupted.";
      });
      socket.on(
        "slack_event",
        async ({ body, ack }: { body: unknown; ack: () => Promise<void> }) => {
          await ack();
          const decoded = Schema.decodeUnknownExit(EventBody)(body);

          if (Exit.isFailure(decoded)) return;
          const message = incomingMessage(decoded.value, settings, botId);

          if (message !== null && !Queue.offerUnsafe(messages, message)) dropped++;
        },
      );
      yield* Effect.tryPromise({
        try: async () => {
          const auth = await web.auth.test();

          if (auth.team_id !== settings.teamId || !auth.user_id)
            throw new ChannelError({
              reason: "configuration",
              message: "Slack token belongs to another workspace.",
            });
          botId = auth.user_id;
          Deferred.doneUnsafe(identity, Effect.succeed(botId));
          await socket.start();
        },
        catch: failure,
      }).pipe(
        Effect.andThen(Effect.never),
        Effect.catch((cause) =>
          Effect.sync(() => {
            error = cause.message;
          }).pipe(Effect.andThen(Effect.sleep("30 seconds"))),
        ),
        Effect.forever,
        Effect.forkScoped,
      );

      const checkAccess = (message: IncomingMessage, id: string) =>
        Effect.tryPromise({
          try: async () => {
            const target = parseConversation(id);

            if (!connected)
              throw new ChannelError({ reason: "unavailable", message: "Slack is disconnected." });

            if (
              message.senderId !== settings.ownerId ||
              message.scopeId !== settings.teamId ||
              message.parentId !== target.channel
            )
              throw new ChannelError({
                reason: "permission",
                message: "Slack destination is outside the authorized conversation.",
              });
            const info = await web.conversations.info({ channel: target.channel });

            if (
              !info.channel?.is_member ||
              info.channel.is_archived ||
              info.channel.is_shared ||
              info.channel.is_ext_shared
            )
              throw new ChannelError({
                reason: "permission",
                message: "Use an unshared Slack channel containing the bot.",
              });

            if (target.ts) {
              const history = await web.conversations.history({
                channel: target.channel,
                latest: target.ts,
                inclusive: true,
                limit: 1,
              });

              if (history.messages?.[0]?.ts !== target.ts)
                throw new ChannelError({
                  reason: "permission",
                  message: "Slack thread no longer exists.",
                });
            }
          },
          catch: failure,
        });

      return {
        id: "slack",
        accountId: Deferred.await(identity),
        policy: { ownerId: settings.ownerId, scopeId: settings.teamId },
        homeConversationId: settings.homeChannelId,
        messages: Stream.fromQueue(messages),
        textLimit: 3000,
        status: Effect.sync(() => ({
          adapter: "slack",
          account: botId || null,
          connected,
          error,
          dropped,
        })),
        checkAccess,
        destination: (id) =>
          Effect.try({ try: () => parseConversation(id).channel, catch: failure }),
        typing: () => Effect.void,
        mark: (message, state) =>
          Effect.tryPromise({
            try: async () => {
              const args = {
                channel: message.parentId,
                timestamp: message.messageId.slice(message.parentId.length + 1),
              };

              if (state === "working") await web.reactions.add({ ...args, name: "eyes" });
              else {
                if (state === "completed")
                  await web.reactions.add({ ...args, name: "white_check_mark" });
                await web.reactions.remove({ ...args, name: "eyes" });
              }
            },
            catch: failure,
          }),
        send: (id, text) =>
          Effect.tryPromise({
            try: async () => {
              const target = parseConversation(id);

              // Slack's SDK uses the same method name as browser window messaging.
              /* oxlint-disable unicorn/require-post-message-target-origin */
              const reply = await web.chat.postMessage({
                channel: target.channel,
                thread_ts: target.ts ?? "",
                text,
                mrkdwn: false,
                parse: "none",
                unfurl_links: false,
                unfurl_media: false,
              });

              /* oxlint-enable unicorn/require-post-message-target-origin */

              if (!reply.ts) throw new Error("Missing message timestamp");

              return reply.ts;
            },
            catch: (cause) => failure(cause, true),
          }),
        download: (attachment, maxBytes) =>
          Effect.tryPromise({
            try: async () => {
              const info = await web.files.info({ file: attachment.ref });
              const url = info.file?.url_private_download ?? info.file?.url_private;

              if (
                !url ||
                new URL(url).hostname !== "files.slack.com" ||
                new URL(url).protocol !== "https:"
              )
                throw new ChannelError({
                  reason: "permission",
                  message: "Slack file URL is unavailable or unsupported.",
                });

              const response = await fetch(url, {
                headers: { Authorization: `Bearer ${Redacted.value(settings.token)}` },
                redirect: "error",
                signal: AbortSignal.timeout(30000),
              });

              if (!response.ok || !response.body) throw new Error("Slack file download failed");
              const chunks: Uint8Array[] = [];
              let length = 0;

              for await (const chunk of response.body) {
                length += chunk.length;

                if (length > maxBytes)
                  throw new ChannelError({
                    reason: "permission",
                    message: "Slack file exceeds the attachment limit.",
                  });
                chunks.push(chunk);
              }

              const bytes = new Uint8Array(length);
              let offset = 0;

              for (const chunk of chunks) {
                bytes.set(chunk, offset);
                offset += chunk.length;
              }

              return bytes;
            },
            catch: failure,
          }),
        naming: {
          sanitize: (title) => title,
          conversation: (message) =>
            checkAccess(message, message.conversationId ?? message.parentId).pipe(
              Effect.as({
                id: message.conversationId ?? message.messageId,
                managedName: null,
              }),
            ),
          changes: Stream.empty,
          current: () => Effect.succeed(""),
          rename: () => Effect.succeed(null),
        },
      } satisfies MessagingChannel["Service"];
    }),
  );
