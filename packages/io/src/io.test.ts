import { describe, expect, test } from "bun:test";

import { readBounded, readBoundedText, runBounded } from "#src/io";

const tooLarge = () => new Error("Too large");

const launch = (script: string) =>
  Bun.spawn([process.execPath, "--eval", script], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

const options = (signal = new AbortController().signal) => ({
  signal,
  timeout: 2000,
  maxBytes: 16,
  tooLarge,
});

const expectReaped = (child: ReturnType<typeof launch>) => {
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  expect(child.stdout.locked).toBe(false);
  expect(child.stderr.locked).toBe(false);
};

describe("io.ts", () => {
  test("when chunks split UTF-8 at the exact byte limit, decodes the complete text", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0xc3]));
        controller.enqueue(new Uint8Array([0xa9]));
        controller.close();
      },
    });

    expect(await readBoundedText(stream, 2, tooLarge)).toBe("é");
    expect(stream.locked).toBe(false);
    expect(await readBounded(new ReadableStream({ start: (c) => c.close() }), 0, tooLarge)).toEqual(
      new Uint8Array(),
    );
  });

  test("when a stream exceeds its limit by one byte, stops and releases the reader even if cancellation rejects", async () => {
    let reads = 0;
    let cancellations = 0;
    let failures = 0;
    const failure = new Error("Limit exceeded");

    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          reads++;
          controller.enqueue(new Uint8Array([reads]));
        },
        cancel() {
          cancellations++;

          return Promise.reject(new Error("Cancel failed"));
        },
      },
      { highWaterMark: 0 },
    );

    await expect(
      readBounded(stream, 2, () => {
        failures++;

        return failure;
      }),
    ).rejects.toBe(failure);
    expect(reads).toBe(3);
    expect(cancellations).toBe(1);
    expect(failures).toBe(1);
    expect(stream.locked).toBe(false);
    stream.getReader().releaseLock();
  });

  test("when reading fails, preserves the failure and releases the reader", async () => {
    const failure = new Error("Read failed");

    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(failure);
      },
    });

    await expect(readBounded(stream, 2, tooLarge)).rejects.toBe(failure);
    expect(stream.locked).toBe(false);
  });

  test("when stream bytes are invalid UTF-8, releases the reader and rejects decoding", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0xff]));
        controller.close();
      },
    });

    await expect(readBoundedText(stream, 1, tooLarge)).rejects.toBeInstanceOf(TypeError);
    expect(stream.locked).toBe(false);
  });
});

describe("runBounded", () => {
  test("when a subprocess writes both pipes and fails, drains output and returns stdout and its exit code", async () => {
    const child = launch(
      'process.stdout.write("hello"); process.stderr.write("diagnostic"); process.exitCode = 3;',
    );

    try {
      expect(await runBounded(child, options())).toEqual({
        stdout: "hello",
        code: 3,
        expired: false,
        aborted: false,
      });
      expectReaped(child);
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
  });

  test.each(["timeout", "abort", "already aborted"])(
    "when a subprocess is %s, kills and reaps it",
    async (mode) => {
      const child = launch("setInterval(() => {}, 1000)");
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;

      try {
        if (mode === "already aborted") controller.abort();

        if (mode === "abort") timer = setTimeout(() => controller.abort(), 30);

        const result = await runBounded(child, {
          ...options(controller.signal),
          timeout: mode === "timeout" ? 30 : 2000,
        });

        expect(result.expired).toBe(mode === "timeout");
        expect(result.aborted).toBe(mode !== "timeout");
        expect(child.signalCode).toBe("SIGKILL");
        expectReaped(child);
      } finally {
        clearTimeout(timer);
        child.kill("SIGKILL");
        await child.exited;
      }
    },
  );

  test.each(["stdout", "stderr"])(
    "when %s exceeds its subprocess limit, kills and reaps the child",
    async (pipe) => {
      const child = launch(`process.${pipe}.write("x".repeat(17)); setInterval(() => {}, 1000);`);

      try {
        await expect(runBounded(child, options())).rejects.toThrow("Too large");
        expect(child.signalCode).toBe("SIGKILL");
        expectReaped(child);
      } finally {
        child.kill("SIGKILL");
        await child.exited;
      }
    },
  );
});
