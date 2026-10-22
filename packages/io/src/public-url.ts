import { BlockList, isIP } from "node:net";

export const publicHttpURL = (value: string, forbidden: () => Error) => {
  const url = new URL(value);

  if (
    value.length > 8192 ||
    /\s/.test(value) ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== ""
  )
    throw forbidden();
  url.hash = "";

  return url;
};

const privateV4 = new BlockList();

// IANA special-purpose ranges, plus multicast. Conservatively exclude special-purpose exceptions.
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const)
  privateV4.addSubnet(address, prefix, "ipv4");

const globalV6 = new BlockList();

globalV6.addSubnet("2000::", 3, "ipv6");

const specialV6 = new BlockList();

for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  specialV6.addSubnet(address, prefix, "ipv6");

export const publicAddress = (address: string) => {
  switch (isIP(address)) {
    case 4:
      return !privateV4.check(address, "ipv4");
    // Only ordinary global unicast is allowed; mapped IPv4 and translation prefixes are excluded.
    case 6:
      return globalV6.check(address, "ipv6") && !specialV6.check(address, "ipv6");
    default:
      return false;
  }
};

export const urlHostname = (url: URL) => url.hostname.replace(/^\[|\]$/g, "");
