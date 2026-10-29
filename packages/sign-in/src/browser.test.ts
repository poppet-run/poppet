import { describe, expect, test } from "bun:test";

import { remoteSession } from "#src/browser";

describe("remoteSession", () => {
  test.each([
    [{ SSH_CONNECTION: "10.0.0.2 50000 10.0.0.1 22" }, "darwin", true],
    [{}, "darwin", false],
    [{}, "linux", true],
    [{ DISPLAY: ":0" }, "linux", false],
    [{ WAYLAND_DISPLAY: "wayland-0" }, "linux", false],
  ])("for %o on %s, reports %p", (environment, platform, expected) => {
    expect(remoteSession(environment, platform)).toBe(expected);
  });
});
