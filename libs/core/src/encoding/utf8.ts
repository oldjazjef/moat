const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

/**
 * Strict UTF-8 decoding: invalid sequences throw instead of becoming U+FFFD, and a BOM is kept
 * (so the JSON parser rejects it, as PHP does).
 */
export function fromUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
