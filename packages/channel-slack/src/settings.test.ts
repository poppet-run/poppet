import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChannelEnvironment } from "@poppet/gateway";
import { Effect, Redacted } from "effect";

import { parseConversation } from "#src/channel";
import { slack } from "#src/registration";
import { loadSlackSettings } from "#src/settings";

test("setup protects both tokens and keeps them out of configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "poppet-slack-"));

  try {
    const setup = (args: string[]) =>
      Effect.runPromise(
        slack
          .setup(args)
          .pipe(Effect.provideService(ChannelEnvironment, { dataDirectory: directory })),
      );

    const args = [
      "setup",
      "--owner-id",
      "U123",
      "--team-id",
      "T123",
      "--home-channel-id",
      "C123",
      "--bot-token",
      "bot-secret",
      "--app-token",
      "app-secret",
    ];

    expect(await setup(args)).not.toContain("secret");
    const loaded = await Effect.runPromise(loadSlackSettings(directory));
    expect(loaded?.teamId).toBe("T123");
    expect(Redacted.value(loaded!.token)).toBe("bot-secret");
    expect(Redacted.value(loaded!.appToken)).toBe("app-secret");
    expect((await stat(join(directory, "channels/slack.json"))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(directory, "config.json"), "utf8")).not.toContain("secret");
    await expect(setup([...args, "--owner-id", "U456"])).rejects.toThrow();
    expect((await Effect.runPromise(loadSlackSettings(directory)))?.ownerId).toBe("U123");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("destinations preserve channel and thread identity and reject malformed IDs", () => {
  expect(parseConversation("C123:12345.000001")).toEqual({ channel: "C123", ts: "12345.000001" });
  expect(parseConversation("G123").channel).toBe("G123");

  for (const id of ["D123", "C123:bad", "C123:123.456:789", "C123\n"])
    expect(() => parseConversation(id)).toThrow();
});
