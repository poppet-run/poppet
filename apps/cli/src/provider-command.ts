import type { ProviderId } from "@poppet/provider";
import { Schema } from "effect";

const Action = Schema.Literals(["login", "status", "models", "logout"]);

/** Parsed provider options, with a null provider left for configuration to resolve. */
export interface ProviderCommand {
  readonly action: typeof Action.Type;
  readonly provider: ProviderId | null;
  readonly keyStdin: boolean;
}
