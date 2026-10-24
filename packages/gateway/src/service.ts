import { Agent, Skills } from "@poppet/agent";
import { AppConfig } from "@poppet/config";
import { Store } from "@poppet/store";
import { Clock, Console, Context, Effect, Layer, Queue, Stream } from "effect";

import { accept } from "#src/accept";
import { commandApprovals } from "#src/approvals";
import { MessagingChannel, type IncomingMessage } from "#src/channel";
import { loop, type GatewayContext, type RunningRequest } from "#src/context";
import { conversationNaming } from "#src/conversation-naming";
import { deliverNext } from "#src/delivery";
import { resolveDestination } from "#src/destination";
import { processNext, recover, type Execution } from "#src/execution";
import { GatewayRepository } from "#src/repository";

const gateway = Effect.gen(function* () {
  const channel = yield* MessagingChannel;
  const agent = yield* Agent;

  const context: GatewayContext = {
    channel,
    repo: yield* GatewayRepository,
    store: yield* Store,
    clock: yield* Clock.Clock,
    // Loops wait for these signals instead of polling storage; timers still cover retries
    // and results committed by the task worker.
    wakes: {
      inbox: yield* Queue.make<void>({ capacity: 1, strategy: "dropping" }),
      delivery: yield* Queue.make<void>({ capacity: 1, strategy: "dropping" }),
      naming: yield* Queue.make<void>({ capacity: 1, strategy: "dropping" }),
    },
  };

  const running: RunningRequest = { current: null };
  const approvals = commandApprovals(channel);

  const execution: Execution = {
    agent,
    setup: { config: yield* AppConfig, skills: yield* Skills },
    approvals,
    running,
  };

  const { nameNext, externalNameChange } = conversationNaming(context, agent);
  let rejected = 0;

  const service = {
    resolveDestination: (requested: string | null = null) => resolveDestination(channel, requested),
    accept: (input: IncomingMessage) => accept(context, { approvals, running }, input),
    processNext: processNext(context, execution),
    deliverNext: deliverNext(context),
    nameNext,
    externalNameChange,
    recover: recover(context),
    connectionStatus: channel.status.pipe(
      Effect.map((connection) => ({ ...connection, rejected })),
    ),
  };

  /** Recovers once, then receives input, runs inference, and delivers replies concurrently. */
  const run = Effect.gen(function* () {
    yield* service.recover;

    const receive = Stream.runForEach(channel.messages, (message) =>
      service.accept(message).pipe(
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
        loop(service.processNext, context.wakes.inbox, "5 seconds"),
        loop(service.deliverNext, context.wakes.delivery, "1 second"),
        loop(nameNext, context.wakes.naming, "5 seconds"),
        Stream.runForEach(channel.naming.changes, externalNameChange),
      ],
      { concurrency: 5, discard: true },
    );
  });

  return { ...service, run };
});

/** Coordinates authorized messaging input, saved agent runs, and durable reply delivery. */
export class Gateway extends Context.Service<Gateway, Effect.Success<typeof gateway>>()(
  "poppet/Gateway",
) {}

export const GatewayLive = Layer.effect(Gateway, gateway);
