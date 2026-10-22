# Channel registration

[Refactoring plans](index.md)

## Goal

Remove the repeated `load` logic from the three channel registrations, and
settle on one error message for unreadable settings.

## Current state

`packages/channel-{discord,telegram,whatsapp}/src/registration.ts` each
implement `load` as:

1. Read `ChannelEnvironment`.
2. Call `load<X>Settings(dataDirectory)`.
3. (Discord and Telegram only) map the error to
   `"Invalid <Label> settings. Run gateway <id> setup again."`.
4. Return `null` when unconfigured.
5. Return `Layer.unwrap(Effect.promise(() => import("#src/channel")).pipe(Effect.map(…)))`.

`channelSettings` in `packages/gateway/src/settings.ts` already maps load
failures to
`"Cannot read or write protected <Label> settings. Run gateway <id> setup again."`.
Discord and Telegram replace that message; WhatsApp keeps it.

Discord and Telegram `setup` also share the `--key-stdin` argument check and the
`ChannelInput.readSecret` call. Their argument counts and decode messages
differ.

## Design

Have `channelSettings` return a `loader` alongside `load` and `save`:

```ts
const store = channelSettings("telegram", "Telegram", TelegramSettings);

load: store.loader((settings, dataDirectory) =>
  import("#src/channel").then(({ telegramChannelLayer }) => telegramChannelLayer(settings)),
),
```

`loader` reads `ChannelEnvironment`, loads the settings, returns `null` when
they're missing, and otherwise unwraps the lazily imported layer. The dynamic
`import` stays in the adapter package so `#src/channel` resolves there.

Pick one failure message. The existing `channelSettings` message covers both
read and write failures, so drop the Discord and Telegram re-mapping, unless a
test or document depends on the "Invalid … settings" wording. In that case,
keep that wording and move it into `channelSettings`.

The shared part of `setup` is small (about five lines). Leave `setup` alone for
now.

## Steps

1. Add `loader` to `channelSettings` and test it in
   `gateway/src/settings.test.ts` (missing settings give `null`; invalid
   settings give a configuration error).
2. Convert WhatsApp first (no message change), then Discord and Telegram.
3. Search `docs/gateways` and the tests for the "Invalid … settings" text, and
   update whichever message loses.

## Verification

Run `channel-*/src/*.test.ts`, `gateway/src/settings.test.ts`, and
`apps/cli/src/channels.test.ts`.
