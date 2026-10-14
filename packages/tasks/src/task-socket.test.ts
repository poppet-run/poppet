import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

import { Effect } from "effect";

import { remoteTaskCommand } from "#src/task-socket";

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
