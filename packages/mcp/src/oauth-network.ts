import { request } from "node:https";
import { isIP } from "node:net";
import { checkServerIdentity } from "node:tls";

import type { FetchLike } from "@modelcontextprotocol/client";
import { publicAddress, resolveAddresses, urlHostname } from "@poppet/io";
import { Schema } from "effect";

import { boundedFetch } from "#src/transport";

const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);

const blocked = () =>
  new Error("OAuth endpoints must use public HTTPS or explicitly configured loopback.");

export const oauthAddress = async (server: URL, endpoint: URL, signal: AbortSignal) => {
  signal.throwIfAborted();

  if (endpoint.username || endpoint.password) throw blocked();

  if (
    loopback.has(server.hostname) &&
    loopback.has(endpoint.hostname) &&
    (endpoint.protocol === "http:" || endpoint.protocol === "https:")
  )
    return null;

  if (endpoint.protocol !== "https:" || loopback.has(endpoint.hostname)) throw blocked();
  const addresses = await resolveAddresses(urlHostname(endpoint), signal);
  const address = addresses[0];

  if (address === undefined || !addresses.every(publicAddress)) throw blocked();

  return address;
};

const pinnedRequest = (url: URL, address: string, init: RequestInit, signal: AbortSignal) =>
  new Promise<Response>((resolve, reject) => {
    const body = init.body;

    if (body != null && !Schema.is(Schema.String)(body) && !(body instanceof URLSearchParams))
      return reject(new Error("Unsupported OAuth request body."));

    const content = body?.toString();
    const headers = new Headers(init.headers);
    headers.set("host", url.host);
    headers.set("accept-encoding", "identity");

    if (content !== undefined) headers.set("content-length", String(Buffer.byteLength(content)));

    if (body instanceof URLSearchParams && !headers.has("content-type"))
      headers.set("content-type", "application/x-www-form-urlencoded");

    const hostname = urlHostname(url);

    const pending = request({
      hostname: address,
      port: url.port || undefined,
      path: url.pathname + url.search,
      method: init.method ?? "GET",
      headers: Object.fromEntries(headers),
      agent: false,
      signal,
      servername: isIP(hostname) ? "" : hostname,
      rejectUnauthorized: true,
      checkServerIdentity: (_name, certificate) => checkServerIdentity(hostname, certificate),
    });

    pending.once("error", reject);
    pending.once("upgrade", (_response, socket) => {
      socket.destroy();
      reject(new Error("OAuth endpoints cannot upgrade connections."));
    });
    pending.once("response", (incoming) => {
      const status = incoming.statusCode ?? 500;
      const responseHeaders = new Headers();

      for (const [header, values] of Object.entries(incoming.headersDistinct)) {
        for (const value of values ?? []) responseHeaders.append(header, value);
      }

      if (status === 204 || status === 205 || status === 304 || init.method === "HEAD") {
        incoming.resume();
        resolve(new Response(null, { status, headers: responseHeaders }));
      } else {
        const chunks: AsyncIterator<Uint8Array> = incoming[Symbol.asyncIterator]();

        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            const chunk = await chunks.next();

            if (chunk.done) controller.close();
            else controller.enqueue(chunk.value);
          },
          cancel() {
            incoming.destroy();
          },
        });

        resolve(new Response(stream, { status, headers: responseHeaders }));
      }
    });
    pending.end(content);
  });

export const oauthFetch = (server: URL, operationSignal: AbortSignal): FetchLike =>
  boundedFetch(262144, async (input, init = {}) => {
    const endpoint = new URL(input);
    const signals = [operationSignal, AbortSignal.timeout(5000)];

    if (init.signal != null) signals.push(init.signal);
    const signal = AbortSignal.any(signals);
    const address = await oauthAddress(server, endpoint, signal);

    return address === null
      ? fetch(endpoint, { ...init, redirect: "manual", signal })
      : pinnedRequest(endpoint, address, init, signal);
  });
