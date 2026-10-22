import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

test("live network requests and system subprocesses are rejected", () => {
  expect(() => fetch("https://provider.invalid/v1/models")).toThrow("external services");
  expect(() => fetch("http://192.0.2.1")).toThrow("external services");
  expect(() => fetch.preconnect("https://provider.invalid")).toThrow("preconnect");
  expect(() => Bun.spawn(["/poppet-test-nonexistent/open", "https://example.invalid"])).toThrow(
    "guarded Bun",
  );
  expect(() => Bun.spawnSync({ cmd: ["/poppet-test-nonexistent/launchctl", "print"] })).toThrow(
    "guarded Bun",
  );
  expect(() => Bun.spawn([process.execPath, "run", "start"])).toThrow("entry point");
  expect(() => spawn("/poppet-test-nonexistent/open", [])).toThrow("guarded Bun");
  expect(() => spawn(process.execPath, ["run", "start"])).toThrow("entry point");
});

test("local redirects cannot bypass the network guard", async () => {
  let reached = false;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, listener) {
      if (new URL(request.url).pathname === "/redirect")
        return Response.redirect(new URL("/destination", listener.url).toString());
      reached = true;

      return new Response("unexpected");
    },
  });

  try {
    await expect(fetch(new URL("/redirect", server.url))).rejects.toThrow();
    expect(reached).toBe(false);
    expect((await fetch(new URL("/redirect", server.url), { redirect: "manual" })).status).toBe(
      302,
    );
  } finally {
    await server.stop(true);
  }
});

test("subprocesses ignore dotenv credentials, isolate home, and inherit both guards", async () => {
  const directory = await mkdtemp(join(tmpdir(), "poppet-dotenv-"));
  await mkdir(join(directory, "data"));
  await Bun.write(join(directory, ".env"), "POPPET_OPENROUTER_API_KEY=dotenv-dummy-key\n");
  await Bun.write(join(directory, "package.json"), JSON.stringify({ type: "module" }));
  await Bun.write(
    join(directory, "probe.ts"),
    `
    import { homedir } from "node:os";
    if (process.env.POPPET_OPENROUTER_API_KEY !== undefined) throw new Error("dotenv leaked");
    if (process.env.POPPET_MODEL !== "fixture-model") throw new Error("fixture config lost");
    if (homedir() !== process.env.HOME || homedir() === "/real-home-sentinel") throw new Error("home leaked");
    for (const attempt of [
      () => fetch("https://provider.invalid/v1/models"),
      () => Bun.spawn(["/poppet-test-nonexistent-launcher"]),
    ]) {
      let blocked = false;
      try { attempt(); } catch { blocked = true; }
      if (!blocked) throw new Error("subprocess guard missing");
    }
    console.log("isolated");
  `,
  );

  try {
    expect(process.env.HOME).toBe(homedir());
    expect(process.env.POPPET_PROVIDER).toBeUndefined();
    expect(process.env.POPPET_OPENROUTER_API_KEY).toBeUndefined();

    const child = Bun.spawn([process.execPath, join(directory, "probe.ts")], {
      cwd: directory,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: "/real-home-sentinel",
        POPPET_MODEL: "fixture-model",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const [output, errors, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(errors).toBe("");
    expect(code).toBe(0);
    expect(output.trim()).toBe("isolated");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
