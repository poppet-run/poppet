import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { AppConfig } from "@poppet/config";
import { readProtectedFile } from "@poppet/io";
import { Cause, Console, Context, Effect, Exit, Layer, Option, Schema } from "effect";

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
  hostname: Schema.String.check(Schema.isMinLength(1)),
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  accessKeyHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});

export type WebSettings = typeof WebSettings.Type;

const Login = Schema.Struct({
  key: Schema.String.check(Schema.isMinLength(32), Schema.isMaxLength(256)),
});

// JSON-escaped text of the maximum length can need six bytes per character.
const maxBodyBytes = 262144;

const securityHeaders = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

const run = async <A, E>(effect: Effect.Effect<A, E>) => {
  const exit = await Effect.runPromiseExit(effect);

  if (Exit.isSuccess(exit)) return exit.value;
  const error = Option.getOrNull(Cause.findErrorOption(exit.cause));

  if (error instanceof WebChatError) throw error;
  throw new WebChatError({
    status: 500,
    message:
      "Poppet could not complete this request. Inspect the worker logs and saved conversation before retrying.",
  });
};

const body = async <A>(request: Request, schema: Schema.Codec<A, string | object>) => {
  if (request.headers.get("content-type") !== "application/json")
    throw new WebChatError({ status: 415, message: "Expected application/json." });
  const text = await request.text();

  if (Buffer.byteLength(text) > maxBodyBytes)
    throw new WebChatError({ status: 413, message: "Request too large." });

  const value = Schema.decodeUnknownOption(Schema.fromJsonString(schema), {
    onExcessProperty: "error",
  })(text);

  if (Option.isNone(value)) throw new WebChatError({ status: 400, message: "Invalid request." });

  return value.value;
};

