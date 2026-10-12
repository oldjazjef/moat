import { utf8 } from '../encoding/utf8';
import type { JsonValue } from '../json/strict-json';

/**
 * RFC 8785 (JCS) for the subset Moat signs: integers from 0 to 2^53 − 1 only (docs/CRYPTO.md §2).
 * Keys are sorted by UTF-16 code units — JavaScript's default string order — and strings are
 * escaped exactly as JSON.stringify does, which is what RFC 8785 prescribes.
 */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError('canonicalJson: integers from 0 to 2^53 - 1 only');
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value).sort(([a], [b]) => compareUtf16(a, b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

export function canonicalJsonBytes(value: JsonValue): Uint8Array {
  return utf8(canonicalJson(value));
}

function compareUtf16(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
