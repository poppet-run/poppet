import { AppConfig, AppConfigLive } from "@poppet/config";
import { ChatGPTAuth, ChatGPTModel, type ConnectionError } from "@poppet/provider-openai";
import { type Config, Console, Data, Effect } from "effect";

import { ChatGPTRuntime } from "./runtime.ts";

class UsageError extends Data.TaggedError("UsageError")<{
  readonly message: string;
}> {}

const help = `Poppet

Usage: bun run start [command]

Commands:
  config    Show validated configuration
  auth login [--consent]    Continue with ChatGPT
  auth status              Show connection and last verification
  auth models              List models available to the account
  auth verify [model]      Verify subscription inference and a local tool round trip
  auth logout              Revoke the session and clear local tokens
  --help    Show this help

Chat, memory, and scheduled tasks are planned next.`;

const showConfig = Effect.gen(function* () {
  const config = yield* AppConfig;
  yield* Console.log(JSON.stringify(config, null, 2));
});

const runAuth = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const auth = yield* ChatGPTAuth;
    const model = yield* ChatGPTModel;

    if (args[0] === "login") {
      const status = yield* auth.login(args[1] === "--consent");
      yield* Console.log(
        status.planUsage
          ? "Connected to ChatGPT. Plan usage is enabled; run auth verify to check inference."
          : "Connected to ChatGPT. Plan usage was not granted; run auth login --consent to enable it.",
      );
    } else if (args[0] === "status") {
      yield* Console.log(JSON.stringify(yield* auth.status, null, 2));
    } else if (args[0] === "models") {
      yield* Console.log(JSON.stringify(yield* model.models, null, 2));
    } else if (args[0] === "verify") {
      const verifiedModel = yield* model.verify(args[1] ?? null);
      yield* Console.log(
        `ChatGPT subscription verification passed with ${verifiedModel}. Completed inference and one local tool round trip.`,
      );
    } else if (args[0] === "logout") {
      const revoked = yield* auth.signOut;
      yield* Console.log(
        revoked
          ? "Signed out. Local tokens were cleared; the registration and host ID were retained."
          : "Local tokens were cleared, but remote revocation was not confirmed. Disconnect Poppet in ChatGPT Settings.",
      );
    }
  });

export const run = (
  args: ReadonlyArray<string>,
): Effect.Effect<void, UsageError | Config.ConfigError | ConnectionError> => {
  // Route help before providing any layers so it works even with invalid config
  // and does not open credential storage or acquire its lock.
  if (args.length === 0 || (args.length === 1 && (args[0] === "--help" || args[0] === "-h"))) {
    return Console.log(help);
  }

  if (args.length === 1 && args[0] === "config") {
    return showConfig.pipe(Effect.provide(AppConfigLive));
  }

  if (args[0] === "auth") {
    const authArgs = args.slice(1);

    const simple =
      authArgs.length === 1 &&
      ["login", "status", "models", "verify", "logout"].includes(authArgs[0] ?? "");

    const consent = authArgs.length === 2 && authArgs[0] === "login" && authArgs[1] === "--consent";
    const chosenModel = authArgs.length === 2 && authArgs[0] === "verify";

    if (simple || consent || chosenModel)
      return runAuth(authArgs).pipe(Effect.provide(ChatGPTRuntime));
  }

  return Effect.fail(new UsageError({ message: "Unknown command. Run bun run start --help." }));
};
