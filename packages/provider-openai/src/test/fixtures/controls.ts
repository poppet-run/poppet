import { planScope } from "#src/connection";

type StreamMode =
  | "completed"
  | "empty_terminal"
  | "truncated"
  | "failed"
  | "incomplete"
  | "wrong_tool"
  | "wrong_token";

export interface Controls {
  scopes: string;
  subject: string;
  identityFailure: "none" | "audience" | "nonce" | "expiry" | "signature" | "future";
  wrongState: boolean;
  denied: boolean;
  discoveryEndpoint: string | null;
  tokenError: string | null;
  refreshError: string | null;
  streamMode: StreamMode;
  expireAccess: boolean;
  omitRefreshFields: boolean;
  revokeFailure: boolean;
}

export const createControls = (): Controls => ({
  scopes: `openid profile email offline_access resource.invoke ${planScope}`,
  subject: "test-account",
  identityFailure: "none",
  wrongState: false,
  denied: false,
  discoveryEndpoint: null,
  tokenError: null,
  refreshError: null,
  streamMode: "completed",
  expireAccess: false,
  omitRefreshFields: false,
  revokeFailure: false,
});
