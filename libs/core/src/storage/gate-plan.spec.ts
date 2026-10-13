import { fingerprint } from '../crypto/kid';
import { fromBase64Url, toBase64Url } from '../encoding/base64url';
import { planGate } from './gate-plan';

const GATE_ID = 'AAAAAAAAAAAAAAAAAAAAAA';
const BOX_KEY = toBase64Url(new Uint8Array(32).fill(7));

describe('planGate (SEC-32, FR-73)', () => {
  it('gives the file the CLI writes and the fingerprint the gate printed', async () => {
    const plan = await planGate({
      name: 'www',
      gateId: GATE_ID,
      boxKey: BOX_KEY,
    });
    expect(plan.path).toBe('gates/www.json');
    expect(JSON.parse(plan.text)).toEqual({
      moat: 'gate',
      v: 1,
      gateId: GATE_ID,
      boxKey: BOX_KEY,
    });
    expect(plan.boxKeyFingerprint).toBe(
      await fingerprint('x25519', fromBase64Url(BOX_KEY)),
    );
    expect(plan.boxKeyFingerprint).toMatch(/^MOAT(-[A-Z2-7]{1,4})+$/);
  });

  it.each([
    [{ name: 'Www', gateId: GATE_ID, boxKey: BOX_KEY }, 'name_invalid'],
    [{ name: '../x', gateId: GATE_ID, boxKey: BOX_KEY }, 'name_invalid'],
    [{ name: 'www', gateId: 'short', boxKey: BOX_KEY }, 'gate_id_invalid'],
    [
      { name: 'www', gateId: `${GATE_ID}\n`, boxKey: BOX_KEY },
      'gate_id_invalid',
    ],
    [
      { name: 'www', gateId: GATE_ID, boxKey: BOX_KEY.slice(1) },
      'box_key_invalid',
    ],
    [
      { name: 'www', gateId: GATE_ID, boxKey: `${BOX_KEY}=` },
      'box_key_invalid',
    ],
    [
      { name: 'www', gateId: GATE_ID, boxKey: toBase64Url(new Uint8Array(31)) },
      'box_key_invalid',
    ],
  ])('refuses %o: %s', async (input, code) => {
    await expect(planGate(input)).rejects.toMatchObject({
      name: 'GatePlanError',
      code,
    });
  });
});
