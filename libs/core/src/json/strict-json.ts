import { reject } from '../errors';
import { fromUtf8 } from '../encoding/utf8';

/** Containers (objects and arrays) may nest at most this deep (docs/CRYPTO.md §2). */
export const MAX_JSON_DEPTH = 32;

// docs/CRYPTO.md §2: numbers are integers from 0 to 2^53 − 1 — no fraction or exponent. `-0` is
// accepted as 0 because PHP's json_decode turns it into int 0 and cannot tell the difference.
const INTEGER_SOURCE = /^(-?0|[1-9][0-9]*)$/;
// JSON.parse accepts an escaped lone surrogate ("\ud800"); PHP's json_decode does not. Reject it so
// both sides parse exactly the same documents.
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/**
 * Parses JSON the way every gate does: strict UTF-8, non-negative integers only (no fraction or
 * exponent, at most 2^53 − 1), no lone surrogates, no key starting with NUL, at most MAX_JSON_DEPTH levels, and
 * objects without a prototype so a `__proto__` key is plain data (DT-17). Anything else →
 * `json_invalid`.
 */
export function parseStrictJson(bytes: Uint8Array): JsonValue {
  let text: string;
  let value: unknown;
  try {
    text = fromUtf8(bytes);
    value = JSON.parse(
      text,
      (key, item: unknown, context?: { source?: string }) => {
        if (LONE_SURROGATE.test(key)) throw new RangeError('surrogate');
        // PHP's json_decode refuses object keys that start with NUL (its marker for private
        // properties); reject them here too so both sides accept the same documents.
        if (key.startsWith('\u0000')) throw new RangeError('key');
        if (typeof item === 'string' && LONE_SURROGATE.test(item))
          throw new RangeError('surrogate');
        if (typeof item === 'number') {
          const source = context?.source;
          if (
            source === undefined ||
            !INTEGER_SOURCE.test(source) ||
            !Number.isSafeInteger(item)
          ) {
            throw new RangeError('number');
          }
        }
        if (Object.is(item, -0)) return 0;
        if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
          return Object.assign(Object.create(null) as object, item);
        }
        return item;
      },
    );
    if (depthOf(value) > MAX_JSON_DEPTH) throw new RangeError('depth');
  } catch {
    reject('json_invalid');
  }
  // Duplicate keys: JSON.parse and PHP's json_decode both keep the last one, so they agree.
  return value as JsonValue;
}

function depthOf(value: unknown): number {
  if (value === null || typeof value !== 'object') return 0;
  let deepest = 0;
  for (const child of Object.values(value))
    deepest = Math.max(deepest, depthOf(child));
  return deepest + 1;
}

export function isJsonObject(
  value: unknown,
): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** True when the object has exactly these keys — strict envelopes (SEC-20, SEC-24). */
export function hasExactKeys(
  value: { [key: string]: unknown },
  keys: readonly string[],
): boolean {
  const own = Object.keys(value);
  return (
    own.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}
