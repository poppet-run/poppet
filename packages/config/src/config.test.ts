import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { ConfigProvider, Effect, Exit } from "effect";

import { loadConfig } from "#src/config";

const withEnvironment = (environment: Record<string, string>) =>
  loadConfig("test-provider", ["test-provider", "other-provider"]).pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromEnv({ env: environment, preserveEmptyStrings: true }),
    ),
  );

describe("configuration", () => {
  test("defaults keep notes under the application data directory", async () => {
    const config = await Effect.runPromise(withEnvironment({}));

    expect(config).toEqual({
      applicationName: "Poppet",
      dataDirectory: join(homedir(), ".config", "poppet"),
      notesDirectory: join(homedir(), ".config", "poppet", "notes"),
      provider: "test-provider",
      model: null,
    });
  });

  test("a custom data directory also changes the default notes directory", async () => {
    const config = await Effect.runPromise(withEnvironment({ POPPET_DATA_DIR: "./test-data" }));

    expect(config.dataDirectory).toBe(resolve("./test-data"));
    expect(config.notesDirectory).toBe(resolve("./test-data/notes"));
  });

  test("explicit values override defaults and resolve relative paths", async () => {
    const config = await Effect.runPromise(
      withEnvironment({
        POPPET_APP_NAME: "My Poppet",
        POPPET_DATA_DIR: "./test-data",
        POPPET_NOTES_DIR: "./my-notes",
        POPPET_PROVIDER: "other-provider",
        POPPET_MODEL: "glm-5.3",
      }),
    );

    expect(config).toEqual({
      applicationName: "My Poppet",
      dataDirectory: resolve("./test-data"),
      notesDirectory: resolve("./my-notes"),
      provider: "other-provider",
      model: "glm-5.3",
    });
  });

  test("invalid values fail instead of silently selecting defaults", () => {
    for (const key of [
      "POPPET_APP_NAME",
      "POPPET_DATA_DIR",
      "POPPET_NOTES_DIR",
      "POPPET_PROVIDER",
      "POPPET_MODEL",
    ]) {
      for (const value of ["", "   ", " trailing-space "]) {
        const exit = Effect.runSyncExit(withEnvironment({ [key]: value }));

        expect(Exit.isFailure(exit)).toBe(true);
      }
    }
  });

  test("rejects reserved or unknown providers without falling back", () => {
    for (const provider of ["openai-api", "unknown"])
      expect(
        Exit.isFailure(Effect.runSyncExit(withEnvironment({ POPPET_PROVIDER: provider }))),
      ).toBe(true);
  });
});
