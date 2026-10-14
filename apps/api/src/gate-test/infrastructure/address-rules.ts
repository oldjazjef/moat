import { BlockList, isIPv4, isIPv6 } from 'node:net';

/**
 * Which resolved addresses «Testen» may connect to (T-59): public ones, and loopback only in
 * development. Everything else — private, shared, link-local, documentation, benchmark,
 * multicast, reserved, 6to4/NAT64 and IPv4-mapped or -compatible forms — is refused, so the
 * window cannot be used to reach into the network this computer sits in. As the PHP gate's SSRF
 * guard (SEC-41): IPv6 only inside the global unicast range 2000::/3, minus the special ranges
 * in it; 6to4 and NAT64 are refused outright rather than checked by their inner IPv4 address.
 */
// Two lists: BlockList compares IPv4 and IPv4-mapped IPv6 as one, so `::ffff:0:0/96` in a shared
// list would refuse every IPv4 address.
const FORBIDDEN_V4 = new BlockList();
const FORBIDDEN_V6 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  FORBIDDEN_V4.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  FORBIDDEN_V6.addSubnet(network, prefix, 'ipv6');

const GLOBAL_V6 = new BlockList();
GLOBAL_V6.addSubnet('2000::', 3, 'ipv6');

const LOOPBACK = new BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');

export type AddressKind = 'public' | 'loopback' | 'forbidden';

export function addressKind(address: string): AddressKind {
  if (isIPv4(address)) {
    if (LOOPBACK.check(address, 'ipv4')) return 'loopback';
    return FORBIDDEN_V4.check(address, 'ipv4') ? 'forbidden' : 'public';
  }
  if (isIPv6(address)) {
    const lower = address.toLowerCase();
    if (LOOPBACK.check(lower, 'ipv6')) return 'loopback';
    // Outside 2000::/3: IPv4-mapped, -compatible and -translated forms, site-local, ULA, ….
    if (!GLOBAL_V6.check(lower, 'ipv6')) return 'forbidden';
    return FORBIDDEN_V6.check(lower, 'ipv6') ? 'forbidden' : 'public';
  }
  return 'forbidden';
}

export function addressAllowed(
  address: string,
  allowLoopback: boolean,
): boolean {
  const kind = addressKind(address);
  return kind === 'public' || (kind === 'loopback' && allowLoopback);
}
