import { describe, expect, it } from 'vitest';
import { keyId } from '../crypto/kid';
import { sodium } from '../crypto/sodium';
import { utf8 } from '../encoding/utf8';
import { MoatRejection } from '../errors';
import {
  signBundle,
  verifyBundle,
  type BundlePayload,
  type Ed25519Signer,
  type VerificationContext,
} from './bundle';

async function freshSigner(): Promise<{ signer: Ed25519Signer; kid: string }> {
  const na = await sodium();
  const pair = na.crypto_sign_keypair();
  const signer: Ed25519Signer = {
    alg: 'ed25519',
    secretKey: pair.privateKey,
    publicKey: pair.publicKey,
  };
  return { signer, kid: await keyId('ed25519', pair.publicKey) };
}

const payload: BundlePayload = {
  type: 'moat.bundle',
  v: 1,
  gateId: 'gate-under-test',
  version: 2,
  issuedAt: 100,
  expiresAt: null,
  config: { version: 1 },
  secrets: {},
};

async function context(overrides: Partial<VerificationContext> = {}): Promise<{
  signer: Ed25519Signer;
  context: VerificationContext;
}> {
  const { signer, kid } = await freshSigner();
  return {
    signer,
    context: {
      gateId: 'gate-under-test',
      signers: [{ kid, alg: 'ed25519', publicKey: signer.publicKey }],
      threshold: 1,
      currentVersion: 1,
      now: 200,
      expiryEnabled: true,
      ...overrides,
    },
  };
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof MoatRejection) return error.code;
    throw error;
  }
  throw new Error('expected a rejection');
}

describe('signBundle / verifyBundle', () => {
  it('accepts what it signs and returns the exact signed bytes', async () => {
    const { signer, context: ctx } = await context();
    const envelope = await signBundle(payload, [signer]);
    const verified = await verifyBundle(utf8(envelope), ctx);
    expect(verified.payload).toEqual(payload);
    const decoded = JSON.parse(envelope) as { payload: string };
    expect(Buffer.from(verified.payloadBytes).toString('base64url')).toBe(
      decoded.payload,
    );
  });

  it('SEC-01: a bundle signed by a key the gate has not pinned is rejected (compromised Cloud)', async () => {
    const { context: ctx } = await context();
    const attacker = await freshSigner();
    const envelope = await signBundle({ ...payload, version: 99 }, [
      attacker.signer,
    ]);
    expect(await rejection(verifyBundle(utf8(envelope), ctx))).toBe(
      'threshold_not_met',
    );
  });

  it('SEC-07: a valid bundle replayed to another gate is rejected', async () => {
    const { signer, context: ctx } = await context({ gateId: 'another-gate' });
    const envelope = await signBundle(payload, [signer]);
    expect(await rejection(verifyBundle(utf8(envelope), ctx))).toBe(
      'gate_mismatch',
    );
  });

  it('SEC-04: replay and downgrade are rejected', async () => {
    const { signer, context: ctx } = await context({ currentVersion: 2 });
    expect(
      await rejection(
        verifyBundle(utf8(await signBundle(payload, [signer])), ctx),
      ),
    ).toBe('version_not_newer');
    expect(
      await rejection(
        verifyBundle(
          utf8(await signBundle({ ...payload, version: 1 }, [signer])),
          ctx,
        ),
      ),
    ).toBe('version_not_newer');
  });

  it('a threshold of 0 still needs one valid signature', async () => {
    const { context: ctx } = await context({ threshold: 0 });
    const attacker = await freshSigner();
    const envelope = await signBundle(payload, [attacker.signer]);
    expect(await rejection(verifyBundle(utf8(envelope), ctx))).toBe(
      'threshold_not_met',
    );
  });
});
