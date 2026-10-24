import { Agent } from "@poppet/agent";
import { Store } from "@poppet/store";
import { Effect, Result } from "effect";

import { MessagingChannel, type IncomingMessage } from "#src/channel";
import { GatewayRepository, gatewayStorage, type Inbox } from "#src/repository";

export const conversationNaming = (authorized: (message: IncomingMessage) => boolean) =>
  Effect.gen(function* () {
    const channel = yield* MessagingChannel;
    const repo = yield* GatewayRepository;
    const store = yield* Store;
    const agent = yield* Agent;

    // A failed or uncertain rename is inspected once, never blindly replayed.
    const syncName = (account: string, entry: Inbox) =>
      Effect.gen(function* () {
        const naming = channel.naming;
        const destination = entry.conversationId;

        if (destination === null || !authorized(entry.message)) return;

        const binding = yield* gatewayStorage(repo.namedBinding(channel.id, account, destination));

        if (
          !binding ||
          binding.sessionId !== entry.sessionId ||
          binding.namingDisabled ||
          binding.managedName === null ||
          binding.creationMessageId === null
        )
          return;
        const current = yield* naming.current(entry.message, destination);

        if (binding.pendingName !== null && current === binding.pendingName) {
          yield* gatewayStorage(
            repo.nameConfirmed(channel.id, account, destination, current, binding.sessionId),
          );
        } else if (current !== binding.managedName || binding.pendingName !== null) {
          yield* gatewayStorage(
            repo.disableNaming(channel.id, account, destination, binding.sessionId),
          );

          return;
        }

        const session = yield* store.session(binding.sessionId);
        const title = session?.title;
        yield* gatewayStorage(
          repo.nameAttempted(channel.id, account, destination, title ?? null, binding.sessionId),
        );

        if (!title || naming.sanitize(title) === current) return;
        const desired = naming.sanitize(title);

        const pending = yield* gatewayStorage(
          repo.namePending(channel.id, account, destination, desired, binding.sessionId),
        );

        if (!pending) return;

        const result = yield* naming
          .rename(entry.message, destination, current, desired)
          .pipe(Effect.result);

        if (Result.isSuccess(result)) {
          const confirmed = result.success;

          if (confirmed === null)
            yield* gatewayStorage(
              repo.disableNaming(channel.id, account, destination, binding.sessionId),
            );
          else
            yield* gatewayStorage(
              repo.nameConfirmed(channel.id, account, destination, confirmed, binding.sessionId),
            );

          return;
        }

        // A fresh fetch reconciles a lost acknowledgement without sending a second rename.
        const observed = yield* naming.current(entry.message, destination).pipe(Effect.result);

        if (Result.isSuccess(observed) && observed.success === desired)
          yield* gatewayStorage(
            repo.nameConfirmed(
              channel.id,
              account,
              destination,
              observed.success,
              binding.sessionId,
            ),
          );
        else
          yield* gatewayStorage(
            repo.disableNaming(channel.id, account, destination, binding.sessionId),
          );
      }).pipe(
        Effect.timeout("10 seconds"),
        Effect.catch(() =>
          entry.conversationId === null || entry.sessionId === null
            ? Effect.void
            : gatewayStorage(
                repo.disableNaming(channel.id, account, entry.conversationId!, entry.sessionId!),
              ).pipe(Effect.asVoid),
        ),
      );

    const nameNext = Effect.gen(function* () {
      const account = yield* channel.accountId;
      const entries = yield* gatewayStorage(repo.namingEntries(channel.id, account));

      for (const entry of entries) {
        if (entry.sessionId === null) continue;
        yield* agent.nameSession(entry.sessionId);
        yield* syncName(account, entry);
      }
    });

    const externalNameChange = (destination: string) =>
      Effect.gen(function* () {
        const account = yield* channel.accountId;
        const entry = yield* gatewayStorage(repo.namingEntry(channel.id, account, destination));

        if (!entry) return;

        const binding = yield* gatewayStorage(repo.namedBinding(channel.id, account, destination));

        if (!binding || binding.namingDisabled || binding.managedName === null) return;
        const current = yield* channel.naming.current(entry.message, destination);

        if (current !== binding.managedName && current !== binding.pendingName)
          yield* gatewayStorage(
            repo.disableNaming(channel.id, account, destination, binding.sessionId),
          );
      }).pipe(Effect.catch(() => Effect.void));

    return { nameNext, externalNameChange };
  });
