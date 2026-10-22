import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AppConfig } from "@poppet/config";
import { LocalMemoryLive } from "@poppet/memory";
import type { ModelRequest } from "@poppet/provider";
import {
  ApprovalRepository,
  ApprovalRepositoryLive,
  Store,
  StoreDatabase,
  StoreLive,
  type CommandProposal,
} from "@poppet/store";
import { ConfigProvider, Effect, Layer, Stream } from "effect";

import { Approvals, ApprovalsLive } from "#src/approvals";
import { runCommandProcess, type CommandOutcome } from "#src/command-process";
import { CommandReviewerLive } from "#src/command-reviewer";
import { Commands, CommandsLive, CommandRunner } from "#src/commands";
import { NotesLive } from "#src/notes";
import { Pages } from "#src/pages";
import { Agent, AgentLive, ModelResolver } from "#src/service";
import { ChatSettings, defaultPolicy } from "#src/settings";
import { WebSearch } from "#src/web-search";

interface FixtureState {
  executable: string;
  args: string[];
  cwd: string;
  enabled: boolean;
  automaticReads: boolean;
  executions: number;
  requests: ModelRequest[];
  reviewer: { provider: string; model: string } | undefined;
  advice: string;
  runner: ((payload: CommandProposal, signal: AbortSignal) => Promise<CommandOutcome>) | null;
}

export const fixture = async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "poppet-commands-test-")));
  const root = join(directory, "work");
  await mkdir(root);
  const alias = join(directory, "bun");
  await symlink(process.execPath, alias);

  const state: FixtureState = {
    executable: alias,
    args: [join(import.meta.dir, "command-fixture.ts"), "report", "", "a b", "$(touch nowhere)"],
    cwd: ".",
    enabled: true,
    automaticReads: false,
    executions: 0,
    requests: [],
    reviewer: undefined,
    advice: '{"verdict":"low_risk","explanation":"A recommendation, never permission."}',
    runner: null,
  };

  const config = Layer.succeed(AppConfig, {
    applicationName: "Test",
    dataDirectory: directory,
    notesDirectory: join(directory, "notes"),
    provider: "test",
    model: "model",
  });

  const settings = Layer.succeed(ChatSettings, defaultPolicy);
  const store = StoreLive.pipe(Layer.provideMerge(config));
  const repo = ApprovalRepositoryLive.pipe(Layer.provideMerge(store));
  const notes = NotesLive.pipe(Layer.provide([store, settings, config]));

  const models = Layer.succeed(ModelResolver, {
    resolve: (provider, model) =>
      Effect.succeed({
        description: {
          provider,
          id: model,
          name: "Test",
          capabilities: {
            tools: true,
            generationSettings: [],
            contextWindow: null,
            maxOutputTokens: null,
          },
        },
        stream: (request) => {
          state.requests.push(request);
          const reviewer = model === "reviewer";
          const call = !reviewer && request.messages.at(-1)?.role !== "tool";

          return Stream.make({
            type: "completed" as const,
            response: {
              output: call
                ? [
                    {
                      type: "tool-call" as const,
                      namespace: "poppet_commands",
                      name: "request_command",
                      callId: "command:one",
                      arguments: JSON.stringify({
                        executable: state.executable,
                        args: state.args,
                        cwd: state.cwd,
                      }),
                    },
                  ]
                : [
                    {
                      type: "text" as const,
                      text: reviewer ? state.advice : "Command request recorded",
                    },
                  ],
              continuation: { version: 1 as const, provider, model, data: {} },
              finishReason: call ? ("tool-calls" as const) : ("stop" as const),
              usage: null,
            },
          });
        },
      }),
  });

  const layer = () => {
    const policy = {
      enabled: state.enabled,
      executables: [alias, "/usr/bin/uname"],
      automaticReads: state.automaticReads,
    };

    const configured =
      state.reviewer === undefined ? policy : { ...policy, reviewer: state.reviewer };

    const environment = ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        POPPET_COMMANDS: JSON.stringify(configured),
      }),
    );

    const reviewer = CommandReviewerLive.pipe(Layer.provide([environment, models]));

    const commands = CommandsLive.pipe(
      Layer.provideMerge([repo, settings, environment]),
      Layer.provide(reviewer),
      Layer.provide(
        Layer.succeed(CommandRunner, {
          run: (payload, signal) => {
            state.executions++;

            return state.runner === null
              ? runCommandProcess(payload, signal, {
                  timeoutMs: 1500,
                  outputBytes: 65536,
                  graceMs: 50,
                  reapMs: 1000,
                })
              : state.runner(payload, signal);
          },
        }),
      ),
    );

    const approvals = ApprovalsLive.pipe(Layer.provideMerge([commands, notes, settings]));

    return AgentLive.pipe(
      Layer.provideMerge([
        approvals,
        models,
        LocalMemoryLive.pipe(Layer.provide(store)),
        Layer.succeed(Pages, { fetch: () => Effect.die("No network") }),
        Layer.succeed(WebSearch, { search: null }),
      ]),
    );
  };

  return {
    directory,
    root,
    alias,
    state,
    run: <A, E>(
      effect: Effect.Effect<
        A,
        E,
        Agent | Commands | Approvals | ApprovalRepository | Store | StoreDatabase
      >,
    ) => Effect.runPromise(effect.pipe(Effect.provide(layer()))),
    close: () => rm(directory, { recursive: true, force: true }),
  };
};

export const propose = (root: string) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const session = yield* store.createSession("test", "model");
    yield* Stream.runDrain(
      (yield* Agent).send(session.id, "Request this exact command for owner review.", {
        commandsRoot: root,
      }),
    );

    return { session, proposal: (yield* ApprovalRepository).list(Date.now())[0]! };
  });
