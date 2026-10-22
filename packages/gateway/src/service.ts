import { createHash } from "node:crypto";

import {
  Agent,
  AgentError,
  Skills,
  loadProject,
  sessionTitle,
  type ChatFailure,
} from "@poppet/agent";
import { AppConfig } from "@poppet/config";
import { DeliveryDestination, Store, StoreError, type Run } from "@poppet/store";
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
  Result,
  Schema,
  Stream,
} from "effect";

import { AttachmentProcessor } from "#src/attachments";
import { ChannelError, IncomingMessage, MessagingChannel } from "#src/channel";
import { GatewayRepository, gatewayStorage, type Inbox } from "#src/repository";
import { messagingRequest } from "#src/request";

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
  const skills = yield* Skills;
  const config = yield* AppConfig;
  const clock = yield* Clock.Clock;
  const processor = Option.getOrNull(yield* Effect.serviceOption(AttachmentProcessor));
  const account = channel.accountId;

  const overloadReply = channel.poll
    ? chunks(
        "Messaging queue is full. This request was not queued. Try again later.",
        channel.textLimit,
      )
    : undefined;

  let active: { entry: Inbox; fiber: Fiber.Fiber<void, ChatFailure | ChannelError> } | null = null;
  let rejected = 0;

  const authorized = (message: IncomingMessage) =>
    message.senderId === channel.policy.ownerId &&
    message.scopeId === channel.policy.scopeId &&
    channel.policy.parentIds.includes(message.parentId);

  const resolveDestination = (conversationId: string) =>
    Effect.gen(function* () {
      if (!channel.destination)
        return yield* Effect.fail(
          new ChannelError({
            reason: "configuration",
            message: "This adapter does not support scheduled destinations.",
          }),
        );
      const parentId = yield* channel.destination(conversationId);

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
            message: "The destination is outside the authorized messaging channels.",
          }),
        );
      yield* channel.checkAccess(message, conversationId);

      return destination;
    });

  // Reconcile saved results rather than rerun inference after a crash or failed send.
  const scheduleResults = Effect.gen(function* () {
    yield* gatewayStorage(() => repo.rejectChangedAccounts(channel.id, account));

    for (const item of yield* gatewayStorage(() => repo.scheduled(channel.id))) {
      const run = yield* store.run(item.runId);

      if (run?.status !== "completed") continue;
      const destination = item.destination;

      const enabled =
        destination.account === account &&
        destination.ownerId === channel.policy.ownerId &&
        destination.scopeId === channel.policy.scopeId &&
        channel.policy.parentIds.includes(destination.parentId);

      yield* gatewayStorage(() =>
        repo.scheduleResult(
          item.id,
          item.runId,
          destination,
          chunks(item.notificationText ?? answer(run), channel.textLimit),
          enabled,
        ),
      );
    }

    for (const item of yield* gatewayStorage(() =>
      repo.proposals(channel.id, clock.currentTimeMillisUnsafe()),
    )) {
      const destination = item.destination;

      const enabled =
        destination.account === account &&
        destination.ownerId === channel.policy.ownerId &&
        destination.scopeId === channel.policy.scopeId &&
        channel.policy.parentIds.includes(destination.parentId);

      const text = `Note proposal prepared for owner review. This is not an execution receipt.\nID: ${item.id}\nPath: ${item.path}\nPayload SHA-256: ${item.digest}\nExpires: ${new Date(item.expiresAt).toISOString()}\nReview full content and current state locally: approvals show ${item.id}\nApprove or cancel using the local approvals CLI. Chat replies and reactions cannot approve it.`;
      yield* gatewayStorage(() =>
        repo.scheduleResult(
          item.id,
          item.runId,
          destination,
          chunks(text, channel.textLimit),
          enabled,
          true,
        ),
      );
    }
  });

  const finish = (id: number, text: string, state = "completed") =>
    gatewayStorage(() => {
      const source = repo.attachment(id)?.result;

      const receipt =
        source === null || source === undefined
          ? ""
          : source.kind === "voice"
            ? `Transcript (local speech recognition):\n${source.text}\n\nAny action needs your confirmation in a subsequent text message.\n\n`
            : `Document ${JSON.stringify(source.name)}: ${source.completeness}\n\n`;

      repo.complete(id, chunks(`${receipt}${text}`, channel.textLimit), state);
    });

  // shortcut: Reactions are best effort; add durable reconciliation if stale markers after crashes matter.
  const mark = (message: IncomingMessage, state: "working" | "completed" | "stopped") =>
    channel.mark(message, state).pipe(Effect.catchTag("ChannelError", () => Effect.void));

  /** Reconciles saved runs with the inbox and leaves interrupted sends uncertain. */
  const recover = Effect.gen(function* () {
    yield* gatewayStorage(() => repo.recoverDelivery(channel.id, account));

    for (const entry of yield* gatewayStorage(() => repo.executing(channel.id, account))) {
      const run = yield* store.run(entry.runId);

      if (run === null) {
        const processing = yield* gatewayStorage(
          () => repo.attachment(entry.id)?.state === "processing",
        );

        if (processing && entry.attempts >= 3) {
          yield* gatewayStorage(() =>
            repo.extractionFailed(
              entry.id,
              "Attachment processing was repeatedly interrupted. Send the file again.",
            ),
          );
          yield* finish(
            entry.id,
            "Attachment processing was repeatedly interrupted. Send the file again.",
            "failed",
          );
        } else if (processing) yield* gatewayStorage(() => repo.retry(entry, 0));
        else yield* gatewayStorage(() => repo.state(entry.id, "queued"));
      } else {
        yield* finish(entry.id, answer(run));
        yield* mark(entry.message, run.status === "completed" ? "completed" : "stopped");
      }
    }
  });

  /** Validates and deduplicates authorized input; status and cancellation bypass inference. */
  const accept = (input: IncomingMessage) =>
    Effect.gen(function* () {
      const message = yield* Schema.decodeUnknownEffect(IncomingMessage)(input).pipe(
        Effect.mapError(
          () => new ChannelError({ reason: "configuration", message: "Invalid incoming message." }),
        ),
      );

      if (!authorized(message) || (!message.text.trim() && message.attachment === undefined))
        return;
      const conversation = message.conversationId;

      const session =
        conversation === null
          ? null
          : yield* gatewayStorage(() =>
              repo.binding(channel.id, account, message.scopeId, conversation),
            );

      if (conversation === null && !message.mentioned) return;

      const entry = yield* gatewayStorage(() =>
        repo.accept(channel.id, account, message, overloadReply),
      );

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
        const savedSession = yield* store.session(session);
        yield* finish(
          entry.id,
          `Session: ${session}\nTitle: ${savedSession?.title ?? session}\nSkill: ${savedSession?.skill?.name ?? "none"}\nProject snapshot: ${savedSession?.project?.name ?? "none"}\nLatest run: ${latest?.status ?? "none"}`,
        );
      }

      yield* mark(message, "completed");
    });

  /** Resolves and binds a session before inference, reusing saved IDs and skill snapshots on recovery. */
  const prepareSession = (entry: Inbox) =>
    Effect.gen(function* () {
      const ownerText =
        entry.message.text ||
        (entry.message.attachment?.kind === "voice"
          ? "Respond to this voice transcript. For a requested action, propose it with the resolved time/timezone and ask for confirmation in a subsequent text message. Do not perform it."
          : `Give a short summary of ${JSON.stringify(entry.message.attachment?.name ?? "this attachment")}.`);

      const parsed = yield* messagingRequest(ownerText).pipe(Effect.result);
      const prompt = Result.isSuccess(parsed) ? parsed.success.prompt : ownerText;

      const created =
        entry.conversationId !== null
          ? { id: entry.conversationId, managedName: null }
          : channel.naming
            ? yield* channel.naming.conversation(entry.message, sessionTitle(prompt))
            : { id: yield* channel.conversation(entry.message), managedName: null };

      const conversation = created.id;
      yield* channel.checkAccess(entry.message, conversation);

      const reject = (text: string) =>
        Effect.gen(function* () {
          yield* gatewayStorage(() => repo.address(entry.id, conversation));
          yield* finish(entry.id, text, "failed");
          yield* mark(entry.message, "stopped");

          return null;
        });

      if (Result.isFailure(parsed)) return yield* reject(parsed.failure.message);
      const request = parsed.success;

      const existing = yield* gatewayStorage(() =>
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

        const project = yield* (
          request.project === null ? Effect.succeed(null) : loadProject(request.project)
        ).pipe(Effect.result);

        if (Result.isFailure(project))
          return yield* reject(
            "Could not load the selected project. Check projects show and create a new session after correcting its files.",
          );
        session = yield* store.createSession(config.provider, config.model, {
          id,
          skill: selected.success,
          project: project.success,
        });
      }

      yield* gatewayStorage(() =>
        repo.attach(entry.id, conversation, session.id, created.managedName, request.fresh),
      );

      return { conversation, session, prompt: request.prompt };
    });

  /** Executes the next eligible queued request, retrying setup only before a run exists. */
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
      yield* mark(entry.message, "working");
      const prepared = yield* prepareSession(entry);

      if (prepared === null) return;
      const { conversation, session, prompt } = prepared;

      if (active !== null)
        active.entry = { ...entry, conversationId: conversation, sessionId: session.id };
      yield* gatewayStorage(() => repo.state(entry.id, "executing"));
      yield* Effect.scoped(
        Effect.gen(function* () {
          // Discord typing expires after ten seconds; progress must never block inference.
          yield* channel.typing(conversation).pipe(
            Effect.catchTag("ChannelError", () => Effect.void),
            Effect.andThen(Effect.sleep("8 seconds")),
            Effect.forever,
            Effect.forkScoped,
          );
          let source;

          if (entry.message.attachment !== undefined) {
            const saved = yield* gatewayStorage(() => repo.attachment(entry.id));

            if (saved?.state === "failed")
              return yield* Effect.fail(
                new ChannelError({
                  reason: "attachment",
                  message: saved.failure ?? "Attachment processing failed. Send the file again.",
                }),
              );
            source = saved?.result ?? undefined;

            if (source === undefined) {
              yield* gatewayStorage(() => repo.processing(entry.id));

              if (processor === null || channel.download === undefined)
                return yield* Effect.fail(
                  new ChannelError({
                    reason: "attachment",
                    message: "Attachment processing is unavailable for this adapter.",
                  }),
                );
              const maxBytes = yield* processor.limit(entry.message.attachment);
              const bytes = yield* channel.download(entry.message, maxBytes);
              const extracted = yield* processor.extract(entry.message.attachment, bytes);
              yield* gatewayStorage(() => repo.extracted(entry.id, extracted));
              source = extracted;
            }
          }

          yield* Stream.runDrain(
            agent.send(session.id, prompt, {
              runId: entry.runId,
              source,
              readOnlyTools: source !== undefined && !entry.message.text,
              taskDestination: Effect.gen(function* () {
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

          if (Cause.hasInterrupts(exit.cause)) {
            yield* gatewayStorage(() => {
              if (
                repo.item(entry.id).state === "cancelled" &&
                repo.attachment(entry.id)?.state === "processing"
              )
                repo.extractionFailed(entry.id, "Attachment processing was cancelled.");
            });

            return;
          }

          const error = Option.getOrNull(Cause.findErrorOption(exit.cause));

          if (
            entry.message.attachment !== undefined &&
            error instanceof ChannelError &&
            error.reason === "attachment"
          )
            yield* gatewayStorage(() => {
              repo.processing(entry.id);
              repo.extractionFailed(entry.id, error.message);
            });

          if (
            error instanceof ChannelError &&
            ["unavailable", "uncertain"].includes(error.reason) &&
            entry.attempts < 3 &&
            (yield* store.run(entry.runId)) === null
          ) {
            const retryAt =
              clock.currentTimeMillisUnsafe() +
              Math.max(1000 * 2 ** entry.attempts, error.retryAfterMs ?? 0);

            yield* gatewayStorage(() => repo.retry(entry, retryAt));
          } else {
            const saved = yield* gatewayStorage(() => repo.item(entry.id));

            if (entry.message.attachment !== undefined && error instanceof ChannelError)
              yield* gatewayStorage(() => {
                if (repo.attachment(entry.id)?.state === "processing")
                  repo.extractionFailed(entry.id, error.message);
              });

            if (saved.conversationId !== null && error !== null && !(error instanceof StoreError)) {
              yield* finish(
                entry.id,
                error instanceof ChannelError && error.reason === "attachment"
                  ? error.message
                  : error instanceof AgentError &&
                      error.reason === "context-limit" &&
                      entry.message.attachment !== undefined
                    ? "This attachment and request exceed the configured conversation context budget. Send a shorter file or caption. No inference was started."
                    : "The request failed. Use /status in this conversation to inspect its session before sending a new request.",
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
    yield* scheduleResults;

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

    yield* Effect.gen(function* () {
      yield* channel.checkAccess(entry.message, destination);
      // Commit before the send. An interruption after this point is an uncertain delivery.
      yield* gatewayStorage(() => repo.delivering(delivery));

      const id = yield* channel.send(
        destination,
        delivery.text,
        `${entry.id}-${delivery.position}`,
      );

      yield* gatewayStorage(() => repo.delivered(delivery, id));
    }).pipe(
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

  // A failed or uncertain rename is inspected once, never blindly replayed.
  const syncName = (entry: Inbox) =>
    Effect.gen(function* () {
      const naming = channel.naming;
      const destination = entry.conversationId;

      if (!naming || destination === null || !authorized(entry.message)) return;

      const binding = yield* gatewayStorage(() =>
        repo.namedBinding(channel.id, account, destination),
      );

      if (
        !binding ||
        binding.sessionId !== entry.sessionId ||
        binding.namingDisabled ||
        binding.managedName === null ||
        binding.creationMessageId === null
      )
        return;
      const current = yield* naming.current(entry.message, destination);

      if (binding.pendingName !== null && current === binding.pendingName) {
        yield* gatewayStorage(() =>
          repo.nameConfirmed(channel.id, account, destination, current, binding.sessionId),
        );
      } else if (current !== binding.managedName || binding.pendingName !== null) {
        yield* gatewayStorage(() =>
          repo.disableNaming(channel.id, account, destination, binding.sessionId),
        );

        return;
      }

      const session = yield* store.session(binding.sessionId);
      const title = session?.title;
      yield* gatewayStorage(() =>
        repo.nameAttempted(channel.id, account, destination, title ?? null, binding.sessionId),
      );

      if (!title || naming.sanitize(title) === current) return;
      const desired = naming.sanitize(title);

      const pending = yield* gatewayStorage(() =>
        repo.namePending(channel.id, account, destination, desired, binding.sessionId),
      );

      if (!pending) return;

      const result = yield* naming
        .rename(entry.message, destination, current, desired)
        .pipe(Effect.result);

      if (Result.isSuccess(result)) {
        const confirmed = result.success;

        if (confirmed === null)
          yield* gatewayStorage(() =>
            repo.disableNaming(channel.id, account, destination, binding.sessionId),
          );
        else
          yield* gatewayStorage(() =>
            repo.nameConfirmed(channel.id, account, destination, confirmed, binding.sessionId),
          );

        return;
      }

      // A fresh fetch reconciles a lost acknowledgement without sending a second rename.
      const observed = yield* naming.current(entry.message, destination).pipe(Effect.result);

      if (Result.isSuccess(observed) && observed.success === desired)
        yield* gatewayStorage(() =>
          repo.nameConfirmed(channel.id, account, destination, observed.success, binding.sessionId),
        );
      else
        yield* gatewayStorage(() =>
          repo.disableNaming(channel.id, account, destination, binding.sessionId),
        );
    }).pipe(
      Effect.timeout("10 seconds"),
      Effect.catch(() =>
        entry.conversationId === null || entry.sessionId === null
          ? Effect.void
          : gatewayStorage(() =>
              repo.disableNaming(channel.id, account, entry.conversationId!, entry.sessionId!),
            ).pipe(Effect.asVoid),
      ),
    );

  const nameNext = Effect.gen(function* () {
    const entries = yield* gatewayStorage(() => repo.namingEntries(channel.id, account));

    for (const entry of entries) {
      if (entry.sessionId === null) continue;
      yield* agent.nameSession(entry.sessionId);
      yield* syncName(entry);
    }
  });

  const externalNameChange = (destination: string) =>
    Effect.gen(function* () {
      const entry = yield* gatewayStorage(() => repo.namingEntry(channel.id, account, destination));

      if (!entry || !channel.naming) return;

      const binding = yield* gatewayStorage(() =>
        repo.namedBinding(channel.id, account, destination),
      );

      if (!binding || binding.namingDisabled || binding.managedName === null) return;
      const current = yield* channel.naming.current(entry.message, destination);

      if (current !== binding.managedName && current !== binding.pendingName)
        yield* gatewayStorage(() =>
          repo.disableNaming(channel.id, account, destination, binding.sessionId),
        );
    }).pipe(Effect.catch(() => Effect.void));

  const connectionStatus = channel.status.pipe(
    Effect.map((connection) => ({ ...connection, rejected })),
  );

  const pollOnce = Effect.gen(function* () {
    if (!channel.poll) return;
    const cursor = yield* gatewayStorage(() => repo.cursor(channel.id, account));
    const updates = yield* channel.poll(cursor);

    for (const update of updates) {
      if (update.message !== null) yield* accept(update.message);
      // A crash before this write safely redelivers an already deduplicated inbox entry.
      yield* gatewayStorage(() => repo.checkpoint(channel.id, account, update.cursor));
    }
  });

  /** Recovers once, then receives input, runs inference, and delivers replies concurrently. */
  const run = Effect.gen(function* () {
    yield* recover;

    const receive = channel.poll
      ? pollOnce.pipe(
          Effect.catchTag("ChannelError", (error) =>
            Effect.sleep(Math.max(1000, error.retryAfterMs ?? 1000)),
          ),
          Effect.andThen(Effect.sleep("100 millis")),
          Effect.forever,
        )
      : Stream.runForEach(channel.messages, (message) =>
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
        processNext.pipe(Effect.andThen(Effect.sleep("100 millis")), Effect.forever),
        deliverNext.pipe(Effect.andThen(Effect.sleep("250 millis")), Effect.forever),
        nameNext.pipe(Effect.andThen(Effect.sleep("1 second")), Effect.forever),
        channel.naming
          ? Stream.runForEach(channel.naming.changes, externalNameChange)
          : Effect.never,
      ],
      { concurrency: 5, discard: true },
    );
  });

  return {
    resolveDestination,
    pollOnce,
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
