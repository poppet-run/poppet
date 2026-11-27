import type { ProviderRegistration } from "@poppet/provider";
import { gemini } from "@poppet/provider-gemini";
import { chatGPT } from "@poppet/provider-openai";
import { openCode, openCodeGo } from "@poppet/provider-opencode";
import { openRouter } from "@poppet/provider-openrouter";

export const providers: ReadonlyArray<ProviderRegistration> = [
  chatGPT,
  openCode,
  openCodeGo,
  openRouter,
  gemini,
];
