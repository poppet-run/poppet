import type { ChatFailure } from "@poppet/agent";
import type { Store } from "@poppet/store";
import { type Clock, type Duration, Effect, type Fiber, Queue, Semaphore } from "effect";

import type { ChannelError, ChannelPolicy, IncomingMessage, MessagingChannel } from "#src/channel";
import { chunks } from "#src/replies";
import type { GatewayRepository, Inbox } from "#src/repository";

export interface GatewayWakes {
  readonly inbox: Queue.Queue<void>;
  readonly delivery: Queue.Queue<void>;
  readonly naming: Queue.Queue<void>;
}

export interface GatewayContext {
  readonly channel: MessagingChannel["Service"];
  readonly repo: GatewayRepository["Service"];
  readonly store: Store["Service"];
  readonly clock: Clock.Clock;
  readonly wakes: GatewayWakes;
}

export interface RunningRequest {
  readonly requests: Map<
    number,
    { entry: Inbox; readonly fiber: Fiber.Fiber<void, ChatFailure | ChannelError> }
  >;
  readonly claims: Semaphore.Semaphore;
}

export const runningRequests = (): RunningRequest => ({
  requests: new Map(),
  claims: Semaphore.makeUnsafe(1),
});

export const authorized = (policy: ChannelPolicy, message: IncomingMessage) =>
  message.senderId === policy.ownerId && message.scopeId === policy.scopeId;

export const wake = (queue: Queue.Queue<void>) => Queue.offer(queue, undefined).pipe(Effect.asVoid);

export const loop = <E>(
  step: Effect.Effect<boolean | void, E>,
  signal: Queue.Queue<void>,
  fallback: Duration.Input,
) =>
  step.pipe(
    Effect.flatMap((worked) =>
      worked === true ? Effect.void : Effect.raceFirst(Queue.take(signal), Effect.sleep(fallback)),
    ),
    Effect.forever,
  );

export const finish = (
  context: GatewayContext,
  id: number,
  text: string,
  state: "completed" | "failed" = "completed",
) =>
  context.repo
    .complete(id, chunks(text, context.channel.textLimit), state)
    .pipe(Effect.andThen(wake(context.wakes.delivery)));

export const mark = (
  context: GatewayContext,
  message: IncomingMessage,
  state: "working" | "completed" | "stopped",
) => context.channel.mark(message, state).pipe(Effect.catchTag("ChannelError", () => Effect.void));
