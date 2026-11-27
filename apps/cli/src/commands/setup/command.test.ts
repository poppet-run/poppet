import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BunServices } from "@effect/platform-bun";
import { GatewayEnvironment, GatewayFetch, GatewayInput } from "@poppet/gateway";
import { CredentialInput, Provider, ProviderConnection, invalidRequest } from "@poppet/provider";
import type { ProviderRegistration } from "@poppet/provider";
import { serveWorker, workerSocketPath } from "@poppet/worker";
import { ConfigProvider, Console, Effect, Layer, Option, Queue, Redacted, Terminal } from "effect";
import type { Cause } from "effect";

import { readChatLine } from "#src/commands/chat/prompt";
import { createCLIContext } from "#src/commands/context";
import { finding } from "#src/commands/doctor/report";
import { gateways } from "#src/commands/gateway/registry";
import { runSetup } from "#src/commands/setup/command";
import type { SetupSection } from "#src/commands/setup/command";
import type { manageWorker } from "#src/commands/worker/service";

const key = (name: string, input?: string, ctrl = false): Terminal.UserInput => ({
  key: { name, ctrl, meta: false, shift: false },
  input: Option.fromUndefinedOr(input),
});

const enter = key("enter");

const answer = (text = "") => (text === "" ? [enter] : [key(text, text), enter]);

const selectAll = [key("space"), enter];

const down = (count: number) => [...Array.from({ length: count }, () => key("down")), enter];

const directories: Array<string> = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

