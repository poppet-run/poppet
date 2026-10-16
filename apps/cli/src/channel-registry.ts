import { discord } from "@poppet/channel-discord/registration";
import { telegram } from "@poppet/channel-telegram/registration";
import { whatsapp } from "@poppet/channel-whatsapp/registration";
import type { ChannelRegistration } from "@poppet/gateway";

// Add a channel package's registration here.
export const channels: ReadonlyArray<ChannelRegistration> = [discord, telegram, whatsapp];
