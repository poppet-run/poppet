import { describe, expect, test } from "bun:test";

import { boundedFetch, ScopedStdioTransport } from "#src/transport";

describe("boundedFetch", () => {
  test.each([
    ["OAuth response", 200, undefined],
    ["HTTP error response", 401, 64],
    ["successful event stream", 200, 32],
  ] as const)(
    "when an SSE-labelled %s exceeds its total byte limit, stops reading",
    async (_case, status, streamLimit) => {
      const fetch = boundedFetch(
        16,
        async () =>
          new Response("data: x\n\n".repeat(5), {
            status,
            headers: { "content-type": "text/event-stream" },
          }),
        streamLimit,
      );

      const response = await fetch("https://test.invalid");
      await expect(response.text()).rejects.toThrow("size limit");
    },
  );

  test("when a successful SSE response stays within both limits, reads successive events", async () => {
    const text = "data: x\n\n".repeat(4);

    const fetch = boundedFetch(
      16,
      async () =>
        new Response(text, {
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        }),
      64,
    );

    expect(await (await fetch("https://test.invalid")).text()).toBe(text);
  });
});

describe("ScopedStdioTransport", () => {
  test("when close is called before start, rejects a subsequent start without spawning or leaking a child", async () => {
    const transport = new ScopedStdioTransport({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      stderr: "ignore",
    });

    await transport.close();
    await expect(transport.start()).rejects.toThrow("closed before start");
    expect(transport.pid).toBeNull();
  });

  test("when a started child ignores SIGTERM, close terminates and awaits child exit cleanly", async () => {
    const transport = new ScopedStdioTransport({
      command: process.execPath,
      args: ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'],
      stderr: "ignore",
    });

    await transport.start();
    const pid = transport.pid;
    expect(pid).not.toBeNull();

    await transport.close();
    await transport.close();
    expect(transport.pid).toBeNull();
  });
});
