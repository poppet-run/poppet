import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { AgentError } from "@poppet/agent";
import {
  ChannelEnvironment,
  ChannelError,
  MessagingChannel,
  type ChannelRegistration,
  type IncomingMessage,
} from "@poppet/gateway";
import {
  Provider,
  ProviderConnection,
  invalidRequest,
  type ModelDescription,
  type ModelRequest,
  type ProviderRegistration,
} from "@poppet/provider";
import { requestWorker, workerSocketPath } from "@poppet/worker";
import {
  ConfigProvider,
  Console,
  Effect,
  Fiber,
  Layer,
  ManagedRuntime,
  Queue,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";

import { readChatLine } from "#src/chat-prompt";
import { makeCLI } from "#src/cli";
import { openWorkerLog } from "#src/worker-log";

const description: ModelDescription = {
  provider: "chat-provider",
  id: "chat-model",
  name: "Chat model",
  capabilities: {
    tools: false,
    generationSettings: [],
    contextWindow: null,
    maxOutputTokens: null,
  },
};

const fixture = async (registeredChannels?: ReadonlyArray<ChannelRegistration>) => {
  const directory = await mkdtemp(join(tmpdir(), "poppet-chat-cli-"));

  const defaults = {
    POPPET_PROVIDER: "chat-provider",
    POPPET_MODEL: "chat-model",
    POPPET_DATA_DIR: directory,
    POPPET_CONTEXT_BYTES: "65536",
    POPPET_HISTORY_TURNS: "20",
    POPPET_OUTPUT_TOKENS: "2048",
    POPPET_MODEL_TURNS: "8",
    POPPET_TOOL_CALLS: "16",
    POPPET_TOOL_BYTES: "16384",
    POPPET_LOG_REASONING: "false",
    POPPET_LOG_TIMINGS: "false",
  };

  const environment: Partial<typeof defaults> = defaults;

  const requests: ModelRequest[] = [];
  const titleRequests: ModelRequest[] = [];
  const lines: string[] = [];
  const errors: string[] = [];
  const chunks: string[] = [];
  const thinkingChunks: string[] = [];
  const outputEvents: string[] = [];
  const clock = ManagedRuntime.make(TestClock.layer());
  await clock.runPromise(TestClock.setTime(Date.now()));

  // SAFETY: these mutable fixture controls accept only the declared action literals and string IDs.
  const state = {
    open: false,
    // Chat runs and optional session naming can hold provider scopes at the same time.
    openScopes: 0,
    built: 0,
    writeFails: false,
    useTools: false,
    taskAction: null as "create" | "list" | "show" | "pause" | "resume" | null,
    taskId: null as string | null,
    hold: false,
    failNext: false,
    active: 0,
    peak: 0,
    reasoning: "",
  };

  const provider = Layer.effect(
    Provider,
    Effect.acquireRelease(
      Effect.sync(() => {
        state.openScopes++;
        state.open = true;
        state.built++;

        return {
          id: description.provider,
          models: Effect.succeed([description]),
          resolve: (id: string) =>
            id !== description.id
              ? Effect.fail(invalidRequest(description.provider, "Unknown model"))
              : Effect.succeed({
                  description: state.useTools
                    ? { ...description, capabilities: { ...description.capabilities, tools: true } }
                    : description,
                  stream: (request: ModelRequest) => {
                    if (request.settings.toolChoice === "none") {
                      titleRequests.push(request);

                      return Stream.make({
                        type: "completed" as const,
                        response: {
                          output: [{ type: "text" as const, text: "A saved conversation title" }],
                          continuation: {
                            version: 1 as const,
                            provider: description.provider,
                            model: description.id,
                            data: {},
                          },
                          finishReason: "stop" as const,
                          usage: { inputTokens: 10, outputTokens: 5 },
                        },
                      });
                    }

                    const completed = Stream.fromEffect(
                      Effect.gen(function* () {
                        expect(state.open).toBe(true);
                        requests.push(request);
                        state.active++;
                        state.peak = Math.max(state.peak, state.active);

                        while (state.hold) yield* Effect.sleep("5 millis");

                        if (state.failNext) {
                          state.failNext = false;

                          return yield* Effect.fail(
                            invalidRequest(description.provider, "Fixture request failed"),
                          );
                        }

                        const save =
                          state.useTools &&
                          !request.messages.some((message) => message.role === "tool");

                        const taskCall =
                          state.taskAction === null
                            ? null
                            : {
                                type: "tool-call" as const,
                                callId: "task",
                                name: "manage_tasks",
                                namespace: "poppet_tasks",
                                arguments: JSON.stringify({
                                  action: state.taskAction,
                                  id:
                                    state.taskAction === "create" || state.taskAction === "list"
                                      ? null
                                      : state.taskId,
                                  name: state.taskAction === "create" ? "Chat summary" : null,
                                  prompt:
                                    state.taskAction === "create"
                                      ? "Summarize recent conversations"
                                      : null,
                                  schedule:
                                    state.taskAction === "create"
                                      ? {
                                          type: "once",
                                          at: new Date(Date.now() + 3600000).toISOString(),
                                        }
                                      : null,
                                  delivery: state.taskAction === "create" ? "local" : null,
                                  skill: null,
                                  after: null,
                                  revision: null,
                                  target: null,
                                  until: null,
                                }),
                              };

                        return {
                          type: "completed" as const,
                          response: {
                            output: save
                              ? [
                                  taskCall ?? {
                                    type: "tool-call" as const,
                                    callId: "save",
                                    name: "memory",
                                    namespace: "poppet_memory",
                                    arguments:
                                      '{"action":"remember","key":"answer.style","value":"Keep answers concise"}',
                                  },
                                ]
                              : [{ type: "text" as const, text: "Answer" }],
                            continuation: {
                              version: 1 as const,
                              provider: description.provider,
                              model: description.id,
                              data: { secretOpaqueState: "retain privately" },
                            },
                            finishReason: save ? ("tool-calls" as const) : ("stop" as const),
                            usage: null,
                          },
                        };
                      }),
                    ).pipe(
                      Stream.onExit(() =>
                        Effect.sync(() => {
                          state.active--;
                        }),
                      ),
                    );

                    const reply = state.useTools
                      ? completed
                      : Stream.concat(
                          Stream.make({ type: "text-delta" as const, text: "An" }),
                          completed,
                        );

                    return Stream.concat(
                      Stream.make({ type: "reasoning-delta" as const, text: state.reasoning }),
                      reply,
                    );
                  },
                }),
        };
      }),
      () =>
        Effect.sync(() => {
          state.openScopes--;
          state.open = state.openScopes > 0;
        }),
    ),
  );

  const connection = Layer.succeed(ProviderConnection, {
    login: () => Effect.succeed("Connected"),
    status: Effect.succeed({ connected: true }),
    logout: Effect.succeed("Disconnected"),
    verify: () => Effect.succeed(description.id),
  });

  const registration: ProviderRegistration = {
    id: description.provider,
    name: "Chat provider",
    authentication: { apiKey: false, help: "Test" },
    layer: Layer.merge(provider, connection),
  };

  const unused: ProviderRegistration = {
    ...registration,
    id: "unused-provider",
    layer: Layer.merge(
      Layer.effect(Provider, Effect.die("Unselected provider was built")),
      connection,
    ),
  };

  const write = (text: string) =>
    state.writeFails
      ? Effect.fail(new AgentError({ reason: "interrupted", message: "Output closed" }))
      : Effect.sync(() => {
          chunks.push(text);
          outputEvents.push(`answer:${text}`);
        });

  const output: Console.Console = {
    ...console,
    log: (...values) => {
      lines.push(values.join(" "));
    },
    error: (...values) => {
      errors.push(stripVTControlCharacters(values.join(" ")));
    },
  };

  const program = (args: ReadonlyArray<string>, read = readChatLine, consoleOutput = output) =>
    makeCLI(
      [unused, registration],
      write,
      (action) => {
        expect(action).toBe("status");

        return Effect.succeed(null);
      },
      registeredChannels,
      read,
      (text) =>
        Effect.sync(() => {
          thinkingChunks.push(text);
          outputEvents.push(`thinking:${text}`);
        }),
    )(args).pipe(
      Effect.provideService(Console.Console, consoleOutput),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv({ env: environment, preserveEmptyStrings: true }),
      ),
    );

  return {
    directory,
    environment,
    requests,
    titleRequests,
    lines,
    errors,
    chunks,
    thinkingChunks,
    outputEvents,
    state,
    clock,
    program,
    invoke: (args: ReadonlyArray<string>) => Effect.runPromise(program(args)),
    startWorker: async (mode: "all" | "tasks" | "gateway" = "all", consoleOutput = output) => {
      const args =
        mode === "gateway"
          ? ["gateway", "work"]
          : ["worker", "run", ...(mode === "tasks" ? ["--tasks-only"] : [])];

      const worker = clock.runFork(program(args, readChatLine, consoleOutput));

      try {
        await Effect.runPromise(
          Effect.gen(function* () {
            while (!lines.some((line) => line.includes("Worker running.")))
              yield* Effect.sleep("5 millis");
          }).pipe(Effect.timeout("2 seconds")),
        );
      } catch (error) {
        await Effect.runPromise(Fiber.interrupt(worker));
        throw error;
      }

      return worker;
    },
    close: async () => {
      await clock.dispose();

      await rm(directory, { recursive: true, force: true });
    },
  };
};