/** Authentication and routing are independent of the listener for lifecycle tests. */
export const webHandler = (
  settings: WebSettings,
  chat: WebChat["Service"],
  assets: ReadonlyMap<string, Blob>,
) => {
  const logins = new Map<string, number>();
  const attempts = new Map<string, { count: number; windowStarted: number }>();
  const secure = settings.origin.startsWith("https:");
  const cookieName = secure ? "__Host-poppet" : "poppet";

  const cookie = (value: string, maxAge: number) =>
    `${cookieName}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;

  const route = async (request: Request, client: string) => {
    const url = new URL(request.url);

    if (
      request.headers.get("host") !== null &&
      request.headers.get("host") !== new URL(settings.origin).host
    )
      return Response.json({ message: "Unexpected host." }, { status: 403 });

    if (request.headers.get("sec-fetch-site") === "cross-site")
      return Response.json({ message: "Cross-site requests are not allowed." }, { status: 403 });

    if (request.method !== "GET" && request.headers.get("origin") !== settings.origin)
      return Response.json({ message: "Unexpected origin." }, { status: 403 });

    if (request.method === "GET" && !url.pathname.startsWith("/api/")) {
      const asset = assets.get(
        url.pathname === "/" || /^\/chat\/[A-Za-z0-9_-]+$/.test(url.pathname)
          ? "/index.html"
          : url.pathname,
      );

      return asset ? new Response(asset) : new Response("Not found", { status: 404 });
    }

    const now = Date.now();

    for (const [key, expiry] of logins) if (expiry <= now) logins.delete(key);

    const token = request.headers
      .get("cookie")
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);

    const authenticated = () => token !== undefined && (logins.get(token) ?? 0) > Date.now();

    if (request.method === "POST" && url.pathname === "/api/login") {
      // Throttle each client, so one remote address cannot lock out the owner.
      for (const [address, entry] of attempts)
        if (now - entry.windowStarted >= 60000) attempts.delete(address);

      if (attempts.size >= 1024) attempts.delete(attempts.keys().next().value!);
      const entry = attempts.get(client) ?? { count: 0, windowStarted: now };
      attempts.set(client, entry);

      if (++entry.count > 10)
        return Response.json(
          { message: "Too many login attempts. Wait a minute." },
          { status: 429 },
        );
      const input = await body(request, Login);
      const digest = createHash("sha256").update(input.key).digest();

      if (!timingSafeEqual(digest, Buffer.from(settings.accessKeyHash, "hex")))
        return Response.json({ message: "Incorrect access key." }, { status: 401 });

      // Replace the oldest login, since lost cookies cannot be signed out.
      if (logins.size >= 32) logins.delete(logins.keys().next().value!);
      const key = randomBytes(32).toString("hex");
      logins.set(key, now + 12 * 60 * 60 * 1000);

      return Response.json({ ok: true }, { headers: { "set-cookie": cookie(key, 43200) } });
    }

    if (!authenticated()) return Response.json({ message: "Sign in to Poppet." }, { status: 401 });

    if (request.method === "POST" && url.pathname === "/api/logout") {
      if (token) logins.delete(token);

      return Response.json({ ok: true }, { headers: { "set-cookie": cookie("", 0) } });
    }

    if (request.method === "GET" && url.pathname === "/api/sessions")
      return Response.json(await run(chat.sessions));

    if (request.method === "POST" && url.pathname === "/api/submissions")
      return Response.json(await run(chat.submit(await body(request, SubmissionBody))), {
        status: 202,
      });
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

      if (request.method === "GET" && !session[2])
        return Response.json(await run(chat.snapshot(id)));

      if (request.method === "GET" && session[2] === "/events") {
        // Pull-based snapshots bound buffering even when a device reads slowly. Reconnection
        // receives a full current snapshot, so no delta replay or browser acknowledgement is needed.
        let marker = await run(chat.marker(id));
        let previous = JSON.stringify(await run(chat.snapshot(id)));
        let first = true;
        let closed = false;
        const encoder = new TextEncoder();

        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (!first) await new Promise((resolve) => setTimeout(resolve, 500));

            if (closed) return;

            if (!authenticated() || request.signal.aborted) {
              controller.close();

              return;
            }

            try {
              // A cheap change marker avoids rebuilding unchanged snapshots.
              const latest = first ? marker : await run(chat.marker(id));

              const current =
                first || latest === marker
                  ? previous
                  : JSON.stringify(await run(chat.snapshot(id)));

              controller.enqueue(
                encoder.encode(
                  first || current !== previous ? `data: ${current}\n\n` : ": connected\n\n",
                ),
              );
              previous = current;
              marker = latest;
              first = false;
            } catch {
              controller.close();
            }
          },
          cancel() {
            closed = true;
          },
        });

        return new Response(stream, {
          headers: { "content-type": "text/event-stream", "x-accel-buffering": "no" },
        });
      }
    }

    return Response.json({ message: "Not found." }, { status: 404 });
  };

  return async (request: Request, client = "local") => {
    let response: Response;

    try {
      response = await route(request, client);
    } catch (error) {
      response = Response.json(
        { message: error instanceof WebChatError ? error.message : "Invalid request." },
        { status: error instanceof WebChatError ? error.status : 400 },
      );
    }

    for (const [name, value] of Object.entries(securityHeaders)) response.headers.set(name, value);

    return response;
  };
};

/** web.json is opt-in. The HTTPS reverse proxy must preserve Host and disable SSE buffering. */
export const serveWebChat = Effect.gen(function* () {
  const config = yield* AppConfig;

  const text = yield* Effect.tryPromise({
    try: () =>
      readProtectedFile(join(config.dataDirectory, "web.json"), {
        maxBytes: 4096,
        ownerWriteOnly: true,
      }),
    catch: () => new Error("Cannot read web.json. Use an owner-controlled regular file."),
  });

  if (text === null) return;

  const settings = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(WebSettings), {
    onExcessProperty: "error",
  })(text).pipe(
    Effect.mapError(
      () => new Error("Invalid web.json. Set origin, hostname, port and accessKeyHash."),
    ),
  );

  const assets = yield* Effect.tryPromise({
    try: async () => {
      const directory = fileURLToPath(new URL("../../../../web/dist/", import.meta.url));
      const files = new Map<string, Blob>();

      await Promise.all(
        (await readdir(directory)).map(async (name) => {
          if (/^[a-zA-Z0-9_.-]+$/.test(name)) {
            const file = Bun.file(join(directory, name));
            files.set(`/${name}`, new Blob([await file.arrayBuffer()], { type: file.type }));
          }
        }),
      );

      if (!files.has("/index.html")) throw new Error("Missing index.html");

      return files;
    },
    catch: () => new Error("Build the web app first with bun run --cwd apps/web build."),
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
          idleTimeout: 0,
          fetch: (request, server) => {
            const peer = server.requestIP(request)?.address ?? "unknown";

            // Behind a loopback reverse proxy, the last forwarded address is the one it appended.
            const forwarded = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer)
              ? request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim()
              : undefined;

            return handler(request, forwarded || peer);
          },
        }),
      catch: () => new Error("Could not start the web chat listener."),
    }),
    (server) => Effect.promise(() => server.stop(true)),
  );
  yield* Console.log(`Web chat: ${settings.origin}`);
});
