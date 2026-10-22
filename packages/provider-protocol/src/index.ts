export { responsesModel } from "#src/responses";

export {
  chatCompletionsModel,
  type ChatContinuation,
  type ChatChunk,
  type ChatOptions,
} from "#src/chat-completions";

export {
  inferenceFailure,
  remoteFailure,
  safeIdentifier,
  type InferenceOptions,
} from "#src/errors";

export { openAIClient, fetchModelCatalog } from "#src/openai-compatible";
