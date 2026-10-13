import { Layer } from "effect";

import { CredentialStoreLive } from "./auth/credentials.ts";
import { ChatGPTAuthLive } from "./auth/service.ts";
import { AppConfigLive } from "./config.ts";
import { ChatGPTModelLive } from "./model/service.ts";
import { OAuthClientLive } from "./oauth/client.ts";
import { BrowserSignInLive } from "./sign-in/service.ts";

// Build independent services first, then supply them to the layers that need them.
const dependencies = Layer.mergeAll(AppConfigLive, OAuthClientLive, BrowserSignInLive);

// provideMerge supplies dependencies and keeps them available to later layers,
// so storage, authentication, and model operations share the same services.
const storage = CredentialStoreLive.pipe(Layer.provideMerge(dependencies));

const authentication = ChatGPTAuthLive.pipe(Layer.provideMerge(storage));

export const ChatGPTRuntime = ChatGPTModelLive.pipe(Layer.provideMerge(authentication));
