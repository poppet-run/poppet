import { type Message, type ModelDescription } from "@poppet/provider";
import type { Run, StoredMessage } from "@poppet/store";

import { AgentError } from "#src/errors";
import type { ChatPolicy } from "#src/settings";

export const instructions =
  "You are Poppet, a helpful personal assistant. Answer the user's request clearly. No tools are available in this conversation.";

export const byteSize = (value: string) => new TextEncoder().encode(value).byteLength;

const invalidHistory = () =>
  new AgentError({
    reason: "history",
    message: "Stored history contains an incomplete or invalid exchange. Start a new session.",
  });

const validateExchange = (messages: ReadonlyArray<Message>) => {
  if (messages[0]?.role !== "user" || messages.at(-1)?.role !== "assistant") throw invalidHistory();
  const pending = new Set<string>();
  const used = new Set<string>();

  for (const message of messages) {
    if (message.role === "assistant") {
      if (pending.size > 0) throw invalidHistory();

      for (const part of message.output) {
        if (part.type !== "tool-call") continue;

        if (used.has(part.callId)) throw invalidHistory();
        pending.add(part.callId);
        used.add(part.callId);
      }
    } else if (message.role === "tool") {
      if (!pending.delete(message.callId)) throw invalidHistory();
    } else if (pending.size > 0) throw invalidHistory();
  }

  if (pending.size > 0) throw invalidHistory();
};

export const outputBudget = (model: ModelDescription, policy: ChatPolicy) =>
  Math.min(policy.outputTokens, model.capabilities.maxOutputTokens ?? policy.outputTokens);

const size = (messages: ReadonlyArray<Message>) =>
  byteSize(JSON.stringify({ instructions, messages, tools: [] }));

export const assembleContext = (
  history: ReadonlyArray<StoredMessage>,
  runs: ReadonlyArray<Run>,
  incoming: Message,
  model: ModelDescription,
  policy: ChatPolicy,
): ReadonlyArray<Message> => {
  const completed = new Set(runs.flatMap((run) => (run.status === "completed" ? [run.id] : [])));
  const exchanges: Message[][] = [];
  let current: Message[] = [];
  let previousRun: string | null = null;

  for (const entry of history) {
    if (entry.runId !== null && !completed.has(entry.runId)) continue;

    if (
      current.length > 0 &&
      (entry.runId !== previousRun ||
        (entry.runId === null &&
          entry.message.role === "user" &&
          current.at(-1)?.role === "assistant"))
    ) {
      validateExchange(current);
      exchanges.push(current);
      current = [];
    }

    current.push(entry.message);
    previousRun = entry.runId;
  }

  if (current.length > 0) {
    validateExchange(current);
    exchanges.push(current);
  }

  // UTF-8 bytes provide a conservative size estimate without a provider-specific
  // tokenizer. Keep room for the answer and wire-format overhead when metadata exists.
  const available =
    model.capabilities.contextWindow === null
      ? policy.contextBytes
      : Math.min(
          policy.contextBytes,
          Math.max(0, model.capabilities.contextWindow - outputBudget(model, policy) - 1024),
        );

  let selected: Message[] = [incoming];

  if (size(selected) > available)
    throw new AgentError({
      reason: "context-limit",
      message:
        "The new message exceeds the context budget. Shorten it or increase POPPET_CONTEXT_BYTES within the model's capacity.",
    });

  for (const exchange of exchanges.slice(-policy.historyTurns).toReversed()) {
    const candidate = [...exchange, ...selected];

    if (size(candidate) > available) break;
    selected = candidate;
  }

  return selected;
};
