import { boundedAttachment, ChannelError, MessagingChannel } from "@poppet/gateway";
import type { ApprovalAction, IncomingMessage } from "@poppet/gateway";
import { SocketModeClient } from "@slack/socket-mode";
import { ErrorCode, WebClient } from "@slack/web-api";
import type { ChatPostMessageArguments } from "@slack/web-api";
import { Deferred, Effect, Exit, Layer, Queue, Redacted, Schema, Stream } from "effect";

import { ActionBody, approvalBlocks, approvalClick } from "#src/approvals";
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

export const allowedSlackChannel = (
  channel: Awaited<ReturnType<WebClient["conversations"]["info"]>>["channel"],
) =>
  channel?.is_member === true &&
  !channel.is_archived &&
  !channel.is_im &&
  !channel.is_mpim &&
  !channel.is_shared &&
  !channel.is_ext_shared &&
  !channel.is_org_shared &&
  !channel.is_pending_ext_shared;

const transientPlatformErrors = new Set([
  "internal_error",
  "service_unavailable",
  "fatal_error",
  "request_timeout",
]);

export const slackFailure = (cause: unknown, sending = false) => {
  if (cause instanceof ChannelError) return cause;

  const decoded = Schema.decodeUnknownExit(
    Schema.Struct({
      code: Schema.optionalKey(Schema.String),
      retryAfter: Schema.optionalKey(Schema.Number),
      data: Schema.optionalKey(
        Schema.Struct({
          error: Schema.optionalKey(Schema.String),
        }),
      ),
    }),
  )(cause);

  const error = Exit.isSuccess(decoded) ? decoded.value : {};

  return new ChannelError({
    reason:
      error.code === ErrorCode.RateLimitedError
        ? "unavailable"
        : error.code === ErrorCode.PlatformError
          ? error.data?.error !== undefined && transientPlatformErrors.has(error.data.error)
            ? "unavailable"
            : "permission"
          : sending
            ? "uncertain"
            : "unavailable",
    message: "Slack operation failed. Check credentials, scopes, and channel membership.",
    retryAfterMs: (error.retryAfter ?? 0) * 1000,
  });
};

const failure = slackFailure;

export const slackSocketSession = (
  socket: {
    readonly start: () => Promise<{ ok: boolean }>;
    readonly on: (event: string, listener: () => void) => void;
  },
  status: (connected: boolean) => void,
) =>
  Effect.gen(function* () {
    const disconnected = yield* Deferred.make<void>();

    const offline = () => {
      status(false);
      Deferred.doneUnsafe(disconnected, Effect.void);
    };

    socket.on("close", offline);
    socket.on("disconnected", offline);
    socket.on("reconnecting", offline);
    socket.on("error", offline);

    const started = yield* Effect.tryPromise({
      try: () => socket.start(),
      catch: failure,
    }).pipe(
      Effect.as(true),
      Effect.raceFirst(Deferred.await(disconnected).pipe(Effect.as(false))),
      Effect.timeoutOrElse({
        duration: "20 seconds",
        orElse: () =>
          Effect.fail(
            new ChannelError({ reason: "unavailable", message: "Slack connection timed out." }),
          ),
      }),
    );

    if (started && !(yield* Deferred.isDone(disconnected))) {
      status(true);
      yield* Deferred.await(disconnected);
    }
  });

