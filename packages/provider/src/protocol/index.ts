export { responsesModel } from "#src/protocol/responses";

export {
  chatCompletionsModel,
  type ChatContinuation,
  type ChatChunk,
  type ChatOptions,
} from "#src/protocol/chat-completions";

export {
  inferenceFailure,
  remoteFailure,
  safeIdentifier,
  type InferenceOptions,
  type RemoteReason,
} from "#src/protocol/errors";

export {
  openAIClient,
  fetchModelCatalog,
  createCatalogCache,
} from "#src/protocol/openai-compatible";

export { userParts, type UserPart } from "#src/protocol/attachments";

export { modelStream } from "#src/protocol/scoped-stream";
