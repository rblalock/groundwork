import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

// The designer's browser runs in its own sandbox, away from the app and its secrets, but it should still
// open only public websites: a member's own site, never a private network, a cloud metadata address, or
// an IP a page or a prompt slipped in. The same rule web_fetch kept: http(s), a real host name, and every
// address it resolves to public. This is checked before the browser goes there; the browser resolves the
// name again itself, and follows redirects and loads a page's own requests without asking. Vercel
// Sandbox's network policy only allows named domains, so it can't say "public addresses only" for any
// site a member names: what keeps those cases harmless is that the browser runs in its own sandbox, apart
// from the app, with nothing of ours in it.

// IPv4: everything but the private, shared, loopback, link-local (cloud metadata), documentation,
// benchmarking, multicast, and reserved ranges.
const NOT_PUBLIC_V4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  NOT_PUBLIC_V4.addSubnet(network, prefix, "ipv4");
}

// IPv6: global unicast only, less the ranges that carry another address (6to4, Teredo, NAT64) or are
// for documentation. An IPv4 address written as IPv6 is judged as IPv4.
const GLOBAL_V6 = new BlockList();
GLOBAL_V6.addSubnet("2000::", 3, "ipv6");
const TUNNELED_V6 = new BlockList();
for (const [network, prefix] of [
  ["2002::", 16],
  ["2001::", 32],
  ["2001:db8::", 32],
  ["64:ff9b::", 96],
] as const) {
  TUNNELED_V6.addSubnet(network, prefix, "ipv6");
}

function publicAddress(address: string): boolean {
  const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return publicAddress(mapped[1]);
  if (isIP(address) === 4) return !NOT_PUBLIC_V4.check(address, "ipv4");
  if (isIP(address) === 6) return GLOBAL_V6.check(address, "ipv6") && !TUNNELED_V6.check(address, "ipv6");
  return false;
}

/** The address as a public website's URL, or throws `NOT_A_WEBSITE`. */
export async function publicSite(input: string): Promise<string> {
  const raw = input.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new Error("NOT_A_WEBSITE");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("NOT_A_WEBSITE");
  if (isIP(host) || !host.includes(".") || /(^|\.)(localhost|local|internal|intranet|home|lan|corp)$/.test(host)) throw new Error("NOT_A_WEBSITE");
  const addresses = await lookup(host, { all: true, verbatim: true }).catch(() => []);
  if (addresses.length === 0 || addresses.some(({ address }) => !publicAddress(address))) throw new Error("NOT_A_WEBSITE");
  return url.toString();
}
