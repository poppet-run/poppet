import { describe, expect, test } from "bun:test";

import { ChatSettings, WebSearch, defaultPolicy } from "@poppet/agent";
import { ApiKeyStore } from "@poppet/credentials";
import { ConfigProvider, Effect, Layer, Redacted } from "effect";

import { WebSearchLive } from "#src/web-search";

describe.each(["brave", "kagi"])("WebSearchLive", (provider) => {
  test.each([
    [false, true],
    [true, false],
    [true, true],
  ])(
    `when ${provider} search is enabled=%s and stored=%s, advertises it only with both permission and a key`,
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
            ConfigProvider.fromUnknown({ webSearch: enabled, webSearchProvider: provider }),
          ),
        ),
      );

      expect(service.search !== null).toBe(enabled && stored);
      expect(reads).toBe(enabled ? 1 : 0);
    },
  );
});
