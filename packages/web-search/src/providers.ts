import { braveSearch } from "#src/brave";
import { kagiSearch } from "#src/kagi";

export const searchProviders = { brave: braveSearch, kagi: kagiSearch } as const;
