import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigProvider, Console, Deferred, Effect, Fiber } from "effect";

import { run } from "#src/cli";
import { loadRegisteredChannels } from "#src/commands/gateway/registry";

const install = async (directory: string, name: string, registration: string) => {
  const target = join(directory, "gateways", "node_modules", name);
  await mkdir(target, { recursive: true });
  await writeFile(
    join(target, "package.json"),
    JSON.stringify({
      name,
      type: "module",
      exports: { "./registration": { import: "./index.ts" } },
    }),
  );
  await writeFile(
    join(target, "index.ts"),
    `import { Effect } from ${JSON.stringify(import.meta.resolve("effect"))};
     import { ChannelEnvironment } from ${JSON.stringify(import.meta.resolve("@poppet/gateway"))};
     export default ${registration};`,
  );
};

const registration = (id: string) => `{
  id: ${JSON.stringify(id)}, name: "Fixture chat", setupHelp: "setup <value>",
  setup: (args) => ChannelEnvironment.use(({ dataDirectory }) =>
    Effect.succeed(JSON.stringify({ dataDirectory, args }))),
  load: Effect.succeed(null)
}`;

const configure = (directory: string, entries: ReadonlyArray<string>) =>
  writeFile(join(directory, "config.json"), JSON.stringify({ gatewayPackages: entries }));

const environment = (directory: string, overrides: Record<string, string> = {}) =>
  ConfigProvider.fromEnv({
    env: { POPPET_DATA_DIR: directory, ...overrides },
    preserveEmptyStrings: true,
  });

describe("external gateway registrations", () => {
  test("when an adapter is installed, loads its setup and worker commands without adding it to help", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-external-gateway-"));
    const lines: Array<string> = [];

    try {
      await install(directory, "@fixture/chat", registration("fixture"));
      await configure(directory, ["@fixture/chat/registration"]);

      await Effect.runPromise(
        Effect.gen(function* () {
          const ready = yield* Deferred.make<void>();

          const output: Console.Console = {
            ...console,
            log: (...values) => {
              lines.push(values.join(" "));
            },
            error: (...values) => {
              const text = values.join(" ");
              lines.push(text);

              if (text.includes('msg="worker started"')) {
                Effect.runSync(Deferred.succeed(ready, undefined));
              }
            },
          };

          const invoke = (args: ReadonlyArray<string>) =>
            run(args, () => Effect.succeed(null)).pipe(
              Effect.provideService(Console.Console, output),
            );

          yield* invoke(["gateway", "--help"]);
          expect(lines.join("\n")).not.toContain("Fixture chat");
          lines.length = 0;
          yield* invoke(["gateway", "fixture", "setup", "--literal"]);
          expect(JSON.parse(lines.at(-1)!)).toEqual({
            dataDirectory: directory,
            args: ["setup", "--literal"],
          });
          yield* invoke(["worker", "status", "--json"]);
          expect(JSON.parse(lines.at(-1)!).worker.messaging.channels).toMatchObject([
            { id: "discord", enabled: false },
            { id: "slack", enabled: false },
            { id: "fixture", enabled: false },
          ]);

          const worker = yield* invoke(["worker", "run"]).pipe(Effect.forkChild);
          yield* Deferred.await(ready).pipe(Effect.timeout("3 seconds"));
          yield* invoke(["worker", "status", "--json"]);
          expect(JSON.parse(lines.at(-1)!).worker.messaging).toMatchObject({
            running: true,
            channels: [{ id: "discord" }, { id: "slack" }, { id: "fixture" }],
          });
          yield* Fiber.interrupt(worker);
        }).pipe(Effect.provideService(ConfigProvider.ConfigProvider, environment(directory))),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("when an adapter is outside the install directory or the directory is writable by others, rejects it before import", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-gateway-paths-"));

    try {
      const nested = join(directory, "data");
      await install(nested, "local", registration("local"));
      await install(directory, "outside", registration("outside"));
      const gateways = join(nested, "gateways");
      const outer = join(directory, "gateways", "node_modules", "outside");
      await symlink(outer, join(gateways, "node_modules", "outside"));

      const invoke = loadRegisteredChannels.pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, environment(nested)),
        Effect.flip,
      );

      await configure(nested, ["outside/registration"]);
      expect(await Effect.runPromise(invoke)).toMatchObject({ reason: "configuration" });
      await configure(nested, ["local/registration"]);
      await chmod(gateways, 0o777);
      expect(await Effect.runPromise(invoke)).toMatchObject({ reason: "configuration" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects missing packages, malformed exports, unsafe entry points, and conflicting IDs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-invalid-gateway-"));

    try {
      await install(directory, "bad", '{ id: "bad", setup: 1, load: null }');
      await install(directory, "duplicate", registration("discord"));
      await install(directory, "invalid", registration("Bad_ID"));
      await install(directory, "valid", registration("extra"));

      await Array.fromAsync(
        [
          [["missing/registration"], "Cannot load gateway package"],
          [["bad/registration"], "Cannot load gateway package"],
          [["../valid"], "Cannot load gateway package"],
          [["file:///tmp/adapter.ts"], "Cannot load gateway package"],
          [["duplicate/registration"], "Duplicate channel registration: discord"],
          [["invalid/registration"], "Invalid channel ID: Bad_ID"],
          [["valid/registration", "valid/registration"], "Duplicate channel registration: extra"],
        ] as const,
        async ([entries, message]) => {
          await configure(directory, entries);

          const result = await Effect.runPromise(
            loadRegisteredChannels.pipe(
              Effect.provideService(ConfigProvider.ConfigProvider, environment(directory)),
              Effect.result,
            ),
          );

          expect(result).toHaveProperty("failure.reason", "configuration");
          expect(result).toHaveProperty("failure.message", expect.stringContaining(message));
        },
      );

      await writeFile(join(directory, "config.json"), JSON.stringify({ gatewayPackages: [] }));

      const overridden = await Effect.runPromise(
        loadRegisteredChannels.pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            environment(directory, { POPPET_GATEWAY_PACKAGES: "[]" }),
          ),
        ),
      );

      expect(overridden.map((entry) => entry.id)).toEqual(["discord", "slack"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