const fixture = async (gatewayIds: ReadonlyArray<string> = ["discord"]) => {
  const directory = await mkdtemp(join(tmpdir(), "poppet-setup-"));
  directories.push(directory);
  const path = join(directory, "config.json");
  const output: Array<string> = [];
  const actions: Array<string> = [];

  const state = {
    connected: false,
    source: "stored",
    logins: 0,
    loginFailures: 0,
    failModels: false,
    failVerify: false,
    verifies: new Array<string>(),
    installed: false,
    active: false,
    managed: true,
    api: true,
    channelError: "",
  };

  const replies = new Map(
    Object.entries({
      "/api/auth.test": { ok: true, team_id: "T123", team: "Home", user: "poppet" },
      "/api/apps.connections.open": { ok: true, url: "wss://example.invalid" },
      "/api/conversations.list": {
        ok: true,
        channels: [
          { id: "C100", name: "general", is_member: true },
          { id: "C200", name: "random", is_member: false },
        ],
      },
      "/api/v10/users/@me": { id: "900", username: "poppet" },
      "/api/v10/oauth2/applications/@me": { owner: { id: "200" } },
      "/api/v10/users/@me/guilds": [{ id: "300", name: "Home" }],
      "/api/v10/guilds/300/channels": [
        { id: "400", name: "general", type: 0 },
        { id: "401", name: "voice", type: 2 },
      ],
      "/telegram/getMe": { ok: true, result: { id: 900, username: "poppet_bot" } },
      "/telegram/getUpdates": {
        ok: true,
        result: [
          {
            update_id: 1,
            message: {
              chat: { id: 100, type: "private", first_name: "Owner" },
              from: { id: 100, is_bot: false, username: "owner" },
            },
          },
          {
            update_id: 2,
            message: {
              chat: { id: -500, type: "supergroup", title: "Family" },
              from: { id: 100, is_bot: false, username: "owner" },
            },
          },
          {
            update_id: 3,
            message: {
              chat: { id: 999, type: "private", username: "stranger" },
              from: { id: 999, is_bot: false, username: "stranger" },
            },
          },
        ],
      },
    }),
  );

  const platform = async (input: string, init: RequestInit) => {
    const url = new URL(input);
    const path = url.pathname.replace(/^\/bot[^/]+/, "/telegram");

    const rejected =
      new Headers(init.headers).get("Authorization")?.endsWith("bad-token") === true ||
      url.pathname.includes("bad-token");

    if (state.channelError !== "" && path === "/api/conversations.list") {
      return Response.json({ ok: false, error: state.channelError });
    }

    if (state.api && !rejected) {
      return Response.json(replies.get(path));
    }

    if (url.hostname === "api.telegram.org") {
      return Response.json(
        { ok: false, error_code: 401, description: "Unauthorized" },
        { status: 401 },
      );
    }

    return url.hostname === "slack.com"
      ? Response.json({ ok: false, error: "invalid_auth" })
      : new Response("{}", { status: 401 });
  };

  const registration = (id: string): ProviderRegistration => ({
    id,
    name: id,
    authentication: { apiKey: true, help: "Test credentials" },
    layer: Layer.merge(
      Layer.succeed(Provider, {
        id,
        models: Effect.suspend(() =>
          state.failModels
            ? Effect.fail(invalidRequest(id, "Catalog unavailable."))
            : Effect.succeed(
                ["first-model", "saved-model"].map((model) => ({
                  provider: id,
                  id: model,
                  name: model,
                  capabilities: {
                    tools: true,
                    images: false,
                    generationSettings: [],
                    contextWindow: null,
                    maxOutputTokens: null,
                  },
                })),
              ),
        ),
        resolve: () => Effect.die("Setup must not run inference"),
      }),
      Layer.succeed(ProviderConnection, {
        status: Effect.sync(() => ({ connected: state.connected, source: state.source })),
        login: () =>
          Effect.gen(function* () {
            if (state.loginFailures > 0) {
              state.loginFailures--;

              return yield* Effect.fail(invalidRequest(id, "Login failed."));
            }

            yield* (yield* CredentialInput).readKey(id);
            state.connected = true;
            state.logins++;

            return "Signed in.";
          }),
        logout: Effect.die("Setup must not log out"),
        verify: (model) =>
          Effect.suspend(() => {
            state.verifies.push(model ?? "default");

            return state.failVerify
              ? Effect.fail(invalidRequest(id, "The model did not call the tool."))
              : Effect.succeed(model ?? "default");
          }),
      }),
    ),
  });

  const worker: typeof manageWorker = (action) => {
    actions.push(action);

    return action === "status" && !state.managed
      ? Effect.succeed(null)
      : Effect.succeed(
          action === "status"
            ? {
                installed: state.installed,
                active: state.active,
                file: "test.plist",
                log: "test.log",
              }
            : "Worker started.",
        );
  };

  const context = createCLIContext(
    [registration("first-provider"), registration("saved-provider")],
    () => Effect.void,
    worker,
    gateways.filter((gateway) => gatewayIds.includes(gateway.id)),
    readChatLine,
    () => Effect.void,
  );

  const run = async (
    steps: ReadonlyArray<ReadonlyArray<Terminal.UserInput>>,
    only: SetupSection | null = null,
  ) => {
    const remaining = [...steps];

    const terminal = Terminal.make({
      columns: Effect.succeed(100),
      rows: Effect.succeed(30),
      size: Effect.die("Setup does not track resizes"),
      readLine: Effect.die("Setup uses prompts"),
      readInput: Effect.gen(function* () {
        const inputs = remaining.shift();

        if (inputs === undefined) {
          return yield* Effect.die("Unexpected setup prompt");
        }

        const queue = yield* Queue.unbounded<Terminal.UserInput, Cause.Done>();
        yield* Queue.offerAll(queue, inputs);
        yield* Queue.end(queue);

        return queue;
      }),
      display: (text) =>
        Effect.sync(() => {
          output.push(text);
        }),
    });

    const result = await Effect.runPromise(
      runSetup(context, only, () =>
        Effect.succeed(finding("worker.service", "skipped", "local", "No installed service.")),
      ).pipe(
        Effect.provideService(Terminal.Terminal, terminal),
        Effect.provideService(GatewayFetch, platform),
        Effect.provideService(CredentialInput, {
          readKey: () => Effect.succeed(Redacted.make("provider-secret")),
          readLine: () => Effect.never,
        }),
        Effect.provideService(Console.Console, {
          ...console,
          log: (...values) => {
            output.push(values.join(" "));
          },
          error: (...values) => {
            output.push(values.join(" "));
          },
        }),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnv({ env: { POPPET_DATA_DIR: directory } }),
        ),
        Effect.provide(BunServices.layer),
        Effect.match({ onSuccess: () => null, onFailure: (error) => error.message }),
      ),
    );

    expect(remaining).toEqual([]);

    return result;
  };

  return { directory, path, state, actions, output, run };
};

