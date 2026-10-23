import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { discord } from "@poppet/channel-discord/registration";
import { ConfigSourceLive, dataDirectory, gatewayPackages } from "@poppet/config";
import { ChannelError, type ChannelRegistration } from "@poppet/gateway";
import { Effect, Predicate, Schema } from "effect";

import { validateChannels } from "#src/channels";

export const channels: ReadonlyArray<ChannelRegistration> = [discord];

const Registration = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  setupHelp: Schema.NonEmptyString,
  setup: Schema.declare((value): value is ChannelRegistration["setup"] =>
    Predicate.isFunction(value),
  ),
  load: Schema.declare((value): value is ChannelRegistration["load"] => Effect.isEffect(value)),
});

// Accept package entry points only, never relative paths, URLs, or parent traversal.
const packageEntry =
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/;

export const loadRegisteredChannels = Effect.gen(function* () {
  const directory = yield* dataDirectory;
  const entries = yield* gatewayPackages;
  const base = pathToFileURL(join(directory, "gateways", "package.json")).href;
  const registered = [...channels];

  for (const entry of entries) {
    const registration = yield* Effect.tryPromise({
      try: async () => {
        if (!packageEntry.test(entry)) throw new Error("Invalid package entry point");
        const module: unknown = await import(import.meta.resolve(entry, base));

        const { default: loaded } = Schema.decodeUnknownSync(
          Schema.Struct({ default: Registration }),
        )(module);

        return loaded;
      },
      catch: () =>
        new ChannelError({
          reason: "configuration",
          message: `Cannot load gateway package ${entry}. Install it in ${join(directory, "gateways")} and export a default ChannelRegistration.`,
        }),
    });

    registered.push(registration);
  }

  yield* Effect.try({
    try: () => validateChannels(registered),
    catch: (cause) =>
      new ChannelError({
        reason: "configuration",
        message: cause instanceof Error ? cause.message : "Invalid gateway registrations.",
      }),
  });

  return registered;
}).pipe(Effect.provide(ConfigSourceLive));
