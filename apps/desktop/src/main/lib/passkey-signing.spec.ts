import { describe, expect, it } from 'vitest';
import { MESSAGES } from './messages';
import { PASSKEY_ORIGIN, PASSKEY_RP_ID, type PasskeyRecord } from './passkey';
import {
  type Assertion,
  PasskeySigningSession,
  type PasskeySigningDeps,
} from './passkey-signing';
import type { BundlePreview, SignResult } from './signing';

const PASSKEY: PasskeyRecord = {
  credentialId: 'Q'.repeat(43),
  publicKey: 'B'.repeat(87),
  kid: 'C'.repeat(22),
  rpId: PASSKEY_RP_ID,
  origin: PASSKEY_ORIGIN,
};
const b64 = (bytes: number[]) => Buffer.from(bytes).toString('base64url');

function preview(digest: string): BundlePreview {
  return {
    project: 'shop',
    gate: 'site',
    version: 1,
    previousVersion: 0,
    locked: false,
    changes: [],
    previous: 'none',
    digest,
  };
}

/** The API stand-in: asks for the assertion, "verifies" it by a rule the test sets. */
function setup(
  options: {
    accept?: (assertion: Assertion) => boolean;
    changeAfterAsk?: boolean;
  } = {},
) {
  let digest = 'digest-1';
  const challenges: Uint8Array[] = [];
  const written: string[] = [];
  const deps: PasskeySigningDeps = {
    texts: MESSAGES['de-CH'].passkeySignDialog,
    passkey: PASSKEY,
    fingerprint: 'MOAT-TEST',
    prepare: async () => ({ status: 'ready', preview: preview(digest) }),
    sign: async (expected, assert): Promise<SignResult> => {
      if (expected !== digest) return { status: 'changed' };
      const challenge = new Uint8Array(32).fill(7);
      challenges.push(challenge);
      const assertion = await assert(challenge);
      if (assertion === null)
        return { status: 'passkey_refused', code: 'cancelled' };
      if (options.changeAfterAsk) {
        digest = 'digest-2';
        return { status: 'changed' };
      }
      if (!(options.accept ?? (() => true))(assertion))
        return { status: 'passkey_refused', code: 'assertion_invalid' };
      written.push(expected);
      return { status: 'signed', version: 1, kid: PASSKEY.kid };
    },
  };
  return {
    session: new PasskeySigningSession(deps),
    challenges,
    written,
    changeProject: () => {
      digest = 'digest-2';
    },
  };
}

const asserted = (overrides: Record<string, unknown> = {}) => ({
  status: 'asserted' as const,
  credentialId: PASSKEY.credentialId,
  authenticatorData: b64([1, 2, 3]),
  clientDataJSON: b64([4, 5, 6]),
  signature: b64([7, 8, 9]),
  ...overrides,
});

async function begin(session: PasskeySigningSession) {
  const step = await session.begin();
  if (step === null || !('begin' in step) || step.begin.kind !== 'request')
    throw new Error('no passkey request');
  return step.begin.request;
}

describe('PasskeySigningSession (DT-15, trust mode 2)', () => {
  it('shows the preview and the passkey fingerprint, and signs the confirmed digest', async () => {
    const { session, written, challenges } = setup();
    const opened = await session.open();
    if (!('view' in opened)) throw new Error('not open');
    expect(opened.view).toMatchObject({
      project: 'shop',
      gate: 'site',
      fingerprint: 'MOAT-TEST',
      rpId: PASSKEY_RP_ID,
      notice: null,
    });
    const request = await begin(session);
    // The window gets the challenge of the bundle, the stored credential and the pinned rpId.
    expect(request).toMatchObject({
      credentialId: PASSKEY.credentialId,
      rpId: PASSKEY_RP_ID,
    });
    expect(Buffer.from(request.challenge, 'base64url')).toEqual(
      Buffer.from(challenges[0] ?? []),
    );
    const done = await session.deliver(asserted());
    expect(done).toEqual({ done: { status: 'signed', version: 1 } });
    expect(written).toEqual(['digest-1']);
  });

  it('writes nothing when the passkey answers with another credential', async () => {
    const { session, written } = setup();
    await session.open();
    await begin(session);
    const step = await session.deliver(
      asserted({ credentialId: 'Z'.repeat(43) }),
    );
    expect(written).toEqual([]);
    expect(step).toMatchObject({ view: { notice: 'assertion_invalid' } });
  });

  it('writes nothing when what comes back is not bytes of the right size', async () => {
    const { session, written } = setup();
    await session.open();
    for (const bad of [
      { signature: '***' },
      { signature: 'A'.repeat(500) },
      { authenticatorData: '' },
      { clientDataJSON: 'A'.repeat(3000) },
    ]) {
      await begin(session);
      const step = await session.deliver(asserted(bad));
      expect(step).toMatchObject({ view: { notice: 'assertion_invalid' } });
    }
    expect(written).toEqual([]);
  });

  it('writes nothing when the signature does not verify as the gate would', async () => {
    const { session, written } = setup({ accept: () => false });
    await session.open();
    await begin(session);
    expect(await session.deliver(asserted())).toMatchObject({
      view: { notice: 'assertion_invalid' },
    });
    expect(written).toEqual([]);
  });

  it('reports a passkey that was cancelled, missing or failed, and lets the person try again', async () => {
    const { session, written } = setup();
    await session.open();
    for (const reason of ['cancelled', 'unavailable', 'failed'] as const) {
      await begin(session);
      expect(await session.deliver({ status: 'failed', reason })).toMatchObject(
        {
          view: { notice: reason },
        },
      );
    }
    await begin(session);
    expect(await session.deliver(asserted())).toEqual({
      done: { status: 'signed', version: 1 },
    });
    expect(written).toHaveLength(1);
  });

  it('asks again with a new preview when the project changed, before or while at the passkey', async () => {
    const before = setup();
    await before.session.open();
    before.changeProject();
    const step = await before.session.begin();
    expect(step).toMatchObject({
      begin: { kind: 'view', view: { notice: 'changed' } },
    });
    expect(before.written).toEqual([]);

    const during = setup({ changeAfterAsk: true });
    await during.session.open();
    await begin(during.session);
    expect(await during.session.deliver(asserted())).toMatchObject({
      view: { notice: 'changed' },
    });
    expect(during.written).toEqual([]);
  });

  it('closing the window while the passkey is asked releases the signing', async () => {
    const { session, written } = setup();
    await session.open();
    await begin(session);
    session.cancel();
    // A late answer finds nothing waiting.
    expect(await session.deliver(asserted())).toMatchObject({ view: {} });
    expect(written).toEqual([]);
  });

  it('does not start a second signing while one is waiting for the passkey', async () => {
    const { session } = setup();
    await session.open();
    await begin(session);
    expect(await session.begin()).toBeNull();
  });

  it('refuses to deliver before the passkey was asked', async () => {
    const { session, written } = setup();
    await session.open();
    expect(await session.deliver(asserted())).toMatchObject({ view: {} });
    expect(written).toEqual([]);
  });
});
