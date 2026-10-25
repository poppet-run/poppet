import { braveSearch } from "#src/brave";
import { kagiSearch } from "#src/kagi";

/** Configurable search backends, keyed by their config.json name. */
export const searchProviders = { brave: braveSearch, kagi: kagiSearch } as const;
