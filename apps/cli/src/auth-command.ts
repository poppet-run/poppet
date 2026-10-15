import type { ProviderId } from "@poppet/provider";
import { Schema } from "effect";

const Action = Schema.Literals(["login", "status", "models", "verify", "logout"]);

/** Parsed authentication options, with null provider or model values left for configuration to resolve. */
export interface AuthCommand {
  readonly action: typeof Action.Type;
  readonly provider: ProviderId | null;
  readonly model: string | null;
  readonly consent: boolean;
  readonly keyStdin: boolean;
}
