import type { QuotaPeriod } from '../config/compiled';

/**
 * FR-30, FR-31, SEC-45: rate limits and quotas as every gate counts them
 * (conformance/vectors/http/rate-limit.json). A rate-limit window opens with the first request and
 * lasts `windowSeconds`; a quota's window is the calendar day or month (UTC) of the request. Within
 * a window at most `requests` pass. A refused request does not count. Several limits apply
 * together: a request passes only if every one has room, and only then is every counter raised.
 */

export type Limit =
  | { requests: number; windowSeconds: number }
  | { requests: number; period: QuotaPeriod };

/** One counter: the window ends at `resetAt` (unix seconds), `count` requests so far. */
export interface Window {
  resetAt: number;
  count: number;
}

/**
 * Refused: `retryAfter` seconds until every full window has ended; `quota` when one of them is a
 * quota's (the gate answers `quota_exceeded` instead of `rate_limited`).
 */
export type LimitResult =
  | { allowed: true; windows: Window[] }
  | { allowed: false; retryAfter: number; quota: boolean };

/** The first second after the calendar day or month (UTC) that holds `now`. */
export function periodEnd(period: QuotaPeriod, now: number): number {
  if (period === 'day') return (Math.floor(now / 86_400) + 1) * 86_400;
  const date = new Date(now * 1000);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) / 1000;
}

/** Applies `limits[i]` to `windows[i]` (null = no counter yet) at `now` (unix seconds). */
export function hitLimits(
  windows: readonly (Window | null)[],
  limits: readonly Limit[],
  now: number,
): LimitResult {
  const next: Window[] = [];
  let retryAfter = 0;
  let quota = false;
  limits.forEach((limit, index) => {
    const window = windows[index] ?? null;
    if (window === null || now >= window.resetAt) {
      const resetAt =
        'period' in limit
          ? periodEnd(limit.period, now)
          : now + limit.windowSeconds;
      next.push({ resetAt, count: 1 });
    } else if (window.count < limit.requests) {
      next.push({ resetAt: window.resetAt, count: window.count + 1 });
    } else {
      retryAfter = Math.max(retryAfter, window.resetAt - now);
      quota ||= 'period' in limit;
      next.push(window);
    }
  });
  return retryAfter > 0
    ? { allowed: false, retryAfter, quota }
    : { allowed: true, windows: next };
}

/**
 * The client a per-IP limit counts (SEC-26): the IPv4 address, or the /64 network of an IPv6
 * address (one host usually owns a whole /64), as `xxxx:xxxx:xxxx:xxxx::/64`. An IPv4-mapped
 * IPv6 address counts as its IPv4 address. Null for anything that is not an IP address.
 */
export function clientKey(address: string): string | null {
  if (isIPv4(address)) return address;
  const groups = parseIPv6(address);
  if (groups === null) return null;
  if (
    groups.slice(0, 5).every((group) => group === 0) &&
    groups[5] === 0xffff
  ) {
    const [high = 0, low = 0] = groups.slice(6);
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
  }
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16).padStart(4, '0'))
    .join(':')}::/64`;
}

function isIPv4(text: string): boolean {
  const parts = text.split('.');
  return (
    parts.length === 4 &&
    parts.every(
      (part) => /^(?:0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255,
    )
  );
}

/** Eight 16-bit groups, or null. Accepts "::" once and a trailing dotted IPv4; no zone id. */
function parseIPv6(text: string): number[] | null {
  if (!/^[0-9A-Fa-f:.]{2,45}$/.test(text)) return null;
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string, last: boolean): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    const items = part.split(':');
    for (const [index, item] of items.entries()) {
      if (last && index === items.length - 1 && item.includes('.')) {
        if (!isIPv4(item)) return null;
        const [a = 0, b = 0, c = 0, d = 0] = item.split('.').map(Number);
        out.push((a << 8) | b, (c << 8) | d);
      } else if (/^[0-9A-Fa-f]{1,4}$/.test(item)) {
        out.push(parseInt(item, 16));
      } else {
        return null;
      }
    }
    return out;
  };
  const head = parse(halves[0] ?? '', halves.length === 1);
  const tail = halves.length === 2 ? parse(halves[1] ?? '', true) : [];
  if (head === null || tail === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  return missing >= 1
    ? [...head, ...Array<number>(missing).fill(0), ...tail]
    : null;
}
