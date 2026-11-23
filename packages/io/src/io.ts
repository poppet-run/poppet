export const readBounded = async (
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  tooLarge: () => Error,
  signal?: AbortSignal,
): Promise<Uint8Array> => {
  signal?.throwIfAborted();
  const reader = stream.getReader();

  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };

  signal?.addEventListener("abort", abort, { once: true });
  const chunks: Array<Uint8Array> = [];
  let bytes = 0;

  try {
    while (true) {
      const item = await reader.read();

      signal?.throwIfAborted();

      if (item.done) {
        break;
      }

      bytes += item.value.byteLength;

      if (bytes > maxBytes) {
        throw tooLarge();
      }

      chunks.push(item.value);
    }

    return new Uint8Array(Buffer.concat(chunks));
  } finally {
    signal?.removeEventListener("abort", abort);

    if (!signal?.aborted) {
      await reader.cancel().catch(() => undefined);
    }

    reader.releaseLock();
  }
};

export const readBoundedText = async (
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  tooLarge: () => Error,
  signal?: AbortSignal,
): Promise<string> =>
  new TextDecoder("utf-8", { fatal: true }).decode(
    await readBounded(stream, maxBytes, tooLarge, signal),
  );

export interface BoundedRun {
  readonly stdout: string;
  readonly code: number;
  readonly expired: boolean;
  readonly aborted: boolean;
}

export const runBounded = async (
  child: Bun.Subprocess<"ignore", "pipe", "pipe">,
  options: {
    readonly signal: AbortSignal;
    readonly timeout: number;
    readonly maxBytes: number;
    readonly tooLarge: () => Error;
  },
): Promise<BoundedRun> => {
  const { signal, timeout, maxBytes, tooLarge } = options;
  let expired = false;
  const abort = () => child.kill("SIGKILL");

  signal.addEventListener("abort", abort, { once: true });

  const timer = setTimeout(() => {
    expired = true;
    abort();
  }, timeout);

  try {
    if (signal.aborted) {
      abort();
    }

    const [stdout, , code] = await Promise.all([
      readBoundedText(child.stdout, maxBytes, tooLarge),
      readBoundedText(child.stderr, maxBytes, tooLarge),
      child.exited,
    ]);

    return { stdout, code, expired, aborted: signal.aborted };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    child.kill("SIGKILL");
    await child.exited;
  }
};
