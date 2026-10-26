import { describe, expect, spyOn, test } from "bun:test";

import { MessagingChannel } from "@poppet/gateway";
import {
  ButtonInteraction,
  ChannelType,
  Client,
  ComponentType,
  Events,
  InteractionType,
  MessageFlags,
} from "discord.js";
import { Effect, Option, Redacted, Stream } from "effect";

import { discordChannelLayer } from "#src/channel";

const user = { id: "100", username: "Poppet", discriminator: "0", avatar: null, bot: true };
const owner = { ...user, id: "200", username: "Owner", bot: false };
const id = "a1234567-1234-1234-1234-123456789012";

const settings = {
  ownerId: owner.id,
  guildId: "500",
  homeChannelId: "300",
  token: Redacted.make("secret"),
};

const fixture = () => {
  const client = new Client({ intents: [] });
  Object.defineProperty(client, "user", { value: user });
  const ready = spyOn(client, "isReady").mockReturnValue(true);

  const login = spyOn(client, "login").mockImplementation(async () => {
    await client.guilds.fetch("500");

    if (client.isReady()) client.emit(Events.ClientReady, client);

    return "logged-in";
  });

  const destroy = spyOn(client, "destroy").mockResolvedValue();
  const operations: string[] = [];

  const prompt = {
    id: "600",
    channel_id: "400",
    guild_id: "500",
    author: user,
    content: "Exact invocation",
    mentions: [],
    mention_roles: [],
    attachments: [],
    embeds: [],
    components: [],
    type: 0,
  };

  const get = spyOn(client.rest, "get").mockImplementation(async (route) => {
    operations.push(`GET ${route}`);

    if (route === "/guilds/500") return { id: "500", name: "Test", roles: [], members: [] };

    if (route === "/channels/400")
      return {
        id: "400",
        guild_id: "500",
        parent_id: "300",
        type: ChannelType.PublicThread,
        name: "Conversation",
        thread_metadata: {
          archived: false,
          locked: false,
          auto_archive_duration: 1440,
          archive_timestamp: new Date().toISOString(),
        },
      };

    if (route === "/channels/400/messages/600") return prompt;
    throw new Error(`Unexpected GET ${route}`);
  });

  const post = spyOn(client.rest, "post").mockImplementation(async (route) => {
    operations.push(`POST ${route}`);

    if (route === "/channels/400/messages") return prompt;

    if (route === "/interactions/7008/token/callback") throw new Error("Lost acknowledgement");

    if (route.startsWith("/interactions/")) return {};
    throw new Error(`Unexpected POST ${route}`);
  });

  const patch = spyOn(client.rest, "patch").mockImplementation(async (route) => {
    operations.push(`PATCH ${route}`);

    return prompt;
  });

  const interaction = (
    interactionId: string,
    overrides: {
      readonly guild_id?: string;
      readonly member?: {
        readonly user: typeof owner;
        readonly roles: readonly string[];
        readonly permissions: string;
      };
      readonly message?: typeof prompt & { readonly webhook_id?: string };
      readonly data?: { readonly custom_id: string; readonly component_type: ComponentType.Button };
    } = {},
  ) =>
    // SAFETY: Reflect constructs the actual SDK class; its constructor is private only in TypeScript.
    Reflect.construct(ButtonInteraction, [
      client,
      {
        id: interactionId,
        application_id: "100",
        token: "token",
        type: InteractionType.MessageComponent,
        version: 1,
        guild_id: "500",
        channel: { id: "400", type: ChannelType.PublicThread },
        member: { user: owner, roles: [], joined_at: new Date().toISOString(), permissions: "0" },
        message: prompt,
        data: { custom_id: `poppet:approval:approve:${id}`, component_type: ComponentType.Button },
        entitlements: [],
        authorizing_integration_owners: {},
        locale: "en-GB",
        app_permissions: "0",
        attachment_size_limit: 0,
        ...overrides,
      },
    ]) as ButtonInteraction;

  return {
    client,
    operations,
    prompt,
    get,
    post,
    patch,
    interaction,
    run: <A, E>(effect: Effect.Effect<A, E, MessagingChannel>) =>
      Effect.runPromise(effect.pipe(Effect.provide(discordChannelLayer(settings, () => client)))),
    close: () => {
      login.mockRestore();
      ready.mockRestore();
      destroy.mockRestore();
      get.mockRestore();
      post.mockRestore();
      patch.mockRestore();
    },
  };
};

