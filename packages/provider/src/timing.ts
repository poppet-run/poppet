import { Cause, Clock, Context, Effect, Exit, Option } from "effect";

/** Request-scoped diagnostics contain durations and fixed labels, never prompt or credential data. */
export class RequestTiming extends Context.Service<
  RequestTiming,
  {
    readonly record: (timing: {
      readonly stage: string;
      readonly durationMs: number;
      readonly outcome?: "completed" | "failed" | "interrupted";
      readonly cached?: boolean;
    }) => Effect.Effect<void>;
  }
>()("poppet/RequestTiming") {}

export const recordTiming = (
  stage: string,
  startedAt: number,
  details: {
    readonly outcome?: "completed" | "failed" | "interrupted";
    readonly cached?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const timing = yield* Effect.serviceOption(RequestTiming);

    if (Option.isSome(timing))
      yield* timing.value.record({
        stage,
        durationMs: Math.max(0, (yield* Clock.currentTimeMillis) - startedAt),
        ...details,
      });
  });

/** Measures success, failure, and cancellation without changing the operation's result. */
export const measureTiming = <A, E, R>(
  stage: string,
  operation: Effect.Effect<A, E, R>,
  details: { readonly cached?: boolean } = {},
) =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;

    return yield* operation.pipe(
      Effect.onExit((exit) =>
        recordTiming(stage, startedAt, {
          ...details,
          outcome: Exit.isSuccess(exit)
            ? "completed"
            : Cause.hasInterrupts(exit.cause)
              ? "interrupted"
              : "failed",
        }),
      ),
    );
  });
