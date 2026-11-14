import { boundedAttachment, type IncomingAttachment } from "@poppet/gateway";
import type { Attachment } from "discord.js";

const hosts = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

type Fetch = (input: URL, init: RequestInit) => Promise<Response>;

export const incomingAttachments = (
  attachments: Iterable<Pick<Attachment, "id" | "name" | "size" | "url">>,
): ReadonlyArray<IncomingAttachment> =>
  [...attachments].slice(0, 10).map((attachment) => ({
    id: attachment.id,
    name: [...(attachment.name || "attachment")].slice(0, 1024).join(""),
    size: attachment.size,
    ref: attachment.url,
  }));

export const downloadAttachment = (fetch: Fetch) => boundedAttachment(fetch, hosts, "Discord");
