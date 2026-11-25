import { describe, expect, test } from "bun:test";

import { GatewayError } from "@poppet/gateway";
import { LogfmtLoggerLive } from "@poppet/io";
import { StoreError } from "@poppet/store";
import { Clock, Console, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import { superviseAdapter } from "#src/commands/gateway/gateways";
import type { AdapterHealth } from "#src/commands/gateway/gateways";

const quiet: Console.Console = { ...console, error: () => {} };

const run = <A, E>(program: Effect.Effect<A, E>) =>
  Effect.runPromise(
    program.pipe(
      Effect.provideService(Console.Console, quiet),
      Effect.provide([TestClock.layer(), LogfmtLoggerLive]),
    ),
  );

describe("superviseAdapter", () => {
  test("when an adapter fails or defects, restarts it with backoff while siblings keep running", async () => {
    const health: AdapterHealth = { restarts: 0, lastError: null };
    let attempts = 0;
    let sibling = 0;

    await run(
      Effect.gen(function* () {
        const outcomes = [
          Effect.fail(new GatewayError({ reason: "unavailable", message: "Disconnected" })),
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

  test("when failures persist then recovery lasts ten minutes, caps and resets the restart delay", async () => {
    const health: AdapterHealth = { restarts: 0, lastError: null };
    const started: Array<number> = [];

    await run(
      Effect.gen(function* () {
        const adapter = Effect.gen(function* () {
          started.push(yield* Clock.currentTimeMillis);

          if (started.length === 11) {
            yield* Effect.sleep("10 minutes");
          }

          return yield* Effect.fail(
            new GatewayError({ reason: "unavailable", message: "Disconnected" }),
          );
        });

        const fiber = yield* superviseAdapter("flaky", adapter, health).pipe(Effect.forkChild);

        yield* TestClock.adjust("1 hour");
        const delays = started.slice(1).map((at, index) => at - started[index]!);

        expect(delays.slice(0, 10)).toEqual([
          1000, 2000, 4000, 8000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000,
        ]);
        expect(delays[10]).toBe(601_000);
        yield* Fiber.interrupt(fiber);
      }),
    );
  });

  test("when storage fails or execution is interrupted, stops the worker", async () => {
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

  test("when an adapter completes cleanly, restarts it with backoff", async () => {
    const health: AdapterHealth = { restarts: 0, lastError: null };
    let attempts = 0;

    await run(
      Effect.gen(function* () {
        const cleanExit = Effect.suspend(() => (attempts++ < 2 ? Effect.void : Effect.never));
        const fiber = yield* superviseAdapter("clean", cleanExit, health).pipe(Effect.forkChild);

        yield* TestClock.adjust("0 millis");
        expect([attempts, health.restarts, health.lastError]).toEqual([
          1,
          1,
          "The adapter stopped unexpectedly.",
        ]);
        yield* TestClock.adjust("1 second");
        expect([attempts, health.restarts]).toEqual([2, 2]);
        yield* TestClock.adjust("2 seconds");
        expect(attempts).toBe(3);
        yield* Fiber.interrupt(fiber);
      }),
    );
  });
});
