import { createHash } from "node:crypto";

import { Agent, type ChatFailure } from "@poppet/agent";
import { AppConfig } from "@poppet/config";
import { Store, StoreError, type Run } from "@poppet/store";
import {
  Cause,
  Clock,
  Console,
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Schema,
  Stream,
} from "effect";

import { ChannelError, IncomingMessage, MessagingChannel } from "#src/channel";
import { GatewayRepository, gatewayStorage, type Inbox } from "#src/repository";

const chunks = (text: string, limit: number) => {
  const result: string[] = [];
  let part = "";

  for (const character of text) {
    if (part.length + character.length > limit) {
      result.push(part);
      part = "";
    }

    part += character;
  }

  if (part) result.push(part);

  return result;
};

const answer = (run: Run) =>
  run.status === "completed" && run.result !== null
    ? run.result.output.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("") ||
      "The request completed without a text answer."
    : "The request failed or was interrupted. Inspect its saved run before sending a new request.";

const gateway = Effect.gen(function* () {
  const channel = yield* MessagingChannel;
  const repo = yield* GatewayRepository;
  const store = yield* Store;
  const agent = yield* Agent;
  const config = yield* AppConfig;
  const clock = yield* Clock.Clock;
  const account = channel.accountId;
  let active: { entry: Inbox; fiber: Fiber.Fiber<void, ChatFailure | ChannelError> } | null = null;
  let rejected = 0;

  const authorized = (message: IncomingMessage) =>
    message.senderId === channel.policy.ownerId &&
    message.scopeId === channel.policy.scopeId &&
    channel.policy.parentIds.includes(message.parentId);

  const finish = (id: number, text: string, state = "completed") =>
    gatewayStorage(() => repo.complete(id, chunks(text, channel.textLimit), state));

  // shortcut: Reactions are best effort; add durable reconciliation if stale markers after crashes matter.
  const mark = (message: IncomingMessage, state: "working" | "completed" | "stopped") =>
    channel.mark(message, state).pipe(Effect.catchTag("ChannelError", () => Effect.void));

  const recover = Effect.gen(function* () {
    yield* gatewayStorage(() => repo.recoverDelivery(channel.id, account));

    for (const entry of yield* gatewayStorage(() => repo.executing(channel.id, account))) {
      const run = yield* store.run(entry.runId);

      if (run === null) yield* gatewayStorage(() => repo.state(entry.id, "queued"));
      else {
        yield* finish(entry.id, answer(run));
        yield* mark(entry.message, run.status === "completed" ? "completed" : "stopped");
      }
    }
  });

  const accept = (input: IncomingMessage) =>
    Effect.gen(function* () {
      const message = yield* Schema.decodeUnknownEffect(IncomingMessage)(input).pipe(
        Effect.mapError(
          () => new ChannelError({ reason: "configuration", message: "Invalid incoming message." }),
        ),
      );

      if (!authorized(message) || !message.text.trim()) return;
      const conversation = message.conversationId;

      const session =
        conversation === null
          ? null
          : yield* gatewayStorage(() =>
              repo.binding(channel.id, account, message.scopeId, conversation),
            );

      if (conversation === null && !message.mentioned) return;
      const entry = yield* gatewayStorage(() => repo.accept(channel.id, account, message));

      if (entry === null) return;

      if (message.text !== "/status" && message.text !== "/cancel") return;
      // Controls never create sessions or wait behind the model they may need to cancel.
      yield* gatewayStorage(() => repo.state(entry.id, "cancelled"));

      if (conversation === null || session === null) return;

      yield* mark(message, "working");

      if (message.text === "/cancel") {
        yield* gatewayStorage(() => repo.cancel(channel.id, account, conversation));

        if (active?.entry.conversationId === conversation) {
          const current = active;
          yield* gatewayStorage(() => repo.state(current.entry.id, "cancelled"));
          yield* Fiber.interrupt(current.fiber);
        }

        yield* finish(entry.id, "Cancelled this thread's queued and active request.");
      } else {
        const latestId = (yield* store.messages(session)).at(-1)?.runId;
        const latest = latestId ? yield* store.run(latestId) : null;
        yield* finish(entry.id, `Session: ${session}\nLatest run: ${latest?.status ?? "none"}`);
      }

      yield* mark(message, "completed");
    });

  const processNext = Effect.gen(function* () {
    const entry = yield* gatewayStorage(() =>
      repo.next(channel.id, account, clock.currentTimeMillisUnsafe()),
    );

    if (entry === null) return false;

    if (!authorized(entry.message)) {
      yield* gatewayStorage(() => repo.state(entry.id, "cancelled"));

      return true;
    }

    const execute = Effect.gen(function* () {
      const conversation = entry.conversationId ?? (yield* channel.conversation(entry.message));
      yield* channel.checkAccess(entry.message, conversation);

      const existing = yield* gatewayStorage(() =>
        repo.binding(channel.id, account, entry.message.scopeId, conversation),
      );

      // A stable session ID also recovers a crash between session creation and binding.
      const id =
        existing ??
        `gateway-${createHash("sha256")
          .update(JSON.stringify([channel.id, account, entry.message.scopeId, conversation]))
          .digest("hex")}`;

      let session = yield* store.session(id);

      if (session === null) {
        if (config.model === null)
          return yield* Effect.fail(
            new ChannelError({
              reason: "configuration",
              message: "Select a model before starting messaging chat.",
            }),
          );
        session = yield* store.createSession(config.provider, config.model, "assistant", id);
      }

      yield* gatewayStorage(() => repo.attach(entry.id, conversation, session.id));

      if (active !== null)
        active.entry = { ...entry, conversationId: conversation, sessionId: session.id };
      yield* gatewayStorage(() => repo.state(entry.id, "executing"));
      yield* mark(entry.message, "working");
      yield* Effect.scoped(
        Effect.gen(function* () {
          // Discord typing expires after ten seconds; progress must never block inference.
          yield* channel.typing(conversation).pipe(
            Effect.catchTag("ChannelError", () => Effect.void),
            Effect.andThen(Effect.sleep("8 seconds")),
            Effect.forever,
            Effect.forkScoped,
          );
          yield* Stream.runDrain(
            agent.send(session.id, entry.message.text, { runId: entry.runId }),
          );
        }),
      );
      const run = yield* store.run(entry.runId);

      if (run !== null) {
        yield* finish(entry.id, answer(run));
        yield* mark(entry.message, run.status === "completed" ? "completed" : "stopped");
      }
    }).pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          if (Exit.isSuccess(exit)) return;
          yield* mark(entry.message, "stopped");

          if (Cause.hasInterrupts(exit.cause)) return;
          const error = Cause.findErrorOption(exit.cause);

          if (
            Option.isSome(error) &&
            error.value instanceof ChannelError &&
            ["unavailable", "uncertain"].includes(error.value.reason) &&
            entry.attempts < 3 &&
            (yield* store.run(entry.runId)) === null
          ) {
            const retryAt =
              clock.currentTimeMillisUnsafe() +
              Math.max(1000 * 2 ** entry.attempts, error.value.retryAfterMs ?? 0);

            yield* gatewayStorage(() => repo.retry(entry, retryAt));
          } else {
            const saved = yield* gatewayStorage(() => repo.item(entry.id));

            if (
              saved.conversationId !== null &&
              Option.isSome(error) &&
              !(error.value instanceof StoreError)
            ) {
              yield* finish(
                entry.id,
                "The request failed. Use /status in this conversation to inspect its session before sending a new request.",
                "failed",
              );
            } else yield* gatewayStorage(() => repo.state(entry.id, "failed"));
          }
        }),
      ),
    );

    const fiber = yield* execute.pipe(Effect.forkChild);
    active = { entry, fiber };

    const result = yield* Fiber.await(fiber).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          active = null;
        }),
      ),
    );

    if (Exit.isFailure(result)) {
      const failure = Cause.findErrorOption(result.cause);

      if (
        Cause.hasDies(result.cause) ||
        (Option.isSome(failure) && failure.value instanceof StoreError)
      )
        return yield* result;
      yield* Console.error(
        "Messaging request failed or was cancelled. Inspect gateway status and saved runs.",
      );
    }

    return true;
  });

  const deliverNext = Effect.gen(function* () {
    const delivery = yield* gatewayStorage(() =>
      repo.nextDelivery(channel.id, account, clock.currentTimeMillisUnsafe()),
    );

    if (delivery === null) return false;
    const entry = yield* gatewayStorage(() => repo.item(delivery.inboxId));
    const destination = entry.conversationId;

    if (!authorized(entry.message) || destination === null) {
      yield* gatewayStorage(() => repo.deliveryFailed(delivery, "failed", 0));

      return true;
    }

    const sent = Effect.gen(function* () {
      yield* channel.checkAccess(entry.message, destination);
      // Commit before the send. An interruption after this point is an uncertain delivery.
      yield* gatewayStorage(() => repo.delivering(delivery));

      const id = yield* channel.send(
        destination,
        delivery.text,
        `${entry.id}-${delivery.position}`,
      );

      yield* gatewayStorage(() => repo.delivered(delivery, id));
    });

    yield* sent.pipe(
      Effect.catchTag("ChannelError", (error) =>
        gatewayStorage(() =>
          repo.deliveryFailed(
            delivery,
            error.reason === "uncertain"
              ? "uncertain"
              : error.reason === "unavailable" && delivery.attempts < 3
                ? "pending"
                : "failed",
            clock.currentTimeMillisUnsafe() +
              Math.max(1000 * 2 ** delivery.attempts, error.retryAfterMs ?? 0),
          ),
        ),
      ),
    );

    return true;
  });

  const connectionStatus = channel.status.pipe(
    Effect.map((connection) => ({ ...connection, rejected })),
  );

  const status = Effect.gen(function* () {
    const connection = yield* connectionStatus;

    return { ...connection, ...(yield* gatewayStorage(() => repo.status())) };
  });

  const run = Effect.gen(function* () {
    yield* recover;
    yield* Effect.all(
      [
        Stream.runForEach(channel.messages, (message) =>
          accept(message).pipe(
            Effect.catchTag("ChannelError", (error) =>
              Effect.sync(() => {
                rejected++;
              }).pipe(Effect.andThen(Console.error(error.message))),
            ),
          ),
        ),
        processNext.pipe(Effect.andThen(Effect.sleep("100 millis")), Effect.forever),
        deliverNext.pipe(Effect.andThen(Effect.sleep("250 millis")), Effect.forever),
      ],
      { concurrency: 3, discard: true },
    );
  });

  return { accept, processNext, deliverNext, recover, connectionStatus, status, run };
});

export class Gateway extends Context.Service<Gateway, Effect.Success<typeof gateway>>()(
  "poppet/Gateway",
) {}

export const GatewayLive = Layer.effect(Gateway, gateway);
