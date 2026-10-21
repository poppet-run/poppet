import { describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Effect, Fiber, Match, type Schema, type Scope } from "effect";

import { browserResult, browserTools, type BrowserTool } from "#src/browser";
import { runBrowserCommand, runBrowserRequest, type BrowserLauncher } from "#src/browser-process";

const fixturePath = fileURLToPath(new URL("./test/browser-fixture.ts", import.meta.url));

const settings = {
  enabled: true,
  command: "browser",
  chromiumExecutable: "/chromium",
  allowedDomains: ["example.com"],
};

const fixture = async (mode = "") => {
  const directory = await mkdtemp(join(tmpdir(), "poppet-browser-test-"));
  const trace = join(directory, "trace");
  const directories = new Set<string>();
  const children: ReturnType<BrowserLauncher>[] = [];
  const commands: ReadonlyArray<string>[] = [];
  const environments: Record<string, string>[] = [];

  const launch: BrowserLauncher = (command, cwd, environment) => {
    directories.add(cwd);
    commands.push(command);
    environments.push(environment);

    const child = Bun.spawn(
      [
        process.execPath,
        fixturePath,
        command[0] === "/chromium" ? "chromium" : "browser",
        ...command.slice(1),
      ],
      {
        cwd,
        env: {
          ...environment,
          POPPET_BROWSER_FIXTURE_TRACE: trace,
          POPPET_BROWSER_FIXTURE_MODE: mode,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    children.push(child);

    return child;
  };

  return {
    launch,
    trace,
    directory,
    directories,
    children,
    commands,
    environments,
    run: <A, E>(work: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(work)),
    close: () => rm(directory, { recursive: true, force: true }),
    tools: () => browserTools(settings, crypto.randomUUID(), 4096, launch),
    cleaned: async () => {
      await Promise.all(
        [...directories].map(async (cwd) => {
          expect(
            await access(cwd).then(
              () => true,
              () => false,
            ),
          ).toBe(false);
        }),
      );
      expect(children.every((child) => child.exitCode !== null || child.signalCode !== null)).toBe(
        true,
      );
    },
  };
};

const call = (tools: ReadonlyArray<BrowserTool>, name: string, input: Schema.JsonObject = {}) =>
  Effect.gen(function* () {
    const tool = tools.find((entry) => entry.toolName === name)!;
    const prepared = yield* tool.prepare(JSON.stringify(input));

    return yield* prepared.execute;
  });

describe.concurrent("browser tools", () => {
  test("publishes strict object schemas and rejects invalid no-argument inputs", async () => {
    const state = await fixture();

    try {
      await state.run(
        Effect.gen(function* () {
          const tools = yield* state.tools();

          for (const tool of tools)
            expect(tool.definition.parameters).toMatchObject({
              type: "object",
              properties: expect.any(Object),
              required: expect.any(Array),
              additionalProperties: false,
            });

          for (const name of ["snapshot", "close"]) {
            const tool = tools.find((entry) => entry.toolName === name)!;
            yield* tool.prepare("{}");

            for (const input of [null, true, 1, "text", [], { extra: true }])
              expect(yield* tool.prepare(JSON.stringify(input)).pipe(Effect.flip)).toHaveProperty(
                "reason",
                "tool-arguments",
              );
          }
        }),
      );
      expect(state.commands.every((command) => command[1] === "--version")).toBe(true);
      await state.cleaned();
    } finally {
      await state.close();
    }
  });

  test("isolates runs, accepts only current references, and reaps its daemon and commands", async () => {
    const state = await fixture();

    try {
      await state.run(
        Effect.gen(function* () {
          const tools = yield* state.tools();
          expect(tools.map((entry) => entry.toolName)).toEqual([
            "open",
            "snapshot",
            "click",
            "fill",
            "press",
            "scroll",
            "close",
          ]);
          yield* call(tools, "open", { url: "https://example.com/" });
          expect(JSON.parse(yield* call(tools, "snapshot"))).toMatchObject({
            url: "https://example.com/",
            truncated: false,
          });
          yield* call(tools, "fill", { reference: "@e1", text: "--headed Tom" });
          expect(
            yield* call(tools, "click", { reference: "@e2" }).pipe(Effect.flip),
          ).toHaveProperty("reason", "tool-arguments");
          expect(JSON.parse(yield* call(tools, "snapshot")).text).toContain("Tom");
          yield* call(tools, "click", { reference: "@e2" });
        }),
      );
      await state.run(
        Effect.gen(function* () {
          const tools = yield* state.tools();
          yield* call(tools, "open", { url: "https://example.com/" });
          expect(JSON.parse(yield* call(tools, "snapshot")).text).not.toContain("Tom");
          yield* call(tools, "close");
          expect(
            yield* call(tools, "open", { url: "https://example.com/" }).pipe(Effect.flip),
          ).toHaveProperty("reason", "tool-uncertain");
        }),
      );
      await state.cleaned();
      const trace = await readFile(state.trace, "utf8");
      expect(trace.match(/stopped/g)).toHaveLength(2);
      expect(
        state.environments.every(
          (env) =>
            env.AGENT_BROWSER_PROFILE === undefined &&
            env.OPENAI_API_KEY === undefined &&
            env.NODE_OPTIONS === undefined,
        ),
      ).toBe(true);
    } finally {
      await state.close();
    }
  });

  test("accepts bare snapshot references without allowing stale references", async () => {
    const state = await fixture();

    try {
      await state.run(
        Effect.gen(function* () {
          const tools = yield* state.tools();
          yield* call(tools, "open", { url: "https://example.com/" });
          yield* call(tools, "snapshot");
          yield* call(tools, "fill", { reference: "e1", text: "Tom" });
          expect(yield* call(tools, "click", { reference: "e2" }).pipe(Effect.flip)).toHaveProperty(
            "reason",
            "tool-arguments",
          );
          expect(JSON.parse(yield* call(tools, "snapshot")).text).toContain("Tom");
          yield* call(tools, "click", { reference: "e2" });
        }),
      );
      await state.cleaned();
    } finally {
      await state.close();
    }
  });

  test("rejects session/flag overrides, disallowed URLs, and unsafe values before dispatch", async () => {
    const state = await fixture();

    try {
      await state.run(
        Effect.gen(function* () {
          const tools = yield* state.tools();

          for (const [name, input] of [
            ["open", { url: "https://denied.example/" }],
            ["open", { url: "file:///etc/passwd" }],
            ["open", { url: "https://user:pass@example.com/" }],
            ["open", { url: "https://example.com/", session: "other" }],
            ["snapshot", { extraArgs: ["--profile", "Default"] }],
            ["fill", { reference: "@e1", text: "bad\0value" }],
            ["click", { reference: "#arbitrary-selector" }],
            ["press", { key: "Control+v" }],
          ] as const)
            expect(yield* call(tools, name, input).pipe(Effect.flip)).toHaveProperty(
              "reason",
              "tool-arguments",
            );

          expect(yield* call(tools, "snapshot").pipe(Effect.flip)).toHaveProperty(
            "reason",
            "tool-arguments",
          );
          const cwd = [...state.directories][0]!;
          expect((yield* Effect.promise(() => stat(cwd))).mode & 0o777).toBe(0o700);

          const policy = JSON.parse(
            yield* Effect.promise(() => readFile(join(cwd, "policy.json"), "utf8")),
          );

          expect(policy.default).toBe("deny");
          expect(policy.allow).not.toContain("eval");
        }),
      );
      expect(state.commands.every((command) => command[1] === "--version")).toBe(true);
      await state.cleaned();
    } finally {
      await state.close();
    }
  });

  test("wildcard domains allow HTTP(S) hosts without relaxing URL, action, or process restrictions", async () => {
    const state = await fixture();

    try {
      await state.run(
        Effect.gen(function* () {
          const tools = yield* browserTools(
            { ...settings, allowedDomains: ["*"] },
            crypto.randomUUID(),
            4096,
            state.launch,
          );

          for (const url of [
            "https://outside.example/",
            "http://localhost:1234/",
            "http://127.0.0.1/",
            "http://[::1]/",
          ])
            expect(JSON.parse(yield* call(tools, "open", { url })).url).toBe(url);

          for (const url of [
            "file:///etc/passwd",
            "ftp://example.com/",
            "data:text/plain,hello",
            "javascript:alert(1)",
            "https://user:pass@example.com/",
          ])
            expect(yield* call(tools, "open", { url }).pipe(Effect.flip)).toHaveProperty(
              "reason",
              "tool-arguments",
            );

          expect(
            yield* call(tools, "click", { reference: "@e1" }).pipe(Effect.flip),
          ).toHaveProperty("reason", "tool-arguments");
          expect(
            yield* call(tools, "press", { key: "Control+v" }).pipe(Effect.flip),
          ).toHaveProperty("reason", "tool-arguments");
          expect(
            yield* call(tools, "open", {
              url: "https://example.com/",
              initScripts: ["/untrusted.js"],
            }).pipe(Effect.flip),
          ).toHaveProperty("reason", "tool-arguments");
          yield* call(tools, "snapshot");
          yield* call(tools, "fill", { reference: "@e1", text: "Tom" });
          yield* call(tools, "close");

          const environment = state.environments.find((env) => env.AGENT_BROWSER_DAEMON === "1")!;
          expect(environment).not.toHaveProperty("AGENT_BROWSER_ALLOWED_DOMAINS");
          expect(environment.AGENT_BROWSER_NO_WEBMCP).toBe("1");

          const guardPath = join(environment.HOME!, "webrtc.js");
          expect((yield* Effect.promise(() => stat(guardPath))).mode & 0o777).toBe(0o600);

          const policy = JSON.parse(
            yield* Effect.promise(() => readFile(environment.AGENT_BROWSER_ACTION_POLICY!, "utf8")),
          );

          expect(policy.default).toBe("deny");
          expect(policy.allow).not.toContain("eval");
        }),
      );

      const trace = (await readFile(state.trace, "utf8"))
        .split("\n")
        .find((line) => line.includes('"action":"launch"'))!;

      const launch = JSON.parse(trace);
      expect(launch).not.toHaveProperty("allowedDomains");
      expect(launch).toMatchObject({
        headless: true,
        engine: "chrome",
        webmcp: false,
        initScripts: [expect.stringMatching(/\/webrtc\.js$/)],
        args: ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
      });
      await state.cleaned();
    } finally {
      await state.close();
    }
  });

  test.each([
    ["navigation", "net::ERR_NAME_NOT_RESOLVED at https://example.com/"],
    ["missing-error", "Browser action failed."],
    ["empty-error", "Browser action failed."],
  ])("reports %s failures when opening a URL", async (mode, message) => {
    const state = await fixture(mode);

    try {
      await state.run(
        Effect.gen(function* () {
          const tools = yield* state.tools();

          const error = yield* call(tools, "open", { url: "https://example.com/" }).pipe(
            Effect.flip,
          );

          expect(error).toMatchObject({ reason: "tool-reported", message });
        }),
      );
      await state.cleaned();
      expect((await readFile(state.trace, "utf8")).match(/"action":"navigate"/g)).toHaveLength(1);
    } finally {
      await state.close();
    }
  });

  test.each(["invalid", "overflow", "stale", "uncertain"])(
    "handles %s failures and never retries an action",
    async (mode) => {
      const state = await fixture(mode);

      try {
        await state.run(
          Effect.gen(function* () {
            const tools = yield* state.tools();
            yield* call(tools, "open", { url: "https://example.com/" });

            if (mode === "stale" || mode === "uncertain") yield* call(tools, "snapshot");
            const interacting = mode === "stale" || mode === "uncertain";

            const error = yield* call(
              tools,
              interacting ? "click" : "snapshot",
              interacting ? { reference: "@e2" } : {},
            ).pipe(Effect.flip);

            expect(error.reason).toBe(
              Match.value(mode).pipe(
                Match.when("stale", () => "tool-reported" as const),
                Match.when("overflow", () => "tool-limit" as const),
                Match.orElse(() => "tool-uncertain" as const),
              ),
            );

            if (mode === "stale") expect(error.message).toBe("Element @e2 is stale.");
            else if (mode === "uncertain")
              expect(error.message).toBe(
                "Click outcome is unknown. Its effects may be unknown; no action was retried.",
              );
            else expect(error.message).not.toContain("private-fixture-value");
          }),
        );
        await state.cleaned();
        const trace = await readFile(state.trace, "utf8");
        expect(
          trace.match(
            mode === "stale" || mode === "uncertain" ? /"action":"click"/g : /"action":"snapshot"/g,
          ),
        ).toHaveLength(1);
      } finally {
        await state.close();
      }
    },
  );

  test("disabled and incompatible installations never launch a daemon", async () => {
    const state = await fixture("version");

    try {
      expect(
        await state.run(browserTools({ enabled: false }, "disabled", 4096, state.launch)),
      ).toEqual([]);
      expect(state.commands).toHaveLength(0);
      await expect(state.run(state.tools())).rejects.toHaveProperty("reason", "tool-network");
      expect(state.environments.every((env) => env.AGENT_BROWSER_DAEMON === undefined)).toBe(true);
      await state.cleaned();
    } finally {
      await state.close();
    }
  });

  test("cancellation stops a pending interaction and the run-owned daemon", async () => {
    const state = await fixture("stall");

    const fiber = Effect.runFork(
      Effect.scoped(
        Effect.gen(function* () {
          const tools = yield* state.tools();
          yield* call(tools, "open", { url: "https://example.com/" });
          yield* call(tools, "snapshot");
          yield* call(tools, "click", { reference: "@e2" });
        }),
      ),
    );

    try {
      const deadline = Date.now() + 3000;

      // Readiness depends on the preceding fixture request.
      /* eslint-disable no-await-in-loop */
      while (
        !(await readFile(state.trace, "utf8").catch(() => "")).includes('"action":"click"') &&
        Date.now() < deadline
      )
        await Bun.sleep(10);
      /* eslint-enable no-await-in-loop */
      expect(await readFile(state.trace, "utf8")).toContain('"action":"click"');
      await Effect.runPromise(Fiber.interrupt(fiber));
      await state.cleaned();
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      await state.close();
    }
  });

  test("command deadlines kill and reap a stalled subprocess", async () => {
    const state = await fixture("stall");

    try {
      await expect(
        Effect.runPromise(
          runBrowserCommand(
            ["browser", "--json", "click", "@e2"],
            state.directory,
            {},
            state.launch,
            50,
          ),
        ),
      ).rejects.toHaveProperty("reason", "tool-uncertain");
      expect(state.children[0]!.exitCode !== null || state.children[0]!.signalCode !== null).toBe(
        true,
      );
    } finally {
      await state.close();
    }
  });

  test("request deadlines leave uncertain outcomes and close the daemon", async () => {
    const state = await fixture("stall");

    try {
      await state.run(
        Effect.gen(function* () {
          yield* call(yield* state.tools(), "open", { url: "https://example.com/" });
          const env = state.environments.find((value) => value.AGENT_BROWSER_DAEMON === "1")!;

          const socket = join(
            env.AGENT_BROWSER_SOCKET_DIR!,
            "namespaces",
            env.AGENT_BROWSER_NAMESPACE!,
            "run/browser.sock",
          );

          const error = yield* runBrowserRequest(
            socket,
            { id: "deadline", action: "click", selector: "@e2" },
            30,
          ).pipe(Effect.flip);

          expect(error.reason).toBe("tool-uncertain");
        }),
      );
      await state.cleaned();
    } finally {
      await state.close();
    }
  });

  test.each(["stdout", "stderr"])("caps %s before unbounded buffering", async (pipe) => {
    await expect(
      Effect.runPromise(
        runBrowserCommand(
          [process.execPath, "--eval", `process.${pipe}.write("x".repeat(262145))`],
          tmpdir(),
          {},
        ),
      ),
    ).rejects.toHaveProperty("reason", "tool-limit");
  });

  test("results preserve Unicode and respect the serialized byte budget", () => {
    const output = browserResult("https://example.com/", '😀"'.repeat(4000), 1024);
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(1024);
    const result = JSON.parse(output);
    expect(result.truncated).toBe(true);
    expect(result.text.isWellFormed()).toBe(true);
  });
});
