import { Resolver } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { checkServerIdentity } from "node:tls";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

import { Context, Effect, Layer } from "effect";

import { AgentError } from "#src/errors";

export const maxPageBytes = 1048576;

export const pageFailure = () =>
  new AgentError({ reason: "tool-network", message: "Could not read the supplied public page." });

const forbidden = () =>
  new AgentError({
    reason: "tool-permission",
    message: "Page reading requires a public HTTP(S) URL with no credentials or nonstandard port.",
  });

export const pageURL = (value: string) => {
  const url = new URL(value);

  if (
    value.length > 8192 ||
    /\s/.test(value) ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== ""
  )
    throw forbidden();
  url.hash = "";

  return url;
};

const privateV4 = new BlockList();

// IANA special-purpose ranges, plus multicast. Conservatively exclude special-purpose exceptions.
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const)
  privateV4.addSubnet(address, prefix, "ipv4");

const globalV6 = new BlockList();

globalV6.addSubnet("2000::", 3, "ipv6");

const specialV6 = new BlockList();

for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  specialV6.addSubnet(address, prefix, "ipv6");

export const publicAddress = (address: string) => {
  switch (isIP(address)) {
    case 4:
      return !privateV4.check(address, "ipv4");
    // Only ordinary global unicast is allowed; mapped IPv4 and translation prefixes are excluded.
    case 6:
      return globalV6.check(address, "ipv6") && !specialV6.check(address, "ipv6");
    default:
      return false;
  }
};

export const pageHostname = (url: URL) => url.hostname.replace(/^\[|\]$/g, "");

const NoRecords = new Set(["ENODATA", "ENOTFOUND"]);

export const resolvePage = async (hostname: string, signal: AbortSignal) => {
  signal.throwIfAborted();

  if (isIP(hostname)) return [hostname];
  const resolver = new Resolver();
  const cancel = () => resolver.cancel();
  signal.addEventListener("abort", cancel, { once: true });

  try {
    const records = await Promise.all([
      resolver.resolve4(hostname).catch((error: NodeJS.ErrnoException) => {
        if (NoRecords.has(error.code ?? "")) return [];
        throw error;
      }),
      resolver.resolve6(hostname).catch((error: NodeJS.ErrnoException) => {
        if (NoRecords.has(error.code ?? "")) return [];
        throw error;
      }),
    ]);

    signal.throwIfAborted();

    return records.flat();
  } finally {
    signal.removeEventListener("abort", cancel);
    resolver.cancel();
  }
};

export interface PageResponse {
  readonly status: number;
  readonly location: string | undefined;
  readonly contentType: string | undefined;
  readonly body: Uint8Array;
}

export const isPageRedirect = (status: number) => [301, 302, 303, 307, 308].includes(status);

const readResponse = async (response: IncomingMessage): Promise<PageResponse> => {
  const status = response.statusCode ?? 0;

  const metadata = {
    status,
    location: response.headers.location,
    contentType: response.headers["content-type"],
  };

  if (isPageRedirect(status)) return { ...metadata, body: new Uint8Array() };

  if (status < 200 || status >= 300)
    throw new AgentError({ reason: "tool-network", message: `The page returned HTTP ${status}.` });
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of response) {
    size += chunk.length;

    if (size > maxPageBytes)
      throw new AgentError({
        reason: "tool-limit",
        message: "The page exceeds the 1 MiB body limit.",
      });
    chunks.push(chunk);
  }

  if (!response.complete) throw pageFailure();
  const body = Buffer.concat(chunks);
  const options = { maxOutputLength: maxPageBytes };

  switch (response.headers["content-encoding"]?.trim().toLowerCase()) {
    case undefined:
    case "":
    case "identity":
      return { ...metadata, body };
    case "gzip":
      return { ...metadata, body: gunzipSync(body, options) };
    case "deflate":
      return { ...metadata, body: inflateSync(body, options) };
    case "br":
      return { ...metadata, body: brotliDecompressSync(body, options) };
    default:
      throw pageFailure();
  }
};

/** Connect directly to the validated literal IP; retain the source hostname for HTTP and TLS. */
export const requestPage = (
  url: URL,
  address: string,
  signal: AbortSignal,
): Promise<PageResponse> =>
  new Promise((resolve, reject) => {
    const hostname = pageHostname(url);
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;

    const pending = request({
      protocol: url.protocol,
      hostname: address,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      // A fresh direct connection avoids both pooled sockets and ambient proxy settings.
      agent: false,
      signal,
      maxHeaderSize: 16384,
      servername: isIP(hostname) ? "" : hostname,
      rejectUnauthorized: true,
      checkServerIdentity: (_name, certificate) => checkServerIdentity(hostname, certificate),
      headers: {
        Host: url.host,
        Accept: "text/html, text/plain",
        "Accept-Encoding": "gzip, deflate, br",
        "User-Agent": "Poppet/0.0.0",
      },
    });

    pending.once("error", reject);
    pending.once("upgrade", (_response, socket) => {
      socket.destroy();
      reject(pageFailure());
    });
    pending.once("response", (response) => {
      const cancel = () => response.destroy();
      signal.addEventListener("abort", cancel, { once: true });

      if (signal.aborted) cancel();
      void readResponse(response)
        .then(resolve, reject)
        .finally(() => {
          signal.removeEventListener("abort", cancel);
          response.destroy();
          pending.destroy();
        });
    });
    pending.end();
  });

/** The agent's injectable DNS and bounded HTTP transport. It never carries provider credentials. */
export class PageTransport extends Context.Service<
  PageTransport,
  {
    readonly resolve: (hostname: string) => Effect.Effect<ReadonlyArray<string>, AgentError>;
    readonly request: (url: URL, address: string) => Effect.Effect<PageResponse, AgentError>;
  }
>()("poppet/PageTransport") {}

export const PageTransportLive = Layer.succeed(PageTransport, {
  resolve: (hostname) =>
    Effect.tryPromise({ try: (signal) => resolvePage(hostname, signal), catch: pageFailure }),
  request: (url, address) =>
    Effect.tryPromise({
      try: (signal) => requestPage(url, address, signal),
      catch: (cause) => (cause instanceof AgentError ? cause : pageFailure()),
    }),
});
