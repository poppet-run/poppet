import type { ChatFailure } from "@poppet/agent";
import type { Store } from "@poppet/store";
import { type Clock, type Duration, Effect, type Fiber, Queue } from "effect";

import type { ChannelError, ChannelPolicy, IncomingMessage, MessagingChannel } from "#src/channel";
import { chunks } from "#src/replies";
import { type GatewayRepository, gatewayStorage, type Inbox } from "#src/repository";

/** Signals that let a loop run as soon as another loop gives it work. */
export interface GatewayWakes {
  readonly inbox: Queue.Queue<void>;
  readonly delivery: Queue.Queue<void>;
  readonly naming: Queue.Queue<void>;
}

/** The services and signals the gateway's loops share. */
export interface GatewayContext {
  readonly channel: MessagingChannel["Service"];
  readonly repo: GatewayRepository["Service"];
  readonly store: Store["Service"];
  readonly clock: Clock.Clock;
  readonly wakes: GatewayWakes;
}

/** The request processNext is executing, which /cancel interrupts in its conversation. */
export interface RunningRequest {
  current: { entry: Inbox; readonly fiber: Fiber.Fiber<void, ChatFailure | ChannelError> } | null;
}

export const authorized = (policy: ChannelPolicy, message: IncomingMessage) =>
  message.senderId === policy.ownerId && message.scopeId === policy.scopeId;

export const wake = (queue: Queue.Queue<void>) => Queue.offer(queue, undefined).pipe(Effect.asVoid);

// Repeat immediately after useful work; otherwise wait for a signal or the fallback timer.
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

/** Saves an inbox entry's reply chunks and wakes delivery. */
export const finish = (context: GatewayContext, id: number, text: string, state = "completed") =>
  gatewayStorage(context.repo.complete(id, chunks(text, context.channel.textLimit), state)).pipe(
    Effect.andThen(wake(context.wakes.delivery)),
  );

// shortcut: Reactions are best effort; add durable reconciliation if stale markers after crashes matter.
export const mark = (
  context: GatewayContext,
  message: IncomingMessage,
  state: "working" | "completed" | "stopped",
) => context.channel.mark(message, state).pipe(Effect.catchTag("ChannelError", () => Effect.void));
