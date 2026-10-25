import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

import { serveWorker, workerSocketPath } from "@poppet/worker";
import { ConfigProvider, Console, Effect, type Schema } from "effect";

import { makeCLI } from "#src/cli";
import { providers } from "#src/providers";
import type { manageWorker } from "#src/worker";

const configure = async (directory: string, settings: Schema.JsonObject) => {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "config.json"), JSON.stringify(settings));

  return { POPPET_DATA_DIR: directory };
};

const invoke = async (
  args: ReadonlyArray<string>,
  environment: Record<string, string> = {},
  worker: typeof manageWorker = (action, dataDirectory) =>
    Effect.sync(() => {
      expect(action).toBe("status");

      return {
        installed: false,
        loaded: false,
        plist: join(dataDirectory, "home/Library/LaunchAgents/test.plist"),
        log: join(dataDirectory, "logs/worker.log"),
      };
    }),
) => {
  let stdout = "";
  const errors: string[] = [];

  const output: Console.Console = {
    ...console,
    log: (...values) => {
      stdout += `${values.join(" ")}\n`;
    },
    error: (...values) => errors.push(stripVTControlCharacters(values.join(" "))),
  };

  const run = makeCLI(
    providers,
    (text) =>
      Effect.sync(() => {
        stdout += text;
      }),
    worker,
  );

  const exitCode = await Effect.runPromise(
    run(args).pipe(
      Effect.provideService(Console.Console, output),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv({ env: environment, preserveEmptyStrings: true }),
      ),
      Effect.match({
        onSuccess: () => 0,
        onFailure: (error) => {
          errors.push(error.message);

          return 1;
        },
      }),
    ),
  );

  return { stdout, stderr: errors.join("\n"), exitCode };
};

