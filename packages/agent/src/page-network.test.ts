import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { createServer as createTLSServer } from "node:https";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";

import { Schema } from "effect";

import { maxPageBytes, pageURL, publicAddress, requestPage, resolvePage } from "#src/page-network";

const certificate = fileURLToPath(new URL("./test/fixtures/pages/cert.pem", import.meta.url));

const key = fileURLToPath(new URL("./test/fixtures/pages/key.pem", import.meta.url));

const listen = async (server: ReturnType<typeof createServer>) => {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();

  if (address === null || !Schema.is(Schema.Struct({ port: Schema.Number }))(address))
    throw new Error("No local listener");

  return address.port;
};

const failedRequest = (request: Promise<unknown>) =>
  request.then(
    () => null,
    (error: Error) => error,
  );

const close = (server: ReturnType<typeof createServer>) =>
  new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });

// These cases span the non-public IANA ranges and both sides of subnet boundaries.
describe.concurrent("page destinations", () => {
  test.each([
    "0.1.2.3",
    "10.0.0.1",
    "100.64.0.1",
    "100.127.255.255",
    "127.255.1.2",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.9",
    "192.0.2.1",
    "192.88.99.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.19.255.255",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "239.255.255.255",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:8.8.8.8",
    "64:ff9b::7f00:1",
    "64:ff9b:1::1",
    "100::1",
    "2001::1",
    "2001:1ff::1",
    "2001:db8::1",
    "2002:7f00:1::1",
    "3fff::1",
    "3fff:fff::1",
    "5f00::1",
    "fc00::1",
    "fdff::1",
    "fe80::1",
    "ff02::1",
    "not-an-ip",
  ])("blocks %s", (address) => {
    expect(publicAddress(address)).toBe(false);
  });

  test.each([
    "8.8.8.8",
    "93.184.215.14",
    "100.63.255.255",
    "100.128.0.0",
    "172.15.255.255",
    "172.32.0.0",
    "198.17.255.255",
    "198.20.0.0",
    "2606:4700::1111",
    "2001:4860:4860::8888",
    "2001:200::1",
    "3ffe::1",
  ])("allows ordinary public unicast %s", (address) => {
    expect(publicAddress(address)).toBe(true);
  });

  test("canonicalizes alternative IPv4 literals before policy checks and never resolves literals", async () => {
    for (const input of ["http://127.1", "http://2130706433", "http://0x7f000001"]) {
      const url = pageURL(input);
      expect(url.hostname).toBe("127.0.0.1");
      expect(publicAddress(url.hostname)).toBe(false);
    }

    expect(await resolvePage("2606:4700::1111", new AbortController().signal)).toEqual([
      "2606:4700::1111",
    ]);
  });
});

