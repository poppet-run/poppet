import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
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

test.concurrent("invalid configuration exits unsuccessfully", async () => {
  const invalidConfig = await invokeProcess(["config"], { POPPET_DATA_DIR: "" });

  expect(invalidConfig.exitCode).toBe(1);
  expect(invalidConfig.stdout).toBe("");
  expect(invalidConfig.stderr).toContain("POPPET_DATA_DIR");
}, 15_000);

test.concurrent("API-key login reads stdin without printing the key and rejects empty input", async () => {
  const provider = "openrouter";
  const directory = await mkdtemp(join(tmpdir(), "poppet-stdin-"));
  const environment = { POPPET_DATA_DIR: directory, POPPET_PROVIDER: provider };

  try {
    const empty = await invokeProcess(["auth", "login", "--key-stdin"], environment, "\n");
    expect(empty.exitCode).toBe(1);
    expect(await readdir(directory)).toEqual([]);

    const saved = await invokeProcess(
      ["auth", "login", "--key-stdin"],
      environment,
      "stdin-test-secret\n",
    );

    expect(saved.exitCode).toBe(0);
    expect(saved.stdout + saved.stderr).not.toContain("stdin-test-secret");
    expect(JSON.parse(await Bun.file(join(directory, `auth/${provider}.json`)).text()).key).toBe(
      "stdin-test-secret",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

test.concurrent("web login reads stdin instead of an invalid environment key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "poppet-web-stdin-"));

  try {
    const saved = await invokeProcess(
      ["web", "login", "--key-stdin"],
      {
        POPPET_DATA_DIR: directory,
        POPPET_BRAVE_SEARCH_API_KEY: "invalid search key",
      },
      "stdin-search-secret\n",
    );

    expect(saved.exitCode).toBe(0);
    expect(saved.stdout + saved.stderr).not.toContain("stdin-search-secret");
    expect(saved.stdout + saved.stderr).not.toContain("invalid search key");
    expect(JSON.parse(await Bun.file(join(directory, "auth/brave-search.json")).text()).key).toBe(
      "stdin-search-secret",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.concurrent("unattended key input fails without creating credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "poppet-unattended-"));

  try {
    const result = await invokeProcess(["auth", "login", "openrouter"], {
      POPPET_DATA_DIR: directory,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("interactive terminal");
    expect(await readdir(directory)).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.concurrent("channel setup bounds stdin and saves its token without printing it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "poppet-channel-input-"));
  const args = ["gateway", "discord", "setup", "100", "200", "300", "400", "--key-stdin"];
  const environment = { POPPET_DATA_DIR: directory };

  try {
    const result = await invokeProcess(args, environment, "x".repeat(8195));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("exceeds 8192 characters");
    expect(await readdir(directory)).toEqual([]);
    expect(result.stdout + result.stderr).not.toContain("x".repeat(64));

    const saved = await invokeProcess(args, environment, "discord-test-secret\n");
    expect(saved.exitCode).toBe(0);
    expect(saved.stdout + saved.stderr).not.toContain("discord-test-secret");
    expect(JSON.parse(await Bun.file(join(directory, "channels/discord.json")).text()).token).toBe(
      "discord-test-secret",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

test.concurrent("WhatsApp QR pairing rejects redirected output without creating credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "poppet-whatsapp-terminal-"));

  try {
    const result = await invokeProcess(["gateway", "whatsapp", "pair"], {
      POPPET_DATA_DIR: directory,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("requires an interactive terminal");
    expect(await readdir(directory)).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.concurrent("interactive chat rejects redirected input without creating a session", async () => {
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
}, 15_000);
