import { describe, expect, test } from "bun:test";

import { parseOptions, quotePath, remoteScript, sshArguments } from "./deploy";

describe("parseOptions", () => {
  test("when nothing is set, deploys origin/main to brighid at ~/poppet", () => {
    expect(parseOptions([], {})).toEqual({
      host: "brighid",
      user: undefined,
      path: "~/poppet",
      ref: "origin/main",
      remote: undefined,
      bun: "bun",
      dryRun: false,
    });
  });

  test("when both a flag and a variable are set, the flag wins", () => {
    expect(
      parseOptions(["--host", "flag-host", "--dry-run"], {
        POPPET_DEPLOY_HOST: "env-host",
        POPPET_DEPLOY_USER: "tom",
        POPPET_DEPLOY_REF: "v1.0.0",
      }),
    ).toMatchObject({ host: "flag-host", user: "tom", ref: "v1.0.0", dryRun: true });
  });

  test("when --help is passed, returns help", () => {
    expect(parseOptions(["--help"], {})).toBe("help");
  });

  test.each([["--hots"], ["main"]])("when given unknown argument %s, throws", (arg) => {
    expect(() => parseOptions([arg], {})).toThrow();
  });
});

describe("quotePath", () => {
  test.each([
    ["~/poppet", `"$HOME"/'poppet'`],
    ["~", `"$HOME"`],
    ["/srv/it's here", `'/srv/it'\\''s here'`],
  ])("when given %s, quotes it as %s", (path, expected) => {
    expect(quotePath(path)).toBe(expected);
  });
});

describe("sshArguments", () => {
  test("when a user is given, connects as user@host in batch mode and runs sh -s", () => {
    expect(sshArguments("brighid", "tom")).toEqual([
      "-o",
      "BatchMode=yes",
      "-T",
      "tom@brighid",
      "--",
      "sh",
      "-s",
    ]);
  });
});

describe("remoteScript", () => {
  const script = remoteScript({
    path: "~/poppet",
    commit: "0123456789abcdef0123456789abcdef01234567",
    remote: "https://github.com/poppet-run/poppet.git",
    bun: "/home/tom/.bun/bin/bun",
  });

  test("when built, refuses local changes before checking out, installing, and touching the worker", () => {
    const order = [
      "status --porcelain",
      "git checkout --quiet --detach '0123456789abcdef0123456789abcdef01234567'",
      "install --frozen-lockfile",
      "worker restart",
    ].map((text) => script.indexOf(text));

    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual(order.toSorted((left, right) => left - right));
  });
});
