import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import { downloadAttachment, incomingAttachments } from "#src/attachments";

const file = {
  id: "800",
  name: "screen.png",
  size: 4,
  url: "https://cdn.discordapp.com/attachments/1/2/screen.png?ex=1",
};

const download = (
  response: () => Response,
  attachment: typeof file = file,
  maxBytes = 1024 * 1024,
) => {
  const requests: { url: string; redirect: RequestInit["redirect"] }[] = [];

  const result = Effect.runPromise(
    downloadAttachment(async (url, init) => {
      requests.push({ url: url.toString(), redirect: init.redirect });

      return response();
    })(attachment, maxBytes).pipe(Effect.result),
  );

  return { requests, result };
};

describe("incomingAttachments", () => {
  test("when a message has files, keeps each file's ID, name, size, and CDN URL", () => {
    const attachment = { id: "800", name: "screen.png", size: 4, url: file.url };

    expect(incomingAttachments([attachment])).toEqual([file]);
  });
});

describe("downloadAttachment", () => {
  test("when Discord returns the file, reads its bytes without following redirects", async () => {
    const { requests, result } = download(() => new Response(new Uint8Array([1, 2, 3, 4])));

    expect(await result).toEqual(expect.objectContaining({ success: Buffer.from([1, 2, 3, 4]) }));
    expect(requests).toEqual([{ url: file.url, redirect: "manual" }]);
  });

  test.each([
    [
      "is hosted elsewhere",
      { ...file, url: "https://example.com/screen.png" },
      "not hosted by Discord",
    ],
    [
      "uses plain HTTP",
      { ...file, url: "http://cdn.discordapp.com/a.png" },
      "not hosted by Discord",
    ],
    ["declares more than the limit", { ...file, size: 2 * 1024 * 1024 }, "larger than 1 MiB"],
  ])("when the file %s, refuses it without a request", async (_, attachment, message) => {
    const { requests, result } = download(() => new Response("unused"), attachment);

    expect(await result).toEqual(
      expect.objectContaining({
        failure: expect.objectContaining({
          reason: "permission",
          message: expect.stringContaining(message),
        }),
      }),
    );
    expect(requests).toHaveLength(0);
  });

  test.each([
    [
      "sends more bytes than its declared size",
      () => new Response(new Uint8Array(1025)),
      "permission",
    ],
    [
      "redirects elsewhere",
      () => new Response(null, { status: 302, headers: { location: "https://example.com/" } }),
      "permission",
    ],
    ["fails on the server", () => new Response("down", { status: 503 }), "unavailable"],
  ] as const)("when Discord %s, reports the failure reason", async (_, response, reason) => {
    const { result } = download(response, file, 1024);

    expect(await result).toEqual(
      expect.objectContaining({ failure: expect.objectContaining({ reason }) }),
    );
  });
});
