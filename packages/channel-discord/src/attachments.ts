import { ChannelError, type IncomingAttachment } from "@poppet/gateway";
import type { Attachment } from "discord.js";
import { Effect } from "effect";

// Discord serves uploads from these hosts; any other URL in an event is refused.
const hosts = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

type Fetch = (input: URL, init: RequestInit) => Promise<Response>;

/** The adapter-neutral form of a message's files, at most the gateway's ten. */
export const incomingAttachments = (
  attachments: Iterable<Pick<Attachment, "id" | "name" | "size" | "url">>,
): ReadonlyArray<IncomingAttachment> =>
  [...attachments].slice(0, 10).map((attachment) => ({
    id: attachment.id,
    name: [...(attachment.name || "attachment")].slice(0, 1024).join(""),
    size: attachment.size,
    ref: attachment.url,
  }));

const refused = (message: string) => new ChannelError({ reason: "permission", message });

const unavailable = () =>
  new ChannelError({
    reason: "unavailable",
    message: "Discord did not return the attachment. Try sending it again.",
  });

const tooLarge = (maxBytes: number) =>
  refused(
    maxBytes >= 1024 * 1024
      ? `the file is larger than ${Math.round((maxBytes / 1024 / 1024) * 10) / 10} MiB.`
      : `the file is larger than ${Math.round(maxBytes / 1024)} KiB.`,
  );

/**
 * Downloads an attachment from Discord's CDN within a deadline and a byte limit, counting the
 * bytes received rather than trusting the declared or reported size.
 */
export const downloadAttachment =
  (fetch: Fetch) => (attachment: IncomingAttachment, maxBytes: number) =>
    Effect.tryPromise({
      try: async (signal) => {
        const url = URL.parse(attachment.ref);

        if (url === null || url.protocol !== "https:" || !hosts.has(url.hostname))
          throw refused("the file is not hosted by Discord.");

        if ((attachment.size ?? 0) > maxBytes) throw tooLarge(maxBytes);

        const response = await fetch(url, {
          redirect: "manual",
          signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
        });

        if (response.status >= 300 && response.status < 400)
          throw refused("Discord redirected the download.");

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
