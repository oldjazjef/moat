import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { PasskeyEnrollTexts } from '../../shared/passkey-dialog';
import { MESSAGES } from './messages';
import { PASSKEY_ORIGIN, PASSKEY_RP_ID, type PasskeyRecord } from './passkey';
import { PasskeyEnrollmentSession } from './passkey-enrollment';
import { attestation } from './passkey-testing';

const texts: PasskeyEnrollTexts = MESSAGES['de-CH'].passkeyDialog;
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

function setup(existing: PasskeyRecord | null = null) {
  const stored: PasskeyRecord[] = [];
  let writable = true;
  const session = new PasskeyEnrollmentSession({
    texts,
    random: (length) => randomBytes(length),
    existing: () => stored.at(-1) ?? existing,
    keyInfo: async (point) => ({
      kid: 'K'.repeat(22),
      publicKey: point,
      fingerprint: 'MOAT-TEST',
    }),
    store: (record) => {
      if (!writable) throw new Error('read only');
      stored.push(record);
    },
  });
  return { session, stored, readOnly: () => (writable = false) };
}

const created = (made: ReturnType<typeof attestation>) => ({
  status: 'created' as const,
  attestationObject: b64(made.attestationObject),
  clientDataJSON: b64(made.clientDataJSON),
});

describe('PasskeyEnrollmentSession', () => {
  it('stores the public key and credential id of a good ceremony, and tells the gate command', async () => {
    const { session, stored } = setup();
    const request = session.begin();
    if (request === null) throw new Error('no request');
    expect(request.rpId).toBe(PASSKEY_RP_ID);
    expect(Buffer.from(request.challenge, 'base64url')).toHaveLength(32);
    const made = attestation(Buffer.from(request.challenge, 'base64url'));
    const view = await session.finish(created(made));
    expect(view.notice).toBeNull();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      credentialId: b64(made.credentialId),
      kid: 'K'.repeat(22),
      rpId: PASSKEY_RP_ID,
      origin: PASSKEY_ORIGIN,
    });
    expect(Buffer.from(stored[0]?.publicKey ?? '', 'base64url')).toHaveLength(
      65,
    );
    expect(view.done?.trustCommand).toBe(
      `php moat-gate.php trust --passkey=${stored[0]?.publicKey} --rp-id=passkey.moat.invalid --origin=https://passkey.moat.invalid`,
    );
    expect(view.done?.fingerprint).toBe('MOAT-TEST');
    expect(Object.keys(view.done ?? {}).sort()).toEqual([
      'fingerprint',
      'installCommand',
      'kid',
      'origin',
      'publicKey',
      'rpId',
      'trustCommand',
    ]);
    // Done: no further ceremony in this window.
    expect(session.begin()).toBeNull();
  });

  it('stores nothing for a ceremony made with another challenge, and a challenge is good once', async () => {
    const { session, stored } = setup();
    const first = session.begin();
    if (first === null) throw new Error('no request');
    const replayed = attestation(randomBytes(32));
    expect((await session.finish(created(replayed))).notice).toBe('invalid');
    // The challenge was spent by that answer, even a right one cannot follow.
    const right = attestation(Buffer.from(first.challenge, 'base64url'));
    expect((await session.finish(created(right))).notice).toBe('invalid');
    expect(stored).toEqual([]);
  });

  it.each([
    ['another origin', { origin: 'https://evil.example' }],
    ['another rpId', { rpId: 'evil.example' }],
    ['no user verification', { flags: 0x41 }],
    ['a get ceremony', { clientType: 'webauthn.get' }],
  ])('stores nothing for %s', async (_name, options) => {
    const { session, stored } = setup();
    const request = session.begin();
    if (request === null) throw new Error('no request');
    const made = attestation(
      Buffer.from(request.challenge, 'base64url'),
      options,
    );
    expect((await session.finish(created(made))).notice).toBe('invalid');
    expect(stored).toEqual([]);
  });

  it('stores nothing for fields that are not base64url or too large', async () => {
    const { session, stored } = setup();
    session.begin();
    for (const outcome of [
      {
        status: 'created' as const,
        attestationObject: '***',
        clientDataJSON: 'AAAA',
      },
      {
        status: 'created' as const,
        attestationObject: 'A'.repeat(30_000),
        clientDataJSON: 'AAAA',
      },
    ]) {
      session.begin();
      expect((await session.finish(outcome)).notice).toBe('invalid');
    }
    expect(stored).toEqual([]);
  });

  it('answers a missing passkey plainly and keeps mode 2 off', async () => {
    const { session, stored } = setup();
    session.begin();
    const view = await session.finish({
      status: 'failed',
      reason: 'unavailable',
    });
    expect(view.notice).toBe('unavailable');
    expect(session.unavailable).toBe(true);
    expect(view.texts.notices.unavailable).toMatch(/kein Passkey/);
    expect(stored).toEqual([]);
    expect(session.stored).toBeNull();
  });

  it('says so when it replaces a passkey, and when it cannot save one', async () => {
    const old: PasskeyRecord = {
      credentialId: 'A'.repeat(43),
      publicKey: 'B'.repeat(87),
      kid: 'C'.repeat(22),
      rpId: PASSKEY_RP_ID,
      origin: PASSKEY_ORIGIN,
    };
    const { session, readOnly } = setup(old);
    expect(session.view().replaces).toBe(true);
    readOnly();
    const request = session.begin();
    if (request === null) throw new Error('no request');
    const made = attestation(Buffer.from(request.challenge, 'base64url'));
    const view = await session.finish(created(made));
    expect(view.notice).toBe('not_writable');
    expect(view.done).toBeNull();
  });

  it('cancelled and failed ceremonies leave nothing behind', async () => {
    const { session, stored } = setup();
    session.begin();
    expect(
      (await session.finish({ status: 'failed', reason: 'cancelled' })).notice,
    ).toBe('cancelled');
    expect(stored).toEqual([]);
  });
});
