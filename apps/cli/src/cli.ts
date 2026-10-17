import { BunServices } from "@effect/platform-bun";
import { ChatSettings, Skills } from "@poppet/agent";
import { AppConfig, ConfigSource, dataDirectory as configuredDataDirectory } from "@poppet/config";
import type { ChannelRegistration } from "@poppet/gateway";
import { MemoryKey, MemoryValue } from "@poppet/memory";
import type { WorkerAction } from "@poppet/platform";
import {
  CredentialInput,
  Provider,
  ProviderConnection,
  verifyModel,
  type ProviderRegistration,
  ProviderId,
} from "@poppet/provider";
import { Session, SessionSearchQuery, SkillName, Store } from "@poppet/store";
import {
  WorkerConnections,
  remoteTaskCommand,
  executeLocalTaskCommand,
  TaskCommand,
  TaskError,
  parseTimestamp,
  taskOperation,
  readLocalTaskStatus,
} from "@poppet/tasks";
import { workerSocketPath } from "@poppet/worker";
import { ConfigProvider, Console, Data, Effect, Layer, Option, Schema } from "effect";
import { Argument, CliConfig, CliOutput, Command, Flag, GlobalFlag } from "effect/cli";

import { readHiddenKey, readKeyStdin } from "#src/api-key-input";
import type { AuthCommand } from "#src/auth-command";
import { channels } from "#src/channel-registry";
import {
  MessagingWorkerLive,
  setupChannel,
  stoppedMessagingStatus,
  validateChannels,
} from "#src/channels";
import {
  inspectChat,
  type ChatCommand,
  MessageText,
  prepareChat,
  sendChat,
  writeChatText,
  writeChatThinking,
  type ChatWriter,
  type ChatReasoningWriter,
} from "#src/chat";
import { interactiveChat, interactiveChatOutput, readChatLine } from "#src/chat-prompt";
import { commandArgs } from "#src/command-args";
import { manageMemory, type MemoryCommand } from "#src/memory";
import { providers } from "#src/providers";
import { findProvider, runtimeLayers } from "#src/runtime";
import { prepareTask } from "#src/tasks";
import { manageWorker } from "#src/worker";
import { remoteWorkerCommand, WorkerRequestsLive, type WorkerCommand } from "#src/worker-commands";
import { runWorker, type WorkerMode } from "#src/worker-host";

class UsageError extends Data.TaggedError("UsageError")<{
  readonly message: string;
}> {}

const textArgument = (name: string) =>
  Argument.String(name).pipe(
    Argument.variadic({ min: 1 }),
    Argument.map((words) => words.join(" ")),
  );

const codingFlag = Flag.Boolean("coding").pipe(
  Flag.withDescription("Use the coding workload"),
  Flag.atMost(1),
  Flag.map(([value = false]) => value),
);

const skillFlag = Flag.String("skill").pipe(
  Flag.withSchema(SkillName),
  Flag.withDescription("Select a local Markdown skill and save its current text"),
  Flag.atMost(1),
  Flag.map(([value]) => value),
);

const showConfig = Effect.gen(function* () {
  yield* Console.log(
    JSON.stringify(
      { ...(yield* AppConfig), chat: yield* ChatSettings, ...(yield* ConfigSource) },
      null,
      2,
    ),
  );
});

