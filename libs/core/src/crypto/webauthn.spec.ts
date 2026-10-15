import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  P256_ORDER,
  publicPoint,
  scalarFrom,
  signDeterministic,
  toBigInt,
  toBytes32,
} from '../../scripts/p256-test-signer';
import { fromBase64Url } from '../encoding/base64url';
import { utf8 } from '../encoding/utf8';
import {
  encodeEcdsaDer,
  isPasskeyOrigin,
  isRpId,
  MAX_DER_SIGNATURE,
  parseEcdsaDer,
} from './webauthn';
import { sodium } from './sodium';

const hex = (bytes: Uint8Array | null): string | null =>
  bytes === null
    ? null
    : [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');

describe('the test-only RFC 6979 signer', () => {
  it('reproduces RFC 6979 appendix A.2.5 (P-256, SHA-256, "sample")', async () => {
    const na = await sodium();
    const x = BigInt(
      '0xC9AFA9D845BA75166B5C215767B1D6934E50C3DB36E89B127B8A622B120F6721',
    );
    expect(hex(publicPoint(x))).toBe(
      '04' +
        '60fed4ba255a9d31c961eb74c6356d68c049b8923b61fa6ce669622e60f29fb6' +
        '7903fe1008b8bc99a41ae9e95628bc64f2f1b20c2d7e9f5177a3c294d4462299',
    );
    expect(hex(signDeterministic(na, x, utf8('sample')))).toBe(
      'efd48b2aacb6a8fd1140dd9cd45e81d69d2c877b56aaf991c34d0ea84eaf3716' +
        'f7cb1c942d657c41d436c7a1b6e29f65f3e900dbb9aff4064dc4ab2f843acda8',
    );
  });
});

describe('strict ECDSA DER (docs/CRYPTO.md §7.3 step 5)', () => {
  const rs = (r: number[], s: number[]): Uint8Array => {
    const out = new Uint8Array(64);
    out.set(r, 32 - r.length);
    out.set(s, 64 - s.length);
    return out;
  };

  it('round-trips the canonical encoding, including a high first bit', () => {
    const value = rs([0x80, 1], [0xff, 0xfe]);
    const der = encodeEcdsaDer(value);
    expect(hex(der)).toBe('300a' + '0203008001' + '020300fffe');
    expect(parseEcdsaDer(der)).toEqual(value);
  });

  const good = encodeEcdsaDer(rs([0x12, 0x34], [0x56]));
  it.each([
    ['a byte after the sequence', Uint8Array.of(...good, 0)],
    [
      'a long-form sequence length',
      Uint8Array.of(0x30, 0x81, good.length - 2, ...good.subarray(2)),
    ],
    ['an empty input', new Uint8Array(0)],
    ['a truncated signature', good.subarray(0, good.length - 1)],
    ['the wrong outer tag', Uint8Array.of(0x31, ...good.subarray(1))],
    [
      'a non-minimal integer (leading zero)',
      Uint8Array.of(0x30, 0x07, 0x02, 0x03, 0x00, 0x12, 0x34, 0x02, 0x01, 0x56),
    ],
    [
      'a negative integer',
      Uint8Array.of(0x30, 0x06, 0x02, 0x02, 0x92, 0x34, 0x02, 0x01, 0x56),
    ],
    ['r = 0', Uint8Array.of(0x30, 0x06, 0x02, 0x01, 0x00, 0x02, 0x01, 0x56)],
    ['s = 0', Uint8Array.of(0x30, 0x06, 0x02, 0x01, 0x12, 0x02, 0x01, 0x00)],
    [
      'an empty integer',
      Uint8Array.of(0x30, 0x05, 0x02, 0x00, 0x02, 0x01, 0x56),
    ],
    [
      'a wrong integer tag',
      Uint8Array.of(0x30, 0x06, 0x03, 0x01, 0x12, 0x02, 0x01, 0x56),
    ],
    [
      'a third integer',
      Uint8Array.of(
        0x30,
        0x09,
        0x02,
        0x01,
        0x12,
        0x02,
        0x01,
        0x56,
        0x02,
        0x01,
        0x01,
      ),
    ],
  ])('rejects %s', (_name, der) => {
    expect(parseEcdsaDer(der)).toBeNull();
  });

  it('rejects r and s of n or more, accepts n − 1 and a high S', () => {
    const atLimit = toBytes32(P256_ORDER - 1n);
    expect(
      parseEcdsaDer(encodeEcdsaDer(concat(atLimit, atLimit))),
    ).not.toBeNull();
    const atOrder = toBytes32(P256_ORDER);
    expect(parseEcdsaDer(encodeEcdsaDer(concat(atOrder, atLimit)))).toBeNull();
    expect(parseEcdsaDer(encodeEcdsaDer(concat(atLimit, atOrder)))).toBeNull();
  });

  const scalar = fc
    .uint8Array({ minLength: 32, maxLength: 32 })
    .map((bytes) => toBytes32((toBigInt(bytes) % (P256_ORDER - 1n)) + 1n));

  it('property: every r, s in range encodes to a DER that parses back to r ‖ s', () => {
    fc.assert(
      fc.property(scalar, scalar, (r, s) => {
        const der = encodeEcdsaDer(concat(r, s));
        expect(der.length).toBeLessThanOrEqual(MAX_DER_SIGNATURE);
        expect(parseEcdsaDer(der)).toEqual(concat(r, s));
      }),
    );
  });

  it('property: arbitrary bytes never throw, and what parses is the canonical encoding (one DER per signature)', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 90 }), (bytes) => {
        const parsed = parseEcdsaDer(bytes);
        if (parsed !== null) expect(encodeEcdsaDer(parsed)).toEqual(bytes);
      }),
      { numRuns: 2000 },
    );
  });

  it('property: any single-byte change, truncation or extension of a valid DER is rejected or canonical', () => {
    fc.assert(
      fc.property(
        scalar,
        scalar,
        fc.nat(80),
        fc.nat(255),
        fc.constantFrom('flip', 'cut', 'grow'),
        (r, s, at, byte, kind) => {
          const der = encodeEcdsaDer(concat(r, s));
          const changed =
            kind === 'flip'
              ? Uint8Array.from(der, (value, index) =>
                  index === at % der.length ? byte : value,
                )
              : kind === 'cut'
                ? der.subarray(0, at % der.length)
                : Uint8Array.of(...der, byte);
          const parsed = parseEcdsaDer(changed);
          if (parsed !== null) expect(encodeEcdsaDer(parsed)).toEqual(changed);
          if (kind !== 'flip') expect(parsed).toBeNull();
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('a signature of the test signer is valid DER', async () => {
    const na = await sodium();
    const signature = signDeterministic(
      na,
      scalarFrom(utf8('x'.repeat(32))),
      utf8('m'),
    );
    expect(parseEcdsaDer(encodeEcdsaDer(signature))).toEqual(signature);
  });
});

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  return Uint8Array.of(...a, ...b);
}

describe('rpId and origin grammar (docs/CRYPTO.md §7.1)', () => {
  it.each([
    'moat.example.org',
    'localhost',
    'a',
    'xn--bcher-kva.example',
    'a-b.c-d.example',
  ])('rpId %s is valid', (value) => expect(isRpId(value)).toBe(true));
  it.each([
    '',
    'Moat.example.org',
    'moat.example.org.',
    '.example.org',
    'a..b',
    '-a.example',
    'a-.example',
    '127.0.0.1',
    '1.2',
    'bücher.example',
    'a b.example',
    `${'a'.repeat(64)}.example`,
    `${'a.'.repeat(126)}ab`,
  ])('rpId %j is invalid', (value) => expect(isRpId(value)).toBe(false));
  it('rpId of 253 characters is valid, of 254 is not', () => {
    const label = 'a'.repeat(63);
    const long = `${label}.${label}.${label}.${'a'.repeat(61)}`;
    expect(long).toHaveLength(253);
    expect(isRpId(long)).toBe(true);
    expect(isRpId(`${long}a`)).toBe(false);
  });

  it.each([
    'app://moat',
    'https://moat.example.org',
    'https://moat.example.org:8443',
    'https://localhost:3000',
    'app://a',
    'https://a:1',
    'https://a:65535',
  ])('origin %s is valid', (value) =>
    expect(isPasskeyOrigin(value)).toBe(true),
  );
  it.each([
    'app://Moat',
    'app://',
    'app://moat/',
    'app://1moat',
    'http://moat.example.org',
    'https://moat.example.org/',
    'https://moat.example.org/path',
    'https://moat.example.org:443',
    'https://moat.example.org:0',
    'https://moat.example.org:65536',
    'https://moat.example.org:08080',
    'https://MOAT.example.org',
    'https://moat.example.org?x',
    'https://127.0.0.1',
    'https://user@moat.example.org',
    ' https://moat.example.org',
    `https://${'a'.repeat(300)}.example`,
  ])('origin %j is invalid', (value) =>
    expect(isPasskeyOrigin(value)).toBe(false),
  );

  it('fromBase64Url is what the entries use (no padding)', () => {
    expect(() => fromBase64Url('AA==')).toThrow();
  });
});
