import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

import { serveWorker } from "@poppet/worker";
import { Effect } from "effect";

import { remoteTaskCommand, taskResponse } from "#src/task-socket";

test("control commands reject missing bindings and extra mutation fields before dispatch", async () => {
  let dispatched = 0;

  const handle = () =>
    Effect.sync(() => {
      dispatched++;

      return {};
    });

  const edit = {
    action: "edit",
    id: "task",
    revision: 0,
    operationId: "request",
    patch: { name: "Renamed" },
  };

  await Promise.all(
    [
      { ...edit, patch: {} },
      { ...edit, patch: { provider: "other" } },
      { ...edit, revision: null },
      { ...edit, destination: "other" },
      { action: "snooze", id: "task", operationId: "request", revision: 0, until: 1000 },
    ].map(async (body) => {
      const response = await Effect.runPromise(taskResponse(body, handle));
      expect(response.status).toBe(400);
    }),
  );

  expect(dispatched).toBe(0);
  expect((await Effect.runPromise(taskResponse(edit, handle))).status).toBe(200);
  expect(dispatched).toBe(1);
});

test("a lost response to a delivered mutation never permits local fallback", async () => {
  const directory = await mkdtemp("/tmp/p7-response-");
  await chmod(directory, 0o700);
  const path = join(directory, "tasks.sock");
  let delivered = 0;

  const server = createServer((socket) => {
    let request = "";
    socket.on("data", (chunk) => {
      request += chunk.toString();

      if (request.includes('{"action":"clear"}')) {
        delivered++;
        server.close();
        socket.destroy();
      }
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, resolve);
    });
    await chmod(path, 0o600);

    const result = await Effect.runPromise(
      remoteTaskCommand(path, { action: "clear" }).pipe(
        Effect.match({ onFailure: (error) => error, onSuccess: (reply) => reply }),
      ),
    );

    expect(result).toMatchObject({ message: expect.stringContaining("was not retried") });
    expect(delivered).toBe(1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("an older worker rejects monitoring creation without retrying as an ordinary report", async () => {
  const directory = await mkdtemp("/tmp/poppet-old-worker-");
  await chmod(directory, 0o700);
  const path = join(directory, "tasks.sock");
  const received: string[] = [];

  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* serveWorker(path, (_request, body) =>
            Effect.sync(() => {
              received.push(JSON.stringify(body));

              return Response.json(
                { ok: false, message: "Invalid task command." },
                { status: 400 },
              );
            }),
          );

          const reply = yield* remoteTaskCommand(path, {
            action: "add-monitor",
            task: {
              name: "Release",
              prompt: "Read release.md",
              provider: "test-provider",
              model: "test-model",
              workload: "assistant",
              schedule: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
            },
          }).pipe(Effect.result);

          expect(reply).toHaveProperty("failure.message", "Invalid task command.");
          expect(received).toHaveLength(1);
          expect(JSON.parse(received[0]!).action).toBe("add-monitor");
        }),
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
