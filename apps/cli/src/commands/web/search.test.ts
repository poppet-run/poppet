import { describe, expect, test } from "bun:test";

import { ChatSettings, WebSearch, defaultPolicy } from "@poppet/agent";
import { ApiKeyStore } from "@poppet/credentials";
import { ConfigProvider, Console, Effect, Layer, Redacted } from "effect";

import { manageWebSearch, WebSearchLive } from "#src/commands/web/search";

describe.each(["brave", "kagi"])("WebSearchLive", (provider) => {
  test.each([
    [false, true],
    [true, false],
    [true, true],
  ])(
    `when ${provider} search is enabled=%j and stored=%j, advertises it only with both permission and a key`,
    async (enabled, stored) => {
      let reads = 0;

      const layer = WebSearchLive.pipe(
        Layer.provide([
          Layer.succeed(ChatSettings, defaultPolicy),
          Layer.succeed(ApiKeyStore, {
            read: (id) =>
              Effect.sync(() => {
                expect(id).toBe(`${provider}-search`);
                reads++;

                return stored ? Redacted.make("test-key") : null;
              }),
            write: () => Effect.void,
            remove: () => Effect.void,
          }),
        ]),
      );

      const service = await Effect.runPromise(
        WebSearch.pipe(
          Effect.provide(layer),
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({
              webSearchProvider: enabled ? provider : undefined,
              POPPET_BRAVE_SEARCH_API_KEY: "invalid environment key",
              POPPET_KAGI_SEARCH_API_KEY: "invalid environment key",
            }),
          ),
        ),
      );

      expect(service.search !== null).toBe(enabled && stored);
      expect(reads).toBe(enabled ? 1 : 0);
    },
  );
});

const run = (action: "login" | "status" | "logout", output: string[]) =>
  manageWebSearch(action, "test-key", true).pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})),
    Effect.provideService(Console.Console, {
      ...console,
      log: (value) => {
        output.push(String(value));
      },
    }),
    Effect.provideService(ApiKeyStore, {
      read: () => Effect.die("Must not read credentials without a provider"),
      write: () => Effect.die("Must not save credentials without a provider"),
      remove: () => Effect.die("Must not delete credentials without a provider"),
    }),
  );

describe("manageWebSearch without a provider", () => {
  test("status reports disabled without inspecting stored credentials", async () => {
    const output: string[] = [];
    await Effect.runPromise(run("status", output));
    expect(JSON.parse(output.join(""))).toEqual({
      provider: null,
      enabled: false,
      configured: false,
      source: null,
    });
  });

  test.each(["login", "logout"] as const)(
    "%s requires a provider before touching credentials",
    async (action) => {
      const error = await Effect.runPromise(run(action, []).pipe(Effect.flip));
      expect(error.message).toBe(
        'Set webSearchProvider to "brave" or "kagi" in config.json first.',
      );
    },
  );
});
