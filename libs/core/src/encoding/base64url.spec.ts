import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MoatRejection } from '../errors';
import { fromBase64Url, fromBase64UrlLength, toBase64Url } from './base64url';
import { toBase32 } from './base32';

describe('base64url', () => {
  it('round-trips any bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 300 }), (bytes) => {
        expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
      }),
    );
  });

  it('accepts exactly one encoding per byte string (no padding, no trailing bits)', () => {
    fc.assert(
      fc.property(
        fc.string({
          unit: fc.constantFrom(...'AZaz09-_=+/ '.split('')),
          maxLength: 12,
        }),
        (text) => {
          let decoded: Uint8Array;
          try {
            decoded = fromBase64Url(text);
          } catch (error) {
            expect(error).toBeInstanceOf(MoatRejection);
            return;
          }
          expect(toBase64Url(decoded)).toBe(text);
        },
      ),
    );
  });

  it('checks the decoded length (SEC-03: keys and signatures have fixed sizes)', () => {
    expect(() => fromBase64UrlLength('Zg', 2)).toThrow('encoding_invalid');
    expect(() => fromBase64UrlLength(42, 1)).toThrow('encoding_invalid');
    expect(fromBase64UrlLength('Zg', 1)).toEqual(new Uint8Array([0x66]));
  });
});

describe('base32', () => {
  it('matches RFC 4648 test vectors (upper case, no padding)', () => {
    const cases: [string, string][] = [
      ['', ''],
      ['f', 'MY'],
      ['fo', 'MZXQ'],
      ['foo', 'MZXW6'],
      ['foob', 'MZXW6YQ'],
      ['fooba', 'MZXW6YTB'],
      ['foobar', 'MZXW6YTBOI'],
    ];
    for (const [text, encoded] of cases)
      expect(toBase32(new TextEncoder().encode(text))).toBe(encoded);
  });
});
