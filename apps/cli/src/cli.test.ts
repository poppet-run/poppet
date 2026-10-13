import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const invoke = async (args: ReadonlyArray<string>, environment: Record<string, string> = {}) => {
  const subprocess = Bun.spawn([process.execPath, "run", "--silent", "start", ...args], {
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    env: {
      PATH: process.env.PATH ?? "",
      ...environment,
    },
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
