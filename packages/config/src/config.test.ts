import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { ConfigProvider, Effect, Exit } from "effect";

import { loadConfig } from "#src/config";

const withEnvironment = (environment: Record<string, string>) =>
  loadConfig("test-provider", ["test-provider", "other-provider"]).pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromEnv({ env: environment, preserveEmptyStrings: true }),
    ),
  );

describe("loadConfig", () => {
  test("when explicit settings override defaults, resolves their relative paths", async () => {
    const config = await Effect.runPromise(
      withEnvironment({
        POPPET_APP_NAME: "My Poppet",
        POPPET_DATA_DIR: "./test-data",
        POPPET_PROVIDER: "other-provider",
        POPPET_MODEL: "glm-5.3",
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
    for (const key of ["POPPET_APP_NAME", "POPPET_DATA_DIR", "POPPET_PROVIDER", "POPPET_MODEL"]) {
      for (const value of ["", "   ", " trailing-space "]) {
        const exit = Effect.runSyncExit(withEnvironment({ [key]: value }));

        expect(Exit.isFailure(exit)).toBe(true);
      }
    }
  });

  test("when the provider is unregistered, rejects it without falling back", () => {
    expect(
      Exit.isFailure(Effect.runSyncExit(withEnvironment({ POPPET_PROVIDER: "unknown" }))),
    ).toBe(true);
  });
});
