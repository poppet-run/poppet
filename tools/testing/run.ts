import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const home = await mkdtemp(join(tmpdir(), "poppet-test-home-"));

try {
  const tests = Bun.spawn(
    [
      process.execPath,
      "test",
      "--no-env-file",
      "--no-install",
      "--no-orphans",
      "--preload",
      fileURLToPath(new URL("./setup.ts", import.meta.url)),
      ...Bun.argv.slice(2),
    ],
    {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        TMPDIR: home,
        TEMP: home,
        TMP: home,
        POPPET_TEST_HOME: home,
        DO_NOT_TRACK: "1",
      },
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    },
  );

  process.once("SIGINT", () => tests.kill("SIGINT"));
  process.once("SIGTERM", () => tests.kill("SIGTERM"));

  process.exitCode = await tests.exited;
} finally {
  await rm(home, { recursive: true, force: true });
}
