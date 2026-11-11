import {
  boundedAttachment,
  ChannelError,
  MessagingChannel,
  type IncomingMessage,
} from "@poppet/gateway";
import { SocketModeClient } from "@slack/socket-mode";
import { ErrorCode, WebClient, type ChatPostMessageArguments } from "@slack/web-api";
import { Deferred, Effect, Exit, Layer, Queue, Redacted, Schema, Stream } from "effect";

import type { SlackSettings } from "#src/settings";

export const escapeSlackText = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

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
    type: Schema.Literal("message"),
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

  const text = content
    .replaceAll(`<@${botId}>`, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .trim();

  const attachments = (event.files ?? [])
    .slice(0, 10)
    .map((file) => Object.assign({}, file, { ref: file.id, name: file.name.slice(0, 1024) }));

  if ((!text && !attachments.length) || text.length > 8192) return null;

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
      error.code === ErrorCode.RateLimitedError
        ? "unavailable"
        : error.code === ErrorCode.PlatformError
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
          }).pipe(Effect.timeout("5 seconds"), Effect.ignore),
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
          try {
            await ack();
          } catch {
            error = "Slack event acknowledgement failed.";

            return;
          }

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
                timestamp: parseConversation(message.messageId).ts!,
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

              const args: ChatPostMessageArguments = {
                channel: target.channel,
                text: escapeSlackText(text),
                mrkdwn: false,
                parse: "none",
                unfurl_links: false,
                unfurl_media: false,
              };

              if (target.ts) args.thread_ts = target.ts;

              // Slack's SDK uses the same method name as browser window messaging.
              /* oxlint-disable unicorn/require-post-message-target-origin */
              const reply = await web.chat.postMessage(args);

              /* oxlint-enable unicorn/require-post-message-target-origin */

              if (!reply.ts) throw new Error("Missing message timestamp");

              return reply.ts;
            },
            catch: (cause) => failure(cause, true),
          }),
        download: (attachment, maxBytes) =>
          Effect.tryPromise({
            try: () => web.files.info({ file: attachment.ref }),
            catch: failure,
          }).pipe(
            Effect.flatMap((info) =>
              boundedAttachment(fetch, new Set(["files.slack.com"]), "Slack", {
                Authorization: `Bearer ${Redacted.value(settings.token)}`,
              })(
                {
                  ...attachment,
                  ref: info.file?.url_private_download ?? info.file?.url_private ?? "",
                },
                maxBytes,
              ),
            ),
          ),
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
