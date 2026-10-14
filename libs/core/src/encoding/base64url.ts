import { reject } from '../errors';

const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const LOOKUP = new Map([...ALPHABET].map((char, index) => [char, index]));

/** base64url without padding (RFC 4648 §5), docs/CRYPTO.md §2. */
export function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = ((buffer << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      out += ALPHABET.charAt((buffer >> bits) & 63);
    }
  }
  if (bits > 0) out += ALPHABET.charAt((buffer << (6 - bits)) & 63);
  return out;
}

/** Standard base64 with padding (RFC 4648 §4), e.g. for HTTP Basic (RFC 7617). */
export function toBase64(bytes: Uint8Array): string {
  const url = toBase64Url(bytes).replaceAll('-', '+').replaceAll('_', '/');
  return url + '='.repeat((4 - (url.length % 4)) % 4);
}

/**
 * Strict decoder: rejects padding, `+`, `/`, whitespace, an impossible length and non-zero
 * trailing bits — so every byte string has exactly one accepted encoding.
 */
export function fromBase64Url(text: string): Uint8Array {
  if (text.length % 4 === 1) reject('encoding_invalid');
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let written = 0;
  for (const char of text) {
    const value = LOOKUP.get(char);
    if (value === undefined) reject('encoding_invalid');
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[written++] = (buffer >> bits) & 0xff;
    }
  }
  if ((buffer & ((1 << bits) - 1)) !== 0) reject('encoding_invalid');
  return out;
}

/** Decodes and checks the exact byte length (keys, nonces, signatures). */
export function fromBase64UrlLength(text: unknown, length: number): Uint8Array {
  if (typeof text !== 'string') reject('encoding_invalid');
  const bytes = fromBase64Url(text);
  if (bytes.length !== length) reject('encoding_invalid');
  return bytes;
}
