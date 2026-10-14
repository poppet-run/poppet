import type { AgentError } from "@poppet/agent";
import { AppConfig } from "@poppet/config";
import type { MemoryError } from "@poppet/memory";
import { WorkerError } from "@poppet/platform";
import {
  CredentialInput,
  Model,
  Provider,
  ProviderConnection,
  verifyModel,
  type ProviderRegistration,
  type ProviderError,
} from "@poppet/provider";
import { Store, type StoreError } from "@poppet/store";
import {
  runTaskWorker,
  WorkerConnections,
  remoteTaskCommand,
  taskSocketPath,
  executeLocalTaskCommand,
  type TaskError,
  readLocalTaskStatus,
} from "@poppet/tasks";
import { Console, Data, Effect, Layer, type Config } from "effect";

import { readHiddenKey, readKeyStdin } from "#src/api-key-input";
import { parseAuthCommand, type AuthCommand } from "#src/auth-command";
import {
  inspectChat,
  parseChatCommand,
  prepareChat,
  sendChat,
  writeChatText,
  type ChatWriter,
} from "#src/chat";
import { manageMemory, parseMemoryCommand } from "#src/memory";
import { providers } from "#src/providers";
import { findProvider, runtimeLayers } from "#src/runtime";
import { parseTaskCommand } from "#src/tasks";
import { manageWorker, parseWorkerCommand } from "#src/worker";
import { remoteWorkerCommand, WorkerRequestsLive, type WorkerCommand } from "#src/worker-commands";

class UsageError extends Data.TaggedError("UsageError")<{
  readonly message: string;
}> {}

const help = (registered: ReadonlyArray<ProviderRegistration>) => `Poppet

Usage: bun run start [command]

Commands:
  config    Show validated configuration
  store status             Open/migrate the conversation store and show counts
  chat new [--coding] <message>  Start a session with the configured provider/model
  chat send <session> <message> Continue a saved session
  chat sessions            List sessions
  chat show <session>      Show messages and run outcomes
  memory list              List explicitly saved facts
  memory remember <key> <value>  Save a new fact
  memory replace <key> <value>   Change an existing fact
  memory forget <key>      Delete a fact
  tasks add <name> --at <timestamp> [--coding] <prompt>
  tasks add <name> --cron <expression> --tz <timezone> [--coding] <prompt>
  tasks list               List saved tasks
  tasks show <task>        Show occurrences, results, and skipped intervals
  tasks pause <task>       Pause scheduling and cancel pending work
  tasks resume <task>      Resume future occurrences
  tasks cancel <occurrence> Cancel pending or active work
  tasks retry <occurrence> Explicitly retry an unsuccessful occurrence
  tasks clear              Interrupt active work and remove all tasks and task history
  tasks providers          Show provider quota pauses and temporary backoff
  tasks resume-provider <provider> Allow scheduled requests again
  tasks status             Show task counts, recent outcomes, and worker status
  tasks work               Run the foreground task worker
  worker install           Install and start the macOS login worker
  worker start             Start an installed worker
  worker stop              Stop it until the next login or explicit start
  worker status            Show launch agent, scheduling, and connection status
  worker logs              Print the last 64 KiB of worker logs
  worker uninstall         Stop and remove login startup; retain saved data
  auth login [provider] [--consent | --key-stdin]  Sign in or save an API key
  auth status [provider]   Show connection status without secrets
  auth models [provider]   List available models
  auth verify [model]      Verify inference and a local tool round trip
  auth logout [provider]   Clear the selected provider

Auth accepts --provider <id> for any action, overriding POPPET_PROVIDER.
Providers: ${registered.map((entry) => entry.id).join(", ")}.
${registered.map((entry) => `${entry.name}: ${entry.authentication.help}`).join("\n")}
  provider models          List supported models for the configured provider
  provider verify          Verify the configured provider/model with a local tool
  --help    Show this help

Chat includes read_note, search_notes and save_note within POPPET_NOTES_DIR.
Chat loads <data directory>/profile.md and explicitly saved facts on each run.
Scheduled tasks use fresh sessions, current memory, and read-only note tools.
Run tasks work to execute them; task commands can reach the running worker.`;

const showConfig = Effect.gen(function* () {
  yield* Console.log(JSON.stringify(yield* AppConfig, null, 2));
});

