import { reject } from '../errors';

/** Longest request path a gate accepts (SEC-44). */
export const MAX_PATH_LENGTH = 2048;

const UNRESERVED = /^[A-Za-z0-9\-._~]$/;
// RFC 3986 pchar minus percent (decoded above) plus "/": what may appear in a normalised path.
const ALLOWED = /^[A-Za-z0-9\-._~!$&'()*+,;=:@/]*$/;

/**
 * SEC-42: turns the raw path of a request (as sent, before any decoding) into the one form that
 * routes are matched against — or rejects it with `path_invalid`. Every gate does exactly this
 * (conformance/vectors/http/path.json):
 *
 * - must start with "/" and be at most MAX_PATH_LENGTH bytes;
 * - percent-encoding is decoded only for unreserved characters (`%41` → `A`); any other escape —
 *   `%2F`, `%5C`, `%00`, `%25` (double encoding), `%20`, non-ASCII — is rejected, so no decoding
 *   step anywhere later can change the meaning;
 * - no empty, "." or ".." segment (no `//`, `/./`, `/../`); a trailing "/" is kept and simply
 *   does not match a route without one;
 * - only RFC 3986 path characters remain.
 */
export function normalisePath(raw: string): string {
  if (raw.length === 0 || raw.length > MAX_PATH_LENGTH || !raw.startsWith('/'))
    reject('path_invalid');
  let out = '';
  for (let index = 0; index < raw.length; index++) {
    const char = raw.charAt(index);
    if (char !== '%') {
      out += char;
      continue;
    }
    const hex = raw.slice(index + 1, index + 3);
    if (!/^[0-9A-Fa-f]{2}$/.test(hex)) reject('path_invalid');
    const decoded = String.fromCharCode(parseInt(hex, 16));
    if (!UNRESERVED.test(decoded)) reject('path_invalid');
    out += decoded;
    index += 2;
  }
  if (!ALLOWED.test(out)) reject('path_invalid');
  const segments = out.split('/').slice(1);
  segments.forEach((segment, position) => {
    const last = position === segments.length - 1;
    if (segment === '.' || segment === '..') reject('path_invalid');
    if (segment === '' && !last) reject('path_invalid');
  });
  return out;
}
