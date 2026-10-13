import { Layer } from "effect";

import { ChatGPTAuthLive } from "./auth.ts";
import { AppConfigLive } from "./config.ts";
import { CredentialStoreLive } from "./credentials.ts";
import { ChatGPTModelLive } from "./model.ts";
import { OAuthClientLive } from "./oauth.ts";
import { BrowserSignInLive } from "./sign-in.ts";

const dependencies = Layer.mergeAll(AppConfigLive, OAuthClientLive, BrowserSignInLive);

const storage = CredentialStoreLive.pipe(Layer.provideMerge(dependencies));

const authentication = ChatGPTAuthLive.pipe(Layer.provideMerge(storage));

export const ChatGPTRuntime = ChatGPTModelLive.pipe(Layer.provideMerge(authentication));
