import { GatewayEnvironment, GatewayError, parseSetupFlags } from "@poppet/gateway";
import type { GatewayRegistration } from "@poppet/gateway";
import { Effect, Schema } from "effect";

import { TelegramSettings, telegramSettings } from "#src/settings";
import { promptTelegramSetup } from "#src/setup";

const setupHelp =
  "setup --owner-id <id> --chat-id <id> [--home-conversation-id <id>] --bot-token <token>";

// Telegram group IDs start with "-", which parseArgs treats as another option.
const negativeId = /^-[1-9][0-9]*(?::[1-9][0-9]*)?$/;

const takesId = (flag: string | undefined) =>
  flag === "--chat-id" || flag === "--home-conversation-id";

const normalizeIds = (args: ReadonlyArray<string>) =>
  args.flatMap((arg, index) => {
    if (negativeId.test(arg) && takesId(args[index - 1])) {
      return [];
    }

    const next = args[index + 1];

    return takesId(arg) && next !== undefined && negativeId.test(next) ? [`${arg}=${next}`] : [arg];
  });

export const telegram = {
  id: "telegram",
  name: "Telegram",
  promptSetup: promptTelegramSetup,
  setupHelp,
  setup: (args) =>
    Effect.gen(function* () {
      const values = yield* parseSetupFlags(
        normalizeIds(args),
        "telegram",
        setupHelp,
        ["owner-id", "chat-id", "bot-token"],
        ["home-conversation-id"],
      );

      const environment = yield* GatewayEnvironment;

      const settings = yield* Schema.decodeUnknownEffect(TelegramSettings)({
        ownerId: values["owner-id"],
        chatId: values["chat-id"],
        homeConversationId: values["home-conversation-id"] ?? values["chat-id"],
        token: values["bot-token"],
      }).pipe(
        Effect.mapError(
          () =>
            new GatewayError({
              reason: "configuration",
              message:
                "Use numeric Telegram IDs, the owner's ID as a private chat ID, a home conversation in that chat, and a bot token from BotFather.",
            }),
        ),
      );

      yield* telegramSettings.save(environment.dataDirectory, settings);

      return "Telegram settings saved. Restart the worker to apply them. Only the configured owner can invoke Poppet; chat members can read its replies.";
    }),
  load: telegramSettings.loader((settings) =>
    import("#src/adapter").then(({ telegramAdapterLayer }) => telegramAdapterLayer(settings)),
  ),
} satisfies GatewayRegistration;

export default telegram;
