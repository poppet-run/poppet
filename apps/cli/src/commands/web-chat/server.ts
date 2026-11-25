import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readdir } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { AppConfig } from "@poppet/config";
import { readBoundedText, readProtectedFile } from "@poppet/io";
import { Cause, Context, Data, Effect, Exit, Layer, Option, Schema } from "effect";

import { WebChatLive, SubmissionBody, WebChatError, WebChat } from "#src/commands/web-chat/chat";

export const WebSettings = Schema.Struct({
  origin: Schema.String.check(
    Schema.makeFilter((value) => {
      try {
        const url = new URL(value);

        return (
          url.origin === value &&
          (url.protocol === "https:" ||
            (url.protocol === "http:" &&
              ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
        );
      } catch {
        return false;
      }
    }),
  ),
  hostname: Schema.Literals(["127.0.0.1", "::1", "localhost"]),
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
  trustProxy: Schema.optionalKey(Schema.Boolean),
  accessKeyHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});

export type WebSettings = typeof WebSettings.Type;

const Login = Schema.Struct({
  key: Schema.String.check(Schema.isMinLength(32), Schema.isMaxLength(256)),
});

const maxBodyBytes = 262_144;
const requestTimeoutSeconds = 10;
const maxStreams = 32;
const loopbackPeers = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

const securityHeaders = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

const run = async <A, E>(effect: Effect.Effect<A, E>) => {
  const exit = await Effect.runPromiseExit(effect);

  if (Exit.isSuccess(exit)) {
    return exit.value;
  }

  const error = Option.getOrNull(Cause.findErrorOption(exit.cause));

  if (error instanceof WebChatError) {
    throw error;
  }

  throw new WebChatError({
    status: 500,
    message:
      "Poppet could not complete this request. Check the worker logs and conversation before retrying.",
  });
};

const body = async <A>(request: Request, schema: Schema.Codec<A, string | object>) => {
  if (request.headers.get("content-type") !== "application/json") {
    throw new WebChatError({ status: 415, message: "Expected application/json." });
  }

  const deadline = AbortSignal.timeout(requestTimeoutSeconds * 1000);
  const signal = AbortSignal.any([request.signal, deadline]);

  const text =
    request.body === null
      ? ""
      : await readBoundedText(
          request.body,
          maxBodyBytes,
          () => new WebChatError({ status: 413, message: "Request too large." }),
          signal,
        ).catch((cause: unknown) => {
          if (deadline.aborted) {
            throw new WebChatError({ status: 408, message: "Request timed out." });
          }

          throw cause;
        });

  const value = Schema.decodeUnknownOption(Schema.fromJsonString(schema), {
    onExcessProperty: "error",
  })(text);

  if (Option.isNone(value)) {
    throw new WebChatError({ status: 400, message: "Invalid request." });
  }

  return value.value;
};

type Encoding = "br" | "gzip";

export interface WebAsset {
  readonly type: string;
  readonly body: Uint8Array<ArrayBuffer>;
  readonly encoded: ReadonlyMap<Encoding, Uint8Array<ArrayBuffer>>;
  readonly immutable: boolean;
}

const encodings = [
  ["br", "br"],
  ["gzip", "gz"],
] as const;

/** Loads the built assets with the compressed copies the web build writes beside them. */
export const loadWebAssets = async (directory: string) => {
  const names = new Set(await readdir(directory));
  const files = new Map<string, WebAsset>();

  await Promise.all(
    [...names].map(async (name) => {
      if (/^[a-zA-Z0-9_.-]+$/.test(name) && !/\.(?:br|gz)$/.test(name)) {
        const file = Bun.file(join(directory, name));
        const encoded = new Map<Encoding, Uint8Array<ArrayBuffer>>();

        for (const [encoding, extension] of encodings) {
          if (names.has(`${name}.${extension}`)) {
            encoded.set(encoding, await Bun.file(join(directory, `${name}.${extension}`)).bytes());
          }
        }

        files.set(`/${name}`, {
          type: file.type,
          body: await file.bytes(),
          encoded,
          // Bun names bundled scripts and styles with a content hash, so a new build gets new URLs.
          immutable: /-[a-z0-9]{8}\.(?:js|css)$/.test(name),
        });
      }
    }),
  );

  return files;
};

const accepted = (header: string | null) =>
  new Set(
    (header ?? "").split(",").flatMap((part) => {
      const [name = "", ...parameters] = part.split(";").map((value) => value.trim());
      const quality = parameters.find((value) => value.startsWith("q="));

      return quality !== undefined && Number(quality.slice(2)) <= 0 ? [] : [name.toLowerCase()];
    }),
  );

const assetResponse = (asset: WebAsset, acceptEncoding: string | null) => {
  const allowed = accepted(acceptEncoding);

  const encoding = encodings
    .map(([name]) => name)
    .find((name) => asset.encoded.has(name) && allowed.has(name));

  const headers = new Headers({
    "content-type": asset.type,
    "cache-control": asset.immutable ? "public, max-age=31536000, immutable" : "no-store",
  });

  if (asset.encoded.size > 0) {
    headers.set("vary", "accept-encoding");
  }

  if (encoding === undefined) {
    return new Response(asset.body, { headers });
  }

  headers.set("content-encoding", encoding);

  return new Response(asset.encoded.get(encoding), { headers });
};

const throttled = () =>
  Response.json({ message: "Too many login attempts. Wait a minute." }, { status: 429 });

export const webHandler = (
  settings: WebSettings,
  chat: WebChat["Service"],
  assets: ReadonlyMap<string, WebAsset>,
) => {
  const logins = new Map<string, number>();
  const attempts = new Map<string, { count: number; windowStarted: number }>();
  let globalAttempts = { count: 0, windowStarted: 0 };
  let streams = 0;
  const secure = settings.origin.startsWith("https:");
  const expectedHost = new URL(settings.origin).host.toLowerCase();
  const cookieName = secure ? "__Host-poppet" : "poppet";

  const cookie = (value: string, maxAge: number) =>
    `${cookieName}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;

  const route = async (request: Request, client: string) => {
    const url = new URL(request.url);
    const host = request.headers.get("host");

    if (host === null || host.toLowerCase() !== expectedHost) {
      return Response.json({ message: "Unexpected host." }, { status: 403 });
    }

    if (request.headers.get("sec-fetch-site") === "cross-site") {
      return Response.json({ message: "Cross-site requests are not allowed." }, { status: 403 });
    }

    if (request.method !== "GET" && request.headers.get("origin") !== settings.origin) {
      return Response.json({ message: "Unexpected origin." }, { status: 403 });
    }

    if (request.method === "GET" && !url.pathname.startsWith("/api/")) {
      const asset = assets.get(
        url.pathname === "/" || /^\/chat\/[A-Za-z0-9_-]+$/.test(url.pathname)
          ? "/index.html"
          : url.pathname,
      );

      return asset
        ? assetResponse(asset, request.headers.get("accept-encoding"))
        : new Response("Not found", { status: 404 });
    }

    const now = Date.now();

    for (const [key, expiry] of logins) {
      if (expiry <= now) {
        logins.delete(key);
      }
    }

    const token = request.headers
      .get("cookie")
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);

    const authenticated = () => token !== undefined && (logins.get(token) ?? 0) > Date.now();

    if (request.method === "POST" && url.pathname === "/api/login") {
      if (now - globalAttempts.windowStarted >= 60_000) {
        globalAttempts = { count: 0, windowStarted: now };
      }

      if (++globalAttempts.count > 60) {
        return throttled();
      }

      for (const [address, entry] of attempts) {
        if (now - entry.windowStarted >= 60_000) {
          attempts.delete(address);
        }
      }

      const entry = attempts.get(client) ?? { count: 0, windowStarted: now };
      attempts.set(client, entry);

      if (++entry.count > 10) {
        return throttled();
      }

      const input = await body(request, Login);
      const digest = createHash("sha256").update(input.key).digest();

      if (!timingSafeEqual(digest, Buffer.from(settings.accessKeyHash, "hex"))) {
        return Response.json({ message: "Incorrect access key." }, { status: 401 });
      }

      if (logins.size >= 32) {
        const oldest = logins.keys().next().value;

        if (oldest !== undefined) {
          logins.delete(oldest);
        }
      }

      const key = randomBytes(32).toString("hex");
      logins.set(key, now + 12 * 60 * 60 * 1000);

      return Response.json({ ok: true }, { headers: { "set-cookie": cookie(key, 43_200) } });
    }

    if (!authenticated()) {
      return Response.json({ message: "Sign in to Poppet." }, { status: 401 });
    }

    if (request.method === "POST" && url.pathname === "/api/logout") {
      if (token) {
        logins.delete(token);
      }

      return Response.json({ ok: true }, { headers: { "set-cookie": cookie("", 0) } });
    }

    if (request.method === "GET" && url.pathname === "/api/sessions") {
      return Response.json(await run(chat.sessions));
    }

    if (request.method === "GET" && url.pathname === "/api/session-list") {
      return Response.json(await run(chat.sessionList(url.searchParams.get("source") ?? "chat")));
    }

    if (request.method === "POST" && url.pathname === "/api/submissions") {
      return Response.json(await run(chat.submit(await body(request, SubmissionBody))), {
        status: 202,
      });
    }

    const receipt = /^\/api\/submissions\/([a-f0-9-]{36})$/.exec(url.pathname);

    if (request.method === "GET" && receipt?.[1]) {
      const result = await run(chat.receipt(receipt[1]));

      return result
        ? Response.json(result)
        : Response.json({ message: "Submission not found." }, { status: 404 });
    }

    const session = /^\/api\/sessions\/([A-Za-z0-9_-]{1,128})(\/events|\/stop)?$/.exec(
      url.pathname,
    );

    if (session?.[1]) {
      const id = session[1];

      if (request.method === "POST" && session[2] === "/stop") {
        await run(chat.stop(id));

        return Response.json({ ok: true });
      }

      if (request.method === "GET" && !session[2]) {
        return Response.json(await run(chat.snapshot(id)));
      }

      if (request.method === "DELETE" && !session[2]) {
        await run(chat.remove(id));

        return Response.json({ ok: true });
      }

      if (request.method === "GET" && session[2] === "/events") {
        if (streams >= maxStreams) {
          return Response.json({ message: "Too many open event streams." }, { status: 429 });
        }

        streams++;
        let marker: string;
        let previous: string;

        try {
          marker = await run(chat.marker(id));
          previous = JSON.stringify(await run(chat.snapshot(id)));
        } catch (cause) {
          streams--;
          throw cause;
        }

        let first = true;
        let closed = false;
        const encoder = new TextEncoder();

        const release = () => {
          if (closed) {
            return;
          }

          closed = true;
          streams--;
          request.signal.removeEventListener("abort", release);
        };

        if (request.signal.aborted) {
          release();
        } else {
          request.signal.addEventListener("abort", release, { once: true });
        }

        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (!first) {
              await new Promise((resolve) => {
                setTimeout(resolve, 500);
              });
            }

            if (closed || !authenticated() || request.signal.aborted) {
              release();
              controller.close();

              return;
            }

            try {
              const latest = first ? marker : await run(chat.marker(id));

              const current =
                first || latest === marker
                  ? previous
                  : JSON.stringify(await run(chat.snapshot(id)));

              if (closed) {
                return;
              }

              controller.enqueue(
                encoder.encode(
                  first || current !== previous ? `data: ${current}\n\n` : ": connected\n\n",
                ),
              );
              previous = current;
              marker = latest;
              first = false;
            } catch {
              if (!closed) {
                release();
                controller.close();
              }
            }
          },
          cancel: release,
        });

        return new Response(stream, {
          headers: { "content-type": "text/event-stream", "x-accel-buffering": "no" },
        });
      }
    }

    return Response.json({ message: "Not found." }, { status: 404 });
  };

  return async (request: Request, peer = "local") => {
    const forwarded =
      settings.trustProxy && loopbackPeers.has(peer)
        ? request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim()
        : undefined;

    const client = forwarded && isIP(forwarded) ? forwarded : peer;
    let response: Response;

    try {
      response = await route(request, client);
    } catch (error) {
      response = Response.json(
        { message: error instanceof WebChatError ? error.message : "Invalid request." },
        { status: error instanceof WebChatError ? error.status : 400 },
      );
    }

    for (const [name, value] of Object.entries(securityHeaders)) {
      response.headers.set(name, value);
    }

    if (!response.headers.has("cache-control")) {
      response.headers.set("cache-control", "no-store");
    }

    return response;
  };
};

class WebChatStartError extends Data.TaggedError("WebChatStartError")<{
  readonly message: string;
}> {}

export const serveWebChat = Effect.gen(function* () {
  const config = yield* AppConfig;

  const text = yield* Effect.tryPromise({
    try: () =>
      readProtectedFile(join(config.dataDirectory, "web.json"), {
        maxBytes: 4096,
        privateOnly: true,
      }),
    catch: () =>
      new WebChatStartError({
        message: "Cannot read web.json. Use an owner-only regular file with mode 600.",
      }),
  });

  if (text === null) {
    return;
  }

  const settings = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(WebSettings), {
    onExcessProperty: "error",
  })(text).pipe(
    Effect.mapError(
      () =>
        new WebChatStartError({
          message: "Invalid web.json. Set origin, hostname, port and accessKeyHash.",
        }),
    ),
  );

  const assets = yield* Effect.tryPromise({
    try: async () => {
      const files = await loadWebAssets(
        fileURLToPath(new URL("../../../../web/dist/", import.meta.url)),
      );

      if (!files.has("/index.html")) {
        throw new Error("Missing index.html");
      }

      return files;
    },
    catch: () =>
      new WebChatStartError({
        message: "Build the web app first with bun run --cwd apps/web build.",
      }),
  });

  const services = yield* Layer.build(WebChatLive);
  const chat = Context.get(services, WebChat);
  const handler = webHandler(settings, chat, assets);
  yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        Bun.serve({
          hostname: settings.hostname,
          port: settings.port,
          maxRequestBodySize: maxBodyBytes,
          idleTimeout: requestTimeoutSeconds,
          fetch: async (request, server) => {
            const response = await handler(
              request,
              server.requestIP(request)?.address ?? "unknown",
            );

            if (response.headers.get("content-type") === "text/event-stream") {
              server.timeout(request, 0);
            }

            return response;
          },
        }),
      catch: () => new WebChatStartError({ message: "Could not start the web chat listener." }),
    }),
    (server) => Effect.promise(() => server.stop(true)),
  );
  yield* Effect.logInfo("web chat started").pipe(Effect.annotateLogs({ url: settings.origin }));
});
