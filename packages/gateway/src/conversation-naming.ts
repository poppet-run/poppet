import type { Agent } from "@poppet/agent";
import { Effect, Result } from "effect";

import { ChannelError } from "#src/channel";
import { authorized, type GatewayContext } from "#src/context";
import type { Inbox } from "#src/repository";

const definitiveNamingFailure = (cause: unknown) =>
  cause instanceof ChannelError && (cause.reason === "permission" || cause.reason === "configuration");

export const conversationNaming = (context: GatewayContext, agent: Agent["Service"]) => {
  const { channel, repo, store } = context;
  const scope = channel.policy.scopeId;

  const syncName = (account: string, entry: Inbox) =>
    Effect.gen(function* () {
      const naming = channel.naming;
      const destination = entry.conversationId;

      if (destination === null || !authorized(channel.policy, entry.message)) return;

      const binding = yield* repo.namedBinding(channel.id, account, scope, destination);

      if (
        !binding ||
        binding.sessionId !== entry.sessionId ||
        binding.namingDisabled ||
        binding.managedName === null ||
        binding.creationMessageId === null
      )
        return;

      const key = {
        adapter: channel.id,
        account,
        scope,
        conversation: destination,
        session: binding.sessionId,
      };

      const current = yield* naming.current(entry.message, destination);

      if (binding.pendingName !== null && current === binding.pendingName) {
        yield* repo.nameConfirmed(key, current);
      } else if (binding.pendingName !== null && current === binding.managedName) {
        yield* repo.clearPendingName(key);
      } else if (current !== binding.managedName || binding.pendingName !== null) {
        yield* repo.disableNaming(key);

        return;
      }

      const session = yield* store.session(binding.sessionId);
      const title = session?.title;
      yield* repo.nameAttempted(key, title ?? null);

      if (!title || naming.sanitize(title) === current) return;
      const desired = naming.sanitize(title);

      const pending = yield* repo.namePending(key, desired);

      if (!pending) return;

      const result = yield* naming
        .rename(entry.message, destination, current, desired)
        .pipe(Effect.result);

      if (Result.isSuccess(result)) {
        const confirmed = result.success;

        if (confirmed === null) yield* repo.disableNaming(key);
        else yield* repo.nameConfirmed(key, confirmed);

        return;
      }

      const observed = yield* naming.current(entry.message, destination).pipe(Effect.result);

      if (Result.isSuccess(observed)) {
        if (observed.success === desired) yield* repo.nameConfirmed(key, observed.success);
        else if (observed.success !== current || definitiveNamingFailure(result.failure))
          yield* repo.disableNaming(key);
        else yield* repo.clearPendingName(key);
      } else if (definitiveNamingFailure(result.failure)) {
        yield* repo.disableNaming(key);
      }
    }).pipe(
      Effect.timeout("10 seconds"),
      Effect.catch((cause) =>
        definitiveNamingFailure(cause) && entry.conversationId !== null && entry.sessionId !== null
          ? repo
              .disableNaming({
                adapter: channel.id,
                account,
                scope,
                conversation: entry.conversationId,
                session: entry.sessionId,
              })
              .pipe(Effect.asVoid)
          : Effect.void,
      ),
    );

  const nameNext = Effect.gen(function* () {
    const account = yield* channel.accountId;

    const entries = yield* repo.namingEntries(
      channel.id,
      account,
      channel.policy.scopeId,
      channel.policy.ownerId,
    );

    for (const entry of entries) {
      if (entry.sessionId === null) continue;
      yield* agent.nameSession(entry.sessionId);
      yield* syncName(account, entry);
    }
  });

  const externalNameChange = (destination: string) =>
    Effect.gen(function* () {
      const account = yield* channel.accountId;
      const entry = yield* repo.namingEntry(channel.id, account, scope, destination);

      if (!entry) return;

      const binding = yield* repo.namedBinding(channel.id, account, scope, destination);

      if (!binding || binding.namingDisabled || binding.managedName === null) return;

      const current = yield* channel.naming.current(entry.message, destination);

      if (current !== binding.managedName && current !== binding.pendingName)
        yield* repo.disableNaming({
          adapter: channel.id,
          account,
          scope,
          conversation: destination,
          session: binding.sessionId,
        });
    }).pipe(Effect.catch(() => Effect.void));

  return { nameNext, externalNameChange };
};
