import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { ConfigProvider, Effect, Exit } from "effect";

import { loadConfig } from "#src/config";

const withSettings = (settings: Record<string, string>) =>
  loadConfig("test-provider", ["test-provider", "other-provider"]).pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown(settings, { preserveEmptyStrings: true }),
    ),
  );

describe("loadConfig", () => {
  test("when explicit settings override defaults, resolves their relative paths", async () => {
    const config = await Effect.runPromise(
      withSettings({
        applicationName: "My Poppet",
        POPPET_DATA_DIR: "./test-data",
        provider: "other-provider",
        model: "glm-5.3",
      }),
    );

    expect(config).toEqual({
      applicationName: "My Poppet",
      dataDirectory: resolve("./test-data"),
      provider: "other-provider",
      model: "glm-5.3",
    });
  });

  test("when configured values are invalid, fails without selecting defaults", () => {
    for (const key of ["applicationName", "POPPET_DATA_DIR", "provider", "model"]) {
      for (const value of ["", "   ", " trailing-space "]) {
        const exit = Effect.runSyncExit(withSettings({ [key]: value }));

        expect(Exit.isFailure(exit)).toBe(true);
      }
    }
  });

  test("when the provider is unregistered, rejects it without falling back", () => {
    expect(Exit.isFailure(Effect.runSyncExit(withSettings({ provider: "unknown" })))).toBe(true);
  });
});