describe.concurrent("production page transport", () => {
  test("connects only to the chosen IP with the original Host, no credentials, and no implicit redirect", async () => {
    const received: {
      host: string | undefined;
      authorization: string | undefined;
      cookie: string | undefined;
      path: string | undefined;
    }[] = [];

    const server = createServer((request, response) => {
      received.push({
        host: request.headers.host,
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
        path: request.url,
      });
      response.writeHead(302, { Location: "http://127.0.0.1/private" });
      response.end("not followed");
    });

    const port = await listen(server);

    try {
      // This hostname cannot resolve. A second lookup would fail instead of reaching the local listener.
      const url = new URL(`http://unresolvable.invalid:${port}/article?q=one`);
      const page = await requestPage(url, "127.0.0.1", new AbortController().signal);
      expect(page.status).toBe(302);
      expect(page.body.byteLength).toBe(0);
      expect(received).toEqual([
        {
          host: `unresolvable.invalid:${port}`,
          authorization: undefined,
          cookie: undefined,
          path: "/article?q=one",
        },
      ]);
    } finally {
      await close(server);
    }
  });

  test.each(["identity", "gzip", "deflate", "br"])(
    "bounds both wire and decoded %s bodies",
    async (encoding) => {
      const compress = (body: Buffer) => {
        switch (encoding) {
          case "gzip":
            return gzipSync(body);
          case "deflate":
            return deflateSync(body);
          case "br":
            return brotliCompressSync(body);
          default:
            return body;
        }
      };

      const server = createServer((request, response) => {
        response.writeHead(200, { "Content-Type": "text/plain", "Content-Encoding": encoding });
        const size = request.url === "/large" ? maxPageBytes + 1 : 128;
        const data = compress(Buffer.alloc(size, "x"));
        // No Content-Length: the client must enforce the actual streamed size.
        response.write(data.subarray(0, 10));
        response.end(data.subarray(10));
      });

      const port = await listen(server);

      try {
        const url = new URL(`http://page.invalid:${port}/small`);
        const small = await requestPage(url, "127.0.0.1", new AbortController().signal);
        expect(small.body.byteLength).toBe(128);
        url.pathname = "/large";
        expect(
          await failedRequest(requestPage(url, "127.0.0.1", new AbortController().signal)),
        ).toBeInstanceOf(Error);
      } finally {
        await close(server);
      }
    },
  );

  test("rejects an oversized compressed wire body even if decompression would be small", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/plain", "Content-Encoding": "gzip" });
      response.end(Buffer.concat([gzipSync("small"), Buffer.alloc(maxPageBytes)]));
    });

    const port = await listen(server);

    try {
      expect(
        await failedRequest(
          requestPage(
            new URL(`http://page.invalid:${port}/`),
            "127.0.0.1",
            new AbortController().signal,
          ),
        ),
      ).toMatchObject({ message: expect.stringContaining("1 MiB") });
    } finally {
      await close(server);
    }
  });

  test("cancellation closes a stalled body connection", async () => {
    const received = Promise.withResolvers<void>();
    const disconnected = Promise.withResolvers<void>();

    const server = createServer((request, response) => {
      request.socket.once("close", () => disconnected.resolve());
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.write("unfinished");
      received.resolve();
    });

    const port = await listen(server);
    const controller = new AbortController();

    try {
      const pending = requestPage(
        new URL(`http://page.invalid:${port}/`),
        "127.0.0.1",
        controller.signal,
      );

      const outcome = pending.then(
        () => null,
        (error: Error) => error,
      );

      await received.promise;
      controller.abort();
      expect(await outcome).toBeInstanceOf(Error);
      await disconnected.promise;
    } finally {
      await close(server);
    }
  });

  test("TLS retains hostname verification and SNI on a pinned connection and ignores ambient proxy and TLS bypass", async () => {
    const seen: string[] = [];

    const server = createTLSServer(
      { key: await Bun.file(key).text(), cert: await Bun.file(certificate).text() },
      (request, response) => {
        seen.push(request.headers.host ?? "");
        response.writeHead(200, { "Content-Type": "text/plain" });
        response.end("trusted");
      },
    );

    const sni: string[] = [];
    server.on("secureConnection", (socket) => {
      sni.push(socket.servername || "");
    });
    const port = await listen(server);

    try {
      const child = Bun.spawn(
        [
          process.execPath,
          "--eval",
          `
        import {requestPage} from ${JSON.stringify(fileURLToPath(new URL("./page-network.ts", import.meta.url)))};
        const good = new URL(${JSON.stringify(`https://page.test:${port}/`)});
        const result = await requestPage(good, '127.0.0.1', new AbortController().signal);
        if(new TextDecoder().decode(result.body) !== 'trusted') throw new Error('Wrong body');
        good.hostname = 'wrong.test';
        try { await requestPage(good, '127.0.0.1', new AbortController().signal); }
        catch { console.log('hostname rejected'); process.exit(0); }
        throw new Error('Accepted incorrect TLS hostname');
      `,
        ],
        {
          env: {
            ...process.env,
            NODE_EXTRA_CA_CERTS: certificate,
            NODE_TLS_REJECT_UNAUTHORIZED: "0",
            HTTP_PROXY: "http://127.0.0.1:1",
            HTTPS_PROXY: "http://127.0.0.1:1",
            ALL_PROXY: "http://127.0.0.1:1",
            NO_PROXY: "",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);

      expect({ code, stderr }).toMatchObject({ code: 0 });
      expect(stdout).toContain("hostname rejected");
      expect(seen).toEqual([`page.test:${port}`]);
      expect(sni).toEqual(["page.test", "wrong.test"]);
      expect(
        await failedRequest(
          requestPage(
            new URL(`https://page.test:${port}/`),
            "127.0.0.1",
            new AbortController().signal,
          ),
        ),
      ).toBeInstanceOf(Error);
    } finally {
      await close(server);
    }
  });
});
