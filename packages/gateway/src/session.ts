import { createHash } from "node:crypto";

import { sessionTitle, type Skills } from "@poppet/agent";
import type { AppConfig } from "@poppet/config";
import { Effect, Result } from "effect";

import { ChannelError } from "#src/channel";
import { finish, mark, type GatewayContext } from "#src/context";
import { gatewayStorage, type Inbox } from "#src/repository";
import { messagingRequest } from "#src/request";

/** What starting a new session needs: the configured model and the skill library. */
export interface SessionSetup {
  readonly config: AppConfig["Service"];
  readonly skills: Skills["Service"];
}

/** Resolves and binds a session before inference, reusing saved IDs and skill snapshots on recovery. */
export const prepareSession = (context: GatewayContext, setup: SessionSetup, entry: Inbox) =>
  Effect.gen(function* () {
    const { channel, repo, store } = context;
    const { config, skills } = setup;
    const account = yield* channel.accountId;

    const ownerText = entry.message.text;
    const parsed = yield* messagingRequest(ownerText).pipe(Effect.result);
    const prompt = Result.isSuccess(parsed) ? parsed.success.prompt : ownerText;

    const created =
      entry.conversationId !== null
        ? { id: entry.conversationId, managedName: null }
        : yield* channel.naming.conversation(entry.message, sessionTitle(prompt));

    const conversation = created.id;
    yield* channel.checkAccess(entry.message, conversation);

    const reject = (text: string) =>
      Effect.gen(function* () {
        yield* gatewayStorage(repo.address(entry.id, conversation));
        yield* finish(context, entry.id, text, "failed");
        yield* mark(context, entry.message, "stopped");

        return null;
      });

    if (Result.isFailure(parsed)) return yield* reject(parsed.failure.message);
    const request = parsed.success;

    const existing = yield* gatewayStorage(
      repo.binding(channel.id, account, entry.message.scopeId, conversation),
    );

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

    yield* gatewayStorage(
      repo.attach(entry.id, conversation, session.id, created.managedName, request.fresh),
    );

    return { conversation, session, prompt: request.prompt };
  });