const saveDiscord = (directory: string) =>
  Effect.runPromise(
    gateways[0]!
      .setup([
        "setup",
        "--owner-id",
        "200",
        "--guild-id",
        "300",
        "--home-channel-id",
        "400",
        "--bot-token",
        "saved-secret",
      ])
      .pipe(
        Effect.provideService(GatewayEnvironment, { dataDirectory: directory }),
        Effect.provideService(GatewayInput, {
          readSecret: Effect.die("Setup must not read stdin"),
        }),
      ),
  );

describe("setup", () => {
  test("fresh setup authenticates, filters models, saves Discord privately, and installs the worker only when chosen", async () => {
    const f = await fixture();
    expect(
      await f.run([
        answer(),
        answer("saved"),
        answer(),
        selectAll,
        answer("discord-secret"),
        answer(),
        answer(),
        answer(),
        answer(),
        answer("y"),
      ]),
    ).toBeNull();
    expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual({
      provider: "first-provider",
      model: "saved-model",
      discord: { ownerId: "200", guildId: "300", homeChannelId: "400" },
    });
    const credentials = join(f.directory, "channels/discord.json");
    expect(JSON.parse(await readFile(credentials, "utf8"))).toEqual({
      token: "discord-secret",
    });
    expect((await stat(credentials)).mode & 0o777).toBe(0o600);
    expect(f.state.logins).toBe(1);
    expect(f.actions).toEqual(["status", "install"]);
    expect(f.output.join("\n")).toContain("*".repeat("discord-secret".length));
    expect(f.output.join("\n")).not.toContain("discord-secret");
    expect(f.output.join("\n")).not.toContain("provider-secret");
    expect(await readdir(f.directory)).not.toContain("store");
    const finish = f.output.slice(f.output.findIndex((line) => line.includes("Setup check")));
    expect(finish.join("\n")).toContain("- Worker connection: The worker is not responding.");
    expect(finish.join("\n")).toContain(
      "  Discord        Mention the bot in a channel to start a thread",
    );
  });

  test("reruns default to the saved provider and model and preserve skipped Discord and unrelated settings", async () => {
    const f = await fixture();
    f.state.connected = true;
    f.state.active = true;
    f.state.installed = true;

    const saved = {
      provider: "saved-provider",
      model: "saved-model",
      tasks: { catchUpMinutes: 15 },
      chat: { outputTokens: 1000 },
      discord: { ownerId: "200", guildId: "300", homeChannelId: "400" },
    };

    await writeFile(f.path, JSON.stringify(saved));
    expect(
      await f.run([answer(), answer(), answer(), answer(), answer(), answer(), answer(), answer()]),
    ).toBeNull();
    expect(f.output.join("\n")).toContain(
      [
        "  Provider  saved-provider, model saved-model",
        "  Gateways  Discord not configured",
        "  Worker    installed and running",
      ].join("\n"),
    );
    expect(f.output.join("\n")).toContain("Step 3 of 3: Background worker");
    expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual(saved);
    expect(f.state.logins).toBe(0);
    expect(f.actions).toEqual(["status"]);
    expect(f.output.join("\n")).toContain("Restart the worker when ready");
  });

  test.each([
    ["only the gateways", 2, [answer(), answer(), answer()], ["status"]],
    ["only the worker", 3, [answer("y")], ["status", "restart"]],
    ["nothing", 4, [], ["status"]],
  ] as const)(
    "a rerun can change %s without touching the provider",
    async (_label, downs, rest, actions) => {
      const f = await fixture();
      f.state.installed = true;
      f.state.active = true;
      const saved = { provider: "saved-provider", model: "saved-model" };
      await writeFile(f.path, JSON.stringify(saved));
      expect(await f.run([down(downs), ...rest])).toBeNull();
      expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual(saved);
      expect(f.state.logins).toBe(0);
      expect(f.actions).toEqual([...actions]);
      expect(f.output.join("\n")).toContain("Setup check");
    },
  );

  test("review lists pending changes and can revise or discard them before anything is saved", async () => {
    const f = await fixture();
    expect(
      await f.run([
        answer(),
        answer(),
        answer(),
        selectAll,
        answer("discord-secret"),
        answer(),
        answer(),
        answer(),
        down(1),
        answer(),
        answer(),
        answer("saved"),
        answer(),
        down(3),
      ]),
    ).toContain("Setup cancelled without saving configuration");
    const output = f.output.join("\n");
    expect(output).toContain("Provider  first-provider, model first-model");
    expect(output).toContain("Provider  first-provider, model saved-model");
    expect(output).toContain(
      "Discord   owner 200, server 300, home channel 400, bot token replaced, checked as poppet",
    );
    expect(await readdir(f.directory)).not.toContain("config.json");
    expect(await readdir(f.directory)).not.toContain("channels");
    expect(f.actions).toEqual(["status"]);
  });

  test.each(["passes", "fails", "is declined"] as const)(
    "when the model test request %s, setup reports it and keeps the chosen model",
    async (outcome) => {
      const f = await fixture([]);
      f.state.failVerify = outcome === "fails";
      expect(
        await f.run([
          answer(),
          answer(),
          answer(outcome === "is declined" ? "n" : ""),
          ...(outcome === "fails" ? [answer()] : []),
          answer(),
          answer(),
        ]),
      ).toBeNull();
      expect(JSON.parse(await readFile(f.path, "utf8")).model).toBe("first-model");
      expect(f.state.verifies).toEqual(outcome === "is declined" ? [] : ["first-model"]);
      const output = f.output.join("\n");
      expect(output.includes("first-model answered the test request.")).toBe(outcome === "passes");
      expect(output.includes("The test request failed: The model did not call the tool.")).toBe(
        outcome === "fails",
      );
    },
  );

  test("setup provider skips the rerun menu and the gateways", async () => {
    const f = await fixture();
    await writeFile(f.path, JSON.stringify({ provider: "saved-provider", model: "saved-model" }));
    expect(
      await f.run([answer(), answer("first"), answer(), answer(), answer()], "provider"),
    ).toBeNull();
    expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual({
      provider: "saved-provider",
      model: "first-model",
    });
    expect(f.output.join("\n")).toContain("Step 2 of 2: Background worker");
  });

  test("when saved gateway settings are unreadable, other steps still run and the gateway step replaces them", async () => {
    const f = await fixture();
    await writeFile(f.path, JSON.stringify({ provider: "saved-provider", model: "saved-model" }));
    await mkdir(join(f.directory, "channels"), { mode: 0o700 });
    const credentials = join(f.directory, "channels/discord.json");
    await writeFile(credentials, "not json", { mode: 0o600 });
    expect(
      await f.run([answer(), answer("first"), answer(), answer(), answer()], "provider"),
    ).toBeNull();
    expect(f.output.join("\n")).toContain("Gateways  Discord unreadable");

    expect(
      await f.run(
        [
          [key("down"), key("down"), key("space"), enter],
          answer("discord-secret"),
          answer(),
          answer(),
          answer(),
          answer(),
          answer(),
        ],
        "gateways",
      ),
    ).toBeNull();
    expect(f.output.join("\n")).toContain(
      "Setup cannot read the saved Discord settings and will replace them.",
    );
    expect(JSON.parse(await readFile(credentials, "utf8"))).toEqual({ token: "discord-secret" });
  });

  test("setup gateways fails clearly when no gateway supports interactive setup", async () => {
    const f = await fixture([]);
    expect(await f.run([], "gateways")).toContain(
      "No installed gateway supports interactive setup",
    );
  });

  test("editing Discord without a live check keeps the saved token and validates typed IDs", async () => {
    const f = await fixture();
    f.state.connected = true;
    f.state.api = false;
    await saveDiscord(f.directory);
    expect(
      await f.run([
        answer(),
        answer(),
        answer(),
        answer(),
        answer(),
        answer(),
        down(1),
        answer(),
        answer(),
        [
          key("u", undefined, true),
          ...answer("invalid"),
          key("u", undefined, true),
          ...answer("500"),
        ],
        answer(),
        answer(),
      ]),
    ).toBeNull();
    expect(f.output.join("\n")).toContain("Discord rejected the bot token.");
    expect(f.output.join("\n")).toContain("not checked");
    expect(JSON.parse(await readFile(f.path, "utf8")).discord.homeChannelId).toBe("500");
    expect(
      JSON.parse(await readFile(join(f.directory, "channels/discord.json"), "utf8")).token,
    ).toBe("saved-secret");
    expect(f.output.join("\n")).toContain("Enter a numeric Discord ID");
    expect(f.output.join("\n")).not.toContain("saved-secret");
  });

  test.each(["retry", "skip"] as const)(
    "a rejected Discord token can be entered again or the gateway skipped (%s)",
    async (choice) => {
      const f = await fixture();

      const after =
        choice === "retry"
          ? [answer(), answer("discord-secret"), answer(), answer(), answer(), answer(), answer()]
          : [down(2), answer(), answer()];

      expect(
        await f.run([answer(), answer(), answer(), selectAll, answer("bad-token"), ...after]),
      ).toBeNull();
      expect(f.output.join("\n")).toContain("Discord rejected the bot token.");
      const config = JSON.parse(await readFile(f.path, "utf8"));
      expect(config.discord?.homeChannelId).toBe(choice === "retry" ? "400" : undefined);
      expect(await Bun.file(join(f.directory, "channels/discord.json")).exists()).toBe(
        choice === "retry",
      );
    },
  );

  test.each([true, false])(
    "deselecting configured Discord removes its settings only when confirmed (%p)",
    async (remove) => {
      const f = await fixture();
      f.state.connected = true;
      await saveDiscord(f.directory);
      expect(
        await f.run([
          answer(),
          answer(),
          answer(),
          answer(),
          selectAll,
          answer(remove ? "y" : ""),
          answer(),
          answer(),
        ]),
      ).toBeNull();
      const config = JSON.parse(await readFile(f.path, "utf8"));
      const credentials = join(f.directory, "channels/discord.json");
      expect(config.discord === undefined).toBe(remove);
      expect(await Bun.file(credentials).exists()).toBe(!remove);
      expect(f.output.join("\n")).toContain(
        remove ? "Removed Discord settings" : "Discord configuration left unchanged.",
      );
    },
  );

  test.each(["cancel", "discord-cancel", "login", "catalog"])(
    "%s stops setup without changing existing configuration",
    async (failure) => {
      const f = await fixture();

      const saved =
        '{"provider":"saved-provider","model":"saved-model","tasks":{"catchUpMinutes":15}}\n';

      await writeFile(f.path, saved);
      f.state.loginFailures = failure === "login" ? 1 : 0;
      f.state.failModels = failure === "catalog";

      const steps = {
        cancel: [answer(), answer(), []],
        "discord-cancel": [answer(), answer(), answer(), answer(), selectAll, []],
        login: [answer(), answer(), down(2)],
        catalog: [answer(), answer(), down(2)],
      };

      const result = await f.run(steps[failure]);
      expect(result).toContain(
        {
          cancel: "Setup cancelled",
          "discord-cancel": "Setup cancelled",
          login: "Login failed",
          catalog: "Catalog unavailable",
        }[failure],
      );
      expect(await readFile(f.path, "utf8")).toBe(saved);
      expect(f.actions).toEqual(["status"]);
      expect(f.state.logins).toBe(failure === "login" ? 0 : 1);
      expect(f.output.join("\n")).toContain("Completed steps above remain saved");
    },
  );

  test("broken configuration fails before prompts, authentication, or writes", async () => {
    const f = await fixture();
    await writeFile(f.path, "broken config");
    expect(await f.run([])).not.toBeNull();
    expect(await readFile(f.path, "utf8")).toBe("broken config");
    expect(f.state.logins).toBe(0);
    expect(f.actions).toEqual([]);
  });

  test("a failed sign-in can be retried without restarting setup", async () => {
    const f = await fixture([]);
    f.state.loginFailures = 1;
    expect(await f.run([answer(), answer(), answer(), answer(), answer(), answer()])).toBeNull();
    expect(f.output.join("\n")).toContain("Login failed");
    expect(f.state.logins).toBe(1);
    expect(JSON.parse(await readFile(f.path, "utf8")).provider).toBe("first-provider");
  });

  test("environment credentials still require login before worker setup", async () => {
    const f = await fixture();
    f.state.connected = true;
    f.state.source = "environment";
    expect(await f.run([answer(), answer(), answer(), answer(), answer(), answer()])).toBeNull();
    expect(f.state.logins).toBe(1);
    expect(f.actions).toEqual(["status"]);
  });

  test("cancelling worker startup leaves the completed configuration saved", async () => {
    const f = await fixture();
    expect(await f.run([answer(), answer(), answer(), answer(), answer(), []])).toContain(
      "Setup cancelled",
    );
    expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual({
      provider: "first-provider",
      model: "first-model",
    });
    expect(f.actions).toEqual(["status"]);
    expect(f.output.join("\n")).toContain("Saved provider first-provider");
  });

  test("a running foreground worker prevents installing a second worker", async () => {
    const f = await fixture();
    await mkdir(join(f.directory, "store"), { mode: 0o700 });
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* serveWorker(workerSocketPath(f.directory), (_request, body) => {
            expect(body).toEqual({ action: "status" });

            return Effect.succeed(Response.json({ ok: true, value: { running: true } }));
          });

          const result = yield* Effect.promise(() =>
            f.run([answer(), answer(), answer(), answer(), answer()]),
          );

          expect(result).toBeNull();
        }),
      ),
    );
    expect(f.actions).toEqual(["status"]);
    expect(f.output.join("\n")).toContain("A foreground worker is running");
  });

  test.each(["restart", "start", "foreground"])(
    "when setup finds worker state %s, uses the matching lifecycle action",
    async (mode) => {
      const f = await fixture();
      f.state.connected = true;
      f.state.installed = true;
      f.state.active = mode === "restart";
      f.state.managed = mode !== "foreground";
      expect(
        await f.run([
          answer(),
          answer("y"),
          answer(),
          answer(),
          answer(),
          answer(),
          ...(mode === "foreground" ? [] : [answer("y")]),
        ]),
      ).toBeNull();
      expect(f.state.logins).toBe(1);

      const expectedActions = {
        foreground: ["status"],
        restart: ["status", "restart"],
        start: ["status", "start"],
      };

      expect(f.actions).toEqual(expectedActions[mode]);

      if (mode === "foreground") {
        expect(f.output.join("\n")).toContain("poppet worker run");
      }
    },
  );
});

