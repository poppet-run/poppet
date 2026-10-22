import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { chromiumVersion } from "#src/browser-process";
import { browserExecutables } from "#src/executables";

describe.concurrent("browser executable discovery", () => {
  test("keeps explicit overrides without requiring a standard installation", async () => {
    expect(
      await browserExecutables(
        { enabled: true, command: "/custom/browser", chromiumExecutable: "/custom/chrome" },
        "/missing-home",
        "/missing-path",
      ),
    ).toEqual({ executable: "/custom/browser", chromium: "/custom/chrome" });
  });

  test("resolves a symlinked launcher to its native sibling and discovers pinned Chrome", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-discovery-"));

    try {
      const bin = join(directory, "bin");
      const packageBin = join(directory, "package", "bin");
      const launcher = join(packageBin, "agent-browser.js");
      const native = join(packageBin, `agent-browser-${process.platform}-${process.arch}`);
      const cache = join(directory, ".agent-browser", "browsers");

      const binary =
        process.platform === "darwin"
          ? "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
          : "chrome";

      const chrome = join(cache, `chrome-${chromiumVersion}`, binary);
      await mkdir(bin, { recursive: true });
      await mkdir(packageBin, { recursive: true });
      await mkdir(dirname(chrome), { recursive: true });
      await writeFile(launcher, "#!/usr/bin/env node\n", { mode: 0o700 });
      await writeFile(native, "native fixture", { mode: 0o700 });
      await writeFile(chrome, "chrome fixture", { mode: 0o700 });
      await symlink(launcher, join(bin, "agent-browser"));

      expect(await browserExecutables({ enabled: true }, directory, bin)).toEqual({
        executable: await realpath(native),
        chromium: chrome,
      });

      await rm(native);
      await expect(browserExecutables({ enabled: true }, directory, bin)).rejects.toThrow(
        "Cannot find the native agent-browser beside its launcher",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("accepts native PATH installs and extracted archives, without selecting another Chrome version", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-discovery-"));

    try {
      const native = join(directory, "agent-browser");

      const binary =
        process.platform === "darwin"
          ? `chrome-mac-${process.arch}/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`
          : "chrome-linux64/chrome";

      const cache = join(directory, ".agent-browser", "browsers");
      const chrome = join(cache, `chrome-${chromiumVersion}`, binary);
      const other = join(cache, "chrome-999.0.0.0", binary);
      await writeFile(native, "native fixture", { mode: 0o700 });
      await mkdir(dirname(other), { recursive: true });
      await writeFile(other, "other chrome", { mode: 0o700 });

      await expect(browserExecutables({ enabled: true }, directory, directory)).rejects.toThrow(
        `Cannot find Chrome for Testing ${chromiumVersion}`,
      );

      await mkdir(dirname(chrome), { recursive: true });
      await writeFile(chrome, "pinned chrome", { mode: 0o700 });
      expect(await browserExecutables({ enabled: true }, directory, directory)).toEqual({
        executable: await realpath(native),
        chromium: chrome,
      });

      await rm(native);
      await expect(browserExecutables({ enabled: true }, directory, directory)).rejects.toThrow(
        "Cannot find agent-browser on PATH",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
