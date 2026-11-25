import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChannelEnvironment } from "@poppet/gateway";
import { Effect, Redacted } from "effect";

import { telegram } from "#src/registration";
import { telegramSettings } from "#src/settings";

const token = "123456:telegram-secret";

const setup = (directory: string, args: ReadonlyArray<string>) =>
  Effect.runPromise(
    telegram
      .setup(args)
      .pipe(Effect.provideService(ChannelEnvironment, { dataDirectory: directory })),
  );

describe.concurrent("settings", () => {
  test("setup saves the policy and token privately and defaults home to the chat", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-telegram-"));

    try {
      expect(await Effect.runPromise(telegramSettings.load(directory))).toBeNull();

      const message = await setup(directory, [
        "setup",
        "--owner-id",
        "200",
        "--chat-id",
        "-100500",
        "--bot-token",
        token,
      ]);

      expect(message).not.toContain(token);
      const path = join(directory, "channels/telegram.json");
      expect((await stat(path)).mode & 0o777).toBe(0o600);

      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
        ownerId: "200",
        chatId: "-100500",
        homeConversationId: "-100500",
        token,
      });

      const loaded = await Effect.runPromise(telegramSettings.load(directory));
      expect(loaded && Redacted.value(loaded.token)).toBe(token);
      expect(JSON.stringify(loaded)).not.toContain(token);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.each([
    ["legacy positional arguments", ["setup", "200", "-100500", "--key-stdin"]],
    [
      "an invalid token",
      ["setup", "--owner-id", "200", "--chat-id=-100500", "--bot-token", "invalid"],
    ],
    ["a missing owner", ["setup", "--chat-id=-100500", "--bot-token", token]],
    ["a missing chat", ["setup", "--owner-id", "200", "--bot-token", token]],
    ["a missing value", ["setup", "--owner-id", "200", "--chat-id=-100500", "--bot-token"]],
    ...(
      [
        ["a duplicate required flag", ["--owner-id", "300"]],
        [
          "a duplicate optional flag",
          ["--home-conversation-id=-100500", "--home-conversation-id=-100500:7"],
        ],
        ["an unknown flag", ["--unknown=" + token]],
        ["an extra positional", [token]],
        ["the old stdin flag", ["--key-stdin"]],
      ] as const
    ).map(
      ([name, extra]) =>
        [
          name,
          ["setup", "--owner-id", "200", "--chat-id=-100500", "--bot-token", token, ...extra],
        ] as const,
    ),
  ])("setup rejects %s without replacing settings or exposing the token", async (_, args) => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-telegram-flags-"));

    try {
      await setup(directory, [
        "setup",
        "--owner-id",
        "200",
        "--chat-id=-100500",
        "--bot-token",
        token,
      ]);
      const path = join(directory, "channels/telegram.json");
      const before = await readFile(path, "utf8");

      const result = await Effect.runPromise(
        telegram
          .setup(args)
          .pipe(
            Effect.provideService(ChannelEnvironment, { dataDirectory: directory }),
            Effect.result,
          ),
      );

      expect(result).toHaveProperty("failure.reason", "configuration");
      expect(JSON.stringify(result)).not.toContain(token);
      expect(await readFile(path, "utf8")).toBe(before);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.each([
    [
      "a private chat that is not the owner's",
      ["setup", "--owner-id", "200", "--chat-id", "300", "--bot-token", token],
    ],
    [
      "a home topic in another chat",
      [
        "setup",
        "--owner-id",
        "200",
        "--chat-id",
        "-100500",
        "--home-conversation-id",
        "-100600:7",
        "--bot-token",
        token,
      ],
    ],
    [
      "a non-numeric owner",
      ["setup", "--owner-id", "owner", "--chat-id", "-100500", "--bot-token", token],
    ],
    ["a missing bot token", ["setup", "--owner-id", "200", "--chat-id", "-100500"]],
  ])("setup rejects %s without saving", async (_, args) => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-telegram-invalid-"));

    try {
      await expect(setup(directory, args)).rejects.toThrow();
      expect(await Effect.runPromise(telegramSettings.load(directory))).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("setup accepts the owner's private chat and a home forum topic", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-telegram-home-"));

    try {
      await setup(directory, [
        "setup",
        "--owner-id",
        "200",
        "--chat-id",
        "200",
        "--bot-token",
        token,
      ]);
      await setup(directory, [
        "setup",
        "--bot-token=" + token,
        "--home-conversation-id=-100500:7",
        "--chat-id=-100500",
        "--owner-id=200",
      ]);
      await setup(directory, [
        "setup",
        "--owner-id",
        "200",
        "--chat-id",
        "-100500",
        "--home-conversation-id",
        "-100500:7",
        "--bot-token",
        token,
      ]);
      const loaded = await Effect.runPromise(telegramSettings.load(directory));
      expect(loaded?.homeConversationId).toBe("-100500:7");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
