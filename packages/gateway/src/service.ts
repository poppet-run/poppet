import { Agent, ChatSettings, Skills } from "@poppet/agent";
import type { ChatFailure } from "@poppet/agent";
import { AppConfig, quietHours } from "@poppet/config";
import { Store } from "@poppet/store";
import type { StoreError } from "@poppet/store";
import { Clock, Context, Effect, FiberSet, Layer, Queue, Stream } from "effect";

import { GatewayAdapter } from "#src/adapter";
import type { GatewayError, IncomingMessage } from "#src/adapter";
import { actionApprovals } from "#src/approvals/approvals";
import { resolveDestination } from "#src/destination";
import { accept } from "#src/pipeline/accept";
import { loop, runningRequests } from "#src/pipeline/context";
import type { GatewayContext } from "#src/pipeline/context";
import { conversationNaming } from "#src/pipeline/conversation-naming";
import { deliverNext } from "#src/pipeline/delivery";
import { dispatchNext, processNext, recover } from "#src/pipeline/execution";
import type { Execution } from "#src/pipeline/execution";
import { GatewayRepository } from "#src/repository";

const gateway = Effect.gen(function* () {
  const adapter = yield* GatewayAdapter;
  const agent = yield* Agent;

  const context: GatewayContext = {
    adapter,
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
  const approvals = actionApprovals(context);

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

  const handleGatewayError = (error: GatewayError) =>
    Effect.sync(() => {
      rejected++;
    }).pipe(
      Effect.andThen(
        Effect.logWarning("messaging message rejected").pipe(
          Effect.annotateLogs({ error: error.message }),
        ),
      ),
    );

  const service = {
    resolveDestination: (requested: string | null = null) => resolveDestination(adapter, requested),
    accept: (input: IncomingMessage) => accept(context, { approvals, running }, input),
    answerApproval: approvals.answerAction,
    processNext: processNext(context, execution),
    deliverNext: deliverNext(context),
    nameNext,
    externalNameChange,
    recover: recover(context, approvals),
    sweepApprovals: approvals.sweep,
    connectionStatus: adapter.status.pipe(
      Effect.map((connection) => Object.assign({}, connection, { rejected })),
    ),
  };

  const run = Effect.gen(function* () {
    yield* service.recover;
    const active = yield* FiberSet.make<void, ChatFailure | GatewayError>();
    const controlFibers = yield* FiberSet.make<void, StoreError>();

    const receive = Stream.runForEach(adapter.messages, (message) =>
      accept(
        context,
        {
          approvals,
          running,
          scheduleControl: (effect) =>
            FiberSet.run(
              controlFibers,
              effect.pipe(Effect.catchTag("GatewayError", handleGatewayError)),
            ).pipe(Effect.asVoid),
        },
        message,
      ).pipe(Effect.catchTag("GatewayError", handleGatewayError)),
    );

    yield* Effect.all(
      [
        receive,
        FiberSet.join(controlFibers),
        Stream.runForEach(adapter.approvals?.actions ?? Stream.never, (action) =>
          approvals.answerAction(action),
        ).pipe(
          Effect.catchTag("GatewayError", (error) =>
            Effect.logWarning("messaging approval action failed").pipe(
              Effect.annotateLogs({ error: error.message }),
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
        approvals.sweep.pipe(Effect.andThen(Effect.sleep("5 seconds")), Effect.forever),
        loop(nameNext, context.wakes.naming, "5 seconds"),
        Stream.runForEach(adapter.naming.changes, externalNameChange),
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
