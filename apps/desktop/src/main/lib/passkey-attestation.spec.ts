import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decodeCbor,
  parseAttestationObject,
  PasskeyEnrollmentError,
  verifyEnrollment,
} from './passkey-attestation';
import {
  attestation,
  type Cbor,
  coseKey,
  encodeCbor,
  p256Coordinates,
  raw,
} from './passkey-testing';

const RP_ID = 'passkey.moat.invalid';
const ORIGIN = 'https://passkey.moat.invalid';

async function enroll(
  challenge: Uint8Array,
  options: Parameters<typeof attestation>[1] = {},
  expected: { rpId?: string; origin?: string; challenge?: Uint8Array } = {},
) {
  const made = attestation(challenge, options);
  return {
    made,
    result: await verifyEnrollment({
      attestationObject: made.attestationObject,
      clientDataJSON: made.clientDataJSON,
      challenge: expected.challenge ?? challenge,
      rpId: expected.rpId ?? RP_ID,
      origin: expected.origin ?? ORIGIN,
    }),
  };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PasskeyEnrollmentError) return error.code;
    throw error;
  }
  return 'accepted';
}

describe('decodeCbor (a strict subset)', () => {
  it('reads integers, strings, arrays and maps', () => {
    const value = decodeCbor(
      encodeCbor(
        new Map<number | string, Cbor>([
          [1, 2],
          ['a', [1, -1, 'x', new Uint8Array([1])]],
        ]),
      ),
    ) as Map<number | string, unknown>;
    expect(value.get(1)).toBe(2);
    expect(value.get('a')).toEqual([1, -1, 'x', new Uint8Array([1])]);
  });

  it.each([
    ['truncated', Uint8Array.of(0x42, 0x01)],
    ['an empty input', new Uint8Array()],
    ['trailing bytes', Uint8Array.of(0x01, 0x02)],
    ['an indefinite-length byte string', Uint8Array.of(0x5f, 0x41, 0x01, 0xff)],
    ['an indefinite-length map', Uint8Array.of(0xbf, 0xff)],
    ['a tag', Uint8Array.of(0xc1, 0x01)],
    ['a float', Uint8Array.of(0xf9, 0x3c, 0x00)],
    ['a boolean', Uint8Array.of(0xf5)],
    ['null', Uint8Array.of(0xf6)],
    ['a non-minimal integer', Uint8Array.of(0x18, 0x05)],
    ['a non-minimal 16-bit length', Uint8Array.of(0x19, 0x00, 0x05)],
    ['an integer beyond 2^53', Uint8Array.of(0x1b, 0x01, 0, 0, 0, 0, 0, 0, 0)],
    ['a reserved additional info', Uint8Array.of(0x1c)],
    ['a string that is not UTF-8', Uint8Array.of(0x62, 0xff, 0xfe)],
    [
      'a byte string longer than the input',
      Uint8Array.of(0x5a, 0xff, 0xff, 0xff, 0xff),
    ],
    ['a duplicate map key', Uint8Array.of(0xa2, 0x01, 0x01, 0x01, 0x02)],
    ['a map key that is an array', Uint8Array.of(0xa1, 0x80, 0x01)],
    [
      'an array of a million items',
      Uint8Array.of(0x9a, 0x00, 0x0f, 0x42, 0x40),
    ],
  ])('refuses %s', (_name, bytes) => {
    expect(() => decodeCbor(bytes)).toThrowError(PasskeyEnrollmentError);
  });

  it('refuses a nesting deeper than any authenticator needs', () => {
    expect(() => decodeCbor(new Uint8Array(40).fill(0x81))).toThrowError(
      PasskeyEnrollmentError,
    );
  });
});

