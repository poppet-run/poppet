import { Effect } from "effect";

import { ChannelError, type IncomingAttachment } from "#src/channel";

export type AttachmentFetch = (input: URL, init: RequestInit) => Promise<Response>;

const refused = (message: string) => new ChannelError({ reason: "permission", message });

const unavailable = () =>
  new ChannelError({
    reason: "unavailable",
    message: "The server did not return the attachment. Try sending it again.",
  });

const tooLarge = (maxBytes: number) =>
  refused(
    maxBytes >= 1024 * 1024
      ? `the file is larger than ${Math.round((maxBytes / 1024 / 1024) * 10) / 10} MiB.`
      : `the file is larger than ${Math.round(maxBytes / 1024)} KiB.`,
  );

/**
 * Downloads an attachment from an adapter host within a deadline and a byte limit, counting the
 * bytes received rather than trusting the declared or reported size.
 */
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

        if (url === null || url.protocol !== "https:" || !hosts.has(url.hostname))
          throw refused(`the file is not hosted by ${label}.`);

        if ((attachment.size ?? 0) > maxBytes) throw tooLarge(maxBytes);

        const response = await fetch(url, {
          headers,
          redirect: "manual",
          signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
        });

        if (response.status >= 300 && response.status < 400)
          throw refused(`${label} redirected the download.`);

        if (!response.ok || response.body === null) throw unavailable();

        const chunks: Uint8Array[] = [];
        let received = 0;

        for await (const chunk of response.body) {
          received += chunk.length;

          if (received > maxBytes) throw tooLarge(maxBytes);
          chunks.push(chunk);
        }

        return Buffer.concat(chunks);
      },
      catch: (cause) => (cause instanceof ChannelError ? cause : unavailable()),
    });
