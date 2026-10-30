import { AppConfig } from "@poppet/config";
import type { ChannelRegistration } from "@poppet/gateway";
import type { ProviderRegistration } from "@poppet/provider";
import { workerSocketPath } from "@poppet/worker";
import { Effect, Layer } from "effect";

import type { ChatWriter, ChatReasoningWriter } from "#src/commands/chat/chat";
import { readChatLine } from "#src/commands/chat/prompt";
import { MessagingWorkerLive, validateChannels } from "#src/commands/gateway/channels";
import { runWorker } from "#src/commands/worker/host";
import {
  remoteWorkerCommand,
  WorkerRequestsLive,
  type WorkerCommand,
} from "#src/commands/worker/requests";
import { manageWorker } from "#src/commands/worker/service";
import { runtimeLayers } from "#src/runtime";

export const createCLIContext = (
  registered: ReadonlyArray<ProviderRegistration>,
  write: ChatWriter,
  worker: typeof manageWorker,
  registeredChannels: ReadonlyArray<ChannelRegistration>,
  readLine: typeof readChatLine,
  writeThinking: ChatWriter,
) => {
  const runtime = runtimeLayers(registered);
  validateChannels(registeredChannels);

  const startWorker = () => {
    const requests = WorkerRequestsLive.pipe(
      Layer.provideMerge(MessagingWorkerLive(registeredChannels)),
      Layer.provideMerge(runtime.tasks),
      Layer.provideMerge(runtime.chat),
    );

    return runWorker.pipe(Effect.provide(requests));
  };

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

  return {
    registered,
    channels: registeredChannels,
    runtime,
    write,
    writeThinking,
    readLine,
    worker,
    startWorker,
    throughWorker,
  };
};

export type CLIContext = Readonly<ReturnType<typeof createCLIContext>>;
