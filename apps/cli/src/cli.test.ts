import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

import { defaultPolicy } from "@poppet/agent";
import { serveWorker, workerSocketPath } from "@poppet/worker";
import { ConfigProvider, Console, Effect } from "effect";

import { makeCLI } from "#src/cli";
import { providers } from "#src/providers";
import type { manageWorker } from "#src/worker";

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

describe("CLI", () => {
  test.each([false, true])(
    "gateway status redacts channel settings, unreadable: %s",
    async (unreadable) => {
      const directory = await mkdtemp(join(tmpdir(), "poppet-channel-status-"));

      const channels = [
        {
          id: "discord",
          name: "Discord",
          settings: {
            version: 1,
            botId: "100",
            ownerId: "200",
            guildId: "300",
            channelIds: ["400"],
            token: "discord-secret",
          },
        },
        {
          id: "telegram",
          name: "Telegram",
          settings: { version: 1, botId: "100", ownerId: "200", token: "100:telegram-secret" },
        },
        {
          id: "whatsapp",
          name: "WhatsApp",
          settings: { version: 1, accountPhone: "447700900001", ownerPhone: "447700900002" },
        },
      ];

      try {
        await mkdir(join(directory, "channels"), { mode: 0o700 });
        await Promise.all(
          channels.map(({ id, settings }) =>
            writeFile(
              join(directory, `channels/${id}.json`),
              unreadable ? "invalid-channel-secret" : JSON.stringify(settings),
              { mode: 0o600 },
            ),
          ),
        );
        const result = await invoke(["gateway", "status"], { POPPET_DATA_DIR: directory });

        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          running: false,
          enabled: !unreadable,
          channels: channels.map(({ id, name }) =>
            unreadable
              ? {
                  id,
                  enabled: false,
                  error: `Cannot read or write protected ${name} settings. Run gateway ${id} setup again.`,
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

  test("concurrent invocations keep configuration separate without changing the process environment", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-cli-config-"));
    const previous = { ...process.env };

    const selections = [
      { name: "First", provider: "openrouter" },
      { name: "Second", provider: "opencode-go" },
    ];

    try {
      const results = await Promise.all(
        selections.map(({ name, provider }) =>
          invoke(["config"], {
            POPPET_APP_NAME: name,
            POPPET_PROVIDER: provider,
            POPPET_DATA_DIR: join(directory, name),
          }),
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

  test("a worker disappearing after inspection never falls back to a local task mutation", async () => {
    const directory = await mkdtemp("/tmp/p24-owner-");
    const storeDirectory = join(directory, "store");
    await mkdir(storeDirectory, { mode: 0o700 });
    const path = workerSocketPath(directory);
    let requests = 0;

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* serveWorker(path, (_request, body) =>
              Effect.promise(async () => {
                requests++;
                expect(body).toEqual({ action: "inspect", id: "saved-task" });
                await unlink(path);

                return Response.json({
                  ok: true,
                  value: { task: { id: "saved-task", revision: 0 }, target: null },
                });
              }),
            );

            const reply = yield* Effect.promise(() =>
              invoke(["tasks", "edit", "saved-task", "--name", "Changed"], {
                POPPET_DATA_DIR: directory,
              }),
            );

            expect(reply.exitCode).toBe(1);
            expect(reply.stderr).toContain("not retried locally");
            expect(requests).toBe(1);
            expect(yield* Effect.promise(() => readdir(storeDirectory))).toEqual([]);
          }),
        ),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("edits, skips, snoozes and queues saved tasks without credentials while preserving snapshots and cadence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-task-controls-cli-"));
    const environment = { POPPET_DATA_DIR: directory, POPPET_MODEL: "saved-model" };
    const offline = { POPPET_DATA_DIR: directory };

    try {
      const added = await invoke(
        ["tasks", "add", "Original", "--at", "2099-10-22T09:00:00Z", "Read notes"],
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
        revision: 1,
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
      const immediate = await invoke(["tasks", "run-now", id], offline);
      expect(immediate.exitCode).toBe(0);
      const queued = JSON.parse(immediate.stdout);
      expect(queued.nextAt).toBe(nextAt);
      const replay = await invoke(["tasks", "run-now", id], offline);
      expect(replay.exitCode).toBe(0);
      expect(JSON.parse(replay.stdout).occurrenceId).toBe(queued.occurrenceId);
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

  test("creates recurring monitors locally and rejects one-off monitoring before opening storage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-monitor-cli-"));
    const environment = { POPPET_DATA_DIR: directory, POPPET_MODEL: "saved-model" };

    try {
      const invalid = await invoke(
        ["tasks", "add", "Release", "--monitor", "--at", "2099-10-14T09:00:00Z", "Read release.md"],
        environment,
      );

      expect(invalid.exitCode).toBe(1);
      expect(invalid.stderr).toContain("Monitoring requires");
      expect(await readdir(directory)).toEqual([]);

      const added = await invoke(
        [
          "tasks",
          "add",
          "Release",
          "--monitor",
          "--cron",
          "0 9 * * *",
          "--tz",
          "UTC",
          "Read release.md and report the release tag",
        ],
        environment,
      );

      expect(added.exitCode).toBe(0);
      const monitor = JSON.parse(added.stdout);
      expect(monitor).toMatchObject({
        monitor: true,
        baseline: "pending-first-success",
        model: "saved-model",
      });
      const shown = await invoke(["tasks", "show", monitor.id], environment);
      expect(JSON.parse(shown.stdout)).toMatchObject({
        task: { monitor: true },
        lastObservation: null,
        occurrences: [],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("manages search credentials independently of inference and keeps config and status secret-free", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-web-cli-"));
    const environment = { POPPET_DATA_DIR: directory };

    try {
      expect(JSON.parse((await invoke(["web", "status"], environment)).stdout)).toEqual({
        enabled: false,
        configured: false,
        source: null,
      });
      await writeFile(join(directory, "config.json"), '{"webSearch":true}');
      expect(JSON.parse((await invoke(["web", "status"], environment)).stdout)).toEqual({
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

  test("rejects missing prompts and invalid task IDs as argument errors before opening the store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "p7-invalid-"));

    try {
      const environment = { POPPET_DATA_DIR: directory, POPPET_MODEL: "test-model" };

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
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("stopped worker status includes providers assigned to saved tasks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-worker-providers-"));

    try {
      const added = await invoke(
        ["tasks", "add", "Router task", "--at", "2099-10-14T09:00:00Z", "Summarize notes"],
        {
          POPPET_DATA_DIR: directory,
          POPPET_PROVIDER: "openrouter",
          POPPET_MODEL: "saved-model",
        },
      );

      expect(added.exitCode).toBe(0);
      const result = await invoke(["worker", "status"], { POPPET_DATA_DIR: directory });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).worker).toMatchObject({
        running: false,
        taskCount: 1,
        providers: ["openrouter"],
        connections: [
          { provider: "openai-chatgpt", connected: false },
          { provider: "openrouter", connected: false, action: "Run auth login openrouter." },
        ],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("recovers local task commands after a worker crashes without deleting its owner lock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "p7-crash-"));

    const environment = {
      PATH: process.env.PATH ?? "",
      POPPET_DATA_DIR: directory,
      POPPET_MODEL: "saved-model",
    };

    const worker = Bun.spawn([process.execPath, "apps/cli/src/main.ts", "tasks", "work"], {
      cwd: fileURLToPath(new URL("../../..", import.meta.url)),
      env: environment,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

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

  test("manages saved tasks without credentials and validates schedules before creating a store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-tasks-cli-"));
    const environment = { POPPET_DATA_DIR: directory, POPPET_MODEL: "test-model" };

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
          "Summarize notes",
        ],
        environment,
      );

      expect(invalid.exitCode).toBe(1);
      expect(invalid.stderr).toContain("Invalid cron");
      expect(await readdir(directory)).toEqual([]);

      const added = await invoke(
        [
          "tasks",
          "add",
          "Summary",
          "--cron",
          "0 9 * * *",
          "--tz",
          "Europe/London",
          "Summarize notes",
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
  }, 15_000);

  test("task, memory, and inspection clients reach the worker and a second worker cannot acquire ownership", async () => {
    const directory = await mkdtemp(join(tmpdir(), "p7-cli-"));
    const environment = { PATH: process.env.PATH ?? "", POPPET_DATA_DIR: directory };

    const worker = Bun.spawn([process.execPath, "apps/cli/src/main.ts", "tasks", "work"], {
      cwd: fileURLToPath(new URL("../../..", import.meta.url)),
      env: environment,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const errors = new Response(worker.stderr).text();

    try {
      const ready = await worker.stdout.getReader().read();
      expect(new TextDecoder().decode(ready.value)).toContain("Worker running.");
      const second = await invoke(["tasks", "work"], environment);
      expect(second.exitCode).toBe(1);
      expect(second.stderr).toContain("Another Poppet process has the store open");

      const added = await invoke(
        [
          "tasks",
          "add",
          "Later",
          "--monitor",
          "--cron",
          "0 9 * * *",
          "--tz",
          "UTC",
          "Read release.md and report its release tag",
        ],
        { ...environment, POPPET_MODEL: "saved-model" },
      );

      expect(added.exitCode).toBe(0);
      const task = JSON.parse(added.stdout);
      expect(task.model).toBe("saved-model");
      expect(task.monitor).toBe(true);
      const remembered = await invoke(["memory", "remember", "project", "Acorn"], environment);
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
      expect(JSON.parse((await invoke(["tasks", "status"], environment)).stdout)).toMatchObject({
        running: true,
        pid: worker.pid,
        taskCount: 1,
        connections: [
          {
            provider: "openai-chatgpt",
            connected: false,
            action: "Run auth login openai-chatgpt.",
          },
        ],
      });
      expect(JSON.parse((await invoke(["tasks", "list"], environment)).stdout)).toMatchObject([
        { id: task.id },
      ]);
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
  }, 15_000);

  test("manages explicit facts across CLI invocations without a provider connection or model", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-memory-cli-"));
    const environment = { POPPET_DATA_DIR: directory };

    try {
      expect((await invoke(["memory", "list"], environment)).stdout.trim()).toBe("[]");

      const remembered = await invoke(
        ["memory", "remember", "answer.style", "Keep answers concise"],
        environment,
      );

      expect(remembered.exitCode).toBe(0);
      expect(JSON.parse(remembered.stdout)).toMatchObject({
        key: "answer.style",
        value: "Keep answers concise",
        sourceRunId: null,
      });

      const duplicate = await invoke(
        ["memory", "remember", "answer.style", "Overwrite"],
        environment,
      );

      expect(duplicate.exitCode).toBe(1);
      expect(duplicate.stderr).toContain("memory replace");

      const replaced = await invoke(
        ["memory", "replace", "answer.style", "Explain", "the reasoning"],
        environment,
      );

      expect(replaced.exitCode).toBe(0);
      expect(JSON.parse((await invoke(["memory", "list"], environment)).stdout)[0]?.value).toBe(
        "Explain the reasoning",
      );
      expect((await invoke(["memory", "forget", "answer.style"], environment)).exitCode).toBe(0);
      expect((await invoke(["memory", "list"], environment)).stdout.trim()).toBe("[]");
      expect((await invoke(["memory", "replace", "missing", "Value"], environment)).exitCode).toBe(
        1,
      );
      expect(await readdir(directory)).toEqual(["store"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  test("rejects invalid memory commands before creating a store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-memory-args-"));

    try {
      const cases = [
        { args: ["list", "extra"], message: "Unexpected positional argument" },
        { args: ["remember", "bad key", "Value"], message: "argument <key>" },
        { args: ["remember", "key"], message: "value" },
        { args: ["replace", "key", " "], message: "no leading or trailing whitespace" },
        { args: ["remember", "key", "😀".repeat(1025)], message: "4096 UTF-8 bytes" },
        { args: ["forget", "key", "extra"], message: "Unexpected positional argument" },
        { args: ["unknown"], message: "Unknown subcommand" },
      ];

      for (const { args, message } of cases) {
        // eslint-disable-next-line no-await-in-loop -- Cases share one application directory.
        const result = await invoke(["memory", ...args], { POPPET_DATA_DIR: directory });
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(message);
      }

      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("parses an explicit Discord task destination and requires a messaging worker to validate it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-task-destination-"));
    const environment = { POPPET_DATA_DIR: directory, POPPET_MODEL: "test-model" };
    const command = ["tasks", "add", "Summary", "--at", "2099-10-15T09:00:00Z", "--discord-thread"];

    try {
      const invalid = await invoke([...command, "invalid", "Summarize notes"], environment);
      expect(invalid.exitCode).toBe(1);
      expect(await readdir(directory)).toEqual([]);
      const rejected = await invoke([...command, "400", "Summarize notes"], environment);
      expect(rejected.exitCode).toBe(1);
      expect(rejected.stderr).toContain("Start worker run or gateway work");
      expect(JSON.parse((await invoke(["tasks", "list"], environment)).stdout)).toEqual([]);

      const local = await invoke(
        ["tasks", "add", "Local", "--at", "2099-10-15T09:00:00Z", "Summarize notes"],
        environment,
      );

      expect(local.exitCode).toBe(0);
      expect(JSON.parse(local.stdout).destination).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("Telegram task destinations require a messaging worker and cannot be combined with Discord", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-telegram-task-"));
    const environment = { POPPET_DATA_DIR: directory, POPPET_MODEL: "test-model" };
    const command = ["tasks", "add", "Summary", "--at", "2099-10-15T09:00:00Z"];

    try {
      const conflict = await invoke(
        [...command, "--discord-thread", "400", "--telegram-chat", "200", "Summarize notes"],
        environment,
      );

      expect(conflict.exitCode).toBe(1);
      expect(conflict.stderr).toContain("Choose only one messaging destination");
      expect(await readdir(directory)).toEqual([]);

      const rejected = await invoke(
        [...command, "--telegram-chat=200", "Summarize notes"],
        environment,
      );

      expect(rejected.exitCode).toBe(1);
      expect(rejected.stderr).toContain("Start worker run or gateway work");
      expect(JSON.parse((await invoke(["tasks", "list"], environment)).stdout)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("validates WhatsApp task phones and rejects conflicting destinations before saving", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-whatsapp-task-"));
    const environment = { POPPET_DATA_DIR: directory, POPPET_MODEL: "test-model" };
    const command = ["tasks", "add", "Summary", "--at", "2099-10-15T09:00:00Z"];

    try {
      const invalid = await invoke(
        [...command, "--whatsapp-chat", "+447700900002", "Summary"],
        environment,
      );

      expect(invalid.exitCode).toBe(1);

      for (const destination of ["--discord-thread=400", "--telegram-chat=200"]) {
        // eslint-disable-next-line no-await-in-loop -- Cases share one application directory.
        const conflict = await invoke(
          [...command, destination, "--whatsapp-chat=447700900002", "Summary"],
          environment,
        );

        expect(conflict.exitCode).toBe(1);
        expect(conflict.stderr).toContain("Choose only one messaging destination");
      }

      expect(await readdir(directory)).toEqual([]);

      const rejected = await invoke(
        [...command, "--whatsapp-chat", "447700900002", "Summary"],
        environment,
      );

      expect(rejected.exitCode).toBe(1);
      expect(rejected.stderr).toContain("Start worker run or gateway work");
      expect(JSON.parse((await invoke(["tasks", "list"], environment)).stdout)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("opens and reopens the conversation store without authentication or model selection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-store-cli-"));

    const environment = {
      POPPET_DATA_DIR: directory,
      POPPET_PROVIDER: "openrouter",
      POPPET_OPENROUTER_API_KEY: "test-secret",
    };

    try {
      const before = await invoke(["config"], environment);
      expect(before.exitCode).toBe(0);
      expect(await readdir(directory)).toEqual([]);
      const first = await invoke(["store", "status"], environment);
      const reopened = await invoke(["store", "status"], environment);
      expect(first.exitCode).toBe(0);
      expect(reopened.exitCode).toBe(0);
      expect(JSON.parse(first.stdout)).toEqual({
        path: join(directory, "store/poppet.sqlite"),
        schemaVersion: 5,
        sessions: 0,
        messages: 0,
        runs: 0,
      });
      expect(JSON.parse(reopened.stdout)).toEqual(JSON.parse(first.stdout));
      expect(first.stdout + first.stderr).not.toContain("test-secret");
      expect(await readdir(directory)).toEqual(["store"]);
      expect(await readdir(join(directory, "store"))).not.toContain("owner.lock");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.each(["retained registration", "malformed details"])(
    "logout deletes %s completely without affecting another provider or recreating details",
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

        const logout = await invoke(["auth", "logout"], environment);
        expect(logout.exitCode).toBe(0);
        expect(logout.stdout).toContain("All local ChatGPT connection details were deleted");
        expect(await Bun.file(path).exists()).toBe(false);
        const status = await invoke(["auth", "status"], environment);
        expect(status.exitCode).toBe(0);
        expect(JSON.parse(status.stdout)).toMatchObject({
          connected: false,
          email: null,
          clientId: null,
          verification: null,
        });
        expect(await Bun.file(path).exists()).toBe(false);
        expect((await invoke(["auth", "logout"], environment)).exitCode).toBe(0);
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

  test("logs in to explicitly chosen API-key providers, defaults to the configured provider, and logs out independently", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-key-login-"));
    const environment = { POPPET_DATA_DIR: directory, POPPET_PROVIDER: "opencode-go" };

    try {
      const router = await invoke(["auth", "login", "openrouter"], {
        ...environment,
        POPPET_OPENROUTER_API_KEY: "router-test-secret",
      });

      const go = await invoke(["auth", "login"], {
        ...environment,
        POPPET_OPENCODE_GO_API_KEY: "go-test-secret",
      });

      expect(router.exitCode).toBe(0);
      expect(go.exitCode).toBe(0);
      expect(router.stdout).toContain("openrouter");

      const routerStatus = await invoke(
        ["auth", "status", "--provider", "openrouter"],
        environment,
      );

      const goStatus = await invoke(["auth", "status"], environment);
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
      const logout = await invoke(["auth", "logout", "openrouter"], environment);
      expect(logout.exitCode).toBe(0);
      expect(
        JSON.parse((await invoke(["auth", "status", "openrouter"], environment)).stdout).connected,
      ).toBe(false);
      expect(JSON.parse((await invoke(["auth", "status"], environment)).stdout).connected).toBe(
        true,
      );
      const chatGPT = await invoke(["auth", "status", "openai-chatgpt"], environment);
      expect(chatGPT.exitCode).toBe(0);
      expect(JSON.parse(chatGPT.stdout)).toMatchObject({ connected: false, planUsage: false });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  test("uses environment credentials without writing them until login and rejects invalid overrides", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-key-env-"));

    const environment = {
      POPPET_DATA_DIR: directory,
      POPPET_PROVIDER: "openrouter",
      POPPET_OPENROUTER_API_KEY: "env-test-secret",
    };

    try {
      const status = await invoke(["auth", "status"], environment);
      expect(JSON.parse(status.stdout)).toEqual({
        provider: "openrouter",
        connected: true,
        source: "environment",
      });
      expect(await readdir(directory)).toEqual([]);
      const login = await invoke(["auth", "login"], environment);
      expect(login.exitCode).toBe(0);
      expect(login.stdout + login.stderr).not.toContain("env-test-secret");
      expect(
        JSON.parse(
          (
            await invoke(["auth", "status"], {
              POPPET_DATA_DIR: directory,
              POPPET_PROVIDER: "openrouter",
            })
          ).stdout,
        ).source,
      ).toBe("stored");

      const invalid = await invoke(["auth", "status"], {
        ...environment,
        POPPET_OPENROUTER_API_KEY: "",
      });

      expect(invalid.exitCode).toBe(1);
      expect(invalid.stderr).toContain("POPPET_OPENROUTER_API_KEY");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects bad auth options before creating credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-key-invalid-"));
    const environment = { POPPET_DATA_DIR: directory, POPPET_PROVIDER: "openrouter" };

    try {
      const cases = [
        { args: ["auth", "login", "unknown"], message: "Unknown provider unknown" },
        { args: ["auth", "login", "--provider"], message: "Missing value for flag --provider" },
        {
          args: ["auth", "login", "openrouter", "--provider", "opencode-go"],
          message: "Choose a provider either positionally or with --provider, not both",
        },
        {
          args: ["auth", "login", "openrouter", "--consent"],
          message: "OpenRouter does not support --consent",
        },
        {
          args: ["auth", "login", "openai-chatgpt", "--key-stdin"],
          message: "ChatGPT does not support --key-stdin",
        },
        { args: ["auth", "status", "--key-stdin"], message: "Unrecognized flag: --key-stdin" },
      ];

      for (const { args, message } of cases) {
        // eslint-disable-next-line no-await-in-loop -- Cases share one application directory.
        const result = await invoke(args, environment);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(message);
      }

      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.each(["stop", "uninstall", "logs"])(
    "worker recovery %s ignores invalid file settings and rejects an empty data directory",
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

  test("root and command help never load configuration or create application files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-cli-help-"));
    const environment = { POPPET_DATA_DIR: directory, POPPET_PROVIDER: "invalid/provider" };

    const paths = ["config", "chat new", "tasks add", "worker stop"];

    try {
      for (const args of [[], ["-h"], ...paths.map((path) => path.split(" ").concat("--help"))]) {
        // eslint-disable-next-line no-await-in-loop -- Cases share one application directory.
        const result = await invoke(args, environment);
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toContain("USAGE");
        expect(result.stdout).toContain("bun run start");
      }

      const taskHelp = await invoke(["tasks", "add", "--help"], environment);
      expect(taskHelp.stdout).toContain("--cron");
      expect(taskHelp.stdout).toContain("--tz");
      expect(taskHelp.stdout).toContain("EXAMPLES");
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects conflicting schedules, repeated flags and malformed worker commands before opening storage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-cli-flags-"));
    const environment = { POPPET_DATA_DIR: directory, POPPET_MODEL: "test-model" };
    const at = "2099-10-15T09:00:00Z";

    const commands = [
      ["config", "unexpected-argument"],
      ["tasks", "add", "Later", "--at", at, "--cron", "0 9 * * *", "--tz", "UTC", "Hello"],
      ["tasks", "add", "Later", "--cron", "0 9 * * *", "Hello"],
      ["tasks", "add", "Later", "--at", at, "--tz", "UTC", "Hello"],
      ["tasks", "add", "Later", "--at", at, "--at", at, "Hello"],
      ["auth", "status", "--provider", "openrouter", "--provider", "opencode-go"],
      ["auth", "login", "--consent", "--consent"],
      ["worker", "start", "extra"],
      ["worker", "install", "--unknown"],
      ["worker", "unknown"],
    ];

    try {
      for (const args of commands) {
        // eslint-disable-next-line no-await-in-loop -- Cases share one application directory.
        const result = await invoke(args, environment);
        expect({ args, exitCode: result.exitCode }).toEqual({ args, exitCode: 1 });
        expect(result.stderr).not.toBe("");
      }

      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("preserves free-form memory values and task prompts containing flag-like text", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-cli-text-"));
    const environment = { POPPET_DATA_DIR: directory, POPPET_MODEL: "test-model" };

    try {
      const remembered = await invoke(
        ["memory", "remember", "flags", "--verbose", "--help", "--", "-h"],
        environment,
      );

      expect(remembered.exitCode).toBe(0);
      expect(JSON.parse(remembered.stdout).value).toBe("--verbose --help -- -h");

      const replaced = await invoke(
        ["memory", "replace", "flags", "Use", "--coding", "literally"],
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

  test("config prints settings supplied by the environment", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-env-cli-"));

    try {
      const result = await invoke(["config"], {
        POPPET_APP_NAME: "Test Poppet",
        POPPET_DATA_DIR: directory,
      });

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        applicationName: "Test Poppet",
        dataDirectory: directory,
        notesDirectory: join(directory, "notes"),
        provider: "openai-chatgpt",
        model: null,
        webSearch: false,
        browser: { enabled: false },
        voice: { enabled: false },
        mcpServers: [],
        chat: defaultPolicy,
        tasks: { catchUpMinutes: 60 },
        configFile: { path: join(directory, "config.json"), exists: false },
        environmentOverrides: ["POPPET_DATA_DIR", "POPPET_APP_NAME"],
      });
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("config shows file settings, all chat budgets, and environment overrides without opening storage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-file-cli-"));

    const chat = {
      logReasoning: true,
      logTimings: true,
      contextBytes: 32768,
      historyTurns: 10,
      outputTokens: 4096,
      modelTurns: 4,
      toolCalls: 8,
      toolBytes: 8192,
      soulBytes: 4096,
      profileBytes: 2048,
      factsBytes: 1024,
    };

    try {
      await writeFile(
        join(directory, "config.json"),
        JSON.stringify({
          applicationName: "File app",
          provider: "openrouter",
          model: "file-model",
          notesDirectory: "my-notes",
          chat,
        }),
      );

      const result = await invoke(["config"], {
        POPPET_DATA_DIR: directory,
        POPPET_MODEL: "override-model",
        POPPET_OUTPUT_TOKENS: "512",
        POPPET_OPENROUTER_API_KEY: "must-not-appear",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        applicationName: "File app",
        dataDirectory: directory,
        notesDirectory: join(directory, "my-notes"),
        provider: "openrouter",
        model: "override-model",
        webSearch: false,
        browser: { enabled: false },
        voice: { enabled: false },
        mcpServers: [],
        chat: { ...chat, outputTokens: 512, runDeadlineSeconds: 300 },
        tasks: { catchUpMinutes: 60 },
        configFile: { path: join(directory, "config.json"), exists: true },
        environmentOverrides: ["POPPET_DATA_DIR", "POPPET_MODEL", "POPPET_OUTPUT_TOKENS"],
      });
      expect(result.stdout).not.toContain("must-not-appear");
      expect(await readdir(directory)).toEqual(["config.json"]);

      const emptyOverride = await invoke(["config"], {
        POPPET_DATA_DIR: directory,
        POPPET_OUTPUT_TOKENS: "",
      });

      expect(emptyOverride.exitCode).toBe(1);
      expect(emptyOverride.stdout).toBe("");
      expect(emptyOverride.stderr).toContain("POPPET_OUTPUT_TOKENS");
      await writeFile(join(directory, "config.json"), JSON.stringify({ chat: { modelTurns: 0 } }));
      const invalid = await invoke(["config"], { POPPET_DATA_DIR: directory });
      expect(invalid.exitCode).toBe(1);
      expect(invalid.stdout).toBe("");
      expect(invalid.stderr).toContain("POPPET_MODEL_TURNS");
      const inspection = await invoke(["chat", "sessions"], { POPPET_DATA_DIR: directory });
      expect(inspection.exitCode).toBe(0);
      expect(JSON.parse(inspection.stdout)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.each(["openai-chatgpt", "opencode-go", "openrouter"])(
    "%s configuration hides secrets and requires a model before opening credentials",
    async (provider) => {
      const directory = await mkdtemp(join(tmpdir(), "poppet-provider-cli-"));

      try {
        const environment = {
          POPPET_DATA_DIR: directory,
          POPPET_PROVIDER: provider,
          POPPET_OPENCODE_GO_API_KEY: "test-secret",
          POPPET_OPENROUTER_API_KEY: "test-secret",
        };

        const settings = await invoke(["config"], environment);
        const missingModel = await invoke(["provider", "verify"], environment);

        expect(settings.exitCode).toBe(0);
        expect(JSON.parse(settings.stdout)).toMatchObject({ provider, model: null });
        expect(settings.stdout).not.toContain("test-secret");
        expect(missingModel.exitCode).toBe(1);
        expect(missingModel.stderr).toContain("POPPET_MODEL");
        expect(await readdir(directory)).toEqual([]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  test("shows disconnected auth status and requires sign-in before verification", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-cli-test-"));

    try {
      const environment = { POPPET_DATA_DIR: directory };
      const status = await invoke(["auth", "status"], environment);
      expect(status.exitCode).toBe(0);
      expect(JSON.parse(status.stdout)).toMatchObject({
        connected: false,
        planUsage: false,
        verification: null,
      });
      const verification = await invoke(["auth", "verify"], environment);
      expect(verification.exitCode).toBe(1);
      expect(verification.stdout).toBe("");
      expect(verification.stderr).toContain("auth login");
      expect(await Bun.file(join(directory, "auth/connection.json")).exists()).toBe(false);
      const invalid = await invoke(["auth", "login", "--unknown"], environment);
      expect(invalid.exitCode).toBe(1);
      expect(invalid.stderr).toContain("Unrecognized flag: --unknown");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
