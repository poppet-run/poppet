import { constants } from "node:fs";
import { access, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { browserFailure, chromiumVersion } from "#src/browser-process";
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
    const directory = join(home, ".agent-browser", "browsers", `chrome-${chromiumVersion}`);

    const binaries =
      process.platform === "darwin"
        ? [
            "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
            `chrome-mac-${process.arch}/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
          ]
        : ["chrome", "chrome-linux64/chrome"];

    const candidates = await Promise.all(
      binaries.map((binary) => {
        const candidate = join(directory, binary);

        return access(candidate, constants.X_OK).then(
          () => candidate,
          () => undefined,
        );
      }),
    );

    chromium = candidates.find((candidate) => candidate !== undefined);

    if (chromium === undefined)
      throw browserFailure(
        "tool-network",
        `Cannot find Chrome for Testing ${chromiumVersion} in the agent-browser cache. Install it or set browser.chromiumExecutable. See docs/browser.md.`,
      );
  }

  return { executable, chromium };
};
