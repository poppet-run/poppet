import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

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

      if (settings?.cmd?.[0] !== process.execPath)
        throw new Error("Tests may only launch guarded Bun subprocesses.");
      const [entry] = settings.cmd.slice(1);

      if (entry !== "--eval" && entry !== "-e" && !entry?.endsWith(".ts"))
        throw new Error("Test subprocesses must run a TypeScript entry point or --eval directly.");
      let isolated = home;

      try {
        if (
          settings.env?.HOME &&
          realpathSync(settings.env.HOME).startsWith(`${realpathSync(home)}${sep}`)
        )
          isolated = settings.env.HOME;
      } catch {
        /* Replace unavailable or out-of-scope homes with the test home. */
      }

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
          HOME: isolated,
          USERPROFILE: isolated,
          XDG_CONFIG_HOME: join(isolated, ".config"),
          TMPDIR: isolated,
          TEMP: isolated,
          TMP: isolated,
          POPPET_TEST_HOME: isolated,
          BUN_OPTIONS: "",
          NODE_OPTIONS: "",
          DO_NOT_TRACK: "1",
        },
      });
    },
  });

Bun.spawn = protectSpawn(Bun.spawn);

Bun.spawnSync = protectSpawn(Bun.spawnSync);

// The pinned Bun Node process API delegates to Bun.spawn; isolation tests cover both APIs.
