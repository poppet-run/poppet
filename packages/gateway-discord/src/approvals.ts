import { formatApprovalStatus, GatewayError } from "@poppet/gateway";
import type {
  ApprovalAction,
  ApprovalPrompt,
  ApprovalSettlement,
  ApprovalState,
} from "@poppet/gateway";
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  Events,
  MessageFlags,
} from "discord.js";
import type { Client, Embed, Interaction } from "discord.js";
import { Effect, Queue, Stream } from "effect";

import type { DiscordSettings } from "#src/settings";

const prefix = "poppet:approval:";

const PENDING_COLOR = 0xe3_a0_08;
const APPROVED_COLOR = 0x22_c5_5e;
const DENIED_COLOR = 0xef_44_44;
const SETTLED_COLOR = 0x6b_72_80;

const MAX_FIELD_VALUE = 1024;
const MAX_DESCRIPTION = 4096;

const clamp = (text: string, limit: number) =>
  text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;

const settledColor = (state: ApprovalState) => {
  switch (state) {
    case "approved":
      return APPROVED_COLOR;
    case "denied":
      return DENIED_COLOR;
    case "expired":
    case "cancelled":
    case "superseded":
    case "unavailable":
      return SETTLED_COLOR;
  }
};

export const discordSettlementText = (
  state: ApprovalState,
  settlement?: ApprovalSettlement,
): string => {
  if (state === "approved") {
    return settlement?.senderId
      ? `Approved by <@${settlement.senderId}>`
      : (settlement?.text ?? formatApprovalStatus(state));
  }

  if (state === "denied") {
    return settlement?.senderId
      ? `Denied by <@${settlement.senderId}>`
      : (settlement?.text ?? formatApprovalStatus(state));
  }

  return settlement?.text ?? formatApprovalStatus(state);
};

export const approvalEmbed = (
  prompt: ApprovalPrompt,
  settled?: { readonly state: ApprovalState; readonly settlement?: ApprovalSettlement },
) => {
  const descriptionParts = [`**Reason:** ${prompt.summary}`];

  if (prompt.codeBlock) {
    const note = prompt.codeBlock.truncated
      ? "\n*Truncated — click Show details for the full payload.*"
      : "";

    descriptionParts.push(
      `**${prompt.codeBlock.label}**\n\`\`\`${prompt.codeBlock.language}\n${prompt.codeBlock.content}\n\`\`\`${note}`,
    );
  }

  const embed = new EmbedBuilder()
    .setColor(settled ? settledColor(settled.state) : PENDING_COLOR)
    .setTitle(prompt.title)
    .setDescription(clamp(descriptionParts.join("\n\n"), MAX_DESCRIPTION));

  for (const field of prompt.fields) {
    const value = field.code ? `\`${field.value}\`` : field.value;
    embed.addFields({
      name: field.label,
      value: clamp(value, MAX_FIELD_VALUE),
      inline: field.inline ?? false,
    });
  }

  if (prompt.args && prompt.args.length > 0) {
    const lines = prompt.args.map((arg) => `• **${arg.key}**: \`${arg.value}\``);

    if (prompt.omittedArgsCount && prompt.omittedArgsCount > 0) {
      lines.push(`• *${prompt.omittedArgsCount} more omitted*`);
    }

    embed.addFields({
      name: "Arguments",
      value: clamp(lines.join("\n"), MAX_FIELD_VALUE),
      inline: false,
    });
  }

  if (settled) {
    embed.addFields({
      name: "Status",
      value: discordSettlementText(settled.state, settled.settlement),
      inline: false,
    });
    embed.setFooter({ text: "Permits one execution only" });
  } else {
    const unixSeconds = Math.floor(prompt.expiresAt / 1000);
    embed.addFields({
      name: "Expires",
      value: `<t:${unixSeconds}:R>`,
      inline: true,
    });
    embed.setFooter({ text: "Permits one execution only" });
  }

  return embed;
};

export const settledFallbackEmbed = (
  existing: Embed | undefined,
  state: ApprovalState,
  settlement?: ApprovalSettlement,
) => {
  const embed = existing ? EmbedBuilder.from(existing) : new EmbedBuilder();
  const status = discordSettlementText(state, settlement);

  const fields = (existing?.fields ?? []).filter(
    (field) => field.name !== "Expires" && field.name !== "Status",
  );

  return embed
    .setColor(settledColor(state))
    .setFields([...fields, { name: "Status", value: status, inline: false }])
    .setFooter({ text: "Permits one execution only" });
};

export const approvalComponents = (id: string, showDetails = false) => {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${prefix}approve:${id}`)
      .setLabel("Approve once")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${prefix}deny:${id}`)
      .setLabel("Deny")
      .setStyle(ButtonStyle.Danger),
  );

  if (showDetails) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`${prefix}details:${id}`)
        .setLabel("Show details")
        .setStyle(ButtonStyle.Secondary),
    );
  }

  return [row];
};

export const approvalActions = (
  client: Client,
  settings: DiscordSettings,
  reportError: (error: string | null) => void,
  getPrompt: (requestId: string) => ApprovalPrompt | undefined,
) =>
  Effect.gen(function* () {
    const actions = yield* Queue.make<ApprovalAction>({ capacity: 64, strategy: "dropping" });
    let active = true;

    const handle = async (interaction: Interaction) => {
      if (!interaction.isButton() || !interaction.customId.startsWith(prefix)) {
        return;
      }

      const match = /^poppet:approval:(approve|deny|details):([a-f0-9-]{36})$/.exec(
        interaction.customId,
      );

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

      const kind = match[1];
      const requestId = match[2];

      if (kind === "details") {
        const saved = requestId === undefined ? undefined : getPrompt(requestId);

        if (!saved) {
          await interaction.reply({
            content: "Full details are no longer available for this approval.",
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [], repliedUser: false },
          });

          return;
        }

        const fenced = `\`\`\`json\n${saved.canonicalPayload}\n\`\`\``;

        if (fenced.length <= 2000) {
          await interaction.reply({
            content: fenced,
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [], repliedUser: false },
          });
        } else {
          await interaction.reply({
            content: "Full canonical approval payload:",
            files: [
              new AttachmentBuilder(Buffer.from(saved.canonicalPayload, "utf8"), {
                name: "approval-details.json",
              }),
            ],
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [], repliedUser: false },
          });
        }

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

        reportError(null);

        const parentId = target.isThread() ? target.parentId : target.id;

        if (requestId === undefined || !parentId) {
          await reply("This approval conversation is no longer available.");

          return;
        }

        if (
          !Queue.offerUnsafe(actions, {
            requestId,
            decision: kind === "approve" ? "approve" : "deny",
            source: {
              messageId: interaction.message.id,
              scopeId: settings.guildId,
              parentId,
              conversationId: target.id,
              senderId: interaction.user.id,
              text: "",
              mentioned: false,
            },
            reply: (text) =>
              Effect.tryPromise({
                try: () => reply(text),
                catch: () =>
                  new GatewayError({
                    reason: "unavailable",
                    message: "Discord approval reply failed.",
                  }),
              }),
          })
        ) {
          await reply("Poppet is busy. Try this approval again before it expires.");
        }
      } catch {
        await reply("Approval could not be confirmed. Try again before it expires.");
      }
    };

    const listener = (interaction: Interaction) => {
      void handle(interaction).catch(() => reportError("Discord approval interaction failed."));
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
