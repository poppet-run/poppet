import type { Agent } from "@poppet/agent";
import { Effect, Result } from "effect";

import { authorized, type GatewayContext } from "#src/context";
import type { Inbox } from "#src/repository";

export const conversationNaming = (context: GatewayContext, agent: Agent["Service"]) => {
  const { channel, repo, store } = context;

  // A failed or uncertain rename is inspected once, never blindly replayed.
  const syncName = (account: string, entry: Inbox) =>
    Effect.gen(function* () {
      const naming = channel.naming;
      const destination = entry.conversationId;

      if (destination === null || !authorized(channel.policy, entry.message)) return;

      const binding = yield* repo.namedBinding(channel.id, account, destination);

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
        conversation: destination,
        session: binding.sessionId,
      };

      const current = yield* naming.current(entry.message, destination);

      if (binding.pendingName !== null && current === binding.pendingName) {
        yield* repo.nameConfirmed(key, current);
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

      // A fresh fetch reconciles a lost acknowledgement without sending a second rename.
      const observed = yield* naming.current(entry.message, destination).pipe(Effect.result);

      if (Result.isSuccess(observed) && observed.success === desired)
        yield* repo.nameConfirmed(key, observed.success);
      else yield* repo.disableNaming(key);
    }).pipe(
      Effect.timeout("10 seconds"),
      Effect.catch(() =>
        entry.conversationId === null || entry.sessionId === null
          ? Effect.void
          : repo
              .disableNaming({
                adapter: channel.id,
                account,
                conversation: entry.conversationId,
                session: entry.sessionId,
              })
              .pipe(Effect.asVoid),
      ),
    );

  const nameNext = Effect.gen(function* () {
    const account = yield* channel.accountId;
    const entries = yield* repo.namingEntries(channel.id, account);

    for (const entry of entries) {
      if (entry.sessionId === null) continue;
      yield* agent.nameSession(entry.sessionId);
      yield* syncName(account, entry);
    }
  });

  const externalNameChange = (destination: string) =>
    Effect.gen(function* () {
      const account = yield* channel.accountId;
      const entry = yield* repo.namingEntry(channel.id, account, destination);

      if (!entry) return;

      const binding = yield* repo.namedBinding(channel.id, account, destination);

      if (!binding || binding.namingDisabled || binding.managedName === null) return;
      const current = yield* channel.naming.current(entry.message, destination);

      if (current !== binding.managedName && current !== binding.pendingName)
        yield* repo.disableNaming({
          adapter: channel.id,
          account,
          conversation: destination,
          session: binding.sessionId,
        });
    }).pipe(Effect.catch(() => Effect.void));

  return { nameNext, externalNameChange };
};