export const slackChannelLayer = (settings: SlackSettings) =>
  Layer.effect(
    MessagingChannel,
    Effect.gen(function* () {
      const messages = yield* Queue.make<IncomingMessage>({ capacity: 64, strategy: "dropping" });
      const actions = yield* Queue.make<ApprovalAction>({ capacity: 64, strategy: "dropping" });
      const prompts = new Map<string, string>();
      const identity = yield* Deferred.make<string>();

      const web = new WebClient(Redacted.value(settings.token), {
        retryConfig: { retries: 0 },
        rejectRateLimitedCalls: true,
        timeout: 10000,
      });

      let connected = false;
      let botId = "";
      let error: string | null = null;
      let dropped = 0;

      const handleEvent = async ({
        type,
        body,
        ack,
      }: {
        type: string;
        body: unknown;
        ack: () => Promise<void>;
      }) => {
        if (type === "interactive") {
          const action = Schema.decodeUnknownExit(ActionBody)(body);

          if (Exit.isSuccess(action))
            await approvalAction(action.value).catch(() => {
              error = "Slack approval interaction failed.";
            });
        } else {
          const decoded = Schema.decodeUnknownExit(EventBody)(body);

          if (Exit.isSuccess(decoded)) {
            const message = incomingMessage(decoded.value, settings, botId);

            if (message !== null && !Queue.offerUnsafe(messages, message)) {
              dropped++;

              return;
            }
          }
        }

        try {
          await ack();

          if (connected) error = null;
        } catch {
          error = "Slack event acknowledgement failed.";
        }
      };

      const connect = Effect.scoped(
        Effect.gen(function* () {
          const auth = yield* Effect.tryPromise({ try: () => web.auth.test(), catch: failure });

          if (auth.team_id !== settings.teamId || !auth.user_id)
            return yield* Effect.fail(
              new ChannelError({
                reason: "configuration",
                message: "Slack token belongs to another workspace.",
              }),
            );

          botId = auth.user_id;

          const socket = yield* Effect.acquireRelease(
            Effect.sync(
              () =>
                new SocketModeClient({
                  appToken: Redacted.value(settings.appToken),
                  autoReconnectEnabled: false,
                  clientOptions: {
                    retryConfig: { retries: 0 },
                    rejectRateLimitedCalls: true,
                    timeout: 10000,
                  },
                }),
            ),
            (owned) =>
              Effect.tryPromise(() => owned.disconnect()).pipe(
                Effect.timeout("5 seconds"),
                Effect.ignore,
              ),
          );

          socket.on("slack_event", (event) => {
            void handleEvent(event);
          });
          yield* slackSocketSession(socket, (online) => {
            connected = online;
            error = online ? null : "Slack connection interrupted.";

            if (online) Deferred.doneUnsafe(identity, Effect.succeed(botId));
          });
        }),
      );

      yield* connect.pipe(
        Effect.catch((cause) =>
          Effect.sync(() => {
            error = cause.message;
          }),
        ),
        Effect.andThen(Effect.sleep("30 seconds")),
        Effect.forever,
        Effect.forkScoped,
      );

      const ephemeral = async (channel: string, user: string, text: string, thread?: string) => {
        await web.chat.postEphemeral({
          channel,
          user,
          text: escapeSlackText(text),
          ...(thread && { thread_ts: thread }),
        });
      };

      const approvalAction = async (body: typeof ActionBody.Type) => {
        const click = approvalClick(body, settings, botId);

        if (click.kind === "ignored") return;

        if (click.kind === "rejected") {
          await ephemeral(
            click.channel,
            click.user,
            "Only the configured owner can answer an approval in the configured workspace.",
            click.thread,
          );

          return;
        }

        const reply = (text: string) =>
          Effect.tryPromise({
            try: () => ephemeral(click.source.parentId, click.source.senderId, text, click.thread),
            catch: failure,
          });

        if (
          !Queue.offerUnsafe(actions, {
            requestId: click.requestId,
            decision: click.decision,
            source: click.source,
            reply,
          })
        )
          await Effect.runPromise(
            reply("Poppet is busy. Try this approval again before it expires."),
          );
      };

      const send = (id: string, text: string, requestId?: string) =>
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

            const reply = await web.chat.postMessage(
              requestId ? { ...args, blocks: approvalBlocks(text, requestId) } : args,
            );

            if (!reply.ts) throw new Error("Missing message timestamp");

            if (requestId) prompts.set(requestId, text);

            return reply.ts;
          },
          catch: (cause) => failure(cause, true),
        });

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

            if (!allowedSlackChannel(info.channel))
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
        send: (id, text) => send(id, text),
        approvals: {
          actions: Stream.fromQueue(actions),
          send: (id, text, _nonce, requestId) => send(id, text, requestId),
          update: (id, messageId, requestId, state) =>
            Effect.tryPromise({
              try: async () => {
                const text = prompts.get(requestId) ?? "";
                prompts.delete(requestId);

                await web.chat.update({
                  channel: parseConversation(id).channel,
                  ts: messageId,
                  text: escapeSlackText(text),
                  blocks: approvalBlocks(text, requestId, state),
                });
              },
              catch: (cause) => failure(cause, true),
            }),
        },
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