export const makeCLI = (
  registered: ReadonlyArray<ProviderRegistration>,
  write: ChatWriter = writeChatText,
  worker: typeof manageWorker = manageWorker,
  registeredChannels: ReadonlyArray<ChannelRegistration> = channels,
  readLine = readChatLine,
  writeThinking: ChatWriter = writeChatThinking,
) => {
  const runtime = runtimeLayers(registered);
  validateChannels(registeredChannels);

  const startWorker = (mode: WorkerMode) =>
    runWorker(mode).pipe(
      Effect.provide(
        WorkerRequestsLive.pipe(
          Layer.provideMerge(
            mode === "tasks" ? Layer.empty : MessagingWorkerLive(registeredChannels),
          ),
          Layer.provideMerge(runtime.tasks),
          Layer.provideMerge(runtime.chat),
        ),
      ),
    );

  const throughWorker = <E>(
    command: WorkerCommand,
    local: Effect.Effect<void, E>,
    onSession: ChatWriter = () => Effect.void,
    output?: {
      readonly answer: ChatWriter;
      readonly reasoning: ChatReasoningWriter;
      readonly announce: ChatWriter;
    },
  ) =>
    Effect.gen(function* () {
      const config = yield* AppConfig;

      const handled = yield* remoteWorkerCommand(
        workerSocketPath(config.dataDirectory),
        command,
        output?.answer ?? write,
        onSession,
        output?.reasoning,
        output?.announce,
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

  const runMemory = (command: MemoryCommand) =>
    throughWorker(
      { kind: "memory", command },
      manageMemory(command).pipe(
        Effect.provide(runtime.memory),
        Effect.flatMap((text) => Console.log(text)),
      ),
    );

  const runWorkerCommand = (action: WorkerAction) => {
    if (action === "stop" || action === "uninstall" || action === "logs")
      return configuredDataDirectory
        .parse(ConfigProvider.fromEnv({ preserveEmptyStrings: true }))
        .pipe(
          Effect.flatMap((directory) => worker(action, directory)),
          Effect.flatMap((managed) => Console.log(managed)),
        );

    return Effect.gen(function* () {
      const config = yield* AppConfig;
      const managed = yield* worker(action, config.dataDirectory);

      if (action !== "status") return yield* Console.log(managed);

      const reply = yield* remoteTaskCommand(workerSocketPath(config.dataDirectory), {
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
  };

  const runTasks = (command: TaskCommand) =>
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const reply = yield* remoteTaskCommand(workerSocketPath(config.dataDirectory), command);

      if (reply !== null) return yield* Console.log(JSON.stringify(reply.value, null, 2));

      const result = yield* executeLocalTaskCommand(command).pipe(Effect.provide(runtime.tasks));
      yield* Console.log(JSON.stringify(result, null, 2));
    }).pipe(Effect.provide(runtime.config));

  const runChat = (
    command: ChatCommand,
    onSession: ChatWriter = () => Effect.void,
    interactive = false,
  ) => {
    if (
      command.action === "show" ||
      command.action === "sessions" ||
      command.action === "rename" ||
      command.action === "search"
    ) {
      const inspection =
        command.action === "search"
          ? ChatSettings.pipe(
              Effect.flatMap(({ toolBytes }) => inspectChat(command, toolBytes)),
              Effect.provide(runtime.chatSettings),
            )
          : inspectChat(command);

      return throughWorker(
        { kind: "chat", command },
        inspection.pipe(
          Effect.provide(runtime.store),
          Effect.flatMap((text) => Console.log(text)),
        ),
      );
    }

    return Effect.scoped(
      Effect.gen(function* () {
        const output = interactive ? yield* interactiveChatOutput(write, writeThinking) : undefined;
        const submission = yield* prepareChat(command);

        yield* throughWorker(
          { kind: "chat", command: submission },
          sendChat(
            submission,
            output?.answer ?? write,
            (text, sessionId) =>
              Effect.gen(function* () {
                if (sessionId !== undefined) yield* onSession(sessionId);
                yield* output?.announce(text) ?? Console.error(text);
              }),
            output === undefined ? {} : { write: output.reasoning, log: () => Effect.void },
          ).pipe(Effect.provide(runtime.chat)),
          onSession,
          output,
        );
      }).pipe(Effect.provide(runtime.config)),
    );
  };

  const providerHelp = registered
    .map((entry) => `${entry.id} (${entry.name}): ${entry.authentication.help}`)
    .join("\n");

  const authCommands = (["login", "status", "models", "verify", "logout"] as const).map(
    (action) => {
      const targetArgument = Argument.String(action === "verify" ? "model" : "provider").pipe(
        Argument.optional,
      );

      const providerFlag = Flag.String("provider").pipe(
        Flag.withSchema(ProviderId),
        Flag.withDescription("Override the configured provider"),
        Flag.atMost(1),
        Flag.map(([value]) => Option.fromUndefinedOr(value)),
      );

      const config =
        action === "login"
          ? {
              target: targetArgument,
              provider: providerFlag,
              consent: Flag.Boolean("consent").pipe(
                Flag.withDescription("Request ChatGPT consent"),
                Flag.atMost(1),
                Flag.map(([value = false]) => value),
              ),
              keyStdin: Flag.Boolean("key-stdin").pipe(
                Flag.withDescription("Read an API key from stdin"),
                Flag.atMost(1),
                Flag.map(([value = false]) => value),
              ),
            }
          : { target: targetArgument, provider: providerFlag };

      return Command.make(action, config, (input) =>
        Effect.gen(function* () {
          const target = Option.getOrNull(input.target);
          const provider = Option.getOrNull(input.provider);

          if (action !== "verify" && target !== null && provider !== null)
            return yield* Effect.fail(
              new UsageError({
                message: "Choose a provider either positionally or with --provider, not both.",
              }),
            );
          const selected = action === "verify" ? provider : (provider ?? target);

          if (selected !== null && !Schema.is(ProviderId)(selected))
            return yield* Effect.fail(new UsageError({ message: "Invalid provider ID." }));
          yield* runAuth({
            action,
            provider: selected,
            model: action === "verify" ? target : null,
            consent: input.consent ?? false,
            keyStdin: input.keyStdin ?? false,
          });
        }).pipe(Effect.provide(runtime.config)),
      ).pipe(
        Command.withDescription(
          {
            login: "Sign in or save an API key",
            status: "Show connection status without secrets",
            models: "List available models",
            verify: "Verify inference and a local tool round trip",
            logout: "Clear the selected provider",
          }[action],
        ),
      );
    },
  );

  const chat = Command.make("chat").pipe(
    Command.withDescription("Chat with the configured provider and model"),
    Command.withSubcommands([
      Command.make(
        "interactive",
        {
          id: Argument.String("session").pipe(
            Argument.withSchema(Session.fields.id),
            Argument.optional,
          ),
          coding: codingFlag,
          skill: skillFlag,
        },
        ({ id, coding, skill }) =>
          interactiveChat(
            { sessionId: Option.getOrUndefined(id), coding, skill },
            (command, onSession) => runChat(command, onSession, true),
            readLine,
          ),
      ).pipe(Command.withDescription("Open a terminal prompt for a new or saved session")),
      Command.make(
        "new",
        {
          coding: codingFlag,
          skill: skillFlag,
          text: textArgument("message").pipe(Argument.withSchema(MessageText)),
        },
        ({ coding, text, skill }) => {
          const command: ChatCommand = { action: "new", coding, text };

          return runChat(skill === undefined ? command : { ...command, skill });
        },
      ).pipe(Command.withDescription("Start a session")),
      Command.make(
        "send",
        {
          id: Argument.String("session").pipe(Argument.withSchema(Session.fields.id)),
          text: textArgument("message").pipe(Argument.withSchema(MessageText)),
        },
        ({ id, text }) => runChat({ action: "send", id, text }),
      ).pipe(Command.withDescription("Continue a saved session")),
      Command.make(
        "rename",
        {
          id: Argument.String("session").pipe(Argument.withSchema(Session.fields.id)),
          text: textArgument("title").pipe(Argument.withSchema(MessageText)),
        },
        ({ id, text }) => runChat({ action: "rename", id, text }),
      ).pipe(Command.withDescription("Rename a saved session")),
      Command.make("sessions", {}, () => runChat({ action: "sessions" })).pipe(
        Command.withDescription("List sessions"),
      ),
      Command.make(
        "search",
        { query: textArgument("query").pipe(Argument.withSchema(SessionSearchQuery)) },
        ({ query }) => runChat({ action: "search", query }),
      ).pipe(Command.withDescription("Search completed conversations")),
      Command.make(
        "show",
        {
          id: Argument.String("session").pipe(Argument.withSchema(Session.fields.id)),
        },
        ({ id }) => runChat({ action: "show", id }),
      ).pipe(Command.withDescription("Show messages and run outcomes")),
    ]),
  );

  const memory = Command.make("memory").pipe(
    Command.withDescription("Manage explicitly saved facts"),
    Command.withSubcommands([
      Command.make("list", {}, () => runMemory({ action: "list" })).pipe(
        Command.withDescription("List saved facts"),
      ),
      ...(["remember", "replace"] as const).map((action) =>
        Command.make(
          action,
          {
            key: Argument.String("key").pipe(Argument.withSchema(MemoryKey)),
            value: textArgument("value").pipe(Argument.withSchema(MemoryValue)),
          },
          ({ key, value }) => runMemory({ action, key, value }),
        ).pipe(
          Command.withDescription(
            action === "remember" ? "Save a new fact" : "Change an existing fact",
          ),
        ),
      ),
      Command.make(
        "forget",
        {
          key: Argument.String("key").pipe(Argument.withSchema(MemoryKey)),
        },
        ({ key }) => runMemory({ action: "forget", key }),
      ).pipe(Command.withDescription("Delete a fact")),
    ]),
  );

  const tasks = Command.make("tasks").pipe(
    Command.withDescription("Schedule and manage requests"),
    Command.withSubcommands([
      Command.make(
        "add",
        {
          name: Argument.String("name"),
          at: Flag.String("at").pipe(
            Flag.withDescription("One-off timestamp with timezone"),
            Flag.atMost(1),
            Flag.map(([value]) => Option.fromUndefinedOr(value)),
          ),
          cron: Flag.String("cron").pipe(
            Flag.withDescription("Recurring cron expression"),
            Flag.atMost(1),
            Flag.map(([value]) => Option.fromUndefinedOr(value)),
          ),
          tz: Flag.String("tz").pipe(
            Flag.withDescription("Timezone for --cron"),
            Flag.atMost(1),
            Flag.map(([value]) => Option.fromUndefinedOr(value)),
          ),
          coding: codingFlag,
          skill: skillFlag,
          discordThread: Flag.String("discord-thread").pipe(
            Flag.withSchema(Schema.NonEmptyString.check(Schema.isPattern(/^[0-9]{1,20}$/))),
            Flag.withDescription("Send each completed result to this authorized Discord thread"),
            Flag.atMost(1),
            Flag.map(([value]) => value),
          ),
          telegramChat: Flag.String("telegram-chat").pipe(
            Flag.withSchema(Schema.NonEmptyString.check(Schema.isPattern(/^[1-9][0-9]{0,15}$/))),
            Flag.withDescription(
              "Send each completed result to the configured owner's private Telegram chat",
            ),
            Flag.atMost(1),
            Flag.map(([value]) => value),
          ),
          whatsappChat: Flag.String("whatsapp-chat").pipe(
            Flag.withSchema(Schema.String.check(Schema.isPattern(/^[1-9]\d{6,14}$/))),
            Flag.withDescription(
              "Send each completed result to the configured WhatsApp owner phone",
            ),
            Flag.atMost(1),
            Flag.map(([value]) => value),
          ),
          prompt: textArgument("prompt"),
        },
        ({
          name,
          at,
          cron,
          tz,
          coding,
          prompt,
          skill,
          discordThread,
          telegramChat,
          whatsappChat,
        }) =>
          Effect.gen(function* () {
            const schedule = yield* taskOperation(() => {
              if (Option.isSome(at) && Option.isNone(cron) && Option.isNone(tz))
                return { type: "once" as const, at: parseTimestamp(at.value) };

              if (Option.isNone(at) && Option.isSome(cron) && Option.isSome(tz))
                return { type: "cron" as const, expression: cron.value, timezone: tz.value };
              throw new TaskError({
                message: "Use either --at <timestamp> or --cron <expression> --tz <timezone>.",
              });
            });

            if (
              [discordThread, telegramChat, whatsappChat].filter((value) => value !== undefined)
                .length > 1
            )
              return yield* Effect.fail(
                new TaskError({ message: "Choose only one messaging destination." }),
              );

            const delivery =
              discordThread !== undefined
                ? { adapter: "discord", conversationId: discordThread }
                : telegramChat !== undefined
                  ? { adapter: "telegram", conversationId: telegramChat }
                  : whatsappChat !== undefined
                    ? { adapter: "whatsapp", conversationId: whatsappChat }
                    : undefined;

            const command = yield* prepareTask(name, schedule, coding, prompt, skill, delivery);

            yield* runTasks(command);
          }).pipe(Effect.provide(runtime.config)),
      ).pipe(
        Command.withDescription("Schedule a request"),
        Command.withExamples([
          { command: 'bun run start tasks add Later --at 2099-10-15T09:00:00Z "Review notes"' },
          {
            command:
              'bun run start tasks add Daily --cron "0 9 * * *" --tz Europe/London "Review notes"',
          },
        ]),
      ),
      ...(["list", "providers", "clear", "status"] as const).map((action) =>
        Command.make(action, {}, () => runTasks({ action })).pipe(
          Command.withDescription(
            {
              list: "List saved tasks",
              providers: "Show provider quota pauses and temporary backoff",
              clear: "Interrupt active work and remove all tasks and task history",
              status: "Show task counts, recent outcomes, and worker status",
            }[action],
          ),
        ),
      ),
      ...(["show", "pause", "resume", "cancel", "retry"] as const).map((action) =>
        Command.make(
          action,
          {
            id: Argument.String(
              action === "cancel" || action === "retry" ? "occurrence" : "task",
            ).pipe(Argument.withSchema(Session.fields.id)),
          },
          ({ id }) => runTasks({ action, id }),
        ).pipe(
          Command.withDescription(
            {
              show: "Show occurrences, results, and skipped intervals",
              pause: "Pause scheduling and cancel pending work",
              resume: "Resume future occurrences",
              cancel: "Cancel pending or active work",
              retry: "Explicitly retry an unsuccessful occurrence",
            }[action],
          ),
        ),
      ),
      Command.make(
        "resume-provider",
        {
          provider: Argument.String("provider").pipe(Argument.withSchema(ProviderId)),
        },
        ({ provider }) => runTasks({ action: "resume-provider", provider }),
      ).pipe(Command.withDescription("Allow scheduled requests again")),
      Command.make("work", {}, () => startWorker("tasks")).pipe(
        Command.withDescription("Run scheduling only in the foreground"),
      ),
    ]),
  );

  const gateway = Command.make("gateway").pipe(
    Command.withDescription("Set up and run messaging channels"),
    Command.withSubcommands([
      ...registeredChannels.map((entry) =>
        Command.make(
          entry.id,
          {
            args: Argument.String("args").pipe(Argument.variadic()),
          },
          ({ args }) =>
            setupChannel(registeredChannels, [entry.id, ...args]).pipe(
              Effect.provide(runtime.config),
            ),
        ).pipe(Command.withDescription(`${entry.name}: gateway ${entry.id} ${entry.setupHelp}`)),
      ),
      Command.make("work", {}, () => startWorker("gateway")).pipe(
        Command.withDescription("Run messaging only in the foreground"),
      ),
      Command.make("status", {}, () =>
        throughWorker(
          { kind: "gateway" },
          stoppedMessagingStatus(registeredChannels).pipe(
            Effect.flatMap((status) => Console.log(JSON.stringify(status, null, 2))),
            Effect.provide(runtime.messagingStatus),
          ),
        ),
      ).pipe(Command.withDescription("Show messaging connection, queue, and delivery status")),
    ]),
  );

  const workerCommand = Command.make("worker").pipe(
    Command.withDescription("Run and manage the background worker"),
    Command.withSubcommands([
      Command.make("run", {}, () => startWorker("all")).pipe(
        Command.withDescription("Run scheduling and messaging in one foreground worker"),
      ),
      ...(["install", "start", "stop", "status", "logs", "uninstall"] as const).map((action) =>
        Command.make(action, {}, () => runWorkerCommand(action)).pipe(
          Command.withDescription(
            {
              install: "Install and start the macOS login worker",
              start: "Start an installed worker",
              stop: "Stop it until the next login or explicit start",
              status: "Show launch agent, scheduling, and connection status",
              logs: "Print the last 64 KiB of worker logs",
              uninstall: "Stop and remove login startup; retain saved data",
            }[action],
          ),
        ),
      ),
    ]),
  );

  const app = Command.make("bun run start").pipe(
    Command.withDescription(`Poppet\n\nProviders:\n${providerHelp}`),
    Command.withSubcommands([
      Command.make("config", {}, () =>
        showConfig.pipe(Effect.provide(Layer.merge(runtime.config, runtime.chatSettings))),
      ).pipe(Command.withDescription("Show validated configuration")),
      Command.make("store").pipe(
        Command.withDescription("Inspect the conversation store"),
        Command.withSubcommands([
          Command.make("status", {}, () =>
            throughWorker(
              { kind: "store" },
              Store.use((store) =>
                store.status.pipe(
                  Effect.flatMap((status) => Console.log(JSON.stringify(status, null, 2))),
                ),
              ).pipe(Effect.provide(runtime.store)),
            ),
          ).pipe(Command.withDescription("Open/migrate the conversation store and show counts")),
        ]),
      ),
      Command.make("auth").pipe(
        Command.withDescription(`Manage provider connections\n\n${providerHelp}`),
        Command.withShortDescription("Manage provider connections"),
        Command.withSubcommands(authCommands),
      ),
      Command.make("provider").pipe(
        Command.withDescription("Inspect and verify the configured provider"),
        Command.withSubcommands([
          Command.make("models", {}, () =>
            Effect.gen(function* () {
              const provider = yield* Provider;
              yield* Console.log(JSON.stringify(yield* provider.models, null, 2));
            }).pipe(Effect.provide(runtime.provider)),
          ).pipe(Command.withDescription("List supported models")),
          Command.make("verify", {}, () =>
            Effect.scoped(
              Effect.gen(function* () {
                const model = yield* runtime.resolveModel;
                yield* verifyModel(model);
                yield* Console.log(
                  `Provider verification passed with ${model.description.provider}/${model.description.id}. Completed inference and one local tool round trip.`,
                );
              }),
            ).pipe(Effect.provide(runtime.config)),
          ).pipe(Command.withDescription("Verify the configured model with a local tool")),
        ]),
      ),
      Command.make("skills").pipe(
        Command.withDescription("Inspect local Markdown skills"),
        Command.withSubcommands([
          Command.make("list", {}, () =>
            Skills.use((skills) => skills.list).pipe(
              Effect.flatMap((names) => Console.log(JSON.stringify(names, null, 2))),
              Effect.provide(runtime.skills),
            ),
          ),
          Command.make(
            "show",
            { name: Argument.String("name").pipe(Argument.withSchema(SkillName)) },
            ({ name }) =>
              Skills.use((skills) => skills.load(name)).pipe(
                Effect.flatMap((skill) => Console.log(skill.content)),
                Effect.provide(runtime.skills),
              ),
          ),
        ]),
      ),
      chat,
      memory,
      tasks,
      gateway,
      workerCommand,
    ]),
  );

  const execute = Command.runWith(app, { version: "0.0.0", renderErrors: false });

  return (args: ReadonlyArray<string>) =>
    execute(commandArgs(args, registeredChannels)).pipe(
      Effect.catchTag("ShowHelp", (error) =>
        Effect.gen(function* () {
          const formatter = yield* CliOutput.Formatter;

          return yield* Effect.fail(
            new UsageError({ message: formatter.formatErrors(error.errors) }),
          );
        }),
      ),
      // Parsing and help need platform services, but no application resources.
      Effect.provideService(CliConfig.CliConfig, CliConfig.make({ builtIns: [GlobalFlag.Help] })),
      Effect.provide(BunServices.layer),
    );
};

export const run = makeCLI(providers);
