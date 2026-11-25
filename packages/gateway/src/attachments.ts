import { Effect } from "effect";

import { GatewayError } from "#src/adapter";
import type { IncomingAttachment } from "#src/adapter";

export type AttachmentFetch = (input: URL, init: RequestInit) => Promise<Response>;

const refused = (message: string) => new GatewayError({ reason: "permission", message });

const unavailable = () =>
  new GatewayError({
    reason: "unavailable",
    message: "The server did not return the attachment. Try sending it again.",
  });

const tooLarge = (maxBytes: number) =>
  refused(
    maxBytes >= 1024 * 1024
      ? `the file is larger than ${Math.round((maxBytes / 1024 / 1024) * 10) / 10} MiB.`
      : `the file is larger than ${Math.round(maxBytes / 1024)} KiB.`,
  );

export const boundedAttachment =
  (
    fetch: AttachmentFetch,
    hosts: ReadonlySet<string>,
    label: string,
    headers: RequestInit["headers"] = {},
  ) =>
  (attachment: IncomingAttachment, maxBytes: number) =>
    Effect.tryPromise({
      try: async (signal) => {
        const url = URL.parse(attachment.ref);

        if (
          url === null ||
          url.protocol !== "https:" ||
          url.port !== "" ||
          url.username !== "" ||
          url.password !== "" ||
          !hosts.has(url.hostname)
        ) {
          throw refused(`the file is not hosted by ${label}.`);
        }

        if ((attachment.size ?? 0) > maxBytes) {
          throw tooLarge(maxBytes);
        }

        const response = await fetch(url, {
          headers,
          redirect: "manual",
          signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        });

        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel().catch(() => {});
          throw refused(`${label} redirected the download.`);
        }

        if (!response.ok || response.body === null) {
          await response.body?.cancel().catch(() => {});
          throw unavailable();
        }

        const chunks: Array<Uint8Array> = [];
        let received = 0;
        const reader = response.body.getReader();

        try {
          while (true) {
            const result: { done: boolean; value?: unknown } = await reader.read();

            if (result.done) {
              break;
            }

            if (!(result.value instanceof Uint8Array)) {
              continue;
            }

            received += result.value.length;

            if (received > maxBytes) {
              throw tooLarge(maxBytes);
            }

            chunks.push(result.value);
          }
        } finally {
          reader.releaseLock();
        }

        return Buffer.concat(chunks);
      },
      catch: (cause) => (cause instanceof GatewayError ? cause : unavailable()),
    });
