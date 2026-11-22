import { AsyncLocalStorage } from "node:async_hooks";

import { StreamableHTTPClientTransport, type FetchLike } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

export class ScopedStdioTransport extends StdioClientTransport {
  private closing: Promise<void> | null = null;
  private closed: Promise<void> | null = null;
  private markClosed: (() => void) | null = null;
  private started = false;
  private closedBeforeStart = false;

  constructor(...args: ConstructorParameters<typeof StdioClientTransport>) {
    super(...args);
    let currentOnClose: (() => void) | undefined;

    Object.defineProperty(this, "onclose", {
      configurable: true,
      enumerable: true,
      get: () => currentOnClose,
      set: (handler: (() => void) | undefined) => {
        currentOnClose =
          handler === undefined
            ? undefined
            : () => {
                this.markClosed?.();
                handler();
              };
      },
    });
  }

  override async start(): Promise<void> {
    if (this.closedBeforeStart) throw new Error("StdioClientTransport was closed before start.");

    let resolveClosed!: () => void;
    this.closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    this.markClosed = resolveClosed;

    // eslint-disable-next-line unicorn/prefer-add-event-listener
    if (this.onclose === undefined) this.onclose = () => {};

    try {
      await super.start();
      this.started = true;
    } catch (cause) {
      resolveClosed();
      throw cause;
    }

    if (this.closedBeforeStart) {
      await this.close();
      throw new Error("StdioClientTransport was closed during start.");
    }
  }

  override close(): Promise<void> {
    if (!this.started && this.pid === null) {
      this.closedBeforeStart = true;

      return super.close();
    }

    this.closing ??= this.closeProcess();

    return this.closing;
  }

  private async closeProcess() {
    const closed = this.closed;

    await super.close();

    if (closed === null) return;

    let timer: ReturnType<typeof setTimeout> | undefined;

    const settled = await Promise.race([
      closed.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 1000);
        timer.unref?.();
      }),
    ]);

    clearTimeout(timer);

    if (!settled) throw new Error("MCP child did not exit after shutdown.");
  }
}

const LF = 0x0a;
const CR = 0x0d;

const bounded = (
  body: ReadableStream<Uint8Array>,
  limit: number,
  streamLimit: number | undefined,
) => {
  let size = 0;
  let total = 0;
  let previous = 0;

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;

        if (total > (streamLimit ?? limit)) {
          controller.error(new Error("MCP HTTP response exceeds the size limit."));

          return;
        }

        if (streamLimit !== undefined) {
          for (const byte of chunk) {
            if (++size > limit) {
              controller.error(new Error("MCP HTTP message exceeds the size limit."));

              return;
            }

            if (byte === LF && previous === LF) size = 0;

            if (byte !== CR) previous = byte;
          }
        }

        controller.enqueue(chunk);
      },
    }),
  );
};

export const boundedFetch =
  (limit: number, base: FetchLike = fetch, streamLimit?: number): FetchLike =>
  async (url, init) => {
    const response = await base(url, init);

    if (response.body === null) return response;

    const mediaType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    const events = response.status === 200 && mediaType === "text/event-stream";

    return new Response(bounded(response.body, limit, events ? streamLimit : undefined), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };

export class ReviewedAccountChanged extends Error {}

interface ReviewedRequest {
  readonly endpoint: string;
  readonly token: string | undefined;
  sent: boolean;
}

const reviewedRequests = new AsyncLocalStorage<ReviewedRequest>();

export const reviewedHTTPRequest = <A>(
  endpoint: string,
  token: string | undefined,
  send: () => Promise<A>,
) => reviewedRequests.run({ endpoint: new URL(endpoint).href, token, sent: false }, send);

export const checkReviewedToken = (token: string | undefined) => {
  const request = reviewedRequests.getStore();

  if (request !== undefined && request.token !== token) throw new ReviewedAccountChanged();

  return token;
};

export const singleReviewedPost =
  (base: FetchLike): FetchLike =>
  async (url, init) => {
    const request = reviewedRequests.getStore();

    if (request === undefined || init?.method !== "POST") return base(url, init);

    if (request.sent || String(url) !== request.endpoint)
      throw new Error("A reviewed MCP call permits one POST to its configured endpoint.");

    request.sent = true;
    const response = await base(url, { ...init, redirect: "manual" });

    if (
      (response.status >= 300 && response.status < 400) ||
      response.status === 401 ||
      response.status === 403
    ) {
      await response.body?.cancel().catch(() => {});
      throw new Error("A reviewed MCP call cannot follow a redirect or retry authorization.");
    }

    return response;
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