describe('verifyEnrollment (SEC-06, docs/CRYPTO.md §7.1)', () => {
  it('takes the credential id and the 65-byte point from a good ceremony', async () => {
    const challenge = randomBytes(32);
    const { made, result } = await enroll(challenge);
    expect(result.point).toHaveLength(65);
    expect(result.point[0]).toBe(0x04);
    expect(Array.from(result.point.subarray(1, 33))).toEqual(
      Array.from(made.x),
    );
    expect(Array.from(result.point.subarray(33))).toEqual(Array.from(made.y));
    expect(Buffer.from(result.credentialId)).toEqual(
      Buffer.from(made.credentialId),
    );
  });

  it('accepts an attestation statement it does not use, and extension data', async () => {
    const challenge = randomBytes(32);
    const made = attestation(challenge, { fmt: 'packed' });
    expect(
      Buffer.from(parseAttestationObject(made.attestationObject).credentialId),
    ).toEqual(Buffer.from(made.credentialId));
    const extended = attestation(challenge, {
      flags: 0xc5,
      trailing: encodeCbor(new Map<string, Cbor>([['credProtect', 1]])),
    });
    await expect(
      verifyEnrollment({
        attestationObject: extended.attestationObject,
        clientDataJSON: extended.clientDataJSON,
        challenge,
        rpId: RP_ID,
        origin: ORIGIN,
      }),
    ).resolves.toBeDefined();
  });

  describe('attacker cases', () => {
    const challenge = randomBytes(32);

    it('refuses a challenge that is not the one asked for (replay of an old ceremony)', async () => {
      expect(
        await codeOf(enroll(challenge, {}, { challenge: randomBytes(32) })),
      ).toBe('challenge_mismatch');
    });

    it('refuses another origin and a cross-origin ceremony', async () => {
      expect(
        await codeOf(enroll(challenge, { origin: 'https://evil.example' })),
      ).toBe('origin_mismatch');
      expect(await codeOf(enroll(challenge, { origin: 'app://moat' }))).toBe(
        'origin_mismatch',
      );
      const crossed = attestation(challenge, {
        clientDataJSON: new TextEncoder().encode(
          JSON.stringify({
            type: 'webauthn.create',
            challenge: Buffer.from(challenge).toString('base64url'),
            origin: ORIGIN,
            crossOrigin: true,
          }),
        ),
      });
      expect(
        await codeOf(
          verifyEnrollment({
            attestationObject: crossed.attestationObject,
            clientDataJSON: crossed.clientDataJSON,
            challenge,
            rpId: RP_ID,
            origin: ORIGIN,
          }),
        ),
      ).toBe('origin_mismatch');
    });

    it('refuses a get ceremony and malformed client data', async () => {
      expect(
        await codeOf(enroll(challenge, { clientType: 'webauthn.get' })),
      ).toBe('client_data_invalid');
      for (const clientDataJSON of [
        new TextEncoder().encode('not json'),
        new TextEncoder().encode('[]'),
        new Uint8Array(),
        new Uint8Array(4000).fill(0x20),
        Uint8Array.of(0xff, 0xfe),
      ])
        expect(await codeOf(enroll(challenge, { clientDataJSON }))).toBe(
          'client_data_invalid',
        );
    });

    it('refuses a wrong rpIdHash', async () => {
      expect(await codeOf(enroll(challenge, { rpId: 'evil.example' }))).toBe(
        'rp_mismatch',
      );
    });

    it('refuses a passkey made without user verification or presence', async () => {
      expect(await codeOf(enroll(challenge, { flags: 0x41 }))).toBe(
        'user_verification_missing',
      );
      expect(await codeOf(enroll(challenge, { flags: 0x44 }))).toBe(
        'user_verification_missing',
      );
    });

    it('refuses authenticator data without a credential', async () => {
      expect(await codeOf(enroll(challenge, { flags: 0x05 }))).toBe(
        'credential_missing',
      );
      expect(
        await codeOf(enroll(challenge, { credentialId: randomBytes(8) })),
      ).toBe('credential_missing');
    });

    it('refuses a key that is not ES256 on P-256', async () => {
      const { x, y } = p256Coordinates();
      const variants: [string, Map<number, Cbor>][] = [
        [
          'OKP (Ed25519)',
          new Map<number, Cbor>([
            [1, 1],
            [3, -8],
            [-1, 6],
            [-2, x],
          ]),
        ],
        [
          'RS256',
          new Map<number, Cbor>([
            [1, 3],
            [3, -257],
            [-1, x],
            [-2, y],
          ]),
        ],
        [
          'ES384 on P-384',
          new Map<number, Cbor>([
            [1, 2],
            [3, -35],
            [-1, 2],
            [-2, new Uint8Array(48)],
            [-3, new Uint8Array(48)],
          ]),
        ],
        [
          'EC2 with the wrong curve',
          new Map<number, Cbor>([
            [1, 2],
            [3, -7],
            [-1, 2],
            [-2, x],
            [-3, y],
          ]),
        ],
        [
          'a missing y',
          new Map<number, Cbor>([
            [1, 2],
            [3, -7],
            [-1, 1],
            [-2, x],
          ]),
        ],
        [
          'a short x',
          new Map<number, Cbor>([
            [1, 2],
            [3, -7],
            [-1, 1],
            [-2, x.subarray(1)],
            [-3, y],
          ]),
        ],
        [
          'an extra member',
          new Map<number, Cbor>([
            [1, 2],
            [3, -7],
            [-1, 1],
            [-2, x],
            [-3, y],
            [4, 1],
          ]),
        ],
      ];
      for (const [name, cose] of variants)
        expect(await codeOf(enroll(challenge, { cose: cose })), name).toBe(
          'key_unsupported',
        );
    });

    it('refuses a point that is not on the curve', async () => {
      const code = await codeOf(
        enroll(challenge, {
          cose: coseKey(randomBytes(32), randomBytes(32)),
        }),
      );
      expect(code).toBe('point_invalid');
      expect(
        await codeOf(
          enroll(challenge, {
            cose: coseKey(new Uint8Array(32), new Uint8Array(32)),
          }),
        ),
      ).toBe('point_invalid');
    });

    it('refuses malformed attestation objects', async () => {
      const good = attestation(challenge).attestationObject;
      const cases: Uint8Array[] = [
        new Uint8Array(),
        good.subarray(0, good.length - 1),
        good.subarray(0, 20),
        new Uint8Array([...good, 0]),
        encodeCbor('not a map'),
        encodeCbor(new Map<string, Cbor>([['fmt', 'none']])),
        encodeCbor(
          new Map<string, Cbor>([
            ['fmt', 5],
            ['attStmt', new Map()],
            ['authData', new Uint8Array(100)],
          ]),
        ),
        new Uint8Array(20_000).fill(0x00),
        // authData whose COSE key is followed by junk
        attestation(challenge, { trailing: Uint8Array.of(0x00) })
          .attestationObject,
        // authData whose COSE key is not a map
        attestation(challenge, { cose: raw(Uint8Array.of(0x01)) })
          .attestationObject,
      ];
      for (const attestationObject of cases) {
        const made = attestation(challenge);
        expect(
          await codeOf(
            verifyEnrollment({
              attestationObject,
              clientDataJSON: made.clientDataJSON,
              challenge,
              rpId: RP_ID,
              origin: ORIGIN,
            }),
          ),
        ).toMatch(/attestation_malformed|credential_missing|key_unsupported/);
      }
    });
  });
});
