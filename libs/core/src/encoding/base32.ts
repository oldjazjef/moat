const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, upper case, no padding — used only for human fingerprints. */
export function toBase32(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET.charAt((buffer >> bits) & 31);
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET.charAt((buffer << (5 - bits)) & 31);
  return out;
}
