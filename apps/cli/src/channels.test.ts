import { describe, expect, test } from "bun:test";

import { ChannelError } from "@poppet/gateway";
import { StoreError } from "@poppet/store";
import { Clock, Console, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import { superviseAdapter, type AdapterHealth } from "#src/channels";

const quiet: Console.Console = { ...console, error: () => {} };

const run = <A, E>(program: Effect.Effect<A, E>) =>
  Effect.runPromise(
    program.pipe(Effect.provideService(Console.Console, quiet), Effect.provide(TestClock.layer())),
  );

describe("messaging adapter supervision", () => {
  test("restarts a failed or defective adapter with backoff while its siblings keep running", async () => {
    const health: AdapterHealth = { restarts: 0, lastError: null };
    let attempts = 0;
    let sibling = 0;

    await run(
      Effect.gen(function* () {
        const outcomes = [
          Effect.fail(new ChannelError({ reason: "unavailable", message: "Disconnected" })),
          Effect.die("Unexpected payload"),
        ];

        const failing = Effect.suspend(() => outcomes[attempts++] ?? Effect.never);

        const fiber = yield* Effect.all(
          [
            superviseAdapter("failing", failing, health),
            Effect.sync(() => {
              sibling++;
            }).pipe(Effect.andThen(Effect.sleep("1 second")), Effect.forever),
          ],
          { concurrency: 2, discard: true },
        ).pipe(Effect.forkChild);

        yield* TestClock.adjust("0 millis");
        expect([attempts, health.restarts, health.lastError]).toEqual([1, 1, "Disconnected"]);
        yield* TestClock.adjust("1 second");
        expect([attempts, health.restarts, health.lastError]).toEqual([
          2,
          2,
          "The adapter stopped unexpectedly.",
        ]);
        yield* TestClock.adjust("1 second");
        expect(attempts).toBe(2);
        yield* TestClock.adjust("1 second");
        expect(attempts).toBe(3);
        expect(sibling).toBeGreaterThanOrEqual(3);
        yield* Fiber.interrupt(fiber);
      }),
    );
  });

  test("caps the restart delay and resets it after a healthy period", async () => {
    const health: AdapterHealth = { restarts: 0, lastError: null };
    const started: number[] = [];

    await run(
      Effect.gen(function* () {
        const adapter = Effect.gen(function* () {
          started.push(yield* Clock.currentTimeMillis);

          // The eleventh attempt stays up for ten minutes before failing again.
          if (started.length === 11) yield* Effect.sleep("10 minutes");

          return yield* Effect.fail(
            new ChannelError({ reason: "unavailable", message: "Disconnected" }),
          );
        });

        const fiber = yield* superviseAdapter("flaky", adapter, health).pipe(Effect.forkChild);

        yield* TestClock.adjust("1 hour");
        const delays = started.slice(1).map((at, index) => at - started[index]!);

        expect(delays.slice(0, 10)).toEqual([
          1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 300000,
        ]);
        // Ten healthy minutes plus a fresh one-second backoff.
        expect(delays[10]).toBe(601_000);
        yield* Fiber.interrupt(fiber);
      }),
    );
  });

  test("storage failures and interruption still stop the worker", async () => {
    const health: AdapterHealth = { restarts: 0, lastError: null };

    const error = await run(
      superviseAdapter(
        "store",
        Effect.fail(new StoreError({ reason: "storage", message: "Disk full" })),
        health,
      ).pipe(Effect.flip),
    );

    expect(error).toBeInstanceOf(StoreError);
    expect(error).toHaveProperty("reason", "storage");
    expect(health.restarts).toBe(0);

    await run(
      Effect.gen(function* () {
        const fiber = yield* superviseAdapter("interrupted", Effect.never, health).pipe(
          Effect.forkChild,
        );

        yield* TestClock.adjust("0 millis");
        yield* Fiber.interrupt(fiber);
        expect(health.restarts).toBe(0);
      }),
    );
  });
});
