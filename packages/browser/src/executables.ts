import { constants } from "node:fs";
import { access, open, realpath, opendir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { openNoFollow, readFileBounded } from "@poppet/io";
import { Schema } from "effect";

import { browserFailure } from "#src/browser-process";
import { chromiumCompatibility } from "#src/compatibility";
import { type BrowserSettings } from "#src/config";

/** Resolve installation paths before the run replaces HOME with a private directory. */
export const browserExecutables = async (
  settings: BrowserSettings,
  home = homedir(),
  path = process.env.PATH ?? "",
) => {
  let executable = settings.command;

  if (executable === undefined) {
    const command = Bun.which("agent-browser", { PATH: path });

    if (command === null)
      throw browserFailure(
        "tool-network",
        "Cannot find agent-browser on PATH. Install it or set browser.command. See docs/browser.md.",
      );

    executable = await realpath(command);
    const file = await open(executable, "r");
    const header = Buffer.alloc(2);

    try {
      await file.read(header, 0, 2, 0);
    } finally {
      await file.close();
    }

    if (header.toString() === "#!") {
      executable = join(dirname(executable), `agent-browser-${process.platform}-${process.arch}`);

      try {
        await access(executable, constants.X_OK);
      } catch {
        throw browserFailure(
          "tool-network",
          "Cannot find the native agent-browser beside its launcher. Set browser.command to the native executable. See docs/browser.md.",
        );
      }
    }
  }

  let chromium = settings.chromiumExecutable;

  if (chromium === undefined) {
    const cache = join(home, ".agent-browser", "browsers");
    const versions: string[] = [];
    const directory = await opendir(cache).catch(() => null);

    if (directory !== null) {
      let entries = 0;

      for await (const entry of directory) {
        if (++entries > 1000)
          throw browserFailure(
            "tool-limit",
            "The agent-browser cache exceeds the 1000 entry discovery limit. Set browser.chromiumExecutable explicitly.",
          );

        if (entry.isDirectory() && /^chrome-\d{1,6}\.\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(entry.name))
          versions.push(entry.name.slice(7));
      }
    }

    // Prefer a supported release line, then the newest installed patch. If only
    // untested releases exist, resolve one so compatibility can explain the problem.
    versions.sort((left, right) => {
      const leftSupported = chromiumCompatibility(left).status === "supported";
      const rightSupported = chromiumCompatibility(right).status === "supported";

      return (
        Number(rightSupported) - Number(leftSupported) ||
        right.localeCompare(left, "en", { numeric: true })
      );
    });

    const binaries =
      process.platform === "darwin"
        ? [
            "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
            `chrome-mac-${process.arch}/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
          ]
        : ["chrome", "chrome-linux64/chrome"];

    // Sequential discovery stops after the first usable binary and keeps file I/O bounded.
    for (const version of versions) {
      // eslint-disable-next-line no-await-in-loop -- Try newer supported installations first.
      const candidates = await Promise.all(
        binaries.map(async (binary) => {
          const candidate = join(cache, `chrome-${version}`, binary);

          return stat(candidate)
            .then(async (info) => {
              if (!info.isFile()) return undefined;
              await access(candidate, constants.X_OK);

              return candidate;
            })
            .catch(() => undefined);
        }),
      );

      chromium = candidates.find((candidate) => candidate !== undefined);

      if (chromium !== undefined) break;
    }

    if (chromium === undefined)
      throw browserFailure(
        "tool-network",
        "agent-browser was found, but no usable Chrome for Testing installation was found in its cache. Run agent-browser install or set browser.chromiumExecutable.",
      );
  }

  return { executable, chromium };
};

/** Saved installation metadata only; doctor must not run version commands. */
export const browserInstallationVersions = async (paths: {
  readonly executable: string;
  readonly chromium: string;
}) => {
  const executable = await realpath(paths.executable);
  const packagePath = join(dirname(executable), "..", "package.json");

  const agentBrowser = await (async () => {
    const file = await openNoFollow(packagePath);

    if (file === null) return null;

    try {
      const info = await file.stat();

      if (!info.isFile() || info.size > 65536) return null;

      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        await readFileBounded(file, 65536, () => new Error("Package metadata limit")),
      );

      return Schema.decodeUnknownSync(
        Schema.fromJsonString(
          Schema.Struct({
            name: Schema.Literal("agent-browser"),
            version: Schema.String.check(Schema.isPattern(/^\d{1,6}\.\d{1,6}\.\d{1,6}$/)),
          }),
        ),
      )(text).version;
    } finally {
      await file.close();
    }
  })().catch(() => null);

  const chromium =
    /(?:^|\/)chrome-(\d{1,6}\.\d{1,6}\.\d{1,6}\.\d{1,6})(?:\/|$)/.exec(
      await realpath(paths.chromium),
    )?.[1] ?? null;

  return { agentBrowser, chromium };
};
