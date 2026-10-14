import {
  interrupted,
  validateRequest,
  type ModelDescription,
  type ModelEvent,
  type ModelRequest,
  type ProviderError,
} from "@poppet/provider";
import { Effect, Stream } from "effect";

import { inferenceFailure } from "#src/errors";

// The stream scope owns both cancellation and an absolute request deadline.
// Taking only a delta still aborts the underlying request when the consumer exits.
export const modelStream = (
  description: ModelDescription,
  request: ModelRequest,
  open: (
    request: ModelRequest,
    signal: AbortSignal,
  ) => Effect.Effect<AsyncIterable<ModelEvent>, ProviderError>,
  failure: (cause: unknown) => ProviderError = (cause) =>
    inferenceFailure(description.provider, cause),
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const decoded = yield* validateRequest(description, request);

      const controller = yield* Effect.acquireRelease(
        Effect.sync(() => new AbortController()),
        (owned) => Effect.sync(() => owned.abort()),
      );

      let expired = false;

      yield* Effect.sleep("60 seconds").pipe(
        Effect.andThen(
          Effect.sync(() => {
            expired = true;
            controller.abort();
          }),
        ),
        Effect.forkScoped,
      );

      const iterable = yield* open(decoded, controller.signal).pipe(
        Effect.mapError((error) =>
          expired ? interrupted(description.provider, "The inference deadline expired.") : error,
        ),
      );

      const cancellable: AsyncIterable<ModelEvent> = {
        [Symbol.asyncIterator]: () => {
          const iterator = iterable[Symbol.asyncIterator]();

          return {
            next: () => iterator.next(),
            return: async () => {
              // Abort before awaiting return: an async generator may still be blocked
              // reading the network, so its own finally block cannot close it yet.
              controller.abort();

              return iterator.return ? iterator.return() : { done: true, value: undefined };
            },
          };
        },
      };

      return Stream.fromAsyncIterable(cancellable, (cause) =>
        expired
          ? interrupted(description.provider, "The inference deadline expired.")
          : failure(cause),
      );
    }),
  );
