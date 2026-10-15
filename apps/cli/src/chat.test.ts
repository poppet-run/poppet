import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentError } from "@poppet/agent";
import {
  Provider,
  ProviderConnection,
  invalidRequest,
  type ModelDescription,
  type ModelRequest,
  type ProviderRegistration,
} from "@poppet/provider";
import { taskSocketPath } from "@poppet/tasks";
import { Console, Effect, Fiber, Layer, ManagedRuntime, Stream } from "effect";
import { TestClock } from "effect/testing";

import { makeCLI } from "#src/cli";

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

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "poppet-chat-cli-"));

  const environment = {
    POPPET_PROVIDER: "chat-provider",
    POPPET_MODEL: "chat-model",
    POPPET_DATA_DIR: directory,
    POPPET_NOTES_DIR: join(directory, "notes"),
    POPPET_CONTEXT_BYTES: "65536",
    POPPET_HISTORY_TURNS: "20",
    POPPET_OUTPUT_TOKENS: "2048",
    POPPET_MODEL_TURNS: "8",
    POPPET_TOOL_CALLS: "16",
    POPPET_TOOL_BYTES: "16384",
  };

  const previous = new Map(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const requests: ModelRequest[] = [];
  const lines: string[] = [];
  const errors: string[] = [];
  const chunks: string[] = [];
  const clock = ManagedRuntime.make(TestClock.layer());
  await clock.runPromise(TestClock.setTime(Date.now()));

  const state = {
    open: false,
    built: 0,
    writeFails: false,
    useTools: false,
    hold: false,
    active: 0,
    peak: 0,
  };

  const provider = Layer.effect(
    Provider,
    Effect.acquireRelease(
      Effect.sync(() => {
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
                    const completed = Stream.fromEffect(
                      Effect.gen(function* () {
                        expect(state.open).toBe(true);
                        requests.push(request);
                        state.active++;
                        state.peak = Math.max(state.peak, state.active);

                        while (state.hold) yield* Effect.sleep("5 millis");

                        const save =
                          state.useTools &&
                          !request.messages.some((message) => message.role === "tool");

                        return {
                          type: "completed" as const,
                          response: {
                            output: save
                              ? [
                                  {
                                    type: "tool-call" as const,
                                    callId: "save",
                                    name: "save_note",
                                    namespace: "poppet_notes",
                                    arguments: '{"path":"summary.md","content":"A saved summary"}',
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

                    return state.useTools
                      ? completed
                      : Stream.concat(
                          Stream.make({ type: "text-delta" as const, text: "An" }),
                          completed,
                        );
                  },
                }),
        };
      }),
      () =>
        Effect.sync(() => {
          state.open = false;
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
    authentication: { consent: false, apiKey: false, help: "Test" },
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
        });

  const output: Console.Console = {
    ...console,
    log: (...values) => {
      lines.push(values.join(" "));
    },
    error: (...values) => {
      errors.push(values.join(" "));
    },
  };

  const program = (args: ReadonlyArray<string>) =>
    makeCLI(
      [unused, registration],
      write,
    )(args).pipe(Effect.provideService(Console.Console, output));

  return {
    directory,
    requests,
    lines,
    errors,
    chunks,
    state,
    clock,
    program,
    invoke: (args: ReadonlyArray<string>) => Effect.runPromise(program(args)),
    startWorker: async () => {
      const worker = clock.runFork(program(["tasks", "work"]));

      try {
        await Effect.runPromise(
          Effect.gen(function* () {
            while (!lines.some((line) => line.includes("Task worker running.")))
              yield* Effect.sleep("5 millis");
          }).pipe(Effect.timeout("5 seconds")),
        );
      } catch (error) {
        await Effect.runPromise(Fiber.interrupt(worker));
        throw error;
      }

      return worker;
    },
    close: async () => {
      await clock.dispose();

      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }

      await rm(directory, { recursive: true, force: true });
    },
  };
};

describe("chat CLI", () => {
  test("the worker accepts chats within a larger context budget and explains oversized requests", async () => {
    const chat = await fixture();
    process.env.POPPET_CONTEXT_BYTES = "1048576";
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

  test("an incomplete request body cannot keep the worker or its storage open during shutdown", async () => {
    const chat = await fixture();
    const worker = await chat.startWorker();
    const socket = createConnection(taskSocketPath(chat.directory));

    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      socket.write(
        "POST /commands HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{",
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

  test("failed, malformed, incomplete, and older worker replies never open local storage or replay a command", async () => {
    const chat = await fixture();
    const directory = join(chat.directory, "store");
    await mkdir(directory, { mode: 0o700 });
    const path = taskSocketPath(chat.directory);
    let delivered = 0;
    let reply = "";
    let contentType = "application/x-ndjson";

    const server = Bun.serve({
      unix: path,
      fetch() {
        delivered++;

        return new Response(reply, { headers: { "content-type": contentType } });
      },
    });

    await chmod(path, 0o600);

    try {
      for (const response of [
        '{"type":"failed","message":"Already saved."}\n',
        '{"type":"stdout","text":"Possibly saved"}\n',
        '{"type":"stdout"}\n',
        '{"type":"done"}\n{"type":"stdout","text":"Too late"}\n',
      ]) {
        reply = response;
        // Each response is selected before issuing the next request.
        // eslint-disable-next-line no-await-in-loop
        await expect(
          chat.invoke(["memory", "remember", "project", "Acorn"]),
        ).rejects.toHaveProperty("_tag", "TaskError");
      }

      reply = "Not found";
      contentType = "text/plain";
      await expect(chat.invoke(["memory", "remember", "project", "Acorn"])).rejects.toThrow(
        "outdated",
      );
      expect(delivered).toBe(5);
      expect(await readdir(directory)).toEqual(["tasks.sock"]);
      await chmod(path, 0o666);
      await expect(chat.invoke(["memory", "list"])).rejects.toThrow("not protected");
      expect(delivered).toBe(5);
    } finally {
      await server.stop(true);
      await chat.close();
    }
  });

  test("chat, memory, and inspection use the running worker and return to local execution after stop", async () => {
    const chat = await fixture();
    const worker = await chat.startWorker();
    const built = chat.state.built;

    const readOutput = async (args: ReadonlyArray<string>) => {
      chat.chunks.length = 0;
      await chat.invoke(args);

      return chat.chunks.join("");
    };

    try {
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
          { kind: "unknown" },
        ].map((command) =>
          fetch("http://localhost/commands", {
            unix: taskSocketPath(chat.directory),
            method: "POST",
            body: JSON.stringify(command),
          }),
        ),
      );

      expect(invalid.map((response) => response.status)).toEqual([400, 400, 400]);
      expect(
        JSON.parse(await readOutput(["memory", "remember", "project", "Acorn"])),
      ).toMatchObject({ key: "project", value: "Acorn" });
      expect(chat.state.built).toBe(built);
      chat.state.useTools = true;
      expect(await readOutput(["chat", "new", "--coding", "Save a summary"])).toBe("Answer\n");
      const session = chat.errors.find((line) => line.startsWith("Session: "))!.slice(9);
      expect(chat.requests[0]?.instructions).toContain("Acorn");
      expect(await readFile(join(chat.directory, "notes/summary.md"), "utf8")).toBe(
        "A saved summary",
      );
      expect(JSON.parse(await readOutput(["chat", "show", session]))).toMatchObject({
        runs: [{ status: "completed", workload: "coding" }],
        toolCalls: [{ status: "completed", name: "save_note" }],
      });
      expect(chat.chunks.join("")).not.toContain("secretOpaqueState");
      expect(JSON.parse(await readOutput(["chat", "sessions"]))).toHaveLength(1);
      expect(JSON.parse(await readOutput(["store", "status"]))).toMatchObject({ sessions: 1 });

      await readOutput(["memory", "replace", "project", "Birch"]);
      chat.state.useTools = false;
      process.env.POPPET_PROVIDER = "unused-provider";
      delete process.env.POPPET_MODEL;
      expect(await readOutput(["chat", "send", session, "Continue"])).toBe("Answer\n");
      expect(chat.requests.at(-1)?.instructions).toContain("Birch");
      await readOutput(["memory", "forget", "project"]);
      expect(await readOutput(["memory", "list"])).toBe("[]\n");
      expect(chat.lines.join("\n")).not.toContain("Save a summary");
      expect(chat.lines.join("\n")).not.toContain("Answer");

      await Effect.runPromise(Fiber.interrupt(worker));
      await chat.invoke(["chat", "show", session]);
      expect(JSON.parse(chat.lines.at(-1)!)).toMatchObject({
        runs: [{ status: "completed" }, { status: "completed" }],
      });
      await chat.invoke(["memory", "list"]);
      expect(chat.lines.at(-1)).toBe("[]");
    } finally {
      await Effect.runPromise(Fiber.interrupt(worker));
      await chat.close();
    }
  });

  test("stopping the worker interrupts active and queued chats and leaves sessions inspectable locally", async () => {
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
        }).pipe(Effect.timeout("5 seconds")),
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

  test("a disconnected chat releases the shared runner so queued chat and scheduled work can finish", async () => {
    const chat = await fixture();
    const worker = await chat.startWorker();
    chat.state.hold = true;
    const first = Effect.runFork(chat.program(["chat", "new", "Interrupted"]));

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          while (chat.requests.length === 0) yield* Effect.sleep("5 millis");
        }).pipe(Effect.timeout("5 seconds")),
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
        }).pipe(Effect.timeout("5 seconds")),
      );
      expect(chat.state.peak).toBe(1);
      chat.state.hold = false;
      await chat.clock.runPromise(TestClock.adjust("1 second"));
      await Effect.runPromise(Fiber.join(second));
      await Effect.runPromise(
        Effect.gen(function* () {
          while (chat.requests.length < 3 || chat.state.active !== 0)
            yield* Effect.sleep("5 millis");
        }).pipe(Effect.timeout("5 seconds")),
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

  test("loads CLI-managed facts and the editable profile in new and resumed chats", async () => {
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

  test("saves a requested note through chat and exposes tool execution in session inspection", async () => {
    const chat = await fixture();

    try {
      chat.state.useTools = true;
      await chat.invoke(["chat", "new", "Save a summary as summary.md"]);
      expect(chat.state.open).toBe(false);
      expect(chat.chunks.join("")).toBe("Answer\n");
      expect(await readFile(join(chat.directory, "notes/summary.md"), "utf8")).toBe(
        "A saved summary",
      );
      await chat.invoke(["chat", "show", chat.errors[0]?.slice("Session: ".length) ?? ""]);
      const saved = JSON.parse(chat.lines.at(-1) ?? "");
      expect(saved.toolCalls).toEqual([
        expect.objectContaining({
          name: "save_note",
          namespace: "poppet_notes",
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

  test("reopens a coding session using its saved selection and hides continuation when inspecting", async () => {
    const chat = await fixture();

    try {
      await chat.invoke(["chat", "new", "--coding", "First question"]);
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
      process.env.POPPET_PROVIDER = "unused-provider";
      delete process.env.POPPET_MODEL;
      process.env.POPPET_CONTEXT_BYTES = "invalid";
      await chat.invoke(["chat", "show", session.id]);
      expect(chat.lines.at(-1)).not.toContain("secretOpaqueState");
      expect(chat.lines.at(-1)).not.toContain("continuation");
      expect(JSON.parse(chat.lines.at(-1) ?? "")).toMatchObject({
        runs: [expect.objectContaining({ status: "completed", workload: "coding" })],
      });
      expect(chat.state.built).toBe(built);
      process.env.POPPET_CONTEXT_BYTES = "65536";
      await chat.invoke(["chat", "send", session.id, "Second question"]);
      expect(chat.state.open).toBe(false);
      expect(chat.requests[1]).toMatchObject({
        workload: "coding",
        messages: [
          { role: "user", text: "First question" },
          { role: "assistant", continuation: { data: { secretOpaqueState: "retain privately" } } },
          { role: "user", text: "Second question" },
        ],
        settings: {},
      });
      await chat.invoke(["chat", "show", session.id]);
      expect(JSON.parse(chat.lines.at(-1) ?? "").runs).toHaveLength(2);
    } finally {
      await chat.close();
    }
  });

  test("validates command arguments, model selection and budgets before contacting providers", async () => {
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

      delete process.env.POPPET_MODEL;
      await expect(chat.invoke(["chat", "new", "Hello"])).rejects.toMatchObject({
        reason: "invalid-request",
        message: expect.stringContaining("POPPET_MODEL"),
      });
      expect(await readdir(chat.directory)).toEqual([]);
      process.env.POPPET_MODEL = "chat-model";
      process.env.POPPET_OUTPUT_TOKENS = "0";
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

  test("a closed output stream interrupts the run and retains only the input", async () => {
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
