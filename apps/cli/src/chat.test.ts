import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
import { Console, Effect, Layer, Stream } from "effect";

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
  const state = { open: false, built: 0, writeFails: false, useTools: false };

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
                  stream: (request: ModelRequest) =>
                    Stream.fromEffect(
                      Effect.sync(() => {
                        expect(state.open).toBe(true);
                        requests.push(request);

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
                    ),
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

  return {
    directory,
    requests,
    lines,
    errors,
    chunks,
    state,
    invoke: (args: ReadonlyArray<string>) =>
      Effect.runPromise(
        makeCLI(
          [unused, registration],
          write,
        )(args).pipe(Effect.provideService(Console.Console, output)),
      ),
    close: async () => {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }

      await rm(directory, { recursive: true, force: true });
    },
  };
};

describe("chat CLI", () => {
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
