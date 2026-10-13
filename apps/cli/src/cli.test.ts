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
  test("logout clears an identity retained by an earlier logout", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-logout-identity-"));
    const environment = { POPPET_DATA_DIR: directory };

    try {
      await mkdir(join(directory, "auth"));
      const path = join(directory, "auth/connection.json");
      await writeFile(
        path,
        JSON.stringify({
          version: 1,
          hostId: "urn:uuid:00000000-0000-4000-8000-000000000000",
          clientId: "oaiapp_test",
          identity: { subject: "old-account", email: "signed-out@example.invalid" },
          credentials: null,
          verification: null,
        }),
      );

      const logout = await invoke(["auth", "logout"], environment);
      const status = await invoke(["auth", "status"], environment);

      expect(logout.exitCode).toBe(0);
      expect(logout.stdout).toContain("account identity, tokens, and verification were cleared");
      expect(status.exitCode).toBe(0);
      expect(JSON.parse(status.stdout)).toMatchObject({
        connected: false,
        email: null,
        clientId: "oaiapp_test",
      });
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
        identity: null,
        credentials: null,
        verification: null,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

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
        "openrouter.json",
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
      const invalid = await invoke(["auth", "login", "--unknown"], environment);
      expect(invalid.exitCode).toBe(1);
      expect(invalid.stderr).toContain("Unknown command");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
