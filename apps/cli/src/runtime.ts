import { AppConfigLive } from "@poppet/config";
import {
  BrowserSignInLive,
  ChatGPTAuthLive,
  ChatGPTModelLive,
  CredentialStoreLive,
  OAuthClientLive,
} from "@poppet/provider-openai";
import { Layer } from "effect";

// Build independent services first, then supply them to the layers that need them.
const dependencies = Layer.mergeAll(AppConfigLive, OAuthClientLive, BrowserSignInLive);

// provideMerge supplies dependencies and keeps them available to later layers,
// so storage, authentication, and model operations share the same services.
const storage = CredentialStoreLive.pipe(Layer.provideMerge(dependencies));

const authentication = ChatGPTAuthLive.pipe(Layer.provideMerge(storage));

export const ChatGPTRuntime = ChatGPTModelLive.pipe(Layer.provideMerge(authentication));
