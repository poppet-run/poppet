import { BunServices } from "@effect/platform-bun";
import type { ChannelRegistration } from "@poppet/gateway";
import type { ProviderRegistration } from "@poppet/provider";
import { Effect } from "effect";
import { CliConfig, CliOutput, Command, GlobalFlag } from "effect/cli";

import { channels } from "#src/channel-registry";
import { type ChatWriter, writeChatText, writeChatThinking } from "#src/chat";
import { readChatLine } from "#src/chat-prompt";
import { commandArgs } from "#src/command-args";
import { chatCommand } from "#src/commands/chat";
import { configCommand } from "#src/commands/config";
import { createCLIContext } from "#src/commands/context";
import { UsageError } from "#src/commands/errors";
import { gatewayCommand } from "#src/commands/gateway";
import { mcpCommand } from "#src/commands/mcp";
import { memoryCommand } from "#src/commands/memory";
import { projectsCommand } from "#src/commands/projects";
import { providerCommand } from "#src/commands/provider";
import { skillsCommand } from "#src/commands/skills";
import { storeCommand } from "#src/commands/store";
import { tasksCommand } from "#src/commands/tasks";
import { webCommand } from "#src/commands/web";
import { workerCommand } from "#src/commands/worker";
import { providers } from "#src/providers";
import { manageWorker } from "#src/worker";

export const makeCLI = (
  registered: ReadonlyArray<ProviderRegistration>,
  write: ChatWriter = writeChatText,
  worker: typeof manageWorker = manageWorker,
  registeredChannels: ReadonlyArray<ChannelRegistration> = channels,
  readLine = readChatLine,
  writeThinking: ChatWriter = writeChatThinking,
) => {
  const context = createCLIContext(
    registered,
    write,
    worker,
    registeredChannels,
    readLine,
    writeThinking,
  );

  const app = Command.make("poppet").pipe(
    Command.withDescription("A personal AI agent for local use"),
    Command.withSubcommands([
      chatCommand(context),
      configCommand(context),
      gatewayCommand(context),
      mcpCommand(context),
      memoryCommand(context),
      projectsCommand(context),
      providerCommand(context),
      skillsCommand(context),
      storeCommand(context),
      tasksCommand(context),
      webCommand(context),
      workerCommand(context),
    ]),
  );

  const execute = Command.runWith(app, { version: "0.0.0", renderErrors: false });

  return (args: ReadonlyArray<string>) =>
    execute(commandArgs(args, registeredChannels)).pipe(
      Effect.catchTag("ShowHelp", (error) =>
        CliOutput.Formatter.use((formatter) =>
          Effect.fail(new UsageError({ message: formatter.formatErrors(error.errors) })),
        ),
      ),
      // Parsing and help need platform services, but no application resources.
      Effect.provideService(CliConfig.CliConfig, CliConfig.make({ builtIns: [GlobalFlag.Help] })),
      Effect.provide(BunServices.layer),
    );
};

export const run = makeCLI(providers);
