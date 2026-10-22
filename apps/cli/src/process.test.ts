import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
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

// Two CLI startups need headroom while subprocess tests compete for CPU in CI.
test.concurrent("invalid configuration and commands exit unsuccessfully", async () => {
  const invalidConfig = await invokeProcess(["config"], { POPPET_DATA_DIR: "" });
  const invalidCommand = await invokeProcess(["config", "unexpected-argument"]);

  expect(invalidConfig.exitCode).toBe(1);
  expect(invalidConfig.stdout).toBe("");
  expect(invalidConfig.stderr).toContain("POPPET_DATA_DIR");
  expect(invalidCommand.exitCode).toBe(1);
  expect(invalidCommand.stdout).toContain("bun run start config");
  expect(invalidCommand.stderr).toContain("Unexpected positional argument");
}, 15_000);

test.concurrent.each(["openrouter", "opencode-go"])(
  "%s reads stdin without printing the key and rejects empty input",
  async (provider) => {
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
  },
  15_000,
);

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

const discordSetup = ["gateway", "discord", "setup", "100", "200", "300", "400", "--key-stdin"];

test.concurrent.each([
  { name: "empty", input: "\n" },
  { name: "oversized", input: "x".repeat(8195) },
])("Discord setup rejects $name input without writing credentials", async ({ input }) => {
  const directory = await mkdtemp(join(tmpdir(), "poppet-discord-invalid-"));

  try {
    const result = await invokeProcess(discordSetup, { POPPET_DATA_DIR: directory }, input);
    expect(result.exitCode).toBe(1);
    expect(await readdir(directory)).toEqual([]);
    expect(result.stdout + result.stderr).not.toContain("x".repeat(64));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.concurrent("Discord setup saves protected settings and status never prints the token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "poppet-discord-setup-"));
  const environment = { POPPET_DATA_DIR: directory };

  try {
    const saved = await invokeProcess(discordSetup, environment, "discord-test-secret\n");
    expect(saved.exitCode).toBe(0);
    expect(saved.stdout + saved.stderr).not.toContain("discord-test-secret");
    expect((await stat(join(directory, "channels/discord.json"))).mode & 0o777).toBe(0o600);
    const status = await invokeProcess(["gateway", "status"], environment);
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      running: false,
      enabled: true,
      channels: [
        { id: "discord", enabled: true },
        { id: "telegram", enabled: false },
        { id: "whatsapp", enabled: false },
      ],
    });
    expect(status.stdout + status.stderr).not.toContain("discord-test-secret");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

test.concurrent("Telegram setup saves protected settings without connecting and status redacts its token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "poppet-telegram-setup-"));
  const environment = { POPPET_DATA_DIR: directory };

  try {
    const saved = await invokeProcess(
      ["gateway", "telegram", "setup", "100", "200", "--key-stdin"],
      environment,
      "100:telegram-test-secret\n",
    );

    expect(saved.exitCode).toBe(0);
    expect(saved.stdout + saved.stderr).not.toContain("telegram-test-secret");
    expect((await stat(join(directory, "channels/telegram.json"))).mode & 0o777).toBe(0o600);
    const status = await invokeProcess(["gateway", "status"], environment);
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      running: false,
      enabled: true,
      channels: [
        { id: "discord", enabled: false },
        { id: "telegram", enabled: true },
        { id: "whatsapp", enabled: false },
      ],
    });
    expect(status.stdout + status.stderr).not.toContain("telegram-test-secret");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

test.concurrent("WhatsApp setup stays offline and QR pairing rejects redirected output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "poppet-whatsapp-setup-"));
  const environment = { POPPET_DATA_DIR: directory };

  try {
    const invalid = await invokeProcess(
      ["gateway", "whatsapp", "setup", "+447700900001", "447700900002"],
      environment,
    );

    expect(invalid.exitCode).toBe(1);
    expect(await readdir(directory)).toEqual([]);

    const saved = await invokeProcess(
      ["gateway", "whatsapp", "setup", "447700900001", "447700900002"],
      environment,
    );

    expect(saved.exitCode).toBe(0);
    expect((await stat(join(directory, "channels/whatsapp.json"))).mode & 0o777).toBe(0o600);
    const status = await invokeProcess(["gateway", "status"], environment);
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      running: false,
      enabled: true,
      channels: [
        { id: "discord", enabled: false },
        { id: "telegram", enabled: false },
        { id: "whatsapp", enabled: true },
      ],
    });
    const pair = await invokeProcess(["gateway", "whatsapp", "pair"], environment);
    expect(pair.exitCode).toBe(1);
    expect(pair.stderr).toContain("requires an interactive terminal");
    expect(await readdir(join(directory, "channels"))).toEqual([
      "whatsapp.json",
      "whatsapp.lock.sqlite",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

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
