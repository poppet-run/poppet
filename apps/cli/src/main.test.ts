import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const invokeProcess = async (
  args: ReadonlyArray<string>,
  environment: Record<string, string> = {},
  input: string | null = null,
) => {
  const subprocess = Bun.spawn([process.execPath, "apps/cli/src/main.ts", ...args], {
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

describe("main.ts", () => {
  test("setup rejects piped input before creating configuration or credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-setup-pipe-"));

    try {
      const result = await invokeProcess(["setup"], { POPPET_DATA_DIR: directory }, "secret\n");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Setup needs an interactive terminal");
      expect(result.stdout + result.stderr).not.toContain("secret");
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("when the CLI bin runs outside the checkout, shows help without loading configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-entry-"));
    const root = fileURLToPath(new URL("../../..", import.meta.url));
    const { bin } = await Bun.file(join(root, "package.json")).json();
    const entry = join(root, bin.poppet);
    const command = join(directory, "poppet.ts");

    try {
      expect(await Bun.file(entry).text()).toStartWith("#!/usr/bin/env bun\n");
      expect((await stat(entry)).mode & 0o111).not.toBe(0);
      await symlink(entry, command);

      const child = Bun.spawn([process.execPath, command, "--help"], {
        cwd: directory,
        env: { PATH: process.env.PATH ?? "", POPPET_DATA_DIR: "" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });

      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);

      expect(exitCode).toBe(0);
      expect(stdout).toContain("poppet <subcommand>");
      expect(stderr).toBe("");
      expect(await readdir(directory)).toEqual(["poppet.ts"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.concurrent("when configuration is invalid, exits unsuccessfully", async () => {
    const invalidConfig = await invokeProcess(["config", "--json"], { POPPET_DATA_DIR: "" });

    expect(invalidConfig.exitCode).toBe(1);
    expect(invalidConfig.stdout).toBe("");
    expect(invalidConfig.stderr).toContain("POPPET_DATA_DIR");
  });

  test.concurrent("when API-key login has no terminal or environment key, rejects piped input without saving it", async () => {
    const provider = "openrouter";
    const directory = await mkdtemp(join(tmpdir(), "poppet-hidden-key-"));
    await writeFile(join(directory, "config.json"), JSON.stringify({ provider }));

    try {
      const result = await invokeProcess(
        ["provider", "login"],
        { POPPET_DATA_DIR: directory },
        "piped-test-secret\n",
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("API-key login needs an interactive terminal");
      expect(result.stdout + result.stderr).not.toContain("piped-test-secret");
      expect(await readdir(directory)).toEqual(["config.json"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.concurrent("when web login receives an API key, uses it instead of an invalid environment key", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-web-api-key-"));
    await writeFile(join(directory, "config.json"), JSON.stringify({ webSearchProvider: "brave" }));

    try {
      const saved = await invokeProcess(["web", "login", "--api-key", "argument-search-secret"], {
        POPPET_DATA_DIR: directory,
        POPPET_BRAVE_SEARCH_API_KEY: "invalid search key",
      });

      expect(saved.exitCode).toBe(0);
      expect(saved.stdout + saved.stderr).not.toContain("argument-search-secret");
      expect(saved.stdout + saved.stderr).not.toContain("invalid search key");
      expect(JSON.parse(await Bun.file(join(directory, "auth/brave-search.json")).text()).key).toBe(
        "argument-search-secret",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.concurrent("web login ignores environment keys and requires explicit input", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-web-environment-"));
    await writeFile(join(directory, "config.json"), JSON.stringify({ webSearchProvider: "brave" }));

    try {
      const result = await invokeProcess(["web", "login"], {
        POPPET_DATA_DIR: directory,
        POPPET_BRAVE_SEARCH_API_KEY: "unused-environment-key",
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("--api-key <key>");
      expect(result.stdout + result.stderr).not.toContain("unused-environment-key");
      expect(await readdir(directory)).toEqual(["config.json"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.concurrent("when key input is unattended, fails without creating credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-unattended-"));

    try {
      const result = await invokeProcess(["provider", "login", "openrouter"], {
        POPPET_DATA_DIR: directory,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("interactive terminal");
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  // Two sequential CLI startups need headroom when CI runs process tests concurrently.
  test.concurrent("when channel setup receives flags, validates and saves the token without printing it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-channel-input-"));

    const args = [
      "gateway",
      "discord",
      "setup",
      "--owner-id",
      "200",
      "--guild-id",
      "300",
      "--home-channel-id",
      "400",
      "--bot-token",
    ];

    const environment = { POPPET_DATA_DIR: directory };

    try {
      const result = await invokeProcess([...args, "x".repeat(8193)], environment);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("nonempty bot token without whitespace");
      expect(await readdir(directory)).toEqual([]);
      expect(result.stdout + result.stderr).not.toContain("x".repeat(64));

      const saved = await invokeProcess([...args, "discord-test-secret"], environment);
      expect(saved.exitCode).toBe(0);
      expect(saved.stdout + saved.stderr).not.toContain("discord-test-secret");
      expect(
        JSON.parse(await Bun.file(join(directory, "channels/discord.json")).text()).token,
      ).toBe("discord-test-secret");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 15000);

  test.concurrent("when interactive chat input is redirected, rejects it without creating a session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-interactive-input-"));

    try {
      const result = await invokeProcess(
        ["chat", "interactive"],
        { POPPET_DATA_DIR: directory },
        "Never send this\n",
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Interactive chat requires a terminal");
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
