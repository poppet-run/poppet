import { createHash } from "node:crypto";

import { sessionTitle } from "@poppet/agent";
import type { AttachmentInput, Skills } from "@poppet/agent";
import type { AppConfig } from "@poppet/config";
import { Effect, Result } from "effect";

import { GatewayError } from "#src/adapter";
import { finish, mark } from "#src/pipeline/context";
import type { GatewayContext } from "#src/pipeline/context";
import { failureDecision } from "#src/pipeline/failure";
import { messagingRequest } from "#src/pipeline/request";
import type { Inbox } from "#src/repository";

export interface SessionSetup {
  readonly config: AppConfig["Service"];
  readonly skills: Skills["Service"];
  readonly attachmentBytes: number;
}

export const prepareSession = (
  context: GatewayContext,
  setup: SessionSetup,
  entry: Inbox,
  onConversation?: (conversation: string, sessionId?: string) => void,
) =>
  Effect.gen(function* () {
    const { adapter, repo, store } = context;
    const { config, skills } = setup;
    const account = yield* adapter.accountId;

    const ownerText = entry.message.text;
    const incoming = entry.message.attachments ?? [];
    const parsed = yield* messagingRequest(ownerText, incoming.length > 0).pipe(Effect.result);
    const prompt = Result.isSuccess(parsed) ? parsed.success.prompt : ownerText;

    const created =
      entry.conversationId !== null
        ? { id: entry.conversationId, managedName: null }
        : yield* adapter.naming.conversation(
            entry.message,
            sessionTitle(prompt.trim() || incoming[0]?.name || ""),
          );

    const conversation = created.id;
    onConversation?.(conversation);
    yield* adapter.checkAccess(entry.message, conversation);

    const reject = (text: string) =>
      Effect.gen(function* () {
        yield* repo.address(entry.id, conversation);
        yield* finish(context, entry.id, text, "failed");
        yield* mark(context, entry.message, "stopped");

        return null;
      });

    if (Result.isFailure(parsed)) {
      return yield* reject(parsed.failure.message);
    }

    const request = parsed.success;

    const attachments: Array<AttachmentInput> = [];

    for (const attachment of incoming) {
      if (adapter.download === undefined) {
        return yield* reject("This messaging channel cannot receive attachments.");
      }

      const downloaded = yield* adapter
        .download(attachment, setup.attachmentBytes)
        .pipe(Effect.result);

      if (Result.isSuccess(downloaded)) {
        attachments.push({ name: attachment.name, body: downloaded.success });
        continue;
      }

      const { message } = downloaded.failure;

      if (failureDecision(downloaded.failure, entry.attempts).retryAfterMs !== null) {
        return yield* Effect.fail(downloaded.failure);
      }

      return yield* reject(`Cannot attach ${JSON.stringify(attachment.name)}: ${message}`);
    }

    const existing = yield* repo.binding(adapter.id, account, entry.message.scopeId, conversation);

    const id =
      entry.sessionId ??
      (request.fresh ? null : existing) ??
      `gateway-${createHash("sha256")
        .update(
          JSON.stringify([
            adapter.id,
            account,
            entry.message.scopeId,
            conversation,
            ...(request.fresh ? [entry.runId] : []),
          ]),
        )
        .digest("hex")}`;

    let session = yield* store.session(id);

    if (session === null) {
      if (config.model === null) {
        return yield* Effect.fail(
          new GatewayError({
            reason: "configuration",
            message: "Select a model before starting messaging chat.",
          }),
        );
      }

      const selected = yield* (
        request.skill === null ? Effect.succeed(null) : skills.load(request.skill)
      ).pipe(Effect.result);

      if (Result.isFailure(selected)) {
        return yield* reject(
          "Could not load the selected skill. Check it with skills list and skills show before starting a new session.",
        );
      }

      session = yield* store.createSession(config.provider, config.model, {
        id,
        origin: `gateway:${adapter.id}`,
        skill: selected.success,
      });
    }

    yield* repo.attach(entry.id, conversation, session.id, created.managedName, request.fresh);
    onConversation?.(conversation, session.id);

    return { conversation, session, prompt: request.prompt, attachments };
  });
