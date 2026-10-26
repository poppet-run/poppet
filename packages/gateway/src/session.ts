import { createHash } from "node:crypto";

import { sessionTitle, type AttachmentInput, type Skills } from "@poppet/agent";
import type { AppConfig } from "@poppet/config";
import { Effect, Result } from "effect";

import { ChannelError } from "#src/channel";
import { finish, mark, type GatewayContext } from "#src/context";
import type { Inbox } from "#src/repository";
import { messagingRequest } from "#src/request";

/** What starting a new session needs: the configured model and the skill library. */
export interface SessionSetup {
  readonly config: AppConfig["Service"];
  readonly skills: Skills["Service"];
  /** The largest attachment the agent accepts; larger downloads are refused. */
  readonly attachmentBytes: number;
}

/** Resolves and binds a session before inference, reusing saved IDs and skill snapshots on recovery. */
export const prepareSession = (context: GatewayContext, setup: SessionSetup, entry: Inbox) =>
  Effect.gen(function* () {
    const { channel, repo, store } = context;
    const { config, skills } = setup;
    const account = yield* channel.accountId;

    const ownerText = entry.message.text;
    const incoming = entry.message.attachments ?? [];
    const parsed = yield* messagingRequest(ownerText, incoming.length > 0).pipe(Effect.result);
    const prompt = Result.isSuccess(parsed) ? parsed.success.prompt : ownerText;

    const created =
      entry.conversationId !== null
        ? { id: entry.conversationId, managedName: null }
        : yield* channel.naming.conversation(
            entry.message,
            sessionTitle(prompt.trim() || incoming[0]?.name || ""),
          );

    const conversation = created.id;
    yield* channel.checkAccess(entry.message, conversation);

    const reject = (text: string) =>
      Effect.gen(function* () {
        yield* repo.address(entry.id, conversation);
        yield* finish(context, entry.id, text, "failed");
        yield* mark(context, entry.message, "stopped");

        return null;
      });

    if (Result.isFailure(parsed)) return yield* reject(parsed.failure.message);
    const request = parsed.success;

    // Every file is needed; answering without one the owner sent would mislead them.
    const attachments: AttachmentInput[] = [];

    for (const attachment of incoming) {
      if (channel.download === undefined)
        return yield* reject("This messaging channel cannot receive attachments.");

      const downloaded = yield* channel
        .download(attachment, setup.attachmentBytes)
        .pipe(Effect.result);

      if (Result.isSuccess(downloaded)) {
        attachments.push({ name: attachment.name, body: downloaded.success });
        continue;
      }

      const { reason, message } = downloaded.failure;

      // Transient failures retry while no run is saved; others are answered now.
      if (reason === "unavailable" || reason === "uncertain")
        return yield* Effect.fail(downloaded.failure);

      return yield* reject(`Cannot attach ${JSON.stringify(attachment.name)}: ${message}`);
    }

    const existing = yield* repo.binding(channel.id, account, entry.message.scopeId, conversation);

    // Fresh requests include their reserved run ID so recovery reuses the same skill snapshot.
    const id =
      entry.sessionId ??
      (request.fresh ? null : existing) ??
      `gateway-${createHash("sha256")
        .update(
          JSON.stringify([
            channel.id,
            account,
            entry.message.scopeId,
            conversation,
            ...(request.fresh ? [entry.runId] : []),
          ]),
        )
        .digest("hex")}`;

    let session = yield* store.session(id);

    if (session === null) {
      if (config.model === null)
        return yield* Effect.fail(
          new ChannelError({
            reason: "configuration",
            message: "Select a model before starting messaging chat.",
          }),
        );

      const selected = yield* (
        request.skill === null ? Effect.succeed(null) : skills.load(request.skill)
      ).pipe(Effect.result);

      if (Result.isFailure(selected))
        return yield* reject(
          "Could not load the selected skill. Check it with skills list and skills show before starting a new session.",
        );

      session = yield* store.createSession(config.provider, config.model, {
        id,
        skill: selected.success,
      });
    }

    yield* repo.attach(entry.id, conversation, session.id, created.managedName, request.fresh);

    return { conversation, session, prompt: request.prompt, attachments };
  });
