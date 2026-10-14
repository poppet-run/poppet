import type { ProviderRegistration } from "@poppet/provider";
import { chatGPT } from "@poppet/provider-openai";
import { openCodeGo } from "@poppet/provider-opencode";
import { openRouter } from "@poppet/provider-openrouter";

// Add a provider package's registration here. The first entry is the default.
export const providers: ReadonlyArray<ProviderRegistration> = [chatGPT, openCodeGo, openRouter];