test("Slack setup checks both tokens, takes the workspace from the token, and offers member channels", async () => {
  const f = await fixture(["slack"]);
  expect(
    await f.run([
      answer(),
      answer(),
      answer(),
      selectAll,
      answer("xoxb-secret"),
      answer("xapp-secret"),
      answer("U100"),
      answer(),
      answer(),
      answer(),
    ]),
  ).toBeNull();
  expect(JSON.parse(await readFile(f.path, "utf8")).slack).toEqual({
    ownerId: "U100",
    teamId: "T123",
    homeChannelId: "C100",
  });
  const output = f.output.join("\n");
  expect(output).toContain("Slack accepted the bot token for poppet in Home (T123).");
  expect(output).toContain("#general (C100)");
  expect(output).not.toContain("#random");
  expect(output).not.toContain("xoxb-secret");
});

test("Telegram setup checks the token and offers the owner and chats from recent messages", async () => {
  const f = await fixture(["telegram"]);
  expect(
    await f.run([
      answer(),
      answer(),
      answer(),
      selectAll,
      answer("123:secret"),
      answer(),
      down(1),
      answer(),
      answer(),
      answer(),
    ]),
  ).toBeNull();
  expect(JSON.parse(await readFile(join(f.directory, "channels/telegram.json"), "utf8"))).toEqual({
    ownerId: "100",
    chatId: "-500",
    homeConversationId: "-500",
    token: "123:secret",
  });
  const output = f.output.join("\n");
  expect(output).toContain("Telegram accepted the token for @poppet_bot.");
  expect(output).toContain("Private chat with Owner (100)");
  expect(output).not.toContain("Private chat with @stranger");
  expect(output).not.toContain("123:secret");
});

