import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readConfig, updateConfig } from './config';
import {
  bytesOf,
  gateKey,
  gatePinCommand,
  isPasskeyUrl,
  passkeyGatesOf,
  PASSKEY_ORIGIN,
  PASSKEY_RP_ID,
  passkeyPlanSigner,
  passkeyRecordOf,
  passkeyRoute,
} from './passkey';

const RECORD = {
  credentialId: 'A'.repeat(43),
  publicKey: 'B'.repeat(87),
  kid: 'C'.repeat(22),
  rpId: PASSKEY_RP_ID,
  origin: PASSKEY_ORIGIN,
};

describe('the passkey origin (T-77)', () => {
  it('is a web origin the gate grammar accepts and the app origin is not it', () => {
    expect(PASSKEY_ORIGIN).toBe('https://passkey.moat.invalid');
    expect(PASSKEY_ORIGIN).not.toContain('app://');
    expect(PASSKEY_RP_ID).toBe('passkey.moat.invalid');
  });

  it('serves only the three dialog files of that origin, nothing else', () => {
    expect(passkeyRoute(`${PASSKEY_ORIGIN}/passkey-dialog.html`)).toEqual({
      kind: 'file',
      file: 'passkey-dialog.html',
      type: 'text/html; charset=utf-8',
    });
    expect(
      passkeyRoute(`${PASSKEY_ORIGIN}/passkey-sign-dialog.html`).kind,
    ).toBe('file');
    expect(passkeyRoute(`${PASSKEY_ORIGIN}/dialog.css`).kind).toBe('file');
    for (const url of [
      `${PASSKEY_ORIGIN}/`,
      `${PASSKEY_ORIGIN}/sign-dialog.html`,
      `${PASSKEY_ORIGIN}/../sign-dialog.html`,
      `${PASSKEY_ORIGIN}/%2e%2e/main.js`,
      `${PASSKEY_ORIGIN}/passkey-dialog.html?x=1`,
      `${PASSKEY_ORIGIN}/__proto__`,
      `${PASSKEY_ORIGIN}/constructor`,
      'https://evil.example/passkey-dialog.html',
      'https://passkey.moat.invalid.evil.example/passkey-dialog.html',
      'https://user@passkey.moat.invalid/passkey-dialog.html',
      'http://passkey.moat.invalid/passkey-dialog.html',
      'app://moat/passkey-dialog.html',
      'file:///etc/passwd',
      'not a url',
    ])
      expect(passkeyRoute(url).kind, url).toBe('refused');
  });

  it('answers IPC only from pages of that origin', () => {
    expect(isPasskeyUrl(`${PASSKEY_ORIGIN}/passkey-sign-dialog.html`)).toBe(
      true,
    );
    expect(isPasskeyUrl('app://moat/app/projects')).toBe(false);
    expect(isPasskeyUrl('https://evil.example/')).toBe(false);
    expect(isPasskeyUrl(undefined)).toBe(false);
    expect(isPasskeyUrl('nope')).toBe(false);
  });
});

describe('the stored passkey', () => {
  it('accepts exactly what the desktop writes', () => {
    expect(passkeyRecordOf(RECORD)).toEqual(RECORD);
  });

  it.each([
    ['another rpId', { ...RECORD, rpId: 'evil.example' }],
    ['another origin', { ...RECORD, origin: 'https://evil.example' }],
    ['the app origin', { ...RECORD, origin: 'app://moat' }],
    ['a short public key', { ...RECORD, publicKey: 'B'.repeat(86) }],
    [
      'a public key that is not base64url',
      { ...RECORD, publicKey: '+'.repeat(87) },
    ],
    ['a short credential id', { ...RECORD, credentialId: 'A' }],
    [
      'a credential id with padding',
      { ...RECORD, credentialId: `${'A'.repeat(42)}=` },
    ],
    ['a bad kid', { ...RECORD, kid: 'short' }],
    ['a missing field', { ...RECORD, kid: undefined }],
    ['null', null],
    ['an array', []],
    ['a string', 'x'],
  ])('drops a record with %s', (_name, value) => {
    expect(passkeyRecordOf(value)).toBeNull();
  });

  it('is read from config.json and a damaged or foreign entry is dropped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'moat-passkey-'));
    try {
      updateConfig(dir, {
        passkey: RECORD,
        passkeyGates: ['A'.repeat(22) + '/site'],
      });
      expect(readConfig(dir).passkey).toEqual(RECORD);
      expect(readConfig(dir).passkeyGates).toEqual(['A'.repeat(22) + '/site']);
      writeFileSync(
        join(dir, 'config.json'),
        JSON.stringify({
          passkey: { ...RECORD, origin: 'app://moat' },
          passkeyGates: [
            '../x',
            'A'.repeat(22) + '/site',
            'A'.repeat(22) + '/site',
            3,
          ],
        }),
      );
      expect(readConfig(dir).passkey).toBeNull();
      expect(readConfig(dir).passkeyGates).toEqual(['A'.repeat(22) + '/site']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps no secret: public key, credential id, key id and the fixed rpId and origin only', () => {
    expect(Object.keys(RECORD).sort()).toEqual([
      'credentialId',
      'kid',
      'origin',
      'publicKey',
      'rpId',
    ]);
  });
});

describe('what the gate is told', () => {
  it('prints the pinning command of docs/CRYPTO.md §7.1', () => {
    expect(gatePinCommand(RECORD, 'trust')).toBe(
      `php moat-gate.php trust --passkey=${'B'.repeat(87)} --rp-id=passkey.moat.invalid --origin=https://passkey.moat.invalid`,
    );
    expect(gatePinCommand(RECORD, 'install')).toMatch(
      /^php moat-gate\.php install --passkey=/,
    );
  });

  it('plans and verifies against the pinned passkey, rpId and origin', () => {
    const signer = passkeyPlanSigner(RECORD);
    expect(signer.kid).toBe(RECORD.kid);
    expect(signer.publicKey).toHaveLength(65);
    expect(signer.passkey).toEqual({
      rpId: PASSKEY_RP_ID,
      origins: [PASSKEY_ORIGIN],
    });
  });
});

describe('gates that sign with the passkey', () => {
  it('lists the names of one project only', () => {
    const keys = [
      gateKey('A'.repeat(22), 'site'),
      gateKey('B'.repeat(22), 'shop'),
      gateKey('A'.repeat(22), 'api'),
    ];
    expect(passkeyGatesOf(keys, 'A'.repeat(22))).toEqual(['api', 'site']);
    expect(passkeyGatesOf(keys, 'C'.repeat(22))).toEqual([]);
  });
});

describe('bytesOf', () => {
  it('reads canonical base64url within the size, and nothing else', () => {
    expect(bytesOf('AQID', 8)).toEqual(Uint8Array.of(1, 2, 3));
    for (const value of ['', 'AQID=', 'AQI+', 'AQ ID', 5, null, undefined])
      expect(bytesOf(value, 8)).toBeNull();
    expect(bytesOf('AQIDBAUG', 3)).toBeNull();
    // non-canonical trailing bits
    expect(bytesOf('AQ', 8)).toEqual(Uint8Array.of(1));
    expect(bytesOf('AR', 8)).toBeNull();
  });
});
