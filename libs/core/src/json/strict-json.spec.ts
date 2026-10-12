import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../canonical/jcs';
import { utf8 } from '../encoding/utf8';
import { MoatRejection } from '../errors';
import { parseStrictJson, type JsonValue } from './strict-json';

const json = fc.letrec<{ value: JsonValue }>((tie) => ({
  value: fc.oneof(
    { depthSize: 'small' },
    fc.constant(null),
    fc.boolean(),
    fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
    fc.string(),
    fc.array(tie('value'), { maxLength: 4 }),
    fc.dictionary(fc.string(), tie('value'), { maxKeys: 4 }),
  ),
})).value;

describe('parseStrictJson', () => {
  it('reads back what canonicalJson writes (fuzz)', () => {
    fc.assert(
      fc.property(json, (value) => {
        const text = canonicalJson(value);
        expect(canonicalJson(parseStrictJson(utf8(text)))).toBe(text);
      }),
    );
  });

  it('never throws anything but a json_invalid rejection on arbitrary bytes (fuzz)', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), (bytes) => {
        try {
          parseStrictJson(bytes);
        } catch (error) {
          expect(error).toBeInstanceOf(MoatRejection);
          expect((error as MoatRejection).code).toBe('json_invalid');
        }
      }),
    );
  });

  it('keeps __proto__ as data instead of changing the prototype (DT-17)', () => {
    const value = parseStrictJson(
      utf8('{"__proto__":{"admin":true}}'),
    ) as Record<string, unknown>;
    expect(Object.getPrototypeOf(value)).toBeNull();
    expect(Object.keys(value)).toEqual(['__proto__']);
    expect((value as { admin?: unknown }).admin).toBeUndefined();
  });

  it('rejects deep nesting without a stack overflow', () => {
    const deep = '['.repeat(100_000) + ']'.repeat(100_000);
    expect(() => parseStrictJson(utf8(deep))).toThrow('json_invalid');
  });
});
