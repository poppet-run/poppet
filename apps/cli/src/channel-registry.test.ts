import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { workerSocketPath } from "@poppet/worker";
import { ConfigProvider, Console, Deferred, Effect, Fiber } from "effect";

import { loadRegisteredChannels } from "#src/channel-registry";
import { run } from "#src/cli";
import { remoteWorkerCommand } from "#src/worker-commands";

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
  test("loads installed package subpaths for setup, help, and the messaging worker", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-external-gateway-"));
    const lines: string[] = [];

    try {
      await install(directory, "@fixture/chat", registration("fixture"));
      await configure(directory, ["@fixture/chat/registration"]);

      await Effect.runPromise(
        Effect.gen(function* () {
          const ready = yield* Deferred.make<void>();

          const output: Console.Console = {
            ...console,
            log: (...values) => {
              const text = values.join(" ");
              lines.push(text);

              if (text.includes("Worker running."))
                Effect.runSync(Deferred.succeed(ready, undefined));
            },
          };

          const invoke = (args: ReadonlyArray<string>) =>
            run(args).pipe(Effect.provideService(Console.Console, output));

          yield* invoke(["gateway", "--help"]);
          expect(lines.join("\n")).toContain("Fixture chat");
          lines.length = 0;
          yield* invoke(["gateway", "fixture", "setup", "--literal"]);
          expect(JSON.parse(lines.at(-1)!)).toEqual({
            dataDirectory: directory,
            args: ["setup", "--literal"],
          });
          yield* invoke(["gateway", "status"]);
          expect(JSON.parse(lines.at(-1)!).channels).toMatchObject([
            { id: "discord", enabled: false },
            { id: "fixture", enabled: false },
          ]);

          const worker = yield* invoke(["worker", "run"]).pipe(Effect.forkChild);
          yield* Deferred.await(ready).pipe(Effect.timeout("3 seconds"));
          yield* remoteWorkerCommand(workerSocketPath(directory), { kind: "gateway" }, (text) =>
            Effect.sync(() => {
              lines.push(text);
            }),
          );
          expect(JSON.parse(lines.at(-1)!)).toMatchObject({
            running: true,
            channels: [{ id: "discord" }, { id: "fixture" }],
          });
          yield* Fiber.interrupt(worker);
        }).pipe(Effect.provideService(ConfigProvider.ConfigProvider, environment(directory))),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects missing packages, malformed exports, unsafe entry points, and conflicting IDs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-invalid-gateway-"));

    try {
      await install(directory, "bad", '{ id: "bad", setup: 1, load: null }');
      await install(directory, "duplicate", registration("discord"));
      await install(directory, "reserved", registration("work"));
      await install(directory, "valid", registration("extra"));

      await Array.fromAsync(
        [
          [["missing/registration"], "Cannot load gateway package"],
          [["bad/registration"], "Cannot load gateway package"],
          [["../valid"], "Cannot load gateway package"],
          [["file:///tmp/adapter.ts"], "Cannot load gateway package"],
          [["duplicate/registration"], "Duplicate channel registration: discord"],
          [["reserved/registration"], "Invalid channel ID: work"],
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

      expect(overridden.map((entry) => entry.id)).toEqual(["discord"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
