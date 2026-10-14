import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const invoke = async (
  args: ReadonlyArray<string>,
  environment: Record<string, string> = {},
  input: string | null = null,
) => {
  const subprocess = Bun.spawn([process.execPath, "run", "--silent", "start", ...args], {
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    env: {
      PATH: process.env.PATH ?? "",
      ...environment,
    },
    stdin: input === null ? "ignore" : new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);

  return { stdout, stderr, exitCode };
};

describe("CLI", () => {
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
      expect(invalid.stderr).toContain("Invalid task or provider ID");
      expect(await readdir(directory)).toEqual([]);
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
      expect(new TextDecoder().decode(ready.value)).toContain("Task worker running");
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
  });

  test("task clients reach the running worker and a second worker cannot acquire ownership", async () => {
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
      expect(new TextDecoder().decode(ready.value)).toContain("Task worker running");
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
  });

  test("manages explicit facts across CLI restarts without a provider connection or model", async () => {
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
  });

  test("rejects invalid memory commands before creating a store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-memory-args-"));

    try {
      const cases = [
        { args: ["list", "extra"], message: "Use memory list" },
        { args: ["remember", "bad key", "Value"], message: "Memory keys must" },
        { args: ["remember", "key"], message: "Memory values must be nonempty" },
        { args: ["replace", "key", " "], message: "no surrounding whitespace" },
        { args: ["remember", "key", "😀".repeat(1025)], message: "4096 UTF-8 bytes" },
        { args: ["forget", "key", "extra"], message: "Use memory list" },
        { args: ["unknown"], message: "Use memory list" },
      ];

      await Promise.all(
        cases.map(async ({ args, message }) => {
          const result = await invoke(["memory", ...args], { POPPET_DATA_DIR: directory });
          expect(result.exitCode).toBe(1);
          expect(result.stderr).toContain(message);
          expect(result.stderr).not.toContain("Unknown command");
        }),
      );
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
        schemaVersion: 6,
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
        expect(await readdir(join(directory, "auth"))).toEqual([
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
      const router = await invoke(
        ["auth", "login", "openrouter", "--key-stdin"],
        environment,
        "router-test-secret\n",
      );

      const go = await invoke(["auth", "login", "--key-stdin"], environment, "go-test-secret\n");
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
  });

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

  test("rejects bad auth options and unattended or empty key input before creating credentials", async () => {
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
        ["auth", "login", "openrouter"],
        ["auth", "verify", "--provider", "openrouter"],
      ];

      const results = await Promise.all(commands.map((command) => invoke(command, environment)));
      expect(results.every((result) => result.exitCode === 1)).toBe(true);
      const empty = await invoke(["auth", "login", "openrouter", "--key-stdin"], environment, "\n");
      expect(empty.exitCode).toBe(1);
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("help works even when application configuration is invalid", async () => {
    const result = await invoke(["--help"], { POPPET_DATA_DIR: "" });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: bun run start");
    expect(result.stderr).toBe("");
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

  test("invalid configuration and commands exit unsuccessfully", async () => {
    const invalidConfig = await invoke(["config"], { POPPET_DATA_DIR: "" });
    const invalidCommand = await invoke(["config", "unexpected-argument"]);

    expect(invalidConfig.exitCode).toBe(1);
    expect(invalidConfig.stdout).toBe("");
    expect(invalidConfig.stderr).toContain("POPPET_DATA_DIR");
    expect(invalidCommand.exitCode).toBe(1);
    expect(invalidCommand.stdout).toBe("");
    expect(invalidCommand.stderr).toContain("Unknown command");
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

  test("root start resolves relative configuration paths from the repository directory", async () => {
    const result = await invoke(["config"], {
      POPPET_DATA_DIR: "relative-data",
      POPPET_NOTES_DIR: "relative-notes",
    });

    const directory = fileURLToPath(new URL("../../..", import.meta.url));

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      dataDirectory: resolve(directory, "relative-data"),
      notesDirectory: resolve(directory, "relative-notes"),
    });
  });

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
      expect(invalid.stderr).toContain("Unknown command");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