const exampleChannel = (id: string) => {
  const incoming = Effect.runSync(Queue.make<IncomingMessage>());
  const sent: string[] = [];
  const replies = Effect.runSync(Queue.make<string>());
  const state = { configured: false, built: 0, closed: 0, directory: "", sent };

  const registration: ChannelRegistration = {
    id,
    name: id,
    setupHelp: "setup",
    setup: (args) =>
      Effect.gen(function* () {
        expect(args).toEqual(["setup"]);
        state.directory = (yield* ChannelEnvironment).dataDirectory;
        state.configured = true;

        return `${id} configured`;
      }),
    load: Effect.gen(function* () {
      const environment = yield* ChannelEnvironment;

      if (!state.configured) return null;
      expect(environment.dataDirectory).toBe(state.directory);

      return Layer.effect(
        MessagingChannel,
        Effect.acquireRelease(
          Effect.sync(() => {
            state.built++;

            return {
              id,
              accountId: "bot",
              policy: { ownerId: "owner", scopeId: "guild", parentIds: ["parent"] },
              messages: Stream.fromQueue(incoming),
              conversation: (message) => Effect.succeed(message.conversationId ?? "thread"),
              checkAccess: () => Effect.void,
              typing: () => Effect.void,
              mark: () => Effect.void,
              send: (_conversation, text) =>
                Effect.gen(function* () {
                  state.sent.push(text);
                  yield* Queue.offer(replies, text);

                  return "sent";
                }),
              status: Effect.succeed({ connected: true }),
              textLimit: 2000,
            } satisfies MessagingChannel["Service"];
          }),
          () =>
            Effect.sync(() => {
              state.closed++;
            }),
        ),
      );
    }),
  };

  return { registration, state, incoming, replies };
};

