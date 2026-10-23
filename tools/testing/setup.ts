import { homedir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import { bashFixtures } from "./bash-fixtures";

const home = process.env.POPPET_TEST_HOME;

if (home === undefined || homedir() !== home)
  throw new Error("Use bun run test so tests start with an isolated home and environment.");

const network = globalThis.fetch;

globalThis.fetch = Object.assign(
  (input: string | URL | Request, init?: BunFetchRequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());

    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      throw new Error(`Tests cannot contact external services: ${url.origin}`);

    // Redirects must be followed explicitly so every destination passes this check.
    return network(input, { ...init, redirect: init?.redirect === "manual" ? "manual" : "error" });
  },
  {
    preconnect: () => {
      throw new Error("Tests cannot preconnect to external services.");
    },
  },
);

const protectSpawn = <T extends typeof Bun.spawn | typeof Bun.spawnSync>(spawn: T): T =>
  new Proxy(spawn, {
    apply(target, _receiver, [command, options]) {
      const settings = Array.isArray(command) ? { ...options, cmd: command } : command;

      // Exercise the real Bash lifecycle without enabling arbitrary shell commands in tests.
      if (settings?.cmd?.[0] === "/bin/bash") {
        const cwd = relative(home, settings.cwd ?? ".");

        if (
          cwd.startsWith("..") ||
          isAbsolute(cwd) ||
          settings.env?.HOME !== home ||
          JSON.stringify(settings.cmd.slice(0, 6)) !==
            JSON.stringify(["/bin/bash", "--noprofile", "--norc", "-o", "pipefail", "-c"]) ||
          settings.cmd.length !== 7 ||
          !Object.values(bashFixtures).includes(settings.cmd[6])
        )
          throw new Error("Tests may only run fixed Bash fixtures inside their isolated home.");

        // SAFETY: the validated options match both native spawn overloads.
        return (target as typeof Bun.spawn)(settings);
      }

      if (settings?.cmd?.[0] !== process.execPath)
        throw new Error("Tests may only launch guarded Bun subprocesses.");
      const [entry] = settings.cmd.slice(1);

      if (entry !== "--eval" && entry !== "-e" && !entry?.endsWith(".ts"))
        throw new Error("Test subprocesses must run a TypeScript entry point or --eval directly.");

      // SAFETY: both native spawn APIs accept this options object; the Proxy preserves their overloads.
      return (target as typeof Bun.spawn)({
        ...settings,
        cmd: [
          process.execPath,
          "--no-env-file",
          "--no-install",
          "--preload",
          fileURLToPath(import.meta.url),
          ...settings.cmd.slice(1),
        ],
        env: {
          ...(settings.env ?? process.env),
          HOME: home,
          USERPROFILE: home,
          XDG_CONFIG_HOME: join(home, ".config"),
          TMPDIR: home,
          TEMP: home,
          TMP: home,
          POPPET_TEST_HOME: home,
          BUN_OPTIONS: "",
          NODE_OPTIONS: "",
          DO_NOT_TRACK: "1",
        },
      });
    },
  });

Bun.spawn = protectSpawn(Bun.spawn);

Bun.spawnSync = protectSpawn(Bun.spawnSync);
