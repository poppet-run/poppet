import { StreamableHTTPClientTransport, type FetchLike } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

export class ScopedStdioTransport extends StdioClientTransport {
  private closing: Promise<void> | null = null;

  override close(): Promise<void> {
    this.closing ??= this.closeProcess();

    return this.closing;
  }

  private async closeProcess() {
    const pid = this.pid;

    await super.close();

    if (pid === null) return;

    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }

      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    throw new Error("MCP child did not exit after shutdown.");
  }
}

const LF = 0x0a;
const CR = 0x0d;

const bounded = (body: ReadableStream<Uint8Array>, limit: number, events: boolean) => {
  let size = 0;
  let previous = 0;

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        for (const byte of chunk) {
          if (++size > limit) {
            controller.error(new Error("MCP HTTP message exceeds the size limit."));

            return;
          }

          if (events && byte === LF && previous === LF) size = 0;

          if (byte !== CR) previous = byte;
        }

        controller.enqueue(chunk);
      },
    }),
  );
};

export const boundedFetch =
  (limit: number, base: FetchLike = fetch): FetchLike =>
  async (url, init) => {
    const response = await base(url, init);

    if (response.body === null) return response;

    const events = response.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("text/event-stream");

    return new Response(bounded(response.body, limit, events === true), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };

export class ScopedHTTPTransport extends StreamableHTTPClientTransport {
  private closing: Promise<void> | null = null;

  override close(): Promise<void> {
    this.closing ??= this.closeSession();

    return this.closing;
  }

  private async closeSession() {
    delete this.onerror;

    let timer: ReturnType<typeof setTimeout> | undefined;

    await Promise.race([
      this.terminateSession().catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 5000);
      }),
    ]);
    clearTimeout(timer);
    await super.close();
  }
}
