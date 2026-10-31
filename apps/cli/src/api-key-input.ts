import { BunServices, BunTerminal } from "@effect/platform-bun";
import { ApiKey } from "@poppet/credentials";
import { promptSecret } from "@poppet/credentials/input";
import { CredentialInput, ProviderError, type ProviderId } from "@poppet/provider";
import { Effect, Option, Queue, Schema, Terminal } from "effect";

const inputError = (provider: ProviderId, message: string) =>
  new ProviderError({ provider, reason: "authentication", message });

export const decodeKey = (provider: ProviderId, value: string) =>
  Schema.decodeUnknownEffect(ApiKey)(value).pipe(
    Effect.mapError(() => inputError(provider, "Enter a nonempty API key without whitespace.")),
  );

export const readHiddenKey = (
  provider: ProviderId,
  unattendedMessage = "API-key login needs an interactive terminal to enter the key with hidden input.",
) => {
  if (!process.stdin.isTTY) return Effect.fail(inputError(provider, unattendedMessage));

  return promptSecret(`${provider} API key (input masked)`).pipe(
    Effect.mapError(() => inputError(provider, "API-key login cancelled.")),
    Effect.provide(BunServices.layer),
  );
};

export const readVisibleLine = (provider: ProviderId, prompt: string) => {
  // Without a terminal nothing can be pasted, so leave the caller's other
  // sources, such as a forwarded sign-in callback, to finish instead.
  if (!process.stdin.isTTY) return Effect.never;

  return Effect.scoped(
    Effect.gen(function* () {
      const terminal = yield* Terminal.Terminal;
      const input = yield* terminal.readInput;
      const display = (text: string) => terminal.display(text).pipe(Effect.ignore);
      yield* display(prompt);
      let value = "";

      while (true) {
        const event = yield* Queue.take(input).pipe(
          Effect.mapError(() => inputError(provider, "Sign-in cancelled.")),
        );

        if (event.key.name === "escape" || (event.key.ctrl && ["c", "d"].includes(event.key.name)))
          return yield* Effect.fail(inputError(provider, "Sign-in cancelled."));

        if (event.key.name === "return" || event.key.name === "enter") {
          yield* display("\n");

          return value;
        }

        if (event.key.name === "backspace") {
          if (value !== "") yield* display("\b \b");
          value = value.slice(0, -1);
        } else if (event.key.ctrl && event.key.name === "u") {
          yield* display(`\r\x1b[2K${prompt}`);
          value = "";
        } else if (!event.key.ctrl && !event.key.meta && Option.isSome(event.input)) {
          yield* display(event.input.value);
          value += event.input.value;
        }

        if (value.length > 8192)
          return yield* Effect.fail(inputError(provider, "The pasted text is too long."));
      }
    }).pipe(Effect.provide(BunTerminal.layer)),
  );
};

/** Reads API keys from hidden terminal input. */
export const terminalKeyInput: CredentialInput["Service"] = {
  readKey: (provider) => readHiddenKey(provider),
  readLine: readVisibleLine,
};
