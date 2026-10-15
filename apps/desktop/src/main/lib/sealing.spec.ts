import { MESSAGES } from './messages';
import {
  MAX_VALUE_BYTES,
  type PrepareSealResult,
  type SealPreview,
  type SealResult,
  SealingSession,
} from './sealing';

const PREVIEW: SealPreview = {
  project: 'shop',
  gate: 'site',
  gateId: 'AAAAAAAAAAAAAAAAAAAAAA',
  boxKeyFingerprint: 'MOAT-ABCD-EFGH',
  name: 'hubspot-token',
  currentVersion: 1,
  nextVersion: 2,
  usedBy: [{ upstream: 'hubspot', origin: 'https://api.hubapi.com' }],
  comparedBy: [],
  digest: 'digest-1',
};
/** TEST ONLY */
const VALUE = 'pat-PLANTED-TEST-ONLY';

function setup() {
  let prepared: PrepareSealResult = { status: 'ready', preview: PREVIEW };
  const results: SealResult[] = [];
  const calls: { digest: string; value: string }[] = [];
  const session = new SealingSession({
    texts: MESSAGES['de-CH'].sealDialog,
    prepare: () => Promise.resolve(prepared),
    seal: (digest, value) => {
      calls.push({ digest, value: new TextDecoder().decode(value) });
      return Promise.resolve(
        results.shift() ?? { status: 'sealed', secretVersion: 2 },
      );
    },
  });
  return {
    session,
    calls,
    results,
    setPrepared: (next: PrepareSealResult) => (prepared = next),
  };
}

const bytes = (text: string) => new TextEncoder().encode(text);

describe('SealingSession', () => {
  it('shows the gate by fingerprint and the secret, never a value or the digest', async () => {
    const { session } = setup();
    const step = await session.open();
    expect(step).toMatchObject({
      view: {
        gate: 'site',
        fingerprint: 'MOAT-ABCD-EFGH',
        name: 'hubspot-token',
        currentVersion: 1,
        nextVersion: 2,
        notice: null,
      },
    });
    expect(JSON.stringify(step)).not.toContain('digest-1');
  });

  it('seals for the shown gate and version, and zeroes the value', async () => {
    const { session, calls } = setup();
    await session.open();
    const value = bytes(VALUE);
    expect(await session.confirm(value)).toEqual({
      done: { status: 'sealed', secretVersion: 2 },
    });
    expect(calls).toEqual([{ digest: 'digest-1', value: VALUE }]);
    expect(value.every((byte) => byte === 0)).toBe(true);
  });

  it('keeps the window open for a bad value and refuses one too long before passing it on', async () => {
    const { session, calls, results } = setup();
    await session.open();
    results.push({ status: 'value_invalid' });
    expect(await session.confirm(bytes('a\nb'))).toMatchObject({
      view: { notice: 'value_invalid' },
    });
    const long = new Uint8Array(MAX_VALUE_BYTES + 1).fill(0x61);
    expect(await session.confirm(long)).toMatchObject({
      view: { notice: 'value_invalid' },
    });
    expect(long.every((byte) => byte === 0)).toBe(true);
    expect(await session.confirm(new Uint8Array())).toMatchObject({
      view: { notice: 'value_invalid' },
    });
    expect(calls).toHaveLength(1);
  });

  it('shows the new state instead of sealing when the gate or version changed', async () => {
    const { session, results, setPrepared, calls } = setup();
    await session.open();
    results.push({ status: 'changed' });
    setPrepared({
      status: 'ready',
      preview: { ...PREVIEW, nextVersion: 3, digest: 'digest-2' },
    });
    expect(await session.confirm(bytes(VALUE))).toMatchObject({
      view: { notice: 'changed', nextVersion: 3 },
    });
    await session.confirm(bytes(VALUE));
    expect(calls.map((call) => call.digest)).toEqual(['digest-1', 'digest-2']);
  });

  it('ends with what blocks it', async () => {
    const { session, setPrepared } = setup();
    setPrepared({ status: 'refused', code: 'secret_unknown' });
    expect(await session.open()).toEqual({
      done: { status: 'refused', code: 'secret_unknown' },
    });
  });
});
