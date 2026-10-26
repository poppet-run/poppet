import { ChannelError, type ApprovalAction, type ApprovalState } from "@poppet/gateway";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Events,
  MessageFlags,
  type Client,
  type Interaction,
} from "discord.js";
import { Effect, Queue, Stream } from "effect";

import type { DiscordSettings } from "#src/settings";

const prefix = "poppet:approval:";

export const approvalComponents = (id: string, state?: ApprovalState) => {
  const row = new ActionRowBuilder<ButtonBuilder>();

  if (state) {
    const labels: Record<ApprovalState, string> = {
      approved: "Approved once",
      denied: "Denied",
      expired: "Expired",
      cancelled: "Cancelled",
      unavailable: "No longer available",
    };

    return [
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`${prefix}approve:${id}`)
          .setLabel(labels[state])
          .setStyle(state === "approved" ? ButtonStyle.Success : ButtonStyle.Secondary)
          .setDisabled(true),
      ),
    ];
  }

  return [
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`${prefix}approve:${id}`)
        .setLabel("Approve once")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`${prefix}deny:${id}`)
        .setLabel("Deny")
        .setStyle(ButtonStyle.Danger),
    ),
  ];
};

/** Acknowledge clicks before remote permission checks or gateway work can delay them. */
export const approvalActions = (
  client: Client,
  settings: DiscordSettings,
  reportError: () => void,
) =>
  Effect.gen(function* () {
    const actions = yield* Queue.make<ApprovalAction>({ capacity: 64, strategy: "dropping" });
    let active = true;

    const handle = async (interaction: Interaction) => {
      if (!interaction.isButton() || !interaction.customId.startsWith(prefix)) return;
      const match = /^poppet:approval:(approve|deny):([a-f0-9-]{36})$/.exec(interaction.customId);

      if (
        !client.isReady() ||
        !interaction.inGuild() ||
        interaction.guildId !== settings.guildId ||
        interaction.user.id !== settings.ownerId ||
        interaction.message.author.id !== client.user.id ||
        interaction.message.webhookId !== null
      ) {
        await interaction.reply({
          content: "Only the configured owner can answer an approval in the configured server.",
          flags: MessageFlags.Ephemeral,
        });

        return;
      }

      if (!match) {
        await interaction.reply({
          content: "This approval button is not valid. Request the operation again.",
          flags: MessageFlags.Ephemeral,
        });

        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const reply = async (text: string) => {
        await interaction.editReply({
          content: text,
          allowedMentions: { parse: [], repliedUser: false },
        });
      };

      try {
        const target = await client.channels.fetch(interaction.channelId);

        if (
          !active ||
          target === null ||
          (target.type !== ChannelType.GuildText && !target.isThread()) ||
          target.guildId !== settings.guildId ||
          (target.isThread() && target.parentId === null) ||
          interaction.message.channelId !== target.id
        ) {
          await reply("This approval conversation is no longer available.");

          return;
        }

        if (
          !Queue.offerUnsafe(actions, {
            requestId: match[2]!,
            decision: match[1] === "approve" ? "approve" : "deny",
            source: {
              messageId: interaction.message.id,
              scopeId: settings.guildId,
              parentId: target.isThread() ? target.parentId! : target.id,
              conversationId: target.id,
              senderId: interaction.user.id,
              text: "",
              mentioned: false,
            },
            reply: (text) =>
              Effect.tryPromise({
                try: () => reply(text),
                catch: () =>
                  new ChannelError({
                    reason: "unavailable",
                    message: "Discord approval reply failed.",
                  }),
              }),
          })
        )
          await reply("Poppet is busy. Try this approval again before it expires.");
      } catch {
        await reply("Approval could not be confirmed. Try again before it expires.");
      }
    };

    const listener = (interaction: Interaction) => {
      void handle(interaction).catch(reportError);
    };

    yield* Effect.acquireRelease(
      Effect.sync(() => client.on(Events.InteractionCreate, listener)),
      () =>
        Effect.sync(() => {
          active = false;
          client.off(Events.InteractionCreate, listener);
        }),
    );

    return Stream.fromQueue(actions);
  });
