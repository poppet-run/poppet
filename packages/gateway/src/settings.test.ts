import { describe, expect, test } from "bun:test";
import { chmod, link, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import { loadGatewaySettings, saveGatewaySettings } from "#src/settings";

import { makeFIFO } from "../../../tools/testing/fifo";

describe.concurrent("settings.ts", () => {
  test("when gateway settings are saved or read, protects files and rejects overly permissive modes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-gateway-settings-"));
    const path = join(directory, "channels/test-gateway.json");

    try {
      expect(await Effect.runPromise(loadGatewaySettings(directory, "test-gateway"))).toBeNull();
      await Effect.runPromise(saveGatewaySettings(directory, "test-gateway", "gateway-secret"));
      expect((await stat(join(directory, "channels"))).mode & 0o777).toBe(0o700);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(await Effect.runPromise(loadGatewaySettings(directory, "test-gateway"))).toBe(
        "gateway-secret",
      );
      await chmod(path, 0o644);

      const widened = await Effect.runPromise(
        loadGatewaySettings(directory, "test-gateway").pipe(Effect.result),
      );

      expect(widened).toHaveProperty("failure.reason", "configuration");
      expect((await stat(path)).mode & 0o777).toBe(0o644);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.each(["symlink", "hardlink", "oversized", "fifo"])(
    "when gateway settings are %s, rejects them without exposing content or changing link targets",
    async (kind) => {
      const directory = await mkdtemp(join(tmpdir(), "poppet-gateway-invalid-"));

      try {
        await Effect.runPromise(saveGatewaySettings(directory, "test-gateway", "gateway-secret"));
        const path = join(directory, "channels/test-gateway.json");
        const other = join(directory, "other");
        await writeFile(other, "gateway-secret", { mode: 0o644 });
        await rm(path);

        if (kind === "symlink") {
          await symlink(other, path);
        } else if (kind === "hardlink") {
          await link(other, path);
        } else if (kind === "fifo") {
          makeFIFO(path);
        } else {
          await writeFile(path, "gateway-secret".repeat(2000));
        }

        const result = await Effect.runPromise(
          loadGatewaySettings(directory, "test-gateway").pipe(Effect.result),
        );

        expect(result).toHaveProperty("failure.reason", "configuration");
        expect(JSON.stringify(result)).not.toContain("gateway-secret");
        expect(await readFile(other, "utf8")).toBe("gateway-secret");
        expect((await stat(other)).mode & 0o777).toBe(0o644);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
