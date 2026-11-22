import { Agent, ChatSettings, Skills, type ChatFailure } from "@poppet/agent";
import { AppConfig, quietHours } from "@poppet/config";
import { Store, type StoreError } from "@poppet/store";
import { Clock, Context, Effect, FiberSet, Layer, Queue, Stream } from "effect";

import { accept } from "#src/accept";
import { actionApprovals } from "#src/approvals";
import { MessagingChannel, type ChannelError, type IncomingMessage } from "#src/channel";
import { loop, runningRequests, type GatewayContext } from "#src/context";
import { conversationNaming } from "#src/conversation-naming";
import { deliverNext } from "#src/delivery";
import { resolveDestination } from "#src/destination";
import { dispatchNext, processNext, recover, type Execution } from "#src/execution";
import { GatewayRepository } from "#src/repository";

const gateway = Effect.gen(function* () {
  const channel = yield* MessagingChannel;
  const agent = yield* Agent;

  const context: GatewayContext = {
    channel,
    repo: yield* GatewayRepository,
    store: yield* Store,
    clock: yield* Clock.Clock,
    quietHours: yield* quietHours,
    wakes: {
      inbox: yield* Queue.make<void>({ capacity: 1, strategy: "dropping" }),
      delivery: yield* Queue.make<void>({ capacity: 1, strategy: "dropping" }),
      naming: yield* Queue.make<void>({ capacity: 1, strategy: "dropping" }),
    },
  };

  const running = runningRequests();
  const { maxConcurrentRequests, imageBytes, textFileBytes } = yield* ChatSettings;
  const approvals = actionApprovals(channel);

  const execution: Execution = {
    agent,
    setup: {
      config: yield* AppConfig,
      skills: yield* Skills,
      attachmentBytes: Math.max(imageBytes, textFileBytes),
    },
    approvals,
    running,
  };

  const { nameNext, externalNameChange } = conversationNaming(context, agent);
  let rejected = 0;

  const service = {
    resolveDestination: (requested: string | null = null) => resolveDestination(channel, requested),
    accept: (input: IncomingMessage) => accept(context, { approvals, running }, input),
    answerApproval: approvals.answerAction,
    processNext: processNext(context, execution),
    deliverNext: deliverNext(context),
    nameNext,
    externalNameChange,
    recover: recover(context),
    connectionStatus: channel.status.pipe(
      Effect.map((connection) => ({ ...connection, rejected })),
    ),
  };

  const run = Effect.gen(function* () {
    yield* service.recover;
    const active = yield* FiberSet.make<void, ChatFailure | ChannelError>();
    const controlFibers = yield* FiberSet.make<void, StoreError>();

    const handleChannelError = (error: ChannelError) =>
      Effect.sync(() => {
        rejected++;
      }).pipe(
        Effect.andThen(
          Effect.logWarning("messaging message rejected").pipe(
            Effect.annotateLogs({ error: error.message }),
          ),
        ),
      );

    const receive = Stream.runForEach(channel.messages, (message) =>
      accept(
        context,
        {
          approvals,
          running,
          scheduleControl: (effect) =>
            FiberSet.run(
              controlFibers,
              effect.pipe(Effect.catchTag("ChannelError", handleChannelError)),
            ).pipe(Effect.asVoid),
        },
        message,
      ).pipe(Effect.catchTag("ChannelError", handleChannelError)),
    );

    yield* Effect.all(
      [
        receive,
        FiberSet.join(controlFibers),
        Stream.runForEach(channel.approvals?.actions ?? Stream.never, (action) =>
          approvals.answerAction(action).pipe(
            Effect.catchTag("ChannelError", (error) =>
              Effect.logWarning("messaging approval action failed").pipe(
                Effect.annotateLogs({ error: error.message }),
              ),
            ),
          ),
        ),
        loop(
          dispatchNext(context, execution, active, maxConcurrentRequests),
          context.wakes.inbox,
          "5 seconds",
        ),
        FiberSet.join(active),
        loop(service.deliverNext, context.wakes.delivery, "1 second"),
        loop(nameNext, context.wakes.naming, "5 seconds"),
        Stream.runForEach(channel.naming.changes, externalNameChange),
      ],
      { concurrency: "unbounded", discard: true },
    );
  }).pipe(Effect.scoped);

  return { ...service, run };
});

export class Gateway extends Context.Service<Gateway, Effect.Success<typeof gateway>>()(
  "poppet/Gateway",
) {}

export const GatewayLive = Layer.effect(Gateway, gateway);