describe("chat.ts", () => {
  test.each(["local", "worker"])(
    "when %s chat manages tasks, uses the current selection and saves each state change",
    async (mode) => {
      const chat = await fixture();
      let worker: Awaited<ReturnType<typeof chat.startWorker>> | null = null;
      chat.state.useTools = true;
      chat.state.taskAction = "create";

      try {
        if (mode === "worker") worker = await chat.startWorker();
        await chat.invoke(["chat", "new", "Create a local summary task"]);
        await chat.invoke(["tasks", "list"]);
        const task = JSON.parse(chat.lines.at(-1)!)[0];
        expect(task).toMatchObject({
          name: "Chat summary",
          prompt: "Summarize recent conversations",
          provider: description.provider,
          model: description.id,
          workload: "assistant",
          destination: null,
        });
        chat.state.taskId = task.id;

        await Array.fromAsync(
          [
            ["show", 0],
            ["pause", 1],
            ["resume", 0],
            ["list", 0],
          ] as const,
          async ([action, paused]) => {
            chat.state.taskAction = action;
            await chat.invoke(["chat", "new", `${action} the saved task`]);
            expect(chat.requests.at(-1)?.tools).toContainEqual(
              expect.objectContaining({ name: "manage_tasks", namespace: "poppet_tasks" }),
            );
            const reply = chat.requests.at(-1)?.messages.at(-1);

            if (reply?.role !== "tool") throw new Error("Missing task tool reply");
            expect(JSON.parse(reply.output)).toMatchObject(
              action === "list"
                ? { tasks: [{ id: task.id, name: task.name, paused }] }
                : { task: { id: task.id, name: task.name, paused } },
            );

            await chat.invoke(["tasks", "show", task.id]);
            expect(JSON.parse(chat.lines.at(-1)!)).toMatchObject({ task: { id: task.id, paused } });
          },
        );
      } finally {
        if (worker !== null) await Effect.runPromise(Fiber.interrupt(worker));
        await chat.close();
      }
    },
  );

  test.each([
    { mode: "local", enabled: false },
    { mode: "local", enabled: true },
    { mode: "worker", enabled: false },
    { mode: "worker", enabled: true },
  ])(
    "when $mode thinking is enabled=$enabled, streams only the permitted interactive output",
    async ({ mode, enabled }) => {
      const chat = await fixture();
      const workerLogs: string[] = [];
      let worker: Awaited<ReturnType<typeof chat.startWorker>> | null = null;
      chat.environment.POPPET_LOG_REASONING = String(enabled);
      chat.state.reasoning = "Checking the notes.";

      try {
        if (mode === "worker")
          worker = await chat.startWorker("all", {
            ...console,
            log: (...values) => {
              chat.lines.push(values.join(" "));
            },
            error: (...values) => {
              workerLogs.push(stripVTControlCharacters(values.join(" ")));
            },
          });

        const input = ["First", "Second", "/exit"];
        await Effect.runPromise(
          chat.program(
            ["chat", "interactive"],
            Effect.sync(() => input.shift() ?? null),
          ),
        );

        expect(chat.chunks.join("")).toBe("Answer\nAnswer\n");
        expect(chat.thinkingChunks).toEqual(
          enabled
            ? [
                "Thinking:\n",
                chat.state.reasoning,
                "\n\n",
                "Thinking:\n",
                chat.state.reasoning,
                "\n\n",
              ]
            : [],
        );
        expect(chat.errors.some((line) => line.includes("Thinking session="))).toBe(false);
        expect(workerLogs.filter((line) => line.includes("Thinking session="))).toHaveLength(
          mode === "worker" && enabled ? 2 : 0,
        );

        if (enabled)
          expect(chat.outputEvents.indexOf(`thinking:${chat.state.reasoning}`)).toBeLessThan(
            chat.outputEvents.indexOf("answer:An"),
          );
      } finally {
        if (worker !== null) await Effect.runPromise(Fiber.interrupt(worker));
        await chat.close();
      }
    },
  );

  test.each(["local", "worker"])(
    "when the %s answer is pending, streams chat new thinking immediately",
    async (mode) => {
      const chat = await fixture();
      let worker: Awaited<ReturnType<typeof chat.startWorker>> | null = null;
      let request: Fiber.Fiber<void, unknown> | null = null;
      chat.environment.POPPET_LOG_REASONING = "true";
      chat.state.reasoning = "Checking the notes.";
      chat.state.hold = true;
      chat.state.useTools = true;

      try {
        if (mode === "worker") worker = await chat.startWorker();
        request = Effect.runFork(chat.program(["chat", "new", "Hello"]));
        await Effect.runPromise(
          Effect.gen(function* () {
            while (!chat.thinkingChunks.includes(chat.state.reasoning))
              yield* Effect.sleep("5 millis");
          }).pipe(Effect.timeout("2 seconds")),
        );
        expect(chat.thinkingChunks).toEqual(["Thinking:\n", chat.state.reasoning]);
        expect(chat.chunks).toEqual([]);
        chat.state.hold = false;
        await chat.clock.runPromise(TestClock.adjust("5 millis"));
        await Effect.runPromise(Fiber.join(request));
        expect(chat.thinkingChunks).toEqual([
          "Thinking:\n",
          chat.state.reasoning,
          "\n\n",
          "Thinking:\n",
          chat.state.reasoning,
          "\n\n",
        ]);
        expect(chat.chunks.join("")).toBe("Answer\n");
      } finally {
        if (request !== null) await Effect.runPromise(Fiber.interrupt(request));

        if (worker !== null) await Effect.runPromise(Fiber.interrupt(worker));
        await chat.close();
      }
    },
  );

  test("when reasoning is streamed, sends no duplicate diagnostic copy to the client", async () => {
    const chat = await fixture();
    chat.environment.POPPET_LOG_REASONING = "true";
    chat.state.reasoning = "Checking the notes.";
    const worker = await chat.startWorker();

    try {
      const response = await requestWorker(
        workerSocketPath(chat.directory),
        "/v1/commands",
        {
          kind: "chat",
          command: {
            action: "new",
            text: "Hello",
            provider: description.provider,
            model: description.id,
            workload: "assistant",
          },
          streamReasoning: true,
        },
        AbortSignal.timeout(5000),
      );

      expect(response?.ok).toBe(true);

      const frames = (await response!.text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));

      expect(frames).toContainEqual({ type: "reasoning-delta", text: chat.state.reasoning });
      expect(frames).not.toContainEqual(
        expect.objectContaining({
          type: "stderr",
          text: expect.stringContaining("Thinking session="),
        }),
      );
      expect(frames.at(-1)).toEqual({ type: "done" });
      expect(chat.errors.filter((line) => line.includes("Thinking session="))).toHaveLength(1);
    } finally {
      await Effect.runPromise(Fiber.interrupt(worker));
      await chat.close();
    }
  });

  test.each(["local", "worker"])(
    "when tools run through %s execution, separates interactive thinking between model turns",
    async (mode) => {
      const chat = await fixture();
      let worker: Awaited<ReturnType<typeof chat.startWorker>> | null = null;
      chat.environment.POPPET_LOG_REASONING = "true";
      chat.state.reasoning = "Checking the notes.";
      chat.state.useTools = true;

      try {
        if (mode === "worker") worker = await chat.startWorker();
        const input = ["First", "/exit"];
        await Effect.runPromise(
          chat.program(
            ["chat", "interactive"],
            Effect.sync(() => input.shift() ?? null),
          ),
        );
        expect(chat.requests).toHaveLength(2);
        expect(chat.thinkingChunks).toEqual([
          "Thinking:\n",
          chat.state.reasoning,
          "\n\n",
          "Thinking:\n",
          chat.state.reasoning,
          "\n\n",
        ]);
        expect(chat.chunks.join("")).toBe("Answer\n");
      } finally {
        if (worker !== null) await Effect.runPromise(Fiber.interrupt(worker));
        await chat.close();
      }
    },
  );

  test.each(["local", "worker"])(
    "when a %s turn fails, closes interactive thinking",
    async (mode) => {
      const chat = await fixture();
      let worker: Awaited<ReturnType<typeof chat.startWorker>> | null = null;
      chat.environment.POPPET_LOG_REASONING = "true";
      chat.state.reasoning = "Checking before failure.";
      chat.state.useTools = true;
      chat.state.failNext = true;

      try {
        if (mode === "worker") worker = await chat.startWorker();
        const input = ["First", "/exit"];
        await Effect.runPromise(
          chat.program(
            ["chat", "interactive"],
            Effect.sync(() => input.shift() ?? null),
          ),
        );
        expect(chat.thinkingChunks).toEqual(["Thinking:\n", chat.state.reasoning, "\n\n"]);
        expect(chat.chunks).toEqual([]);
        expect(chat.errors).toContain("\nFixture request failed");
      } finally {
        if (worker !== null) await Effect.runPromise(Fiber.interrupt(worker));
        await chat.close();
      }
    },
  );

  test.each(["local", "worker"])(
    "when reasoning is enabled for %s execution, includes it in output and worker logs",
    async (mode) => {
      const chat = await fixture();
      const log = openWorkerLog(join(chat.directory, "logs"));
      let worker: Awaited<ReturnType<typeof chat.startWorker>> | null = null;
      delete chat.environment.POPPET_LOG_REASONING;

      try {
        await writeFile(
          join(chat.directory, "config.json"),
          JSON.stringify({ chat: { logReasoning: true } }),
        );
        chat.state.reasoning = "Check the notes before answering.";
        chat.state.useTools = true;

        if (mode === "worker")
          worker = await chat.startWorker("all", {
            ...console,
            log: (...values) => {
              chat.lines.push(values.join(" "));
            },
            error: (...values) => {
              log.write(Buffer.from(`${values.join(" ")}\n`));
            },
          });

        await chat.invoke(["chat", "new", "Hello"]);
        expect(chat.chunks.join("")).toBe("Answer\n");
        const reasoning = chat.errors.filter((line) => line.includes("Thinking session="));
        expect(reasoning).toEqual([]);
        expect(chat.thinkingChunks).toEqual([
          "Thinking:\n",
          chat.state.reasoning,
          "\n\n",
          "Thinking:\n",
          chat.state.reasoning,
          "\n\n",
        ]);
        expect(chat.thinkingChunks.join("")).not.toContain("retain privately");
        expect(chat.requests).toHaveLength(2);
        expect(chat.requests.every((request) => request.settings.reasoningSummary)).toBe(true);

        chat.state.reasoning = "Thinking before a failure";
        chat.state.failNext = true;
        await expect(
          chat.invoke(["chat", "send", chat.requests[0]!.sessionId, "Again"]),
        ).rejects.toMatchObject({ message: "Fixture request failed" });
        const diagnostics = chat.errors.filter((line) => line.includes("Thinking session="));
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics.at(-1)).toContain(chat.state.reasoning);

        if (mode === "worker") {
          const workerLog = await readFile(join(chat.directory, "logs/worker.log"), "utf8");
          const saved = stripVTControlCharacters(workerLog).trim().split("\n");
          expect(saved).toHaveLength(3);
          expect(saved[0]).toContain(`session=${chat.requests[0]?.sessionId} run=`);
          expect(saved[0]).toContain("Check the notes before answering.");
          expect(saved.at(-1)).toBe(diagnostics[0]);
        }

        await chat.invoke(["chat", "show", chat.requests[0]!.sessionId]);
        expect(chat.chunks.join("")).not.toContain(chat.state.reasoning);
      } finally {
        if (worker !== null) await Effect.runPromise(Fiber.interrupt(worker));
        log.close();
        await chat.close();
      }
    },
  );

  test.each(["local", "worker"])(
    "when %s timing diagnostics are enabled, separates them from answers and records failures",
    async (mode) => {
      const chat = await fixture();
      let worker: Awaited<ReturnType<typeof chat.startWorker>> | null = null;
      const workerLogs: string[] = [];
      delete chat.environment.POPPET_LOG_TIMINGS;

      try {
        await writeFile(
          join(chat.directory, "config.json"),
          JSON.stringify({ chat: { logTimings: true } }),
        );

        if (mode === "worker")
          worker = await chat.startWorker("all", {
            ...console,
            log: (...values) => {
              chat.lines.push(values.join(" "));
            },
            error: (...values) => {
              workerLogs.push(stripVTControlCharacters(values.join(" ")));
            },
          });

        await chat.invoke(["chat", "new", "Private prompt"]);
        expect(chat.chunks.join("")).toBe("Answer\n");
        const entries = chat.errors.filter((line) => line.includes("Timing session="));

        const timings: { stage: string; durationMs: number }[] = entries.map((line) =>
          JSON.parse(line.slice(line.indexOf(" {") + 1)),
        );

        expect(timings.map((timing) => timing.stage)).toEqual([
          "memory",
          "model-resolution",
          "first-text",
          "model-turn",
          "run",
          "model-resolution",
          "session-title",
        ]);
        expect(
          timings.every((timing) => Number.isFinite(timing.durationMs) && timing.durationMs >= 0),
        ).toBe(true);
        expect(entries.join("")).not.toContain("Private prompt");
        chat.state.failNext = true;
        await expect(
          chat.invoke(["chat", "send", chat.requests[0]!.sessionId, "Fail"]),
        ).rejects.toMatchObject({ message: "Fixture request failed" });
        const diagnostics = chat.errors.filter((line) => line.includes("Timing session="));
        expect(diagnostics.at(-1)).toContain('"stage":"run"');
        expect(diagnostics.at(-1)).toContain('"outcome":"failed"');

        if (mode === "worker") expect(workerLogs).toEqual(diagnostics);
      } finally {
        if (worker !== null) await Effect.runPromise(Fiber.interrupt(worker));
        await chat.close();
      }
    },
  );

  test("when diagnostic environment settings override the file, applies them and rejects invalid values", async () => {
    const chat = await fixture();

    try {
      await writeFile(
        join(chat.directory, "config.json"),
        JSON.stringify({ chat: { logReasoning: true, logTimings: true } }),
      );
      chat.state.reasoning = "Private thinking";
      await chat.invoke(["chat", "new", "Hello"]);
      expect(chat.errors.some((line) => line.includes("Thinking session="))).toBe(false);
      expect(chat.thinkingChunks).toEqual([]);
      expect(chat.errors.some((line) => line.includes("Timing session="))).toBe(false);
      expect(chat.requests[0]?.settings.reasoningSummary).toBeUndefined();
      chat.environment.POPPET_LOG_REASONING = "invalid";
      await expect(chat.invoke(["config"])).rejects.toHaveProperty("_tag", "ConfigError");
      chat.environment.POPPET_LOG_REASONING = "false";
      chat.environment.POPPET_LOG_TIMINGS = "invalid";
      await expect(chat.invoke(["config"])).rejects.toHaveProperty("_tag", "ConfigError");
    } finally {
      await chat.close();
    }
  });

  test.each(["local", "worker"])(
    "when %s execution uses file settings, applies model selection and chat budgets",
    async (mode) => {
      const chat = await fixture();
      let worker: Awaited<ReturnType<typeof chat.startWorker>> | null = null;

      for (const key of ["POPPET_PROVIDER", "POPPET_MODEL", "POPPET_MODEL_TURNS"] as const)
        delete chat.environment[key];

      const inspect = async (args: string[]) => {
        chat.chunks.length = 0;
        await chat.invoke(args);

        return JSON.parse(mode === "worker" ? chat.chunks.join("") : chat.lines.at(-1)!);
      };

      const settings = {
        provider: "chat-provider",
        model: "chat-model",
      };

      try {
        await writeFile(
          join(chat.directory, "config.json"),
          JSON.stringify({ ...settings, chat: { modelTurns: 1 } }),
        );
        chat.state.useTools = true;

        if (mode === "worker") worker = await chat.startWorker();

        await expect(
          chat.invoke(["chat", "new", "Remember my answer preference"]),
        ).rejects.toMatchObject({
          message: "The run has no model turn left to use tool results.",
        });
        expect(chat.requests).toHaveLength(1);
        expect(await inspect(["memory", "list"])).toEqual([]);
        await writeFile(
          join(chat.directory, "config.json"),
          JSON.stringify({ ...settings, chat: { modelTurns: 2 } }),
        );

        if (worker !== null) {
          await expect(
            chat.invoke(["chat", "new", "Still using the old budget"]),
          ).rejects.toMatchObject({
            message: "The run has no model turn left to use tool results.",
          });
          await Effect.runPromise(Fiber.interrupt(worker));
          worker = null;
          chat.lines.length = 0;
          worker = await chat.startWorker();
        }

        await chat.invoke(["chat", "new", "Remember my answer preference after reloading"]);
        expect(await inspect(["memory", "list"])).toMatchObject([
          { key: "answer.style", value: "Keep answers concise" },
        ]);
        await chat.invoke([
          "tasks",
          "add",
          "File task",
          "--at",
          "2099-10-15T09:00:00Z",
          "Summarize",
        ]);
        expect(JSON.parse(chat.lines.at(-1) ?? "")).toMatchObject({
          provider: "chat-provider",
          model: "chat-model",
        });
      } finally {
        if (worker !== null) await Effect.runPromise(Fiber.interrupt(worker));
        await chat.close();
      }
    },
  );

  test.each(["local", "worker"])(
    "when %s execution selects a skill, saves its snapshot for chats and tasks",
    async (mode) => {
      const remote = mode === "worker";
      const chat = await fixture();
      let worker: Awaited<ReturnType<typeof chat.startWorker>> | null = null;
      const file = join(chat.directory, "skills", "weekly-review", "SKILL.md");

      const inspect = async (args: ReadonlyArray<string>) => {
        chat.lines.length = 0;
        chat.chunks.length = 0;
        await chat.invoke(args);

        return JSON.parse(chat.lines.at(-1) ?? chat.chunks.join(""));
      };

      try {
        await mkdir(join(chat.directory, "skills", "weekly-review"), { recursive: true });
        await writeFile(file, "Original weekly procedure");
        await chat.invoke(["skills", "show", "weekly-review"]);
        expect(chat.lines.at(-1)).toBe("Original weekly procedure");
        expect(chat.state.built).toBe(0);

        if (remote) worker = await chat.startWorker();
        expect(await inspect(["skills", "list"])).toEqual(["weekly-review"]);

        await chat.invoke([
          "chat",
          "new",
          "--skill",
          "weekly-review",
          "--coding",
          "Review",
          "--literal",
        ]);
        const id = chat.errors.find((line) => line.startsWith("Session: "))!.slice(9);
        expect(chat.requests[0]?.instructions).toContain("Original weekly procedure");
        expect(chat.requests[0]?.messages.at(-1)).toEqual({
          role: "user",
          text: "Review --literal",
        });
        expect(chat.titleRequests[0]?.instructions).not.toContain("Original weekly procedure");
        expect(await inspect(["chat", "show", id])).toMatchObject({
          session: {
            skill: { name: "weekly-review", content: "Original weekly procedure" },
            workload: "coding",
          },
        });

        const job = await inspect([
          "tasks",
          "add",
          "Review",
          "--skill=weekly-review",
          "--at",
          "2099-01-01T00:00:00Z",
          "Review recent conversations",
        ]);

        expect(job.skill).toEqual({ name: "weekly-review", content: "Original weekly procedure" });

        await writeFile(file, "Edited weekly procedure");
        await chat.invoke(["chat", "send", id, "Continue"]);
        expect(chat.requests.at(-1)?.instructions).toContain("Original weekly procedure");
        await chat.invoke(["chat", "new", "--coding", "--skill=weekly-review", "A fresh review"]);
        expect(chat.requests.at(-1)?.instructions).toContain("Edited weekly procedure");
        await rm(join(chat.directory, "skills"), { recursive: true });
        await chat.invoke(["chat", "send", id, "Continue without the file"]);
        expect(chat.requests.at(-1)?.instructions).toContain("Original weekly procedure");
        expect(await inspect(["tasks", "show", job.id])).toMatchObject({
          task: { skill: job.skill },
        });

        const count = chat.requests.length;
        await expect(
          chat.invoke(["chat", "new", "--skill", "missing", "Review"]),
        ).rejects.toMatchObject({ message: expect.stringContaining("Skills must") });
        await expect(
          chat.invoke([
            "tasks",
            "add",
            "Bad",
            "--skill",
            "missing",
            "--at",
            "2099-01-01T00:00:00Z",
            "Review",
          ]),
        ).rejects.toMatchObject({ message: expect.stringContaining("Skills must") });
        expect(chat.requests).toHaveLength(count);
        expect(await inspect(["tasks", "list"])).toHaveLength(1);
        expect(await inspect(["chat", "sessions"])).toHaveLength(2);
        await chat.invoke(["chat", "new", "Ordinary session"]);
        expect(chat.requests.at(-1)?.instructions).not.toContain("weekly procedure");

        if (worker !== null) {
          await Effect.runPromise(Fiber.interrupt(worker));
          worker = null;
        }

        expect(await inspect(["chat", "show", id])).toMatchObject({
          session: { skill: { content: "Original weekly procedure" } },
        });
        expect(await inspect(["tasks", "show", job.id])).toMatchObject({
          task: { skill: job.skill },
        });
      } finally {
        if (worker !== null) await Effect.runPromise(Fiber.interrupt(worker));
        await chat.close();
      }
    },
  );

  test.each(["local", "worker"])(
    "when interactive chat continues through %s execution, retains one skill and session",
    async (mode) => {
      const remote = mode === "worker";
      const chat = await fixture();
      let worker: Awaited<ReturnType<typeof chat.startWorker>> | undefined;

      try {
        await mkdir(join(chat.directory, "skills", "review"), { recursive: true });
        await writeFile(
          join(chat.directory, "skills/review/SKILL.md"),
          "Give a short project review.",
        );

        if (remote) worker = await chat.startWorker();
        const input = ["   ", "  First message  ", "Second --help", "/exit"];
        await Effect.runPromise(
          chat.program(
            ["chat", "interactive", "--coding", "--skill", "review"],
            Effect.sync(() => input.shift() ?? null),
          ),
        );
        expect(chat.requests).toHaveLength(2);
        expect(new Set(chat.requests.map((request) => request.sessionId)).size).toBe(1);
        expect(chat.requests[1]!.messages).toEqual(
          expect.arrayContaining([
            { role: "user", text: "  First message  " },
            { role: "user", text: "Second --help" },
          ]),
        );
        const id = chat.requests[0]!.sessionId;

        if (worker !== undefined) {
          await Effect.runPromise(Fiber.interrupt(worker));
          worker = undefined;
        }

        delete chat.environment.POPPET_MODEL;
        chat.environment.POPPET_PROVIDER = "unused-provider";
        await rm(join(chat.directory, "skills"), { recursive: true });
        const resumed = ["After restart", null];
        await Effect.runPromise(
          chat.program(
            ["chat", "interactive", id],
            Effect.sync(() => resumed.shift() ?? null),
          ),
        );
        expect(chat.requests[2]!.sessionId).toBe(id);
        expect(chat.requests[2]!.instructions).toContain("Give a short project review.");
        await chat.invoke(["chat", "show", id]);
        const saved = JSON.parse(chat.lines.at(-1)!);
        expect(saved.session).toMatchObject({
          provider: "chat-provider",
          model: "chat-model",
          workload: "coding",
          skill: { name: "review" },
        });
        expect(saved.runs.map((run: { status: string }) => run.status)).toEqual([
          "completed",
          "completed",
          "completed",
        ]);
      } finally {
        if (worker !== undefined) await Effect.runPromise(Fiber.interrupt(worker));
        await chat.close();
      }
    },
  );

  test.each(["local", "worker"])(
    "when the first interactive turn fails through %s execution, retains its session",
    async (mode) => {
      const remote = mode === "worker";
      const chat = await fixture();
      let worker: Awaited<ReturnType<typeof chat.startWorker>> | undefined;

      try {
        if (remote) worker = await chat.startWorker();
        chat.state.failNext = true;
        const input = ["First fails", "Next succeeds", "/exit"];
        await Effect.runPromise(
          chat.program(
            ["chat", "interactive"],
            Effect.sync(() => input.shift() ?? null),
          ),
        );
        expect(chat.requests).toHaveLength(2);
        expect(chat.requests[0]!.sessionId).toBe(chat.requests[1]!.sessionId);
        expect(chat.requests[1]!.messages).not.toContainEqual({
          role: "user",
          text: "First fails",
        });

        if (worker !== undefined) {
          await Effect.runPromise(Fiber.interrupt(worker));
          worker = undefined;
        }

        await chat.invoke(["chat", "show", chat.requests[0]!.sessionId]);
        // The worker test clock can give both runs the same timestamp.
        expect(
          JSON.parse(chat.lines.at(-1)!)
            .runs.map((run: { status: string }) => run.status)
            .toSorted(),
        ).toEqual(["completed", "failed"]);
      } finally {
        if (worker !== undefined) await Effect.runPromise(Fiber.interrupt(worker));
        await chat.close();
      }
    },
  );

  test.each(["local", "worker"])(
    "when interactive inference is interrupted through %s execution, finalizes its run",
    async (mode) => {
      const remote = mode === "worker";
      const chat = await fixture();
      let worker: Awaited<ReturnType<typeof chat.startWorker>> | undefined;
      let prompt: Fiber.Fiber<void, unknown> | undefined;

      try {
        if (remote) worker = await chat.startWorker();
        chat.state.hold = true;
        let reads = 0;
        prompt = Effect.runFork(
          chat.program(
            ["chat", "interactive"],
            Effect.sync(() => {
              reads++;

              return "Hold this request";
            }),
          ),
        );
        await Effect.runPromise(
          Effect.gen(function* () {
            while (chat.requests.length === 0) yield* Effect.sleep("5 millis");
          }).pipe(Effect.timeout("2 seconds")),
        );
        await Effect.runPromise(Fiber.interrupt(prompt));
        prompt = undefined;
        chat.state.hold = false;
        // A remote disconnect closes the request scope asynchronously; wait for runner cleanup.
        await Effect.runPromise(
          Effect.gen(function* () {
            while (chat.state.active > 0) yield* Effect.sleep("5 millis");
          }).pipe(Effect.timeout("2 seconds")),
        );
        expect(reads).toBe(1);

        if (worker !== undefined) {
          await Effect.runPromise(Fiber.interrupt(worker));
          worker = undefined;
        }

        await chat.invoke(["chat", "show", chat.requests[0]!.sessionId]);
        expect(JSON.parse(chat.lines.at(-1)!).runs).toMatchObject([{ status: "interrupted" }]);
      } finally {
        if (prompt !== undefined) await Effect.runPromise(Fiber.interrupt(prompt));

        if (worker !== undefined) await Effect.runPromise(Fiber.interrupt(worker));
        await chat.close();
      }
    },
  );

  test("when a saved skill exceeds the context budget, rejects the request before inference", async () => {
    const chat = await fixture();

    try {
      await mkdir(join(chat.directory, "skills", "large"), { recursive: true });
      await writeFile(join(chat.directory, "skills", "large", "SKILL.md"), "x".repeat(8192));
      chat.environment.POPPET_CONTEXT_BYTES = "4096";
      await expect(
        chat.invoke(["chat", "new", "--skill", "large", "Review"]),
      ).rejects.toMatchObject({ reason: "context-limit" });
      expect(chat.requests).toHaveLength(0);
      const id = chat.errors.find((line) => line.startsWith("Session: "))!.slice(9);
      await chat.invoke(["chat", "show", id]);
      expect(JSON.parse(chat.lines.at(-1)!)).toMatchObject({
        runs: [{ status: "failed", failureReason: "agent:context-limit" }],
      });
    } finally {
      await chat.close();
    }
  });

  test("when channels are registered, provides help, setup, lazy startup, isolated sessions, and status", async () => {
    const first = exampleChannel("example-channel");
    const second = exampleChannel("other-channel");

    const broken: ChannelRegistration = {
      id: "broken-channel",
      name: "Broken channel",
      setupHelp: "setup",
      setup: () =>
        Effect.fail(
          new ChannelError({ reason: "configuration", message: "Invalid channel settings" }),
        ),
      load: Effect.fail(
        new ChannelError({ reason: "configuration", message: "Invalid channel settings" }),
      ),
    };

    const buildFailure: ChannelRegistration = {
      ...broken,
      id: "build-failure",
      load: Effect.succeed(
        Layer.effect(
          MessagingChannel,
          Effect.fail(
            new ChannelError({
              reason: "configuration",
              message: "Credential storage unavailable",
            }),
          ),
        ),
      ),
    };

    const chat = await fixture([first.registration, second.registration, broken, buildFailure]);
    let worker: Awaited<ReturnType<typeof chat.startWorker>> | undefined;
    let stage = "setup";

    try {
      await chat.invoke(["gateway", "--help"]);
      expect(chat.lines.at(-1)).toContain("gateway example-channel setup");
      expect(chat.lines.at(-1)).not.toContain("gateway discord");
      await expect(chat.invoke(["gateway", "missing-channel", "setup"])).rejects.toMatchObject({
        message: expect.stringContaining('Unknown subcommand "missing-channel"'),
      });
      await chat.invoke(["gateway", "status"]);
      expect(JSON.parse(chat.lines.at(-1)!)).toMatchObject({ running: false, enabled: true });

      await Promise.all(
        [first, second].map((channel) =>
          chat.invoke(["gateway", channel.registration.id, "setup"]),
        ),
      );
      await chat.invoke(["gateway", "status"]);
      expect(JSON.parse(chat.lines.at(-1)!)).toMatchObject({ running: false, enabled: true });
      expect([first.state.built, second.state.built]).toEqual([0, 0]);
      stage = "worker startup";
      worker = await chat.startWorker("gateway");
      expect([first.state.built, second.state.built]).toEqual([1, 1]);

      await Promise.all(
        [first, second].map((channel) =>
          chat.clock.runPromise(
            Queue.offer(channel.incoming, {
              messageId: "same-message",
              scopeId: "guild",
              parentId: "parent",
              conversationId: "thread",
              senderId: "owner",
              text: channel.registration.id,
              mentioned: false,
            }),
          ),
        ),
      );
      stage = "initial replies";
      await Effect.runPromise(
        Effect.all([Queue.take(first.replies), Queue.take(second.replies)]).pipe(
          Effect.timeout("2 seconds"),
        ),
      );
      expect(first.state.sent).toEqual(["Answer"]);
      expect(second.state.sent).toEqual(["Answer"]);
      expect(chat.requests.map((request) => request.messages.at(-1))).toEqual(
        expect.arrayContaining([
          { role: "user", text: "example-channel" },
          { role: "user", text: "other-channel" },
        ]),
      );
      expect(new Set(chat.requests.map((request) => request.sessionId)).size).toBe(2);
      expect(chat.state.peak).toBe(1);
      chat.chunks.length = 0;
      await chat.invoke(["gateway", "status"]);
      expect(JSON.parse(chat.chunks.join(""))).toMatchObject({
        running: true,
        enabled: true,
        queued: 0,
        executing: 0,
        pendingDelivery: 0,
        channels: [
          { id: "example-channel", enabled: true, connected: true },
          { id: "other-channel", enabled: true, connected: true },
          { id: "broken-channel", enabled: false, error: "Invalid channel settings" },
          { id: "build-failure", enabled: false, error: "Credential storage unavailable" },
        ],
      });
      await Effect.runPromise(Fiber.interrupt(worker));
      worker = undefined;
      expect([first.state.closed, second.state.closed]).toEqual([1, 1]);
    } catch (cause) {
      throw new Error(
        `Messaging fixture failed during ${stage}: ${JSON.stringify({
          errors: chat.errors,
          state: chat.state,
          requests: chat.requests.map((request) => request.messages.at(-1)),
          sent: [first.state.sent, second.state.sent],
        })}`,
        { cause },
      );
    } finally {
      if (worker !== undefined) await Effect.runPromise(Fiber.interrupt(worker));
      await chat.close();
    }
  });

  test.each(["all", "tasks", "gateway"] as const)(
    "when worker mode is %s, starts only selected services and keeps shared commands available",
    async (mode) => {
      const chat = await fixture();
      let worker: Awaited<ReturnType<typeof chat.startWorker>> | undefined;

      try {
        await mkdir(join(chat.directory, "channels"), { mode: 0o700 });
        await writeFile(join(chat.directory, "channels/discord.json"), "invalid settings", {
          mode: 0o600,
        });
        await chat.invoke([
          "tasks",
          "add",
          "Due",
          "--at",
          new Date(Date.now() + 60_000).toISOString(),
          "Summarize",
        ]);
        const task = JSON.parse(chat.lines.at(-1)!);
        worker = await chat.startWorker(mode);
        await chat.invoke(["worker", "status"]);
        expect(JSON.parse(chat.lines.at(-1)!).worker).toMatchObject({
          running: true,
          services: { tasks: mode !== "gateway", gateway: mode !== "tasks" },
        });
        chat.chunks.length = 0;
        await chat.invoke(["gateway", "status"]);
        const gateway = JSON.parse(chat.chunks.join(""));
        expect(gateway).toMatchObject({
          running: mode !== "tasks",
          enabled: false,
        });

        if (mode === "tasks") expect(gateway.channels).toEqual([]);
        else
          expect(gateway.channels).toMatchObject([
            {
              id: "discord",
              enabled: false,
              error:
                "Cannot read or write protected Discord settings. Run gateway discord setup again.",
            },
          ]);
        await chat.clock.runPromise(TestClock.adjust("61 seconds"));

        if (mode === "gateway") {
          expect(chat.requests).toHaveLength(0);
          await chat.invoke(["tasks", "show", task.id]);
          expect(JSON.parse(chat.lines.at(-1)!).occurrences).toEqual([]);
        } else {
          await Effect.runPromise(
            Effect.gen(function* () {
              while (chat.requests.length === 0) yield* Effect.sleep("5 millis");
            }).pipe(Effect.timeout("2 seconds")),
          );
          expect(chat.requests).toHaveLength(1);
        }

        const count = chat.requests.length;
        await chat.invoke(["chat", "new", "Hello from CLI"]);
        expect(chat.requests).toHaveLength(count + 1);
        expect(chat.state.peak).toBe(1);
        await expect(
          chat.invoke(mode === "gateway" ? ["worker", "run", "--tasks-only"] : ["gateway", "work"]),
        ).rejects.toHaveProperty("reason", "busy");
        await Effect.runPromise(Fiber.interrupt(worker));
        worker = undefined;
        expect(await Bun.file(workerSocketPath(chat.directory)).exists()).toBe(false);
        await chat.invoke(["store", "status"]);
      } finally {
        if (worker !== undefined) await Effect.runPromise(Fiber.interrupt(worker));
        await chat.close();
      }
    },
  );

  test("when the worker uses a larger context budget, accepts fitting chats and explains overflow", async () => {
    const chat = await fixture();
    chat.environment.POPPET_CONTEXT_BYTES = "1048576";
    const prompt = "x".repeat(150_000);

    try {
      await chat.invoke(["chat", "new", prompt]);
      expect(chat.requests).toHaveLength(1);
      const worker = await chat.startWorker();

      try {
        await chat.invoke(["chat", "new", prompt]);
        expect(chat.requests).toHaveLength(2);
        expect(chat.chunks.join("")).toBe("Answer\nAnswer\n");
        await expect(chat.invoke(["chat", "new", "x".repeat(2 * 1024 * 1024 + 1)])).rejects.toThrow(
          "2 MiB",
        );
        expect(chat.requests).toHaveLength(2);
      } finally {
        await Effect.runPromise(Fiber.interrupt(worker));
      }
    } finally {
      await chat.close();
    }
  });

  test("when shutdown encounters an incomplete request body, closes the worker and storage", async () => {
    const chat = await fixture();
    const worker = await chat.startWorker();
    const socket = createConnection(workerSocketPath(chat.directory));

    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      socket.write(
        "POST /v1/commands HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{",
      );
      await Effect.runPromise(Effect.sleep("50 millis"));
      const stopping = Effect.runPromise(Fiber.interrupt(worker)).then(() => true);

      const stopped = await Promise.race([
        stopping,
        Effect.runPromise(Effect.sleep("1 second").pipe(Effect.as(false))),
      ]);

      expect(stopped).toBe(true);
      expect(chat.requests).toHaveLength(0);
      await chat.invoke(["memory", "remember", "project", "Acorn"]);
      expect(JSON.parse(chat.lines.at(-1)!)).toMatchObject({ key: "project", value: "Acorn" });
    } finally {
      socket.destroy();
      await Effect.runPromise(Fiber.interrupt(worker));
      await chat.close();
    }
  });

  test("when worker replies fail or are malformed or incomplete, avoids local fallback and replay", async () => {
    const chat = await fixture();
    const directory = join(chat.directory, "store");
    await mkdir(directory, { mode: 0o700 });
    const path = workerSocketPath(chat.directory);
    let delivered = 0;
    let reply = "";

    const server = Bun.serve({
      unix: path,
      fetch() {
        delivered++;

        return new Response(reply, { headers: { "content-type": "application/x-ndjson" } });
      },
    });

    await chmod(path, 0o600);

    try {
      await Array.fromAsync(
        [
          '{"type":"failed","message":"Already saved."}\n',
          '{"type":"stdout","text":"Possibly saved"}\n',
          '{"type":"stdout"}\n',
          '{"type":"done"}\n{"type":"stdout","text":"Too late"}\n',
        ],
        async (response) => {
          reply = response;
          // Each response is selected before issuing the next request.
          await expect(
            chat.invoke(["memory", "remember", "project", "Acorn"]),
          ).rejects.toHaveProperty("_tag", "WorkerRequestError");
        },
      );

      expect(delivered).toBe(4);
      expect(await readdir(directory)).toEqual(["tasks.sock"]);
      await chmod(path, 0o666);
      await expect(chat.invoke(["memory", "list"])).rejects.toThrow("not protected");
      expect(delivered).toBe(4);
    } finally {
      await server.stop(true);
      await chat.close();
    }
  });

  test("when the worker starts and stops, routes chat, memory, and inspection to the current owner", async () => {
    const chat = await fixture();
    const worker = await chat.startWorker();
    const built = chat.state.built;

    const readOutput = async (args: ReadonlyArray<string>) => {
      chat.chunks.length = 0;
      await chat.invoke(args);

      return chat.chunks.join("");
    };

    try {
      expect(JSON.parse(await readOutput(["gateway", "status"]))).toMatchObject({
        running: true,
        enabled: false,
      });

      const unknown = await fetch("http://localhost/v1/unknown", {
        unix: workerSocketPath(chat.directory),
        method: "POST",
        body: JSON.stringify({
          kind: "memory",
          command: { action: "remember", key: "unexpected", value: "bad" },
        }),
      });

      expect(unknown.status).toBe(404);

      const invalid = await Promise.all(
        [
          { kind: "memory", command: { action: "remember", key: "../bad", value: "Acorn" } },
          {
            kind: "chat",
            command: {
              action: "new",
              text: "Hello",
              provider: "chat-provider",
              model: "",
              workload: "assistant",
            },
          },
          { kind: "chat", command: { action: "search", query: " " } },
          { kind: "unknown" },
          {
            kind: "memory",
            command: { action: "remember", key: "extra", value: "bad", ignored: true },
          },
          { kind: "store", ignored: true },
        ].map((command) =>
          fetch("http://localhost/v1/commands", {
            unix: workerSocketPath(chat.directory),
            method: "POST",
            body: JSON.stringify(command),
          }),
        ),
      );

      expect(invalid.map((response) => response.status)).toEqual([400, 400, 400, 400, 400, 400]);
      expect(JSON.parse(await readOutput(["memory", "list"]))).toEqual([]);
      expect(
        JSON.parse(await readOutput(["memory", "remember", "project", "Acorn"])),
      ).toMatchObject({ key: "project", value: "Acorn" });
      expect(chat.state.built).toBe(built);
      chat.state.useTools = true;
      expect(await readOutput(["chat", "new", "--coding", "Save a summary"])).toBe("Answer\n");
      const session = chat.errors.find((line) => line.startsWith("Session: "))!.slice(9);
      expect(chat.requests[0]?.instructions).toContain("Acorn");

      expect(JSON.parse(await readOutput(["chat", "show", session]))).toMatchObject({
        runs: [{ status: "completed", workload: "coding" }],
        toolCalls: [{ status: "completed", name: "memory" }],
      });
      expect(chat.chunks.join("")).not.toContain("secretOpaqueState");
      expect(JSON.parse(await readOutput(["chat", "sessions"]))).toHaveLength(1);
      const inferenceCount = chat.requests.length;
      const search = JSON.parse(await readOutput(["chat", "search", "summary"]));
      expect(search).toMatchObject({
        matches: [
          expect.objectContaining({ sessionId: session, role: "user", excerpt: "Save a summary" }),
        ],
        truncated: false,
      });
      expect(chat.requests).toHaveLength(inferenceCount);
      expect(JSON.parse(await readOutput(["chat", "search", "secretOpaqueState"]))).toEqual({
        matches: [],
        truncated: false,
      });
      expect(JSON.parse(await readOutput(["store", "status"]))).toMatchObject({ sessions: 1 });

      await readOutput(["memory", "replace", "project", "Birch"]);
      chat.state.useTools = false;
      chat.environment.POPPET_PROVIDER = "unused-provider";
      delete chat.environment.POPPET_MODEL;
      expect(await readOutput(["chat", "send", session, "Continue"])).toBe("Answer\n");
      expect(chat.requests.at(-1)?.instructions).toContain("Birch");
      await readOutput(["memory", "forget", "project"]);
      await readOutput(["memory", "forget", "answer.style"]);
      expect(await readOutput(["memory", "list"])).toBe("[]\n");
      expect(chat.lines.join("\n")).not.toContain("Save a summary");
      expect(chat.lines.join("\n")).not.toContain("Answer");

      await Effect.runPromise(Fiber.interrupt(worker));
      await chat.invoke(["chat", "show", session]);
      expect(JSON.parse(chat.lines.at(-1)!)).toMatchObject({
        runs: [{ status: "completed" }, { status: "completed" }],
      });
      await chat.invoke(["chat", "search", "summary"]);
      expect(JSON.parse(chat.lines.at(-1)!)).toEqual(search);
      await chat.invoke(["memory", "list"]);
      expect(chat.lines.at(-1)).toBe("[]");
    } finally {
      await Effect.runPromise(Fiber.interrupt(worker));
      await chat.close();
    }
  });

  test("when the worker stops, interrupts active and queued chats and allows local inspection", async () => {
    const chat = await fixture();
    const worker = await chat.startWorker();
    chat.state.hold = true;
    const client = Effect.runFork(chat.program(["chat", "new", "Stop this run"]));

    const queued = Effect.runFork(
      Effect.gen(function* () {
        while (chat.requests.length === 0) yield* Effect.sleep("5 millis");
        yield* chat.program(["chat", "new", "Cancel before starting"]);
      }),
    );

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          while (
            chat.requests.length === 0 ||
            chat.errors.filter((line) => line.startsWith("Session:")).length < 2
          )
            yield* Effect.sleep("5 millis");
        }).pipe(Effect.timeout("2 seconds")),
      );
      await Effect.runPromise(Fiber.interrupt(worker));
      await expect(Effect.runPromise(Fiber.join(client))).rejects.toThrow("not retried");
      await expect(Effect.runPromise(Fiber.join(queued))).rejects.toThrow("not retried");
      expect(chat.requests).toHaveLength(1);
      expect(chat.state.active).toBe(0);
      await chat.invoke(["chat", "show", chat.errors[0]!.slice(9)]);
      expect(JSON.parse(chat.lines.at(-1)!)).toMatchObject({
        runs: [{ status: "interrupted", output: null }],
        messages: [{ message: { role: "user", text: "Stop this run" } }],
      });
    } finally {
      chat.state.hold = false;
      await Effect.runPromise(Fiber.interrupt(client));
      await Effect.runPromise(Fiber.interrupt(queued));
      await Effect.runPromise(Fiber.interrupt(worker));
      await chat.close();
    }
  });

  test("when a chat disconnects, releases the runner for queued chat and scheduled work", async () => {
    const chat = await fixture();
    const worker = await chat.startWorker();
    chat.state.hold = true;
    const first = Effect.runFork(chat.program(["chat", "new", "Interrupted"]));

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          while (chat.requests.length === 0) yield* Effect.sleep("5 millis");
        }).pipe(Effect.timeout("2 seconds")),
      );
      const second = Effect.runFork(chat.program(["chat", "new", "Queued"]));
      await chat.invoke([
        "tasks",
        "add",
        "Scheduled",
        "--at",
        new Date(Date.now()).toISOString(),
        "Scheduled request",
      ]);
      await Effect.runPromise(Effect.sleep("50 millis"));
      expect(chat.requests).toHaveLength(1);
      expect(chat.chunks).toContain("An");
      expect(chat.state.peak).toBe(1);

      await Effect.runPromise(Fiber.interrupt(first));
      await Effect.runPromise(
        Effect.gen(function* () {
          while (chat.requests.length < 2) yield* Effect.sleep("5 millis");
        }).pipe(Effect.timeout("2 seconds")),
      );
      expect(chat.state.peak).toBe(1);
      chat.state.hold = false;
      await chat.clock.runPromise(TestClock.adjust("1 second"));
      await Effect.runPromise(Fiber.join(second));
      await Effect.runPromise(
        Effect.gen(function* () {
          while (chat.requests.length < 3 || chat.state.active !== 0)
            yield* Effect.sleep("5 millis");
        }).pipe(Effect.timeout("2 seconds")),
      );
      expect(chat.state.peak).toBe(1);
      chat.chunks.length = 0;
      await chat.invoke(["chat", "sessions"]);
      const sessions = JSON.parse(chat.chunks.join(""));
      chat.chunks.length = 0;
      await chat.invoke([
        "chat",
        "show",
        sessions.find((item: { id: string }) => item.id === chat.errors[0]!.slice(9)).id,
      ]);
      expect(JSON.parse(chat.chunks.join(""))).toMatchObject({
        runs: [{ status: "interrupted", output: null }],
        messages: [{ message: { role: "user", text: "Interrupted" } }],
      });
    } finally {
      chat.state.hold = false;
      await Effect.runPromise(Fiber.interrupt(first));
      await Effect.runPromise(Fiber.interrupt(worker));
      await chat.close();
    }
  });

  test("when chats start or resume, loads CLI-managed facts and the editable profile", async () => {
    const saved = await fixture();

    try {
      await writeFile(join(saved.directory, "profile.md"), "My name is Tom.");
      await saved.invoke(["memory", "remember", "answer.style", "Keep answers concise"]);
      expect(saved.state.built).toBe(0);
      await saved.invoke(["chat", "new", "How should you answer?"]);
      expect(saved.requests[0]?.instructions).toContain("Keep answers concise");
      expect(saved.requests[0]?.instructions).toContain("My name is Tom.");
      const session = saved.errors.find((line) => line.startsWith("Session: "))?.slice(9) ?? "";
      await saved.invoke(["memory", "replace", "answer.style", "Explain the reasoning"]);
      await saved.invoke(["chat", "send", session, "What about now?"]);
      expect(saved.requests[1]?.instructions).toContain("Explain the reasoning");
      expect(saved.requests[1]?.instructions).not.toContain("Keep answers concise");
      await saved.invoke(["memory", "forget", "answer.style"]);
      await saved.invoke(["chat", "new", "What about now?"]);
      expect(saved.requests[2]?.instructions).not.toContain("answer.style");
      await saved.invoke(["memory", "list"]);
      expect(saved.lines.at(-1)).toBe("[]");
    } finally {
      await saved.close();
    }
  });

  test.each(["local", "worker"])(
    "when the model changes memory through %s execution, saves it in the CLI store",
    async (mode) => {
      const chat = await fixture();
      const remote = mode === "worker";
      let worker: Awaited<ReturnType<typeof chat.startWorker>> | undefined;

      const inspect = async (args: string[]) => {
        chat.chunks.length = 0;
        await chat.invoke(args);

        return JSON.parse(remote ? chat.chunks.join("") : chat.lines.at(-1)!);
      };

      try {
        chat.state.useTools = true;

        if (remote) worker = await chat.startWorker();
        await chat.invoke(["chat", "new", "Remember that I prefer concise answers"]);

        const session = chat.errors
          .find((line) => line.startsWith("Session: "))!
          .slice("Session: ".length);

        const saved = await inspect(["chat", "show", session]);
        expect(saved.toolCalls).toMatchObject([
          { name: "memory", namespace: "poppet_memory", status: "completed" },
        ]);
        expect(await inspect(["memory", "list"])).toEqual([
          expect.objectContaining({
            key: "answer.style",
            value: "Keep answers concise",
            sourceRunId: saved.runs[0].id,
          }),
        ]);
        chat.state.useTools = false;
        await chat.invoke(["chat", "new", "How should you answer?"]);
        expect(chat.requests.at(-1)!.instructions).toContain(
          '"key":"answer.style","value":"Keep answers concise"',
        );
      } finally {
        if (worker !== undefined) await Effect.runPromise(Fiber.interrupt(worker));
        await chat.close();
      }
    },
  );

  test("when chat saves a requested fact, records tool execution for session inspection", async () => {
    const chat = await fixture();

    try {
      chat.state.useTools = true;
      await chat.invoke(["chat", "new", "Remember that I prefer concise answers"]);
      expect(chat.state.open).toBe(false);
      expect(chat.chunks.join("")).toBe("Answer\n");

      await chat.invoke(["chat", "show", chat.errors[0]?.slice("Session: ".length) ?? ""]);
      const saved = JSON.parse(chat.lines.at(-1) ?? "");
      expect(saved.toolCalls).toEqual([
        expect.objectContaining({
          name: "memory",
          namespace: "poppet_memory",
          status: "completed",
        }),
      ]);
      expect(
        saved.messages.map((entry: { message: { role: string } }) => entry.message.role),
      ).toEqual(["user", "assistant", "tool", "assistant"]);
      expect(chat.requests).toHaveLength(2);
    } finally {
      await chat.close();
    }
  });

  test("when a coding session reopens, uses its saved selection and hides continuation from inspection", async () => {
    const chat = await fixture();

    try {
      await chat.invoke(["chat", "new", "--coding", "First", "question", "--help", "--coding"]);
      expect(chat.state.open).toBe(false);
      expect(chat.chunks.join("")).toBe("Answer\n");
      expect(chat.errors[0]).toStartWith("Session: ");
      expect(chat.errors[1]).toStartWith("Run: ");
      await chat.invoke(["chat", "sessions"]);
      const session = JSON.parse(chat.lines.at(-1) ?? "")[0];
      expect(session).toMatchObject({
        provider: "chat-provider",
        model: "chat-model",
        workload: "coding",
      });
      const built = chat.state.built;
      chat.environment.POPPET_PROVIDER = "unused-provider";
      delete chat.environment.POPPET_MODEL;
      chat.environment.POPPET_CONTEXT_BYTES = "invalid";
      await chat.invoke(["chat", "show", session.id]);
      expect(chat.lines.at(-1)).not.toContain("secretOpaqueState");
      expect(chat.lines.at(-1)).not.toContain("continuation");
      expect(JSON.parse(chat.lines.at(-1) ?? "")).toMatchObject({
        runs: [expect.objectContaining({ status: "completed", workload: "coding" })],
      });
      expect(chat.state.built).toBe(built);
      chat.environment.POPPET_CONTEXT_BYTES = "65536";
      await chat.invoke(["chat", "send", session.id, "--unknown", "Second", "question"]);
      expect(chat.state.open).toBe(false);
      expect(chat.requests[1]).toMatchObject({
        workload: "coding",
        messages: [
          { role: "user", text: "First question --help --coding" },
          { role: "assistant", continuation: { data: { secretOpaqueState: "retain privately" } } },
          { role: "user", text: "--unknown Second question" },
        ],
        settings: {},
      });
      await chat.invoke(["chat", "show", session.id]);
      expect(JSON.parse(chat.lines.at(-1) ?? "").runs).toHaveLength(2);
    } finally {
      await chat.close();
    }
  });

  test("when arguments, model selection, or budgets are invalid, rejects them before contacting providers", async () => {
    const chat = await fixture();

    try {
      await Promise.all(
        [
          ["chat", "new"],
          ["chat", "send", "../bad", "Hello"],
          ["chat", "show", "session", "extra"],
          ["chat", "sessions", "extra"],
        ].map((args) => expect(chat.invoke(args)).rejects.toHaveProperty("_tag", "UsageError")),
      );

      delete chat.environment.POPPET_MODEL;
      await expect(chat.invoke(["chat", "new", "Hello"])).rejects.toMatchObject({
        reason: "invalid-request",
        message: expect.stringContaining("POPPET_MODEL"),
      });
      expect(await readdir(chat.directory)).toEqual([]);
      chat.environment.POPPET_MODEL = "chat-model";
      chat.environment.POPPET_OUTPUT_TOKENS = "0";
      await expect(chat.invoke(["chat", "new", "Hello"])).rejects.toHaveProperty(
        "_tag",
        "ConfigError",
      );
      expect(chat.requests).toHaveLength(0);
      expect(chat.state.built).toBe(0);
    } finally {
      await chat.close();
    }
  });

  test("when an answer completes, generates one title and allows local and worker manual renames", async () => {
    const chat = await fixture();
    let worker: Awaited<ReturnType<typeof chat.startWorker>> | null = null;

    try {
      await chat.invoke(["chat", "new", "An original conversation prompt"]);
      const id = chat.errors[0]!.slice("Session: ".length);
      expect(chat.chunks.join("")).toBe("Answer\n");
      expect(chat.titleRequests).toHaveLength(1);
      await chat.invoke(["chat", "show", id]);
      const saved = JSON.parse(chat.lines.at(-1)!);
      expect(saved.session).toMatchObject({
        title: "A saved conversation title",
        titleSource: "generated",
        titleAttempted: true,
        titleUsage: { inputTokens: 10, outputTokens: 5 },
      });
      expect(saved.runs).toHaveLength(1);
      expect(saved.messages).toHaveLength(2);
      const built = chat.state.built;
      await chat.invoke(["chat", "rename", id, "Local", "--literal", "title"]);
      expect(JSON.parse(chat.lines.at(-1)!).title).toBe("Local --literal title");
      worker = await chat.startWorker();
      await chat.invoke(["chat", "rename", id, "My worker title"]);
      await chat.invoke(["chat", "send", id, "Continue"]);
      await chat.invoke(["chat", "show", id]);
      expect(chat.chunks.join("")).toContain('"title": "My worker title"');
      expect(chat.titleRequests).toHaveLength(1);
      expect(chat.state.built).toBe(built + 1);
    } finally {
      if (worker) await Effect.runPromise(Fiber.interrupt(worker));
      await chat.close();
    }
  });

  test("when the output stream closes, interrupts the run and retains only the input", async () => {
    const chat = await fixture();

    try {
      chat.state.writeFails = true;
      await expect(chat.invoke(["chat", "new", "Hello"])).rejects.toMatchObject({
        reason: "interrupted",
      });
      expect(chat.state.open).toBe(false);
      const id = chat.errors[0]?.slice("Session: ".length) ?? "";
      await chat.invoke(["chat", "show", id]);
      const saved = JSON.parse(chat.lines.at(-1) ?? "");
      expect(saved.runs[0]).toMatchObject({
        status: "interrupted",
        failureReason: "agent:interrupted",
        output: null,
      });
      expect(saved.messages).toHaveLength(1);
    } finally {
      await chat.close();
    }
  });
});