describe("Discord approval components", () => {
  test("sends both buttons and disables the controls on settlement without changing the invocation", async () => {
    const f = fixture();

    try {
      await f.run(
        Effect.gen(function* () {
          const channel = yield* MessagingChannel;
          yield* channel.accountId;
          expect(yield* channel.approvals!.send("400", "Exact invocation", "nonce", id)).toBe(
            "600",
          );
          expect(f.post).toHaveBeenCalledWith(
            "/channels/400/messages",
            expect.objectContaining({
              body: expect.objectContaining({
                content: "Exact invocation",
                nonce: "nonce",
                enforce_nonce: true,
                allowed_mentions: { parse: [], replied_user: false },
                components: [
                  {
                    type: 1,
                    components: [
                      {
                        type: 2,
                        custom_id: `poppet:approval:approve:${id}`,
                        label: "Approve once",
                        style: 3,
                      },
                      { type: 2, custom_id: `poppet:approval:deny:${id}`, label: "Deny", style: 4 },
                    ],
                  },
                ],
              }),
            }),
          );
          yield* channel.approvals!.update("400", "600", id, "approved");
          expect(f.patch).toHaveBeenLastCalledWith(
            "/channels/400/messages/600",
            expect.objectContaining({
              body: expect.objectContaining({
                components: [
                  {
                    type: 1,
                    components: [
                      {
                        type: 2,
                        custom_id: `poppet:approval:approve:${id}`,
                        label: "Approved once",
                        style: 3,
                        disabled: true,
                      },
                    ],
                  },
                ],
              }),
            }),
          );
          expect(f.patch.mock.calls[0]![1]!.body).toHaveProperty("content", undefined);
          f.prompt.author = owner;
          expect(
            yield* channel.approvals!.update("400", "600", id, "expired").pipe(Effect.result),
          ).toHaveProperty("failure.reason", "permission");
          expect(f.patch).toHaveBeenCalledTimes(1);
        }),
      );
    } finally {
      f.close();
    }
  });

  test("filters invalid clicks and privately acknowledges valid buttons before channel lookup", async () => {
    const f = fixture();

    try {
      await f.run(
        Effect.gen(function* () {
          const channel = yield* MessagingChannel;
          yield* channel.accountId;

          for (const [interactionId, overrides] of [
            ["7001", { member: { user: { ...owner, id: "999" }, roles: [], permissions: "0" } }],
            ["7002", { guild_id: "999" }],
            [
              "7003",
              {
                data: {
                  custom_id: "poppet:approval:approve:invalid",
                  component_type: ComponentType.Button,
                },
              },
            ],
            ["7004", { message: { ...f.prompt, author: owner } }],
            ["7005", { message: { ...f.prompt, webhook_id: "800" } }],
            ["7006", { data: { custom_id: "unrelated", component_type: ComponentType.Button } }],
            ["7008", {}],
          ] as const)
            f.client.emit(Events.InteractionCreate, f.interaction(interactionId, overrides));

          const valid = f.interaction("7009", {
            data: { custom_id: `poppet:approval:deny:${id}`, component_type: ComponentType.Button },
          });

          f.client.emit(Events.InteractionCreate, valid);
          const action = Option.getOrThrow(yield* Stream.runHead(channel.approvals!.actions));
          expect(action).toMatchObject({
            requestId: id,
            decision: "deny",
            source: {
              messageId: "600",
              scopeId: "500",
              parentId: "300",
              conversationId: "400",
              senderId: "200",
              text: "",
              mentioned: false,
            },
          });
          expect(valid.ephemeral).toBe(true);
          expect(f.operations.indexOf("POST /interactions/7009/token/callback")).toBeLessThan(
            f.operations.indexOf("GET /channels/400"),
          );

          for (const interactionId of ["7001", "7002", "7003", "7004", "7005"])
            expect(f.post).toHaveBeenCalledWith(
              `/interactions/${interactionId}/token/callback`,
              expect.objectContaining({
                body: expect.objectContaining({
                  type: 4,
                  data: expect.objectContaining({ flags: MessageFlags.Ephemeral }),
                }),
              }),
            );
          expect(f.operations).not.toContain("POST /interactions/7006/token/callback");
          expect(f.post).toHaveBeenCalledWith(
            "/interactions/7009/token/callback",
            expect.objectContaining({ body: { type: 5, data: { flags: MessageFlags.Ephemeral } } }),
          );
          yield* action.reply("Command denied.");
          expect(f.patch).toHaveBeenCalledWith(
            "/webhooks/100/token/messages/%40original",
            expect.objectContaining({
              body: expect.objectContaining({
                content: "Command denied.",
                allowed_mentions: { parse: [], replied_user: false },
              }),
            }),
          );
          expect(yield* channel.status).toHaveProperty(
            "error",
            "Discord approval interaction failed.",
          );
        }),
      );
      expect(f.client.listenerCount(Events.InteractionCreate)).toBe(0);
    } finally {
      f.close();
    }
  });
});
