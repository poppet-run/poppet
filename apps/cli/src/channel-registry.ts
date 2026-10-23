import { discord } from "@poppet/channel-discord/registration";
import type { ChannelRegistration } from "@poppet/gateway";

// Add a channel package's registration here.
export const channels: ReadonlyArray<ChannelRegistration> = [discord];
