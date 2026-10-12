import { describe, expect, it } from 'vitest';
import { sodium } from '../crypto/sodium';
import { utf8 } from '../encoding/utf8';
import { MoatRejection } from '../errors';
import { openSecret, sealSecret } from './seal';

const PLANTED_SECRET = 'sk-PLANTED-SECRET-must-never-appear';

async function gateKeys(): Promise<{
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}> {
  const na = await sodium();
  const pair = na.crypto_box_keypair();
  return { secretKey: pair.privateKey, publicKey: pair.publicKey };
}

describe('sealSecret / openSecret', () => {
  it('opens on the gate it was sealed for', async () => {
    const gate = await gateKeys();
    const sealed = await sealSecret(utf8(PLANTED_SECRET), gate.publicKey, {
      gateId: 'g1',
      secretName: 'hubspot-token',
      secretVersion: 1,
    });
    const opened = await openSecret(
      sealed,
      gate.secretKey,
      'g1',
      'hubspot-token',
    );
    expect(new TextDecoder().decode(opened)).toBe(PLANTED_SECRET);
  });

  it('uses fresh randomness for every seal', async () => {
    const gate = await gateKeys();
    const binding = { gateId: 'g1', secretName: 's', secretVersion: 1 };
    const first = await sealSecret(utf8('x'), gate.publicKey, binding);
    const second = await sealSecret(utf8('x'), gate.publicKey, binding);
    expect(first.epk).not.toBe(second.epk);
    expect(first.nonce).not.toBe(second.nonce);
  });

  it('SEC-31: another gate key cannot open it (the Cloud has no gate key)', async () => {
    const gate = await gateKeys();
    const other = await gateKeys();
    const sealed = await sealSecret(utf8(PLANTED_SECRET), gate.publicKey, {
      gateId: 'g1',
      secretName: 's',
      secretVersion: 1,
    });
    await expect(
      openSecret(sealed, other.secretKey, 'g1', 's'),
    ).rejects.toThrow('secret_invalid');
  });

  it('SEC-34: the planted secret appears neither in the sealed object nor in a rejection', async () => {
    const gate = await gateKeys();
    const sealed = await sealSecret(utf8(PLANTED_SECRET), gate.publicKey, {
      gateId: 'g1',
      secretName: 's',
      secretVersion: 1,
    });
    expect(JSON.stringify(sealed)).not.toContain(PLANTED_SECRET);
    try {
      await openSecret(sealed, gate.secretKey, 'g2', 's');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(MoatRejection);
      expect(String(error)).not.toContain(PLANTED_SECRET);
      expect(JSON.stringify(error)).not.toContain(PLANTED_SECRET);
      expect((error as Error).stack ?? '').not.toContain(PLANTED_SECRET);
    }
  });
});
