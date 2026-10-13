import { BunTerminal } from "@effect/platform-bun";
import { ApiKey, type ApiKeyProvider } from "@poppet/credentials";
import { ProviderError } from "@poppet/provider";
import { Console, Effect, Option, Queue, Schema, Terminal } from "effect";

const inputError = (provider: ApiKeyProvider, message: string) =>
  new ProviderError({ provider, reason: "authentication", message });

const decodeKey = (provider: ApiKeyProvider, value: string) =>
  Schema.decodeUnknownEffect(ApiKey)(value).pipe(
    Effect.mapError(() => inputError(provider, "Enter a nonempty API key without whitespace.")),
  );

export const readKeyStdin = (provider: ApiKeyProvider) =>
  Effect.tryPromise({
    try: () => Bun.stdin.text(),
    catch: () => inputError(provider, "Could not read the API key from stdin."),
  }).pipe(Effect.flatMap((value) => decodeKey(provider, value.replace(/\r?\n$/, ""))));

export const readHiddenKey = (provider: ApiKeyProvider) => {
  if (!process.stdin.isTTY)
    return Effect.fail(
      inputError(
        provider,
        "API-key login needs an interactive terminal. Supply the key through its environment variable or use --key-stdin.",
      ),
    );

  return Effect.scoped(
    Effect.gen(function* () {
      const terminal = yield* Terminal.Terminal;
      const input = yield* terminal.readInput;
      yield* Console.error(`${provider} API key (input hidden):`);
      let value = "";

      while (true) {
        const event = yield* Queue.take(input).pipe(
          Effect.mapError(() => inputError(provider, "API-key login cancelled.")),
        );

        if (event.key.name === "escape" || (event.key.ctrl && ["c", "d"].includes(event.key.name)))
          return yield* Effect.fail(inputError(provider, "API-key login cancelled."));

        if (event.key.name === "return" || event.key.name === "enter")
          return yield* decodeKey(provider, value);

        if (event.key.name === "backspace") value = value.slice(0, -1);
        else if (event.key.ctrl && event.key.name === "u") value = "";
        else if (!event.key.ctrl && !event.key.meta && Option.isSome(event.input))
          value += event.input.value;

        if (value.length > 8192)
          return yield* Effect.fail(inputError(provider, "The API key is too long."));
      }
    }).pipe(Effect.provide(BunTerminal.layer)),
  );
};
