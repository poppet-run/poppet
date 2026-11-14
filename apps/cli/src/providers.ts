import type { ProviderRegistration } from "@poppet/provider";
import { chatGPT } from "@poppet/provider-openai";
import { openCodeGo } from "@poppet/provider-opencode";
import { openRouter } from "@poppet/provider-openrouter";

export const providers: ReadonlyArray<ProviderRegistration> = [chatGPT, openCodeGo, openRouter];
