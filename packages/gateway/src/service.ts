import { createHash } from "node:crypto";

import { Agent, AgentError, Skills, sessionTitle, type ChatFailure } from "@poppet/agent";
import { AppConfig } from "@poppet/config";
import { DeliveryDestination, Store, StoreError } from "@poppet/store";
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
  Queue,
  Result,
  Schema,
  Stream,
} from "effect";

import { commandApprovals } from "#src/approvals";
import { ChannelError, IncomingMessage, MessagingChannel } from "#src/channel";
import {
  authorized as allowed,
  finish as finishEntry,
  loop,
  mark as markMessage,
  wake,
  type GatewayContext,
} from "#src/context";
import { conversationNaming } from "#src/conversation-naming";
import { failureDecision } from "#src/failure";
import { answer, chunks } from "#src/replies";
import { GatewayRepository, gatewayStorage, type Inbox } from "#src/repository";
import { messagingRequest, isCommandApproval, isControl } from "#src/request";

const gateway = Effect.gen(function* () {
  const channel = yield* MessagingChannel;
  const repo = yield* GatewayRepository;
  const store = yield* Store;
  const agent = yield* Agent;
  const skills = yield* Skills;
  const config = yield* AppConfig;
  const clock = yield* Clock.Clock;

  let active: { entry: Inbox; fiber: Fiber.Fiber<void, ChatFailure | ChannelError> } | null = null;

  // Loops wait for these signals instead of polling storage; timers still cover retries
  // and results committed by the task worker.
  const inboxWake = yield* Queue.make<void>({ capacity: 1, strategy: "dropping" });
  const deliveryWake = yield* Queue.make<void>({ capacity: 1, strategy: "dropping" });
  const namingWake = yield* Queue.make<void>({ capacity: 1, strategy: "dropping" });
  let rejected = 0;

  const context: GatewayContext = {
    channel,
    repo,
    store,
    clock,
    wakes: { inbox: inboxWake, delivery: deliveryWake, naming: namingWake },
  };

  const authorized = (message: IncomingMessage) => allowed(channel.policy, message);

  const { nameNext, externalNameChange } = yield* conversationNaming(authorized);

  const resolveDestination = (requested: string | null = null) =>
    Effect.gen(function* () {
      const conversationId = requested ?? channel.homeConversationId;

      if (conversationId === undefined)
        return yield* Effect.fail(
          new ChannelError({
            reason: "configuration",
            message: "Configure a home channel or select an explicit destination.",
          }),
        );

      const parentId = yield* channel.destination(conversationId);
      const account = yield* channel.accountId;

      const destination = yield* Schema.decodeUnknownEffect(DeliveryDestination)({
        adapter: channel.id,
        account,
        ownerId: channel.policy.ownerId,
        scopeId: channel.policy.scopeId,
        parentId,
        conversationId,
      }).pipe(
        Effect.mapError(
          () =>
            new ChannelError({
              reason: "configuration",
              message: "Invalid messaging destination.",
            }),
        ),
      );

      const message: IncomingMessage = {
        messageId: "scheduled-destination",
        senderId: destination.ownerId,
        scopeId: destination.scopeId,
        parentId,
        conversationId,
        text: "",
        mentioned: false,
      };

      if (!authorized(message))
        return yield* Effect.fail(
          new ChannelError({
            reason: "permission",
            message: "The destination is outside the authorized messaging server.",
          }),
        );
      yield* channel.checkAccess(message, conversationId);

      return destination;
    });

  const approvals = commandApprovals(channel);

  // Reconcile saved results rather than rerun inference after a crash or failed send.
  const scheduleResults = Effect.gen(function* () {
    const account = yield* channel.accountId;
    yield* gatewayStorage(repo.rejectScheduledDeliveries(channel.id, account));

    for (const item of yield* gatewayStorage(repo.scheduled(channel.id))) {
      const run = yield* store.run(item.runId);

      if (run?.status !== "completed") continue;
      const destination = item.destination;

      const enabled =
        destination.account === account &&
        destination.ownerId === channel.policy.ownerId &&
        destination.scopeId === channel.policy.scopeId;

      yield* gatewayStorage(
        repo.scheduleResult(
          item.id,
          item.runId,
          destination,
          chunks(answer(run), channel.textLimit),
          enabled,
        ),
      );
    }
  });

  const finish = (id: number, text: string, state = "completed") =>
    finishEntry(context, id, text, state);

  const mark = (message: IncomingMessage, state: "working" | "completed" | "stopped") =>
    markMessage(context, message, state);

  /** Reconciles saved runs with the inbox and leaves interrupted sends uncertain. */
  const recover = Effect.gen(function* () {
    const account = yield* channel.accountId;
    yield* gatewayStorage(repo.recoverDelivery(channel.id, account));

    for (const entry of yield* gatewayStorage(repo.executing(channel.id, account))) {
      const run = yield* store.run(entry.runId);

      if (run === null) yield* gatewayStorage(repo.state(entry.id, "queued"));
      else {
        yield* finish(entry.id, answer(run));
        yield* mark(entry.message, run.status === "completed" ? "completed" : "stopped");
      }
    }
  });

  /** Answers /status, /cancel, or an approval reply in a bound conversation without the model. */
  const handleControl = (
    entry: Inbox,
    message: IncomingMessage,
    conversation: string,
    session: string,
  ) =>
    Effect.gen(function* () {
      yield* mark(message, "working");
      yield* finish(entry.id, yield* controlReply(entry, message, conversation, session));
      yield* mark(message, "completed");
    });

  const controlReply = (
    entry: Inbox,
    message: IncomingMessage,
    conversation: string,
    session: string,
  ) =>
    Effect.gen(function* () {
      if (isCommandApproval(message.text)) {
        yield* channel.checkAccess(message, conversation);

        return yield* approvals.answer(conversation, message.text);
      }

      if (message.text === "/cancel") {
        yield* gatewayStorage(repo.cancel(channel.id, entry.account, conversation));

        if (active?.entry.conversationId === conversation) {
          const current = active;
          yield* gatewayStorage(repo.state(current.entry.id, "cancelled"));
          yield* Fiber.interrupt(current.fiber);
        }

        return "Cancelled this thread's queued and active request.";
      }

      const latestId = (yield* store.messages(session)).at(-1)?.runId;
      const latest = latestId ? yield* store.run(latestId) : null;
      const savedSession = yield* store.session(session);

      return `Session: ${session}\nTitle: ${savedSession?.title ?? session}\nSkill: ${savedSession?.skill?.name ?? "none"}\nLatest run: ${latest?.status ?? "none"}`;
    });

  /** Validates and deduplicates authorized input; status and cancellation bypass inference. */
  const accept = (input: IncomingMessage) =>
    Effect.gen(function* () {
      const account = yield* channel.accountId;

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
          : yield* gatewayStorage(repo.binding(channel.id, account, message.scopeId, conversation));

      if (session === null && !message.mentioned) return;

      const entry = yield* gatewayStorage(repo.accept(channel.id, account, message));

      if (entry === null) return;
      yield* wake(inboxWake);

      if (!isControl(message.text)) return;
      // Controls never create sessions or wait behind the model they may need to cancel.
      yield* gatewayStorage(repo.state(entry.id, "cancelled"));

      if (conversation === null || session === null) return;
      yield* handleControl(entry, message, conversation, session);
    });

  /** Resolves and binds a session before inference, reusing saved IDs and skill snapshots on recovery. */
  const prepareSession = (entry: Inbox) =>
    Effect.gen(function* () {
      const account = yield* channel.accountId;

      const ownerText = entry.message.text;
      const parsed = yield* messagingRequest(ownerText).pipe(Effect.result);
      const prompt = Result.isSuccess(parsed) ? parsed.success.prompt : ownerText;

      const created =
        entry.conversationId !== null
          ? { id: entry.conversationId, managedName: null }
          : yield* channel.naming.conversation(entry.message, sessionTitle(prompt));

      const conversation = created.id;
      yield* channel.checkAccess(entry.message, conversation);

      const reject = (text: string) =>
        Effect.gen(function* () {
          yield* gatewayStorage(repo.address(entry.id, conversation));
          yield* finish(entry.id, text, "failed");
          yield* mark(entry.message, "stopped");

          return null;
        });

      if (Result.isFailure(parsed)) return yield* reject(parsed.failure.message);
      const request = parsed.success;

      const existing = yield* gatewayStorage(
        repo.binding(channel.id, account, entry.message.scopeId, conversation),
      );

      // Fresh requests include their reserved run ID so recovery reuses the same skill snapshot.
      const id =
        entry.sessionId ??
        (request.fresh ? null : existing) ??
        `gateway-${createHash("sha256")
          .update(
            JSON.stringify([
              channel.id,
              account,
              entry.message.scopeId,
              conversation,
              ...(request.fresh ? [entry.runId] : []),
            ]),
          )
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

        const selected = yield* (
          request.skill === null ? Effect.succeed(null) : skills.load(request.skill)
        ).pipe(Effect.result);

        if (Result.isFailure(selected))
          return yield* reject(
            "Could not load the selected skill. Check it with skills list and skills show before starting a new session.",
          );

        session = yield* store.createSession(config.provider, config.model, {
          id,
          skill: selected.success,
        });
      }

      yield* gatewayStorage(
        repo.attach(entry.id, conversation, session.id, created.managedName, request.fresh),
      );

      return { conversation, session, prompt: request.prompt };
    });

  /** Executes the next eligible queued request, retrying setup only before a run exists. */
  const processNext = Effect.gen(function* () {
    const account = yield* channel.accountId;

    const entry = yield* gatewayStorage(
      repo.next(channel.id, account, clock.currentTimeMillisUnsafe()),
    );

    if (entry === null) return false;

    if (!authorized(entry.message)) {
      yield* gatewayStorage(repo.state(entry.id, "cancelled"));

      return true;
    }

    const execute = Effect.gen(function* () {
      yield* mark(entry.message, "working");
      const prepared = yield* prepareSession(entry);

      if (prepared === null) return;
      const { conversation, session, prompt } = prepared;

      if (active !== null)
        active.entry = { ...entry, conversationId: conversation, sessionId: session.id };
      yield* gatewayStorage(repo.state(entry.id, "executing"));
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
            agent.send(session.id, prompt, {
              runId: entry.runId,
              approveCommand: (request) => approvals.request(entry.message, conversation, request),
              home: resolveDestination().pipe(
                Effect.mapError(
                  (error) => new AgentError({ reason: "tool-permission", message: error.message }),
                ),
              ),
              here: Effect.gen(function* () {
                if (!authorized(entry.message))
                  return yield* Effect.fail(
                    new AgentError({
                      reason: "tool-permission",
                      message: "The current messaging owner is no longer authorized.",
                    }),
                  );

                return yield* resolveDestination(conversation).pipe(
                  Effect.mapError(
                    (error) =>
                      new AgentError({ reason: "tool-permission", message: error.message }),
                  ),
                );
              }),
            }),
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

          const { retryAfterMs, reply } = failureDecision(
            Option.getOrNull(Cause.findErrorOption(exit.cause)),
            entry.attempts,
          );

          if (retryAfterMs !== null && (yield* store.run(entry.runId)) === null) {
            yield* gatewayStorage(
              repo.retry(entry, clock.currentTimeMillisUnsafe() + retryAfterMs),
            );

            return;
          }

          const saved = yield* gatewayStorage(repo.item(entry.id));

          if (reply !== null && saved.conversationId !== null)
            yield* finish(entry.id, reply, "failed");
          else yield* gatewayStorage(repo.state(entry.id, "failed"));
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
      const failure = Option.getOrNull(Cause.findErrorOption(result.cause));

      if (Cause.hasDies(result.cause) || failure instanceof StoreError) return yield* result;
      yield* Console.error(
        "Messaging request failed or was cancelled. Inspect gateway status and saved runs.",
      );
    }

    return true;
  });

  /** Sends the next saved reply chunk without automatically retrying an uncertain delivery. */
  const deliverNext = Effect.gen(function* () {
    const account = yield* channel.accountId;
    yield* scheduleResults;

    const delivery = yield* gatewayStorage(
      repo.nextDelivery(channel.id, account, clock.currentTimeMillisUnsafe()),
    );

    if (delivery === null) return false;
    const entry = yield* gatewayStorage(repo.item(delivery.inboxId));
    const destination = entry.conversationId;

    if (!authorized(entry.message) || destination === null) {
      yield* gatewayStorage(repo.deliveryFailed(delivery, "failed", 0));

      return true;
    }

    yield* Effect.gen(function* () {
      yield* channel.checkAccess(entry.message, destination);
      // Commit before the send. An interruption after this point is an uncertain delivery.
      yield* gatewayStorage(repo.delivering(delivery));

      const id = yield* channel.send(
        destination,
        delivery.text,
        `${entry.id}-${delivery.position}`,
      );

      yield* gatewayStorage(repo.delivered(delivery, id));
      yield* wake(namingWake);
    }).pipe(
      Effect.catchTag("ChannelError", (error) =>
        gatewayStorage(
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

  /** Recovers once, then receives input, runs inference, and delivers replies concurrently. */
  const run = Effect.gen(function* () {
    yield* recover;

    const receive = Stream.runForEach(channel.messages, (message) =>
      accept(message).pipe(
        Effect.catchTag("ChannelError", (error) =>
          Effect.sync(() => {
            rejected++;
          }).pipe(Effect.andThen(Console.error(error.message))),
        ),
      ),
    );

    yield* Effect.all(
      [
        receive,
        loop(processNext, inboxWake, "5 seconds"),
        loop(deliverNext, deliveryWake, "1 second"),
        loop(nameNext, namingWake, "5 seconds"),
        Stream.runForEach(channel.naming.changes, externalNameChange),
      ],
      { concurrency: 5, discard: true },
    );
  });

  return {
    resolveDestination,
    accept,
    processNext,
    deliverNext,
    nameNext,
    externalNameChange,
    recover,
    connectionStatus,
    run,
  };
});

/** Coordinates authorized messaging input, saved agent runs, and durable reply delivery. */
export class Gateway extends Context.Service<Gateway, Effect.Success<typeof gateway>>()(
  "poppet/Gateway",
) {}

export const GatewayLive = Layer.effect(Gateway, gateway);
