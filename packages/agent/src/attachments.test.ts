import { describe, expect, test } from "bun:test";

import type { Completion, ModelRequest } from "@poppet/provider";
import { Store } from "@poppet/store";
import { Effect, Stream } from "effect";

import { identifyAttachment } from "#src/attachments";
import { Agent } from "#src/service";
import { defaultPolicy, type ChatPolicy } from "#src/settings";
import { agentHarness, testModel } from "#src/test/harness";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);

const webp = new Uint8Array([...new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "), 1]);

const text = (value: string) => new TextEncoder().encode(value);

const response: Completion = {
  output: [{ type: "text", text: "Seen" }],
  continuation: { version: 1, provider: "test-provider", model: "test-model", data: {} },
  finishReason: "stop",
  usage: null,
};

const answer = () => Stream.make({ type: "completed" as const, response });

const fixture = async (images: boolean, policy: Partial<ChatPolicy> = {}) => {
  const harness = await agentHarness(policy);
  const requests: ModelRequest[] = [];

  const layer = harness.agent(() =>
    Effect.succeed(testModel({ stream: answer, answer, requests, capabilities: { images } })),
  );

  return {
    requests,
    run: <A, E>(program: Effect.Effect<A, E, Agent | Store>) =>
      Effect.runPromise(program.pipe(Effect.provide(layer))),
    close: harness.close,
  };
};

describe("identifyAttachment", () => {
  test("when bytes are an image, identifies the type from the bytes whatever the name says", () => {
    expect(identifyAttachment({ name: "photo.txt", body: png }, defaultPolicy)).toEqual({
      name: "photo.txt",
      mediaType: "image/png",
    });
    expect(identifyAttachment({ name: "sticker", body: webp }, defaultPolicy).mediaType).toBe(
      "image/webp",
    );
  });

  test("when a file is UTF-8 text with an allowed extension, accepts it with a clean name", () => {
    expect(
      identifyAttachment({ name: "../logs/\u0007build.LOG", body: text("ok") }, defaultPolicy),
    ).toEqual({ name: "build.LOG", mediaType: "text/plain" });
  });

  test.each([
    ["an unsupported type", "report.pdf", text("%PDF-1.7"), "only PNG, JPEG"],
    ["invalid UTF-8", "notes.txt", new Uint8Array([0xff, 0xfe]), "not UTF-8 text"],
    ["a NUL byte", "notes.txt", new Uint8Array([0x61, 0, 0x62]), "not UTF-8 text"],
    ["an oversized text file", "notes.txt", text("abcd"), "text files are limited"],
    ["an oversized image", "screen.png", png, "images are limited"],
  ])("when a file has %s, rejects it with the reason", (_, name, body, reason) => {
    expect(() =>
      identifyAttachment({ name, body }, { ...defaultPolicy, textFileBytes: 3, imageBytes: 4 }),
    ).toThrow(reason);
  });
});

describe("Agent attachments", () => {
  test("when the owner attaches an image and a file, sends their contents and withdraws mutating tools", async () => {
    const state = await fixture(true);

    try {
      const saved = await state.run(
        Effect.gen(function* () {
          const store = yield* Store;
          const agent = yield* Agent;
          const session = yield* store.createSession("test-provider", "test-model");

          yield* Stream.runDrain(
            agent.send(session.id, "", {
              attachments: [
                { name: "screen.png", body: png },
                { name: "notes.md", body: text("# Notes") },
              ],
            }),
          );

          return {
            session: yield* store.session(session.id),
            messages: yield* store.messages(session.id),
          };
        }),
      );

      const [user] = saved.messages.map((entry) => entry.message);
      expect(user).toMatchObject({
        role: "user",
        text: "",
        attachments: [
          { name: "screen.png", mediaType: "image/png", size: png.length },
          { name: "notes.md", mediaType: "text/plain", size: 7 },
        ],
      });
      expect(saved.session?.title).toBe("screen.png");

      const [request] = state.requests;
      const ids = user?.role === "user" ? (user.attachments ?? []).map((entry) => entry.id) : [];
      expect(request?.attachments).toEqual([
        { id: ids[0]!, base64: Buffer.from(png).toString("base64") },
        { id: ids[1]!, text: "# Notes" },
      ]);
      expect(request?.tools.map((tool) => tool.name)).not.toContain("memory");
    } finally {
      await state.close();
    }
  });

  test("when the session's model does not accept images, fails the run without inference", async () => {
    const state = await fixture(false);

    try {
      const failure = await state.run(
        Effect.gen(function* () {
          const store = yield* Store;
          const session = yield* store.createSession("test-provider", "test-model");

          return yield* Stream.runDrain(
            (yield* Agent).send(session.id, "What is this?", {
              attachments: [{ name: "screen.png", body: png }],
            }),
          ).pipe(Effect.flip);
        }),
      );

      expect(failure).toMatchObject({
        reason: "attachment",
        message: "Test does not accept images. Start a new session with a model that does.",
      });
      expect(state.requests).toHaveLength(0);
    } finally {
      await state.close();
    }
  });

  test("when too many files are attached, rejects the message before saving it", async () => {
    const state = await fixture(true, { attachmentsPerMessage: 1 });

    try {
      const result = await state.run(
        Effect.gen(function* () {
          const store = yield* Store;
          const session = yield* store.createSession("test-provider", "test-model");

          const failure = yield* Stream.runDrain(
            (yield* Agent).send(session.id, "Two", {
              attachments: [
                { name: "a.txt", body: text("a") },
                { name: "b.txt", body: text("b") },
              ],
            }),
          ).pipe(Effect.flip);

          return { failure, messages: yield* store.messages(session.id) };
        }),
      );

      expect(result.failure).toMatchObject({ reason: "attachment" });
      expect(result.messages).toHaveLength(0);
    } finally {
      await state.close();
    }
  });

  test("when retained history holds more images than a request allows, resends only the newest", async () => {
    const state = await fixture(true, { imagesPerRequest: 1 });

    try {
      await state.run(
        Effect.gen(function* () {
          const store = yield* Store;
          const agent = yield* Agent;
          const session = yield* store.createSession("test-provider", "test-model");

          for (const prompt of ["First", "Second"])
            yield* Stream.runDrain(
              agent.send(session.id, prompt, {
                attachments: [{ name: `${prompt}.png`, body: png }],
              }),
            );
        }),
      );

      const latest = state.requests.at(-1)!;
      const users = latest.messages.filter((message) => message.role === "user");

      expect(users[0]).toEqual({
        role: "user",
        text: expect.stringMatching(
          /^First\n\[Earlier image not resent: "First\.png" \(attachment [\w-]+\)\]$/,
        ),
      });
      expect(users[1]).toMatchObject({ text: "Second", attachments: [{ name: "Second.png" }] });
      expect(latest.attachments).toHaveLength(1);
    } finally {
      await state.close();
    }
  });
});
