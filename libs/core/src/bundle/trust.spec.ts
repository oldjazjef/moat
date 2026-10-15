import { describe, expect, it } from 'vitest';
import {
  publicPoint,
  scalarFrom,
  signDeterministic,
} from '../../scripts/p256-test-signer';
import { keyId } from '../crypto/kid';
import { sodium } from '../crypto/sodium';
import { encodeEcdsaDer, webauthnSignature } from '../crypto/webauthn';
import { toBase64Url } from '../encoding/base64url';
import { concatBytes, utf8 } from '../encoding/utf8';
import { MoatRejection } from '../errors';
import {
  assembleEnvelope,
  bundlePayloadBytes,
  verifyBundle,
  webauthnChallenge,
  type BundlePayload,
  type PinnedSigner,
} from './bundle';
import { encodeTrust, parseTrust } from './trust';

const GATE_ID = 'q3V8x1Yp0mZb2cWfK9d7aA';
const payload: BundlePayload = {
  type: 'moat.bundle',
  v: 1,
  gateId: GATE_ID,
  version: 1,
  issuedAt: 1,
  expiresAt: null,
  config: { version: 1 },
  secrets: {},
};

async function passkey(): Promise<{
  scalar: bigint;
  signer: PinnedSigner;
}> {
  const scalar = scalarFrom(utf8('a fixed test-only seed of 32 byte'));
  const publicKey = publicPoint(scalar);
  return {
    scalar,
    signer: {
      kid: await keyId('webauthn-es256', publicKey),
      alg: 'webauthn-es256',
      publicKey,
      rpId: 'moat.example.org',
      origins: ['app://moat'],
    },
  };
}

describe('the passkey signing path of a desktop', () => {
  it('webauthnChallenge is SHA-256 of the signed message, and an assertion over it verifies', async () => {
    const na = await sodium();
    const { scalar, signer } = await passkey();
    const payloadBytes = bundlePayloadBytes(payload);
    const challenge = await webauthnChallenge(payloadBytes);
    expect(challenge).toEqual(
      na.crypto_hash_sha256(
        concatBytes(utf8('moat:bundle:v1\n'), payloadBytes),
      ),
    );

    // What an authenticator returns for that challenge.
    const clientDataJSON = utf8(
      JSON.stringify({
        type: 'webauthn.get',
        challenge: toBase64Url(challenge),
        origin: 'app://moat',
        crossOrigin: false,
      }),
    );
    const authenticatorData = concatBytes(
      na.crypto_hash_sha256(utf8('moat.example.org')),
      new Uint8Array([0x05, 0, 0, 0, 1]),
    );
    const signature = encodeEcdsaDer(
      signDeterministic(
        na,
        scalar,
        concatBytes(authenticatorData, na.crypto_hash_sha256(clientDataJSON)),
      ),
    );
    const entry = webauthnSignature({
      kid: signer.kid,
      authenticatorData,
      clientDataJSON,
      signature,
    });
    expect(Object.keys(entry)).toEqual([
      'kid',
      'alg',
      'sig',
      'authenticatorData',
      'clientDataJSON',
    ]);

    const verified = await verifyBundle(
      utf8(assembleEnvelope(payloadBytes, [entry])),
      {
        gateId: GATE_ID,
        signers: [signer],
        threshold: 1,
        currentVersion: 0,
        now: 0,
        expiryEnabled: false,
      },
    );
    expect(verified.payload.version).toBe(1);
  });
});

describe('trust.json', () => {
  it('encodeTrust and parseTrust round-trip a mode 2 file', async () => {
    const { signer } = await passkey();
    const trust = {
      gateId: GATE_ID,
      mode: 2 as const,
      threshold: 1,
      signers: [signer],
    };
    const parsed = await parseTrust(encodeTrust(trust), GATE_ID);
    expect(parsed).toEqual(trust);
  });

  it('refuses a file for another gate with trust_invalid, never a partial result', async () => {
    const { signer } = await passkey();
    const text = encodeTrust({
      gateId: 'someone-else',
      mode: 2,
      threshold: 1,
      signers: [signer],
    });
    await expect(parseTrust(text, GATE_ID)).rejects.toSatisfy(
      (error) =>
        error instanceof MoatRejection && error.code === 'trust_invalid',
    );
  });
});
