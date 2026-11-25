import { ChannelEnvironment, ChannelError, parseSetupFlags } from "@poppet/gateway";
import type { ChannelRegistration } from "@poppet/gateway";
import { Effect, Schema } from "effect";

import { TelegramSettings, telegramSettings } from "#src/settings";

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

      const environment = yield* ChannelEnvironment;

      const settings = yield* Schema.decodeUnknownEffect(TelegramSettings)({
        ownerId: values["owner-id"],
        chatId: values["chat-id"],
        homeConversationId: values["home-conversation-id"] ?? values["chat-id"],
        token: values["bot-token"],
      }).pipe(
        Effect.mapError(
          () =>
            new ChannelError({
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
    import("#src/channel").then(({ telegramChannelLayer }) => telegramChannelLayer(settings)),
  ),
} satisfies ChannelRegistration;

export default telegram;
