import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Console, Effect } from "effect";

import { makeCLI } from "#src/cli";
import { providers } from "#src/providers";

const invoke = async (args: ReadonlyArray<string>, environment: Record<string, string> = {}) => {
  const previous = { ...process.env };

  // Bun's import.meta.env retains this object, so update it without replacing it.
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, {
    PATH: previous.PATH ?? "",
    HOME: previous.HOME,
    USERPROFILE: previous.USERPROFILE,
    XDG_CONFIG_HOME: previous.XDG_CONFIG_HOME,
    TMPDIR: previous.TMPDIR,
    ...environment,
  });
  let stdout = "";
  const errors: string[] = [];

  const output: Console.Console = {
    ...console,
    log: (...values) => {
      stdout += `${values.join(" ")}\n`;
    },
    error: (...values) => errors.push(values.join(" ")),
  };

  const run = makeCLI(
    providers,
    (text) =>
      Effect.sync(() => {
        stdout += text;
      }),
    (action, config) =>
      Effect.sync(() => {
        expect(action).toBe("status");

        return {
          installed: false,
          loaded: false,
          plist: join(config.dataDirectory, "home/Library/LaunchAgents/test.plist"),
          log: join(config.dataDirectory, "logs/worker.log"),
        };
      }),
  );

  try {
    const exitCode = await Effect.runPromise(
      run(args).pipe(
        Effect.provideService(Console.Console, output),
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
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previous);
  }
};

describe("CLI", () => {
  test("isolates command configuration from the shell and restores the original environment", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-cli-env-"));

    const inherited = {
      POPPET_PROVIDER: "openai-chatgpt",
      POPPET_MODEL: "inherited-model",
      POPPET_APP_NAME: "Inherited app",
      POPPET_DATA_DIR: join(directory, "inherited"),
    };

    const original = process.env;
    const previous = new Map(Object.keys(inherited).map((key) => [key, process.env[key]]));
    Object.assign(process.env, inherited);

    try {
      const configured = await invoke(["config"], {
        POPPET_PROVIDER: "openrouter",
        POPPET_DATA_DIR: directory,
      });

      expect(configured.exitCode).toBe(0);
      expect(JSON.parse(configured.stdout)).toMatchObject({
        applicationName: "Poppet",
        provider: "openrouter",
        model: null,
        dataDirectory: directory,
      });
      const defaults = await invoke(["config"], { POPPET_DATA_DIR: directory });
      expect(JSON.parse(defaults.stdout)).toMatchObject({
        provider: "openai-chatgpt",
        model: null,
      });
      expect(process.env).toBe(original);

      for (const [key, value] of Object.entries(inherited)) expect(process.env[key]).toBe(value);
      expect(await readdir(directory)).toEqual([]);
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }

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
      expect(second.stderr).toContain("Another Poppet store may be open");

      const added = await invoke(
        ["tasks", "add", "Later", "--at", "2099-10-14T09:00:00Z", "Summarize notes"],
        { ...environment, POPPET_MODEL: "saved-model" },
      );

      expect(added.exitCode).toBe(0);
      const task = JSON.parse(added.stdout);
      expect(task.model).toBe("saved-model");
      const remembered = await invoke(["memory", "remember", "project", "Acorn"], environment);
      expect(remembered.exitCode).toBe(0);
      expect(JSON.parse(remembered.stdout)).toMatchObject({ key: "project", value: "Acorn" });
      expect(JSON.parse((await invoke(["memory", "list"], environment)).stdout)).toMatchObject([
        { key: "project", value: "Acorn" },
      ]);
      expect(JSON.parse((await invoke(["chat", "sessions"], environment)).stdout)).toEqual([]);
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
        // eslint-disable-next-line no-await-in-loop -- Invocations temporarily replace process.env.
        const result = await invoke(["memory", ...args], { POPPET_DATA_DIR: directory });
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(message);
      }

      expect(await readdir(directory)).toEqual([]);
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
        schemaVersion: 7,
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
      const commands = [
        ["auth", "login", "unknown"],
        ["auth", "login", "--provider"],
        ["auth", "login", "openrouter", "--provider", "opencode-go"],
        ["auth", "login", "openrouter", "--consent"],
        ["auth", "login", "openai-chatgpt", "--key-stdin"],
        ["auth", "status", "--key-stdin"],
        ["auth", "verify", "--provider", "openrouter"],
      ];

      const results = [];

      for (const command of commands) {
        // eslint-disable-next-line no-await-in-loop -- Invocations temporarily replace process.env.
        results.push(await invoke(command, environment));
      }

      expect(results.every((result) => result.exitCode === 1)).toBe(true);
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("help works even when application configuration is invalid", async () => {
    const result = await invoke(["--help"], { POPPET_DATA_DIR: "" });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("bun run start <subcommand>");
    expect(result.stderr).toBe("");
  });

  test("root and command help never load configuration or create application files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-cli-help-"));
    const environment = { POPPET_DATA_DIR: directory, POPPET_PROVIDER: "invalid/provider" };

    const paths = [
      "config",
      "store status",
      "provider models",
      "provider verify",
      "auth login",
      "auth status",
      "auth models",
      "auth verify",
      "auth logout",
      "chat new",
      "chat send",
      "chat sessions",
      "chat show",
      "memory list",
      "memory remember",
      "memory replace",
      "memory forget",
      "tasks add",
      "tasks list",
      "tasks show",
      "tasks pause",
      "tasks resume",
      "tasks cancel",
      "tasks retry",
      "tasks clear",
      "tasks providers",
      "tasks resume-provider",
      "tasks status",
      "tasks work",
      "gateway discord",
      "gateway discord setup",
      "gateway work",
      "gateway status",
      "worker run",
      "worker install",
      "worker start",
      "worker stop",
      "worker status",
      "worker logs",
      "worker uninstall",
    ];

    try {
      for (const args of [[], ["-h"], ...paths.map((path) => path.split(" ").concat("--help"))]) {
        // eslint-disable-next-line no-await-in-loop -- Each call temporarily changes process.env.
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
        // eslint-disable-next-line no-await-in-loop -- Each call temporarily changes process.env.
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
    const result = await invoke(["config"], {
      POPPET_APP_NAME: "Test Poppet",
      POPPET_DATA_DIR: "/tmp/poppet-test",
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      applicationName: "Test Poppet",
      dataDirectory: "/tmp/poppet-test",
      notesDirectory: "/tmp/poppet-test/notes",
      provider: "openai-chatgpt",
      model: null,
    });
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