describe("makeCLI", () => {
  test.each([false, true])(
    "when gateway settings are unreadable=%j, reports status without exposing secrets",
    async (unreadable) => {
      const directory = await mkdtemp(join(tmpdir(), "poppet-channel-status-"));

      const channels = [
        {
          id: "discord",
          name: "Discord",
          settings: {
            ownerId: "200",
            guildId: "300",
            homeChannelId: "400",
            token: "discord-secret",
          },
        },
      ];

      try {
        await mkdir(join(directory, "channels"), { mode: 0o700 });
        await Promise.all(
          channels.map(async ({ id, settings }) => {
            const { token, ...policy } = settings;
            await configure(directory, { discord: policy });
            await writeFile(
              join(directory, `channels/${id}.json`),
              unreadable ? "invalid-channel-secret" : JSON.stringify({ token }),
              { mode: 0o600 },
            );
          }),
        );
        const result = await invoke(["gateway", "status"], { POPPET_DATA_DIR: directory });

        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          running: false,
          enabled: !unreadable,
          channels: channels.map(({ id }) =>
            unreadable
              ? {
                  id,
                  enabled: false,
                  error:
                    "Cannot load Discord configuration or credentials. Check config.json and run gateway discord setup again.",
                }
              : { id, enabled: true },
          ),
        });
        expect(result.stdout + result.stderr).not.toContain("secret");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  test("when invocations run concurrently, isolates configuration without changing the process environment", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-cli-config-"));
    const previous = { ...process.env };

    const selections = [
      { name: "First", provider: "openrouter" },
      { name: "Second", provider: "opencode-go" },
    ];

    try {
      const results = await Promise.all(
        selections.map(async ({ name, provider }) =>
          invoke(
            ["config"],
            await configure(join(directory, name), { applicationName: name, provider }),
          ),
        ),
      );

      expect(results.map((result) => result.exitCode)).toEqual([0, 0]);
      expect(
        results.map((result) => {
          const config = JSON.parse(result.stdout);

          return { name: config.applicationName, provider: config.provider };
        }),
      ).toEqual(selections);
      expect({ ...process.env }).toEqual(previous);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("when a worker is running, sends a task control once without inspecting first or falling back locally", async () => {
    const directory = await mkdtemp("/tmp/p24-owner-");
    const storeDirectory = join(directory, "store");
    await mkdir(storeDirectory, { mode: 0o700 });
    const path = workerSocketPath(directory);
    const bodies: Schema.Json[] = [];

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* serveWorker(path, (_request, body) =>
              Effect.sync(() => {
                bodies.push(body);

                return Response.json({ ok: true, value: { taskId: "saved-task" } });
              }),
            );

            const reply = yield* Effect.promise(() =>
              invoke(["tasks", "edit", "saved-task", "--name", "Changed"], {
                POPPET_DATA_DIR: directory,
              }),
            );

            expect(reply.exitCode).toBe(0);
            expect(bodies).toEqual([
              { action: "edit", id: "saved-task", patch: { name: "Changed" } },
            ]);
            expect(yield* Effect.promise(() => readdir(storeDirectory))).toEqual(["tasks.sock"]);
          }),
        ),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("when saved tasks are edited, skipped, snoozed, or queued offline, preserves snapshots and cadence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-task-controls-cli-"));
    const environment = await configure(directory, { model: "saved-model" });
    const offline = { POPPET_DATA_DIR: directory };

    try {
      const added = await invoke(
        ["tasks", "add", "Original", "--at", "2099-10-22T09:00:00Z", "Read recent conversations"],
        environment,
      );

      expect(added.exitCode).toBe(0);
      const id = JSON.parse(added.stdout).id;

      const snoozed = await invoke(
        ["tasks", "snooze", id, "--until", "2099-10-23T09:00:00Z"],
        offline,
      );

      expect(snoozed.exitCode).toBe(0);
      const held = JSON.parse(snoozed.stdout);

      const edited = await invoke(
        ["tasks", "edit", id, "--name", "Renamed", "--prompt", "Read the new decisions"],
        offline,
      );

      expect(edited.exitCode).toBe(0);
      const replacement = JSON.parse(edited.stdout);
      expect(replacement).toMatchObject({
        changedFields: ["name", "prompt"],
        availableAt: held.availableAt,
        replacedOccurrenceIds: [held.occurrenceId],
      });
      expect((await invoke(["tasks", "edit", id], offline)).exitCode).toBe(1);
      expect((await invoke(["tasks", "edit", id, "--tz", "UTC"], offline)).exitCode).toBe(1);

      const rescheduled = await invoke(
        ["tasks", "edit", id, "--cron", "0 9 * * *", "--tz", "Europe/London"],
        offline,
      );

      expect(rescheduled.exitCode).toBe(0);
      expect(JSON.parse(rescheduled.stdout).snoozeCleared).toBe(true);
      const skipped = await invoke(["tasks", "skip-next", id], offline);
      expect(skipped.exitCode).toBe(0);
      const nextAt = JSON.parse(skipped.stdout).nextAt;
      const immediate = await invoke(["tasks", "run", id], offline);
      expect(immediate.exitCode).toBe(0);
      const queued = JSON.parse(immediate.stdout);
      expect(queued.nextAt).toBe(nextAt);
      const repeated = await invoke(["tasks", "run", id], offline);
      expect(repeated.exitCode).toBe(0);
      expect(JSON.parse(repeated.stdout).occurrenceId).toBe(queued.occurrenceId);
      const shown = await invoke(["tasks", "show", id], offline);
      expect(shown.exitCode).toBe(0);
      expect(JSON.parse(shown.stdout)).toMatchObject({
        task: {
          id,
          revision: 2,
          name: "Renamed",
          model: "saved-model",
          prompt: "Read the new decisions",
        },
        target: { occurrenceId: queued.occurrenceId },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("when Kagi credentials are configured, leaves Brave credentials intact", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-kagi-cli-"));
    const environment = { POPPET_DATA_DIR: directory };

    try {
      expect(
        (
          await invoke(["web", "login"], {
            POPPET_DATA_DIR: directory,
            POPPET_BRAVE_SEARCH_API_KEY: "brave-only-key",
          })
        ).exitCode,
      ).toBe(0);
      await configure(directory, { webSearchProvider: "kagi" });
      expect(JSON.parse((await invoke(["web", "status"], environment)).stdout)).toEqual({
        provider: "kagi",
        enabled: false,
        configured: false,
        source: null,
      });

      const login = await invoke(["web", "login"], {
        ...environment,
        POPPET_KAGI_SEARCH_API_KEY: "kagi-only-key",
      });

      expect(login.exitCode).toBe(0);
      expect(login.stdout).toContain("Kagi Search key saved");
      expect(login.stdout).not.toContain("kagi-only-key");
      expect(JSON.parse((await invoke(["web", "status"], environment)).stdout)).toEqual({
        provider: "kagi",
        enabled: false,
        configured: true,
        source: "stored",
      });

      const overridden = await invoke(["web", "status"], {
        ...environment,
        POPPET_KAGI_SEARCH_API_KEY: "kagi-override-key",
      });

      expect(JSON.parse(overridden.stdout).source).toBe("environment");
      expect(overridden.stdout).not.toContain("kagi-override-key");

      const invalid = await invoke(["web", "status"], {
        ...environment,
        POPPET_KAGI_SEARCH_API_KEY: "",
      });

      expect(invalid.exitCode).not.toBe(0);

      const config = await invoke(["config"], {
        ...environment,
        POPPET_KAGI_SEARCH_API_KEY: "kagi-only-key",
      });

      expect(JSON.parse(config.stdout).webSearchProvider).toBe("kagi");
      expect(config.stdout).not.toContain("kagi-only-key");
      expect((await invoke(["web", "logout"], environment)).exitCode).toBe(0);
      expect(JSON.parse((await invoke(["web", "status"], environment)).stdout).configured).toBe(
        false,
      );
      await configure(directory, { webSearchProvider: "brave" });
      expect(
        JSON.parse((await invoke(["web", "status"], { POPPET_DATA_DIR: directory })).stdout),
      ).toMatchObject({
        provider: "brave",
        configured: true,
        source: "stored",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("when search credentials change, keeps inference credentials separate and status secret-free", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-web-cli-"));
    const environment = { POPPET_DATA_DIR: directory };

    try {
      expect(JSON.parse((await invoke(["web", "status"], environment)).stdout)).toEqual({
        provider: "brave",
        enabled: false,
        configured: false,
        source: null,
      });
      await writeFile(join(directory, "config.json"), '{"webSearch":true}');
      expect(JSON.parse((await invoke(["web", "status"], environment)).stdout)).toEqual({
        provider: "brave",
        enabled: true,
        configured: false,
        source: null,
      });

      const login = await invoke(["web", "login"], {
        ...environment,
        POPPET_BRAVE_SEARCH_API_KEY: "search-only-key",
      });

      expect(login.exitCode).toBe(0);
      expect(login.stdout).not.toContain("search-only-key");
      expect(JSON.parse((await invoke(["web", "status"], environment)).stdout)).toEqual({
        provider: "brave",
        enabled: true,
        configured: true,
        source: "stored",
      });

      const status = await invoke(["web", "status"], {
        ...environment,
        POPPET_BRAVE_SEARCH_API_KEY: "override-key",
      });

      expect(JSON.parse(status.stdout)).toMatchObject({ source: "environment" });
      expect(status.stdout).not.toContain("override-key");

      const config = await invoke(["config"], {
        ...environment,
        POPPET_BRAVE_SEARCH_API_KEY: "override-key",
      });

      expect(JSON.parse(config.stdout).webSearch).toBe(true);
      expect(config.stdout).not.toContain("override-key");
      expect(
        (await readdir(join(directory, "auth"))).filter((name) => name.endsWith(".json")),
      ).toEqual(["brave-search.json"]);
      expect((await invoke(["web", "logout"], environment)).exitCode).toBe(0);
      expect(JSON.parse((await invoke(["web", "status"], environment)).stdout)).toMatchObject({
        configured: false,
      });

      const invalid = await invoke(["web", "status"], {
        ...environment,
        POPPET_BRAVE_SEARCH_API_KEY: "invalid key",
      });

      expect(invalid.exitCode).toBe(1);
      expect(invalid.stderr).not.toContain("invalid key");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("when prompts are missing or task IDs are invalid, rejects arguments before opening the store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "p7-invalid-"));

    try {
      const environment = await configure(directory, { model: "test-model" });

      const missing = await invoke(
        ["tasks", "add", "Missing prompt", "--at", "2099-10-14T09:00:00Z"],
        environment,
      );

      expect(missing.exitCode).toBe(1);
      expect(missing.stderr).toContain("prompt");
      expect(missing.stderr).not.toContain("Could not read or update");
      const invalid = await invoke(["tasks", "show", "bad/id"], environment);
      expect(invalid.exitCode).toBe(1);
      expect(invalid.stderr).toContain("argument <task>");
      expect(await readdir(directory)).toEqual(["config.json"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("when the worker is stopped, includes saved-task providers in status", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-worker-providers-"));

    try {
      const added = await invoke(
        [
          "tasks",
          "add",
          "Router task",
          "--at",
          "2099-10-14T09:00:00Z",
          "Summarize recent conversations",
        ],
        await configure(directory, { provider: "openrouter", model: "saved-model" }),
      );

      expect(added.exitCode).toBe(0);
      await configure(directory, {});
      const result = await invoke(["worker", "status"], { POPPET_DATA_DIR: directory });
      expect(result.exitCode).toBe(0);
      expect(
        JSON.parse(
          (
            await invoke(["worker", "resume-provider", "openrouter"], {
              POPPET_DATA_DIR: directory,
            })
          ).stdout,
        ),
      ).toEqual({ provider: "openrouter", resumed: true });
      expect(
        JSON.parse((await invoke(["worker", "providers"], { POPPET_DATA_DIR: directory })).stdout),
      ).toEqual([]);
      expect(JSON.parse(result.stdout).worker).toMatchObject({
        running: false,
        taskCount: 1,
        providers: ["openrouter"],
        connections: [
          { provider: "openai-chatgpt", connected: false },
          { provider: "openrouter", connected: false, action: "Run provider login openrouter." },
        ],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("when the worker crashes with its owner lock intact, recovers local task commands", async () => {
    const directory = await mkdtemp(join(tmpdir(), "p7-crash-"));

    await configure(directory, { model: "saved-model" });

    const environment = {
      PATH: process.env.PATH ?? "",
      POPPET_DATA_DIR: directory,
    };

    const worker = Bun.spawn(
      [process.execPath, "apps/cli/src/main.ts", "worker", "run", "--tasks-only"],
      {
        cwd: fileURLToPath(new URL("../../..", import.meta.url)),
        env: environment,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const errors = new Response(worker.stderr).text();

    try {
      const ready = await worker.stdout.getReader().read();
      expect(new TextDecoder().decode(ready.value)).toContain("Worker running.");
      expect(
        (
          await invoke(
            ["tasks", "add", "Later", "--at", "2099-10-14T09:00:00Z", "Hello"],
            environment,
          )
        ).exitCode,
      ).toBe(0);
      worker.kill("SIGKILL");
      await worker.exited;
      expect(await readdir(join(directory, "store"))).toContain("tasks.sock");
      const list = await invoke(["tasks", "list"], environment);
      expect(list.exitCode).toBe(0);
      expect(JSON.parse(list.stdout)).toMatchObject([{ name: "Later" }]);
      const clear = await invoke(["tasks", "clear"], environment);
      expect(clear.exitCode).toBe(0);
      expect(JSON.parse(clear.stdout)).toEqual({ cleared: 1 });
      expect(JSON.parse((await invoke(["tasks", "list"], environment)).stdout)).toEqual([]);
    } finally {
      worker.kill("SIGKILL");
      await worker.exited;
      expect(await errors).toBe("");
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("when managing saved tasks without credentials, validates schedules before creating a store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-tasks-cli-"));
    const environment = await configure(directory, { model: "test-model" });

    try {
      const invalid = await invoke(
        [
          "tasks",
          "add",
          "Summary",
          "--cron",
          "* * * * *",
          "--tz",
          "Invalid/Zone",
          "Summarize recent conversations",
        ],
        environment,
      );

      expect(invalid.exitCode).toBe(1);
      expect(invalid.stderr).toContain("Invalid cron");
      expect(await readdir(directory)).toEqual(["config.json"]);

      const added = await invoke(
        [
          "tasks",
          "add",
          "Summary",
          "--cron",
          "0 9 * * *",
          "--tz",
          "Europe/London",
          "Summarize recent conversations",
        ],
        environment,
      );

      expect(added.exitCode).toBe(0);
      const task = JSON.parse(added.stdout);
      expect(task).toMatchObject({
        name: "Summary",
        provider: "openai-chatgpt",
        model: "test-model",
        schedule: { expression: "0 9 * * *", timezone: "Europe/London" },
      });
      const offline = { POPPET_DATA_DIR: directory };
      expect(JSON.parse((await invoke(["tasks", "list"], offline)).stdout)).toHaveLength(1);
      expect(JSON.parse((await invoke(["tasks", "pause", task.id], offline)).stdout).paused).toBe(
        1,
      );
      expect(JSON.parse((await invoke(["tasks", "resume", task.id], offline)).stdout).paused).toBe(
        0,
      );
      expect(JSON.parse((await invoke(["tasks", "show", task.id], offline)).stdout)).toMatchObject({
        occurrences: [],
        skipped: [],
      });
      expect((await invoke(["tasks", "show", "missing"], offline)).stderr).toContain(
        "does not exist",
      );
      expect((await invoke(["tasks", "clear", "extra"], offline)).exitCode).toBe(1);
      expect(JSON.parse((await invoke(["tasks", "clear"], offline)).stdout)).toEqual({
        cleared: 1,
      });
      expect(JSON.parse((await invoke(["tasks", "list"], offline)).stdout)).toEqual([]);
      expect(JSON.parse((await invoke(["tasks", "clear"], offline)).stdout)).toEqual({
        cleared: 0,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("when the worker owns storage, routes task, memory, and inspection commands to it and rejects another owner", async () => {
    const directory = await mkdtemp(join(tmpdir(), "p7-cli-"));
    const environment = { PATH: process.env.PATH ?? "", POPPET_DATA_DIR: directory };

    const worker = Bun.spawn(
      [process.execPath, "apps/cli/src/main.ts", "worker", "run", "--tasks-only"],
      {
        cwd: fileURLToPath(new URL("../../..", import.meta.url)),
        env: environment,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const errors = new Response(worker.stderr).text();

    try {
      const ready = await worker.stdout.getReader().read();
      expect(new TextDecoder().decode(ready.value)).toContain("Worker running.");
      const second = await invoke(["worker", "run", "--tasks-only"], environment);
      expect(second.exitCode).toBe(1);
      expect(second.stderr).toContain("Another Poppet process has the store open");

      const added = await invoke(
        [
          "tasks",
          "add",
          "Later",
          "--cron",
          "0 9 * * *",
          "--tz",
          "UTC",
          "Read release.md and report its release tag",
        ],
        await configure(directory, { model: "saved-model" }),
      );

      expect(added.exitCode).toBe(0);
      const task = JSON.parse(added.stdout);
      expect(task.model).toBe("saved-model");
      const remembered = await invoke(["memory", "set", "project", "Acorn"], environment);
      expect(remembered.exitCode).toBe(0);
      expect(JSON.parse(remembered.stdout)).toMatchObject({ key: "project", value: "Acorn" });
      expect(JSON.parse((await invoke(["memory", "list"], environment)).stdout)).toMatchObject([
        { key: "project", value: "Acorn" },
      ]);
      expect(JSON.parse((await invoke(["chat", "sessions"], environment)).stdout)).toEqual([]);
      const search = await invoke(["chat", "search", "Acorn"], environment);
      expect(search.exitCode).toBe(0);
      expect(JSON.parse(search.stdout)).toEqual({ matches: [], truncated: false });
      expect(JSON.parse((await invoke(["store", "status"], environment)).stdout)).toMatchObject({
        sessions: 0,
      });
      expect(
        JSON.parse((await invoke(["worker", "status"], environment)).stdout).worker,
      ).toMatchObject({
        running: true,
        pid: worker.pid,
        taskCount: 1,
        services: { tasks: true, gateway: false },
        connections: [
          {
            provider: "openai-chatgpt",
            connected: false,
            action: "Run provider login openai-chatgpt.",
          },
        ],
      });
      expect(JSON.parse((await invoke(["tasks", "list"], environment)).stdout)).toMatchObject([
        { id: task.id },
      ]);
      expect(
        JSON.parse(
          (await invoke(["worker", "resume-provider", "openai-chatgpt"], environment)).stdout,
        ),
      ).toEqual({ provider: "openai-chatgpt", resumed: true });
      expect(JSON.parse((await invoke(["worker", "providers"], environment)).stdout)).toEqual([]);
      expect((await invoke(["tasks", "pause", task.id], environment)).exitCode).toBe(0);
      expect((await invoke(["tasks", "show", "missing"], environment)).stderr).toContain(
        "does not exist",
      );
      expect(JSON.parse((await invoke(["tasks", "clear"], environment)).stdout)).toEqual({
        cleared: 1,
      });
      expect(JSON.parse((await invoke(["tasks", "list"], environment)).stdout)).toEqual([]);
    } finally {
      worker.kill("SIGTERM");
      await worker.exited;
      expect(await errors).toBe("");
      expect(await readdir(join(directory, "store"))).not.toContain("owner.lock");
      expect(await readdir(join(directory, "store"))).not.toContain("tasks.sock");
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("when no provider is connected or selected, manages explicit facts across invocations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-memory-cli-"));
    const environment = { POPPET_DATA_DIR: directory };

    try {
      expect((await invoke(["memory", "list"], environment)).stdout.trim()).toBe("[]");

      const remembered = await invoke(
        ["memory", "set", "answer.style", "Keep answers concise"],
        environment,
      );

      expect(remembered.exitCode).toBe(0);
      expect(JSON.parse(remembered.stdout)).toMatchObject({
        key: "answer.style",
        value: "Keep answers concise",
        sourceRunId: null,
      });

      const replaced = await invoke(
        ["memory", "set", "answer.style", "Explain", "the reasoning"],
        environment,
      );

      expect(replaced.exitCode).toBe(0);
      expect(JSON.parse((await invoke(["memory", "list"], environment)).stdout)[0]?.value).toBe(
        "Explain the reasoning",
      );
      expect((await invoke(["memory", "forget", "answer.style"], environment)).exitCode).toBe(0);
      expect((await invoke(["memory", "list"], environment)).stdout.trim()).toBe("[]");

      const history = await invoke(["memory", "history", "answer.style"], environment);
      expect(
        JSON.parse(history.stdout).map(
          (entry: { action: string; origin: string }) => `${entry.action}:${entry.origin}`,
        ),
      ).toEqual(["remember:cli", "replace:cli", "forget:cli"]);

      const reverted = await invoke(["memory", "revert", "answer.style", "1"], environment);
      expect(reverted.exitCode).toBe(0);
      expect(JSON.parse(reverted.stdout)).toMatchObject({ value: "Keep answers concise" });
      expect(
        (await invoke(["memory", "revert", "answer.style", "3"], environment)).stdout,
      ).toContain("Forgot answer.style.");
      expect((await invoke(["memory", "history", "missing"], environment)).exitCode).toBe(1);
      expect(await readdir(directory)).toEqual(["store"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("when memory commands are invalid, rejects them before creating a store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-memory-args-"));

    try {
      const cases = [
        { args: ["list", "extra"], message: "Unexpected positional argument" },
        { args: ["set", "bad key", "Value"], message: "argument <key>" },
        { args: ["set", "key"], message: "value" },
        { args: ["set", "key", " "], message: "no leading or trailing whitespace" },
        { args: ["set", "key", "😀".repeat(1025)], message: "4096 UTF-8 bytes" },
        { args: ["forget", "key", "extra"], message: "Unexpected positional argument" },
        { args: ["unknown"], message: "Unknown subcommand" },
      ];

      await Array.fromAsync(cases, async ({ args, message }) => {
        const result = await invoke(["memory", ...args], { POPPET_DATA_DIR: directory });
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(message);
      });

      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("when a Discord task destination is supplied, requires messaging-worker validation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-task-destination-"));
    const environment = await configure(directory, { model: "test-model" });

    const command = [
      "tasks",
      "add",
      "Summary",
      "--at",
      "2099-10-15T09:00:00Z",
      "--channel",
      "discord",
      "--conversation",
    ];

    try {
      await Array.fromAsync([["--conversation", "400"]], async (flags) => {
        const incomplete = await invoke(
          ["tasks", "add", "Incomplete", "--at", "2099-10-15T09:00:00Z", ...flags, "Summary"],
          environment,
        );

        expect(incomplete.exitCode).toBe(1);
        expect(incomplete.stderr).toContain("Use --channel when selecting --conversation");
        expect(await readdir(directory)).toEqual(["config.json"]);
      });

      const rejected = await invoke(
        [...command, "400", "Summarize recent conversations"],
        environment,
      );

      expect(rejected.exitCode).toBe(1);
      expect(rejected.stderr).toContain("Start worker run or gateway work");
      expect(JSON.parse((await invoke(["tasks", "list"], environment)).stdout)).toEqual([]);

      const local = await invoke(
        ["tasks", "add", "Local", "--at", "2099-10-15T09:00:00Z", "Summarize recent conversations"],
        environment,
      );

      expect(local.exitCode).toBe(0);
      expect(JSON.parse(local.stdout).destination).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("when no model or authentication is selected, opens and reopens the conversation store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-store-cli-"));

    await configure(directory, { provider: "openrouter" });

    const environment = {
      POPPET_DATA_DIR: directory,
      POPPET_OPENROUTER_API_KEY: "test-secret",
    };

    try {
      const before = await invoke(["config"], environment);
      expect(before.exitCode).toBe(0);
      expect(await readdir(directory)).toEqual(["config.json"]);
      const first = await invoke(["store", "status"], environment);
      const reopened = await invoke(["store", "status"], environment);
      expect(first.exitCode).toBe(0);
      expect(reopened.exitCode).toBe(0);
      expect(JSON.parse(first.stdout)).toEqual({
        path: join(directory, "store/poppet.sqlite"),
        schemaVersion: 2,
        sessions: 0,
        messages: 0,
        runs: 0,
      });
      expect(JSON.parse(reopened.stdout)).toEqual(JSON.parse(first.stdout));
      expect(first.stdout + first.stderr).not.toContain("test-secret");
      expect((await readdir(directory)).toSorted()).toEqual(["config.json", "store"]);
      expect(await readdir(join(directory, "store"))).not.toContain("owner.lock");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.each(["retained registration", "malformed details"])(
    "when logging out with %s, deletes all details without affecting another provider or recreating files",
    async (kind) => {
      const directory = await mkdtemp(join(tmpdir(), "poppet-logout-details-"));
      const environment = { POPPET_DATA_DIR: directory };

      try {
        await mkdir(join(directory, "auth"));
        const path = join(directory, "auth/connection.json");
        await writeFile(
          path,
          kind === "malformed details"
            ? "invalid-json"
            : JSON.stringify({
                version: 1,
                hostId: "urn:uuid:00000000-0000-4000-8000-000000000000",
                clientId: "oaiapp_test",
                identity: { subject: "old-account", email: "signed-out@example.invalid" },
                credentials: null,
                verification: { model: "previous-model", at: 1 },
              }),
        );
        const unrelated = join(directory, "auth/other-provider.json");
        await writeFile(unrelated, "other-provider-details");

        const logout = await invoke(["provider", "logout"], environment);
        expect(logout.exitCode).toBe(0);
        expect(logout.stdout).toContain("All local ChatGPT connection details were deleted");
        expect(await Bun.file(path).exists()).toBe(false);
        const status = await invoke(["provider", "status"], environment);
        expect(status.exitCode).toBe(0);
        expect(JSON.parse(status.stdout)).toMatchObject({
          connected: false,
          email: null,
          clientId: null,
          verification: null,
        });
        expect(await Bun.file(path).exists()).toBe(false);
        expect((await invoke(["provider", "logout"], environment)).exitCode).toBe(0);
        expect((await readdir(join(directory, "auth"))).toSorted()).toEqual([
          "other-provider.json",
          "owner.lock.sqlite",
        ]);
        expect(await readFile(unrelated, "utf8")).toBe("other-provider-details");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  test("when logging into API-key providers, honors explicit selection and keeps logout independent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-key-login-"));
    const environment = await configure(directory, { provider: "opencode-go" });

    try {
      const router = await invoke(["provider", "login", "openrouter"], {
        ...environment,
        POPPET_OPENROUTER_API_KEY: "router-test-secret",
      });

      const go = await invoke(["provider", "login"], {
        ...environment,
        POPPET_OPENCODE_GO_API_KEY: "go-test-secret",
      });

      expect(router.exitCode).toBe(0);
      expect(go.exitCode).toBe(0);
      expect(router.stdout).toContain("openrouter");

      const routerStatus = await invoke(
        ["provider", "status", "--provider", "openrouter"],
        environment,
      );

      const goStatus = await invoke(["provider", "status"], environment);
      expect(JSON.parse(routerStatus.stdout)).toEqual({
        provider: "openrouter",
        connected: true,
        source: "stored",
      });
      expect(JSON.parse(goStatus.stdout)).toEqual({
        provider: "opencode-go",
        connected: true,
        source: "stored",
      });

      for (const result of [router, go, routerStatus, goStatus]) {
        expect(result.stdout + result.stderr).not.toContain("router-test-secret");
        expect(result.stdout + result.stderr).not.toContain("go-test-secret");
      }

      expect((await readdir(join(directory, "auth"))).toSorted()).toEqual([
        "opencode-go.json",
        "opencode-go.lock.sqlite",
        "openrouter.json",
        "openrouter.lock.sqlite",
      ]);
      const logout = await invoke(["provider", "logout", "openrouter"], environment);
      expect(logout.exitCode).toBe(0);
      expect(
        JSON.parse((await invoke(["provider", "status", "openrouter"], environment)).stdout)
          .connected,
      ).toBe(false);
      expect(JSON.parse((await invoke(["provider", "status"], environment)).stdout).connected).toBe(
        true,
      );
      const chatGPT = await invoke(["provider", "status", "openai-chatgpt"], environment);
      expect(chatGPT.exitCode).toBe(0);
      expect(JSON.parse(chatGPT.stdout)).toMatchObject({ connected: false, planUsage: false });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("when environment credentials are supplied, uses them without saving until login and rejects invalid overrides", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-key-env-"));

    await configure(directory, { provider: "openrouter" });

    const environment = {
      POPPET_DATA_DIR: directory,
      POPPET_OPENROUTER_API_KEY: "env-test-secret",
    };

    try {
      const status = await invoke(["provider", "status"], environment);
      expect(JSON.parse(status.stdout)).toEqual({
        provider: "openrouter",
        connected: true,
        source: "environment",
      });
      expect(await readdir(directory)).toEqual(["config.json"]);
      const login = await invoke(["provider", "login"], environment);
      expect(login.exitCode).toBe(0);
      expect(login.stdout + login.stderr).not.toContain("env-test-secret");
      expect(
        JSON.parse(
          (
            await invoke(["provider", "status"], {
              POPPET_DATA_DIR: directory,
              POPPET_PROVIDER: "openrouter",
            })
          ).stdout,
        ).source,
      ).toBe("stored");

      const invalid = await invoke(["provider", "status"], {
        ...environment,
        POPPET_OPENROUTER_API_KEY: "",
      });

      expect(invalid.exitCode).toBe(1);
      expect(invalid.stderr).toContain("POPPET_OPENROUTER_API_KEY");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("when provider options are invalid, rejects them before creating credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-key-invalid-"));
    const environment = await configure(directory, { provider: "openrouter" });

    try {
      const cases = [
        { args: ["provider", "login", "unknown"], message: "Unknown provider unknown" },
        { args: ["provider", "login", "--provider"], message: "Missing value for flag --provider" },
        {
          args: ["provider", "login", "openrouter", "--provider", "opencode-go"],
          message: "Choose a provider either positionally or with --provider, not both",
        },
        {
          args: ["provider", "login", "openrouter", "--consent"],
          message: "Unrecognized flag: --consent",
        },
        {
          args: ["provider", "login", "openai-chatgpt", "--key-stdin"],
          message: "ChatGPT does not support --key-stdin",
        },
        { args: ["provider", "status", "--key-stdin"], message: "Unrecognized flag: --key-stdin" },
      ];

      await Array.fromAsync(cases, async ({ args, message }) => {
        const result = await invoke(args, environment);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(message);
      });

      expect(await readdir(directory)).toEqual(["config.json"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.each(["stop", "uninstall", "logs"])(
    "when worker recovery runs %s, ignores invalid file settings and rejects an empty data directory",
    async (action) => {
      const directory = await mkdtemp(join(tmpdir(), "poppet-worker-recovery-"));
      const calls: string[] = [];

      const worker: typeof manageWorker = (requested, selectedDirectory) =>
        Effect.sync(() => {
          expect(selectedDirectory).toBe(directory);
          calls.push(requested);

          return `${requested} completed`;
        });

      try {
        await writeFile(join(directory, "config.json"), '{"model":123}');

        const result = await invoke(["worker", action], { POPPET_DATA_DIR: directory }, worker);

        expect(result).toEqual({ stdout: `${action} completed\n`, stderr: "", exitCode: 0 });
        expect(calls).toEqual([action]);
        expect(await readdir(directory)).toEqual(["config.json"]);

        const invalidDirectory = await invoke(["worker", action], { POPPET_DATA_DIR: "" }, worker);

        expect(invalidDirectory.exitCode).toBe(1);
        expect(invalidDirectory.stderr).toContain("POPPET_DATA_DIR");
        expect(calls).toEqual([action]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  test("when root or command help is requested, avoids configuration loading and file creation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-cli-help-"));
    const environment = await configure(directory, { provider: "invalid/provider" });

    const paths = [
      "setup",
      "config",
      "provider",
      "provider login",
      "provider models",
      "skills",
      "skills list",
      "skills show",
      "memory list",
      "chat new",
      "tasks add",
      "tasks run",
      "worker run",
      "worker providers",
      "worker resume-provider",
      "worker stop",
    ];

    try {
      await Array.fromAsync(
        [[], ["-h"], ...paths.map((path) => path.split(" ").concat("--help"))],
        async (args) => {
          const result = await invoke(args, environment);
          expect(result.exitCode).toBe(0);
          expect(result.stderr).toBe("");
          expect(result.stdout).toContain("USAGE");
          expect(result.stdout).toContain("poppet");
        },
      );

      const rootHelp = await invoke(["--help"], environment);
      expect(rootHelp.stdout).toContain("A personal AI agent for local use");
      expect(rootHelp.stdout).not.toContain("API key");

      const providerHelp = await invoke(["provider", "--help"], environment);

      for (const provider of providers) {
        expect(providerHelp.stdout).toContain(provider.id);
        expect(providerHelp.stdout).toContain(provider.authentication.help);
      }

      const skillsHelp = await invoke(["skills", "--help"], environment);
      expect(skillsHelp.stdout).toMatch(/list +List local skills/);
      expect(skillsHelp.stdout).toMatch(/show +Show a skill's Markdown instructions/);

      for (const action of ["login", "logout", "status", "models"])
        expect(providerHelp.stdout).toContain(`  ${action} `);

      const taskHelp = await invoke(["tasks", "add", "--help"], environment);
      expect(taskHelp.stdout).toContain("--cron");
      expect(taskHelp.stdout).toContain("--tz");
      expect(taskHelp.stdout).toContain("EXAMPLES");
      expect(await readdir(directory)).toEqual(["config.json"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("when schedules conflict, flags repeat, or worker commands are malformed, rejects them before storage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-cli-flags-"));
    const environment = await configure(directory, { model: "test-model" });
    const at = "2099-10-15T09:00:00Z";

    const commands = [
      ["config", "unexpected-argument"],
      ["worker", "resume-provider", "bad/id"],
      ["tasks", "add", "Later", "--at", at, "--cron", "0 9 * * *", "--tz", "UTC", "Hello"],
      ["tasks", "add", "Later", "--cron", "0 9 * * *", "Hello"],
      ["tasks", "add", "Later", "--at", at, "--tz", "UTC", "Hello"],
      ["tasks", "add", "Later", "--at", at, "--at", at, "Hello"],
      ["tasks", "add", "Later", "--at", at, "--discord-thread", "400", "Hello"],
      [
        "tasks",
        "add",
        "Later",
        "--at",
        at,
        "--channel=a",
        "--channel=b",
        "--conversation=400",
        "Hello",
      ],
      ["provider", "status", "--provider", "openrouter", "--provider", "opencode-go"],
      ["provider", "login", "--key-stdin", "--key-stdin"],
      ["worker", "start", "extra"],
      ["worker", "install", "--unknown"],
      ["worker", "unknown"],
    ];

    try {
      await Array.fromAsync(commands, async (args) => {
        const result = await invoke(args, environment);
        expect({ args, exitCode: result.exitCode }).toEqual({ args, exitCode: 1 });
        expect(result.stderr).not.toBe("");
      });

      expect(await readdir(directory)).toEqual(["config.json"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("when memory values or task prompts contain flag-like text, preserves that text", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-cli-text-"));
    const environment = await configure(directory, { model: "test-model" });

    try {
      const remembered = await invoke(
        ["memory", "set", "flags", "--verbose", "--help", "--", "-h"],
        environment,
      );

      expect(remembered.exitCode).toBe(0);
      expect(JSON.parse(remembered.stdout).value).toBe("--verbose --help -- -h");

      const replaced = await invoke(
        ["memory", "set", "flags", "Use", "--coding", "literally"],
        environment,
      );

      expect(replaced.exitCode).toBe(0);
      expect(JSON.parse(replaced.stdout).value).toBe("Use --coding literally");

      const added = await invoke(
        [
          "tasks",
          "add",
          "Later",
          "--at",
          "2099-10-15T09:00:00Z",
          "--coding",
          "Explain",
          "--coding",
          "--help",
          "--",
          "-h",
        ],
        environment,
      );

      expect(added.exitCode).toBe(0);
      expect(JSON.parse(added.stdout)).toMatchObject({
        workload: "coding",
        prompt: "Explain --coding --help -- -h",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("when configuration is absent, ignores removed environment settings without creating files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-env-cli-"));

    try {
      const result = await invoke(["config"], {
        POPPET_APP_NAME: "Test Poppet",
        POPPET_DATA_DIR: directory,
      });

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        applicationName: "Poppet",
        dataDirectory: directory,
        configFile: { path: join(directory, "config.json"), exists: false },
        environmentOverrides: ["POPPET_DATA_DIR"],
      });
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("when file settings coexist with obsolete environment overrides, uses only editable file settings and keeps secrets out", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-file-cli-"));

    try {
      await configure(directory, {
        provider: "openrouter",
        model: "file-model",
        chat: { outputTokens: 4096, logReasoning: true, maxConcurrentRequests: 2 },
      });

      const result = await invoke(["config"], {
        POPPET_DATA_DIR: directory,
        POPPET_MODEL: "ignored",
        POPPET_OUTPUT_TOKENS: "",
        POPPET_OPENROUTER_API_KEY: "must-not-appear",
      });

      expect(result.exitCode).toBe(0);
      const saved = JSON.parse(result.stdout);
      expect(saved).toMatchObject({
        model: "file-model",
        environmentOverrides: ["POPPET_DATA_DIR"],
      });
      expect(saved.chat).toEqual({
        outputTokens: 4096,
        logReasoning: true,
        logTimings: false,
        runDeadlineSeconds: 300,
        maxConcurrentRequests: 2,
      });
      expect(result.stdout).not.toContain("must-not-appear");
      expect(await readdir(directory)).toEqual(["config.json"]);
      await configure(directory, { chat: { outputTokens: 0 } });
      expect((await invoke(["config"], { POPPET_DATA_DIR: directory })).exitCode).toBe(1);
      const inspection = await invoke(["chat", "sessions"], { POPPET_DATA_DIR: directory });
      expect(inspection.exitCode).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.each(["openai-chatgpt", "opencode-go", "openrouter"])(
    "when %s has no selected model, hides configuration secrets and fails before opening credentials",
    async (provider) => {
      const directory = await mkdtemp(join(tmpdir(), "poppet-provider-cli-"));

      try {
        await configure(directory, { provider: provider });

        const environment = {
          POPPET_DATA_DIR: directory,
          POPPET_OPENCODE_GO_API_KEY: "test-secret",
          POPPET_OPENROUTER_API_KEY: "test-secret",
        };

        const settings = await invoke(["config"], environment);
        const missingModel = await invoke(["chat", "new", "Hello"], environment);

        expect(settings.exitCode).toBe(0);
        expect(JSON.parse(settings.stdout)).toMatchObject({ provider, model: null });
        expect(settings.stdout).not.toContain("test-secret");
        expect(missingModel.exitCode).toBe(1);
        expect(missingModel.stderr).toContain("config.json");
        expect(await readdir(directory)).toEqual(["config.json"]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  test("when the provider is disconnected, reports status without creating credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-cli-test-"));

    try {
      const environment = { POPPET_DATA_DIR: directory };
      const status = await invoke(["provider", "status"], environment);
      expect(status.exitCode).toBe(0);
      expect(JSON.parse(status.stdout)).toMatchObject({
        connected: false,
        planUsage: false,
        verification: null,
      });
      expect(await Bun.file(join(directory, "auth/connection.json")).exists()).toBe(false);
      const invalid = await invoke(["provider", "login", "--unknown"], environment);
      expect(invalid.exitCode).toBe(1);
      expect(invalid.stderr).toContain("Unrecognized flag: --unknown");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
