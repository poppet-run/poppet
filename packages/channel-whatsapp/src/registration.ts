import { ChannelEnvironment, ChannelError, type ChannelRegistration } from "@poppet/gateway";
import { Effect, Layer, Schema } from "effect";

import { WhatsAppSettings, loadWhatsAppSettings, saveWhatsAppSettings } from "#src/settings";

const usage = () =>
  new ChannelError({
    reason: "configuration",
    message:
      "Use gateway whatsapp setup <account-phone> <owner-phone>, then gateway whatsapp pair in an interactive terminal. Use international digits without '+'.",
  });

export const whatsapp: ChannelRegistration = {
  id: "whatsapp",
  name: "WhatsApp",
  setupHelp: "setup <account-phone> <owner-phone> | pair",
  setup: (args) =>
    Effect.gen(function* () {
      const environment = yield* ChannelEnvironment;

      if (args[0] === "setup" && args.length === 3) {
        const settings = yield* Schema.decodeUnknownEffect(WhatsAppSettings)({
          version: 1,
          accountPhone: args[1],
          ownerPhone: args[2],
        }).pipe(Effect.mapError(usage));

        yield* saveWhatsAppSettings(environment.dataDirectory, settings);

        return "WhatsApp settings saved. Stop the worker, run gateway whatsapp pair, then restart the worker. Only the configured owner's private chat is enabled.";
      }

      if (args[0] !== "pair" || args.length !== 1) return yield* Effect.fail(usage());

      if (!process.stdin.isTTY || !process.stdout.isTTY)
        return yield* Effect.fail(
          new ChannelError({
            reason: "configuration",
            message:
              "WhatsApp QR pairing requires an interactive terminal; QR secrets must not enter worker logs or redirected output.",
          }),
        );
      const settings = yield* loadWhatsAppSettings(environment.dataDirectory);

      if (settings === null) return yield* Effect.fail(usage());
      const { pairWhatsApp } = yield* Effect.promise(() => import("#src/pair"));
      yield* pairWhatsApp(environment.dataDirectory, settings);

      return "WhatsApp linked. Start the worker to enable owner-only text chat.";
    }),
  load: Effect.gen(function* () {
    const environment = yield* ChannelEnvironment;
    const settings = yield* loadWhatsAppSettings(environment.dataDirectory);

    if (settings === null) return null;

    return Layer.unwrap(
      Effect.promise(() => import("#src/channel")).pipe(
        Effect.map(({ whatsappChannelLayer }) =>
          whatsappChannelLayer(environment.dataDirectory, settings),
        ),
      ),
    );
  }),
};