test.each(["skip", "continue"] as const)(
  "a rejected Telegram token can be skipped or kept unchecked with typed IDs (%s)",
  async (choice) => {
    const f = await fixture(["telegram"]);
    const typed = [answer("100"), answer(), answer(), answer()];
    expect(
      await f.run([
        answer(),
        answer(),
        answer(),
        selectAll,
        answer("1:bad-token"),
        choice === "skip" ? down(2) : down(1),
        ...(choice === "skip" ? [answer(), answer()] : typed),
      ]),
    ).toBeNull();

    const saved = await readFile(join(f.directory, "channels/telegram.json"), "utf8").catch(
      () => null,
    );

    expect(saved === null ? null : JSON.parse(saved)).toEqual(
      choice === "skip"
        ? null
        : { ownerId: "100", chatId: "100", homeConversationId: "100", token: "1:bad-token" },
    );
    expect(f.output.join("\n")).toContain("Telegram rejected the bot token.");
  },
);

test("when Slack refuses the channel list, setup reports the refusal and asks for the channel ID", async () => {
  const f = await fixture(["slack"]);
  f.state.channelError = "missing_scope";
  expect(
    await f.run([
      answer(),
      answer(),
      answer(),
      selectAll,
      answer("xoxb-secret"),
      answer("xapp-secret"),
      answer("U100"),
      answer("C300"),
      answer(),
      answer(),
    ]),
  ).toBeNull();
  expect(JSON.parse(await readFile(f.path, "utf8")).slack.homeChannelId).toBe("C300");
  const output = f.output.join("\n");
  expect(output).toContain(
    "Slack refused conversations.list with missing_scope. Check the token and the app's scopes. Enter the home channel ID instead.",
  );
  expect(output).not.toContain("/invite");
});

test("setup offers both bundled channels in one list and preserves skipped configuration", async () => {
  const f = await fixture(["discord", "slack"]);
  expect(await f.run([answer(), answer(), answer(), answer(), answer(), answer()])).toBeNull();
  expect(f.output.join("\n")).toContain("Slack");
  expect(f.output.join("\n")).toContain("Discord configuration left unchanged.");
  expect(f.output.join("\n")).toContain("Slack configuration left unchanged.");
});
