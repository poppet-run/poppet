import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { browserExecutables, browserInstallationVersions } from "#src/executables";

import versions from "../test-versions.json";

const chromiumVersion = versions.chromium;

describe.concurrent("browserExecutables", () => {
  test("selects the newest usable supported patch and skips incomplete installations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-discovery-"));

    try {
      const binary =
        process.platform === "darwin"
          ? "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
          : "chrome";

      const cache = join(directory, ".agent-browser", "browsers");
      const older = join(cache, "chrome-156.0.8078.9", binary);
      const newer = join(cache, "chrome-156.0.8078.100", binary);
      const unusable = join(cache, "chrome-156.0.8078.101", binary);
      const incomplete = join(cache, "chrome-156.0.8078.102", binary);
      await Promise.all(
        [older, newer, unusable].map(async (path) => {
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, "fixture", { mode: path === unusable ? 0o600 : 0o700 });
        }),
      );
      await mkdir(incomplete, { recursive: true });
      const settings = { enabled: true, command: "/custom/agent-browser" };
      expect((await browserExecutables(settings, directory)).chromium).toBe(newer);
      await rm(newer);
      expect((await browserExecutables(settings, directory)).chromium).toBe(older);
      await rm(older);
      await expect(browserExecutables(settings, directory)).rejects.toThrow(
        "agent-browser was found, but no usable Chrome for Testing installation",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("when explicit executable overrides exist, uses them without requiring a standard installation", async () => {
    expect(
      await browserExecutables(
        { enabled: true, command: "/custom/browser", chromiumExecutable: "/custom/chrome" },
        "/missing-home",
        "/missing-path",
      ),
    ).toEqual({ executable: "/custom/browser", chromium: "/custom/chrome" });
  });

  test("when the launcher is symlinked, finds its native sibling and installed Chrome", async () => {
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
      await writeFile(
        join(directory, "package/package.json"),
        JSON.stringify({ name: "agent-browser", version: versions.agentBrowser }),
      );
      const discovered = await browserExecutables({ enabled: true }, directory, bin);
      expect(await browserInstallationVersions(discovered)).toEqual({
        agentBrowser: versions.agentBrowser,
        chromium: chromiumVersion,
      });

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

  test("when native or extracted installations exist, prefers a supported Chrome release over a newer untested release", async () => {
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

      expect((await browserExecutables({ enabled: true }, directory, directory)).chromium).toBe(
        other,
      );

      await mkdir(dirname(chrome), { recursive: true });
      await writeFile(chrome, "supported chrome", { mode: 0o700 });
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
