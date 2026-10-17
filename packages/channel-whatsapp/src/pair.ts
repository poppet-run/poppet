import { ChannelError } from "@poppet/gateway";
import { makeWASocket } from "baileys";
import { Console, Effect } from "effect";
import * as qrcode from "qrcode-terminal";

import { WhatsAppClient, WhatsAppClientLive, type SocketFactory } from "#src/client";
import type { WhatsAppSettings } from "#src/settings";

const showQr = (value: string) =>
  Effect.sync(() => {
    let rendered = "";
    qrcode.generate(value, { small: true }, (qr) => {
      rendered = qr;
    });

    return rendered;
  }).pipe(Effect.flatMap(Console.log));

/** Explicit foreground pairing is the only place a login QR may be rendered. */
export const pairWhatsApp = (
  dataDirectory: string,
  settings: WhatsAppSettings,
  createSocket: SocketFactory = makeWASocket,
) =>
  Effect.gen(function* () {
    const client = yield* WhatsAppClient;
    yield* Console.log(
      "Open WhatsApp on the configured account's phone, choose Linked devices, and scan the QR below.",
    );
    yield* client.linked;
  }).pipe(
    Effect.provide(WhatsAppClientLive(dataDirectory, settings, createSocket, showQr)),
    Effect.timeoutOrElse({
      duration: "2 minutes",
      orElse: () =>
        Effect.fail(
          new ChannelError({
            reason: "configuration",
            message: "WhatsApp pairing timed out or failed. Run gateway whatsapp pair again.",
          }),
        ),
    }),
  );
