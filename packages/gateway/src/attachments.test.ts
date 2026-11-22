import { expect, test } from "bun:test";

import { Effect } from "effect";

import { boundedAttachment } from "#src/attachments";

test("authenticated downloads keep credentials on the approved host and refuse redirects", async () => {
  const requests: RequestInit[] = [];

  const download = boundedAttachment(
    async (_url, init) => {
      requests.push(init);

      return new Response(null, { status: 302, headers: { location: "https://example.com" } });
    },
    new Set(["files.slack.com"]),
    "Slack",
    { Authorization: "Bearer secret" },
  );

  const attachment = { id: "F123", name: "note.txt", ref: "https://files.slack.com/file" };
  await expect(Effect.runPromise(download(attachment, 10))).rejects.toThrow("redirected");
  expect(requests[0]?.headers).toEqual({ Authorization: "Bearer secret" });
  expect(requests[0]?.redirect).toBe("manual");
  await expect(
    Effect.runPromise(download({ ...attachment, ref: "https://example.com/file" }, 10)),
  ).rejects.toThrow("not hosted");
  expect(requests).toHaveLength(1);
});

test("download limits use received bytes even when declared size is smaller", async () => {
  const download = boundedAttachment(
    async () => new Response(new Uint8Array(20)),
    new Set(["files.slack.com"]),
    "Slack",
  );

  await expect(
    Effect.runPromise(
      download({ id: "F123", name: "note.txt", size: 1, ref: "https://files.slack.com/file" }, 10),
    ),
  ).rejects.toThrow("larger");
});

test("when an attachment URL contains a port or userinfo or returns non-OK/3xx, rejects it and cancels the response body", async () => {
  let cancelled = 0;

  const download = boundedAttachment(
    async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled++;
          },
        }),
        { status: 500 },
      ),
    new Set(["files.slack.com"]),
    "Slack",
  );

  for (const ref of [
    "https://files.slack.com:8443/file",
    "https://user@files.slack.com/file",
    "https://user:pass@files.slack.com/file",
  ])
    await expect(
      Effect.runPromise(download({ id: "F123", name: "note.txt", ref }, 10)),
    ).rejects.toThrow("not hosted");

  await expect(
    Effect.runPromise(
      download({ id: "F123", name: "note.txt", ref: "https://files.slack.com/file" }, 10),
    ),
  ).rejects.toMatchObject({ reason: "unavailable" });
  expect(cancelled).toBe(1);
});
