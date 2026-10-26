import { describe, expect, it } from 'vitest';
import { toBase64Url } from '../encoding/base64url';
import { encodeEcdsaDer } from './webauthn';
import {
  PasskeyAssertionError,
  type AssertionInput,
  verifyAssertion,
} from './webauthn-attestation';

const RP_ID = 'moat.example.ch';
const ORIGIN = 'https://moat.example.ch';
const utf8 = (text: string) => new TextEncoder().encode(text);
const sha256 = async (data: Uint8Array) =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(data)));

async function authenticator() {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const point = new Uint8Array(
    await crypto.subtle.exportKey('raw', pair.publicKey),
  );
  return {
    point,
    async assert(
      challenge: Uint8Array,
      patch: {
        clientType?: string;
        flags?: number;
        rpId?: string;
        origin?: string;
        signCount?: number;
        clientExtra?: Record<string, unknown>;
      } = {},
    ): Promise<AssertionInput> {
      const counter = new Uint8Array(4);
      new DataView(counter.buffer).setUint32(0, patch.signCount ?? 7, false);
      const authenticatorData = new Uint8Array([
        ...(await sha256(utf8(patch.rpId ?? RP_ID))),
        patch.flags ?? 0x05,
        ...counter,
      ]);
      const clientDataJSON = utf8(
        JSON.stringify({
          type: patch.clientType ?? 'webauthn.get',
          challenge: toBase64Url(challenge),
          origin: patch.origin ?? ORIGIN,
          ...patch.clientExtra,
        }),
      );
      const rs = new Uint8Array(
        await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          pair.privateKey,
          new Uint8Array([
            ...authenticatorData,
            ...(await sha256(clientDataJSON)),
          ]),
        ),
      );
      return {
        point,
        challenge,
        rpId: RP_ID,
        origin: ORIGIN,
        authenticatorData,
        clientDataJSON,
        signature: encodeEcdsaDer(rs),
      };
    },
  };
}

const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PasskeyAssertionError) return error.code;
    throw error;
  }
  return 'accepted';
};

describe('verifyAssertion (sign in with a passkey)', () => {
  const challenge = new Uint8Array(32).fill(7);

  it('accepts a good assertion and reports the counter', async () => {
    const device = await authenticator();
    expect(await verifyAssertion(await device.assert(challenge))).toEqual({
      signCount: 7,
    });
  });

  it('refuses each broken part with its own code', async () => {
    const device = await authenticator();
    const other = await authenticator();
    const good = await device.assert(challenge);
    const wrongType = await device.assert(challenge, {
      clientType: 'webauthn.create',
    });
    const noUv = await device.assert(challenge, { flags: 0x01 });
    const noUp = await device.assert(challenge, { flags: 0x04 });
    const crossOrigin = await device.assert(challenge, {
      clientExtra: { crossOrigin: true },
    });
    const flipped = {
      ...good,
      authenticatorData: new Uint8Array([
        ...good.authenticatorData.slice(0, 36),
        9,
      ]),
    };
    const cases: [string, AssertionInput][] = [
      ['challenge_mismatch', { ...good, challenge: new Uint8Array(32) }],
      ['origin_mismatch', { ...good, origin: 'https://evil.example' }],
      ['rp_mismatch', { ...good, rpId: 'evil.example' }],
      ['client_data_invalid', wrongType],
      ['user_verification_missing', noUv],
      ['user_verification_missing', noUp],
      ['origin_mismatch', crossOrigin],
      [
        'assertion_malformed',
        { ...good, authenticatorData: new Uint8Array(10) },
      ],
      ['assertion_malformed', { ...good, signature: new Uint8Array(200) }],
      ['client_data_invalid', { ...good, clientDataJSON: new Uint8Array(0) }],
      ['client_data_invalid', { ...good, clientDataJSON: utf8('[1]') }],
      ['signature_invalid', { ...good, point: other.point }],
      ['signature_invalid', { ...good, point: new Uint8Array(65) }],
      ['signature_invalid', flipped],
    ];
    for (const [code, input] of cases)
      expect(await codeOf(verifyAssertion(input)), code).toBe(code);
  });
});
