import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

import { Effect } from "effect";
import { describe, expect, test } from "vitest";

import { remoteTaskCommand, taskResponse } from "#src/task-socket";

describe("task-socket.ts", () => {
  test("when task controls omit required fields or add unknown fields, rejects them before dispatch", async () => {
    let dispatched = 0;

    const handle = () =>
      Effect.sync(() => {
        dispatched++;

        return {};
      });

    const edit = { action: "edit", id: "task", patch: { name: "Renamed" } };

    await Promise.all(
      [
        { ...edit, patch: {} },
        { ...edit, patch: { provider: "other" } },
        { ...edit, revision: 0 },
        { ...edit, destination: "other" },
        { action: "snooze", id: "task" },
        { action: "skip-next", id: "task", target: null },
      ].map(async (body) => {
        const response = await Effect.runPromise(taskResponse(body, handle));
        expect(response.status).toBe(400);
      }),
    );

    expect(dispatched).toBe(0);
    expect((await Effect.runPromise(taskResponse(edit, handle))).status).toBe(200);
    expect(dispatched).toBe(1);
  });

  test("when a delivered mutation loses its response, rejects local fallback", async () => {
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
});