export const makeCLI = (
  registered: ReadonlyArray<ProviderRegistration>,
  write: ChatWriter = writeChatText,
) => {
  const runtime = runtimeLayers(registered);

  const throughWorker = <E>(command: WorkerCommand, local: Effect.Effect<void, E>) =>
    Effect.gen(function* () {
      const config = yield* AppConfig;

      const handled = yield* remoteWorkerCommand(
        taskSocketPath(config.dataDirectory),
        command,
        write,
      );

      if (!handled) yield* local;
    }).pipe(Effect.provide(runtime.config));

  const runAuth = (command: AuthCommand) =>
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const selected = command.provider ?? config.provider;
      const entry = yield* findProvider(selected, registered);

      if (command.keyStdin && !entry.authentication.apiKey)
        return yield* Effect.fail(
          new UsageError({
            message: `${entry.name} does not support --key-stdin. ${entry.authentication.help}`,
          }),
        );

      if (command.consent && !entry.authentication.consent)
        return yield* Effect.fail(
          new UsageError({
            message: `${entry.name} does not support --consent. ${entry.authentication.help}`,
          }),
        );

      return yield* Effect.gen(function* () {
        if (command.action === "models") {
          const provider = yield* Provider;
          yield* Console.log(JSON.stringify(yield* provider.models, null, 2));

          return;
        }

        const connection = yield* ProviderConnection;

        if (command.action === "login") yield* Console.log(yield* connection.login(command));
        else if (command.action === "status")
          yield* Console.log(JSON.stringify(yield* connection.status, null, 2));
        else if (command.action === "logout") yield* Console.log(yield* connection.logout);
        else if (command.action === "verify") {
          const model = yield* connection.verify(command.model ?? config.model);
          yield* Console.log(
            `Provider verification passed with ${selected}/${model}. Completed inference and one local tool round trip.`,
          );
        }
      }).pipe(
        Effect.provide(runtime.selectedProvider(selected)),
        Effect.provideService(CredentialInput, {
          readKey: (provider, stdin) => (stdin ? readKeyStdin(provider) : readHiddenKey(provider)),
        }),
      );
    });

  return (
    args: ReadonlyArray<string>,
  ): Effect.Effect<
    void,
    | Config.ConfigError
    | ProviderError
    | StoreError
    | MemoryError
    | UsageError
    | AgentError
    | TaskError
    | WorkerError
  > => {
    // Help works before configuration or credential storage is opened.
    if (args.length === 0 || (args.length === 1 && (args[0] === "--help" || args[0] === "-h")))
      return Console.log(help(registered));

    if (args.length === 1 && args[0] === "config")
      return showConfig.pipe(Effect.provide(runtime.config));

    if (args.length === 2 && args[0] === "store" && args[1] === "status")
      return throughWorker(
        { kind: "store" },
        Store.use((store) =>
          store.status.pipe(
            Effect.flatMap((status) => Console.log(JSON.stringify(status, null, 2))),
          ),
        ).pipe(Effect.provide(runtime.store)),
      );

    if (args.length === 2 && args[0] === "provider" && args[1] === "models")
      return Effect.gen(function* () {
        const provider = yield* Provider;
        yield* Console.log(JSON.stringify(yield* provider.models, null, 2));
      }).pipe(Effect.provide(runtime.provider));

    if (args.length === 2 && args[0] === "provider" && args[1] === "verify")
      return Effect.gen(function* () {
        const model = yield* Model;
        yield* verifyModel(model);
        yield* Console.log(
          `Provider verification passed with ${model.description.provider}/${model.description.id}. Completed inference and one local tool round trip.`,
        );
      }).pipe(Effect.provide(runtime.model));

    if (args[0] === "auth") {
      const command = parseAuthCommand(args.slice(1));

      if (command !== null) return runAuth(command).pipe(Effect.provide(runtime.config));
    }

    if (args[0] === "memory") {
      // Validate arguments before acquiring the store and applying migrations.
      return parseMemoryCommand(args.slice(1)).pipe(
        Effect.flatMap((command) =>
          throughWorker(
            { kind: "memory", command },
            manageMemory(command).pipe(
              Effect.provide(runtime.memory),
              Effect.flatMap((text) => Console.log(text)),
            ),
          ),
        ),
      );
    }

    if (args[0] === "worker") {
      return Effect.gen(function* () {
        const action = yield* parseWorkerCommand(args.slice(1));

        const config = yield* AppConfig;
        const managed = yield* manageWorker(action, config);

        if (action !== "status") return yield* Console.log(managed);

        const reply = yield* remoteTaskCommand(taskSocketPath(config.dataDirectory), {
          action: "status",
        });

        if (reply !== null)
          return yield* Console.log(
            JSON.stringify({ launchAgent: managed, worker: reply.value }, null, 2),
          );

        const overview = yield* readLocalTaskStatus.pipe(Effect.provide(runtime.tasks));

        const ids = [...new Set([config.provider, ...overview.providers])];

        const connections = yield* WorkerConnections.use((service) =>
          Effect.forEach(ids, (id) => service.status(id)),
        ).pipe(Effect.provide(runtime.connections));

        yield* Console.log(
          JSON.stringify(
            {
              launchAgent: managed,
              worker: {
                ...overview,
                running: false,
                pid: null,
                startedAt: null,
                activeOccurrence: null,
                connections,
              },
            },
            null,
            2,
          ),
        );
      }).pipe(Effect.provide(runtime.config));
    }

    if (args[0] === "tasks") {
      if (args.length === 2 && args[1] === "work")
        return runTaskWorker.pipe(
          Effect.provide(
            Layer.merge(WorkerRequestsLive.pipe(Layer.provideMerge(runtime.chat)), runtime.tasks),
          ),
        );

      return Effect.gen(function* () {
        const command = yield* parseTaskCommand(args.slice(1));
        const config = yield* AppConfig;
        const reply = yield* remoteTaskCommand(taskSocketPath(config.dataDirectory), command);

        if (reply !== null) return yield* Console.log(JSON.stringify(reply.value, null, 2));

        const result = yield* executeLocalTaskCommand(command).pipe(Effect.provide(runtime.tasks));
        yield* Console.log(JSON.stringify(result, null, 2));
      }).pipe(Effect.provide(runtime.config));
    }

    if (args[0] === "chat") {
      const command = parseChatCommand(args.slice(1));

      if (command !== null) {
        if (command.action === "show" || command.action === "sessions")
          return throughWorker(
            { kind: "chat", command },
            inspectChat(command).pipe(
              Effect.provide(runtime.store),
              Effect.flatMap((text) => Console.log(text)),
            ),
          );

        return prepareChat(command).pipe(
          Effect.flatMap((submission) =>
            throughWorker(
              { kind: "chat", command: submission },
              sendChat(submission, write).pipe(Effect.provide(runtime.chat)),
            ),
          ),
          Effect.provide(runtime.config),
        );
      }
    }

    return Effect.fail(new UsageError({ message: "Unknown command. Run bun run start --help." }));
  };
};

export const run = makeCLI(providers);
