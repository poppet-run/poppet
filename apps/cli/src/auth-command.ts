import { ProviderId } from "@poppet/provider";
import { Schema } from "effect";

const Action = Schema.Literals(["login", "status", "models", "verify", "logout"]);

export interface AuthCommand {
  readonly action: typeof Action.Type;
  readonly provider: ProviderId | null;
  readonly model: string | null;
  readonly consent: boolean;
  readonly keyStdin: boolean;
}

export const parseAuthCommand = (args: ReadonlyArray<string>): AuthCommand | null => {
  const action = args[0];

  if (!Schema.is(Action)(action)) return null;
  let provider: ProviderId | null = null;
  let consent = false;
  let keyStdin = false;
  const positional: string[] = [];

  for (let index = 1; index < args.length; index++) {
    const argument = args[index];

    if (argument === "--provider") {
      const value = args[++index];

      if (provider !== null || !Schema.is(ProviderId)(value)) return null;
      provider = value;
    } else if (argument === "--consent" && action === "login" && !consent) consent = true;
    else if (argument === "--key-stdin" && action === "login" && !keyStdin) keyStdin = true;
    else if (argument !== undefined && !argument.startsWith("-")) positional.push(argument);
    else return null;
  }

  if (positional.length > 1) return null;
  const value = positional[0];

  if (action !== "verify" && value !== undefined) {
    if (provider !== null || !Schema.is(ProviderId)(value)) return null;
    provider = value;
  }

  return {
    action,
    provider,
    model: action === "verify" ? (value ?? null) : null,
    consent,
    keyStdin,
  };
};
