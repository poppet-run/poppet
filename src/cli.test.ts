import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const invoke = async (args: ReadonlyArray<string>, environment: Record<string, string> = {}) => {
  const subprocess = Bun.spawn([process.execPath, "src/main.ts", ...args], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
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
});
