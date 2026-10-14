import { describe, expect, it, vi } from 'vitest';
import type { DeployPackage } from './deploy';
import type { FtpsUploadResult } from './ftps-client';
import { type FtpsTarget, FtpsSession } from './ftps';
import { MESSAGES } from './messages';

const PKG: DeployPackage = {
  project: 'shop',
  gate: 'www',
  gateId: 'AAAAAAAAAAAAAAAAAAAAAA',
  version: 3,
  locked: false,
  bundle: '{}',
  bundleSha256: 'ab'.repeat(32),
  policy: '{}',
};
const FILES = [{ name: 'moat-www-v3/bundle-v3.json', data: new Uint8Array() }];
const PIN = `SHA256${':AB'.repeat(32)}`;
const CERTIFICATE = {
  fingerprint: PIN,
  subject: 'CN=ftp.example.ch',
  issuer: 'CN=ftp.example.ch',
  validTo: 'Oct 14 12:00:00 2027 GMT',
};
/** TEST ONLY */
const PASSWORD = 'TEST-ONLY-password';
const INPUT = {
  host: 'ftp.example.ch',
  port: '21',
  username: 'eme@example.ch',
  remoteDir: 'moat-uploads',
  mode: 'explicit' as const,
  secret: PASSWORD,
  remember: true,
};
const STORED: FtpsTarget = {
  host: 'ftp.example.ch',
  port: 21,
  username: 'eme@example.ch',
  remoteDir: 'moat-uploads',
  mode: 'explicit',
  certificate: PIN,
  secret: `sealed:${PASSWORD}`,
};

function setup(stored: FtpsTarget | null = null, available = true) {
  let target = stored;
  const results: FtpsUploadResult[] = [];
  const upload = vi.fn((): Promise<FtpsUploadResult> =>
    Promise.resolve(results.shift() ?? { status: 'uploaded' }),
  );
  const session = new FtpsSession({
    texts: MESSAGES['de-CH'].ftpsDialog,
    pkg: PKG,
    files: FILES,
    keychain: {
      available,
      seal: (secret) => `sealed:${secret}`,
      open: (sealed) =>
        sealed.startsWith('sealed:') ? sealed.slice('sealed:'.length) : null,
    },
    stored: () => target,
    save: (next) => {
      target = next;
    },
    forget: () => {
      target = null;
    },
    upload,
  });
  return { session, upload, results, saved: () => target };
}

describe('FtpsSession (DT-05, T-69)', () => {
  it('starts on port 21 with explicit FTPS', () => {
    expect(setup().session.view().target).toMatchObject({
      port: '21',
      mode: 'explicit',
      certificate: null,
    });
  });

  it('first upload: shows the certificate, uploads only after the person trusts it, then pins it', async () => {
    const { session, upload, results, saved } = setup();
    results.push({ status: 'certificate_unknown', certificate: CERTIFICATE });
    const first = await session.connect(INPUT);
    if (!('view' in first)) throw new Error('expected a view');
    expect(first.view.step).toBe('certificate');
    expect(first.view.certificate).toEqual(CERTIFICATE);
    expect(upload).toHaveBeenLastCalledWith(
      expect.objectContaining({ password: PASSWORD, mode: 'explicit' }),
      null,
      'moat-uploads',
      FILES,
    );
    expect(saved()).toBeNull();
    // The view never carries the password.
    expect(JSON.stringify(first.view)).not.toContain(PASSWORD);

    expect(await session.trustCertificate()).toEqual({
      done: { status: 'exported', target: 'ftps', version: 3 },
    });
    expect(upload).toHaveBeenLastCalledWith(
      expect.anything(),
      PIN,
      'moat-uploads',
      FILES,
    );
    expect(saved()).toEqual(STORED);
  });

  it('a certificate a CA vouches for: uploaded at once, nothing pinned', async () => {
    const { session, saved } = setup();
    expect(
      await session.connect({ ...INPUT, mode: 'implicit', port: '990' }),
    ).toEqual({
      done: { status: 'exported', target: 'ftps', version: 3 },
    });
    expect(saved()).toMatchObject({
      mode: 'implicit',
      port: 990,
      certificate: null,
    });
  });

  it('next time: the pinned certificate and the remembered password, nothing typed', async () => {
    const { session, upload } = setup(STORED);
    expect(session.view().target).toMatchObject({
      host: 'ftp.example.ch',
      secretRemembered: true,
      certificate: PIN,
    });
    expect(await session.connect({ ...INPUT, secret: '' })).toEqual({
      done: { status: 'exported', target: 'ftps', version: 3 },
    });
    expect(upload).toHaveBeenCalledWith(
      expect.objectContaining({ password: PASSWORD }),
      PIN,
      'moat-uploads',
      FILES,
    );
  });

  it('a changed certificate stops the upload; only «Ziel entfernen» lets a new one be confirmed', async () => {
    const { session, results, saved } = setup(STORED);
    results.push({
      status: 'certificate_changed',
      certificate: { ...CERTIFICATE, fingerprint: `SHA256${':CD'.repeat(32)}` },
    });
    const step = await session.connect(INPUT);
    expect('view' in step && step.view).toMatchObject({
      step: 'target',
      notice: 'certificate_changed',
    });
    expect(saved()?.certificate).toBe(PIN);
    expect(session.forget().notice).toBe('forgotten');
    expect(saved()).toBeNull();
  });

  it('a package folder left incomplete, or a server without TLS, says so', async () => {
    const { session, results, saved } = setup();
    results.push({ status: 'certificate_unknown', certificate: CERTIFICATE });
    await session.connect(INPUT);
    results.push({ status: 'partial' });
    const step = await session.trustCertificate();
    expect('view' in step && step.view.notice).toBe('partial');
    results.push({ status: 'tls_failed' });
    const plain = await session.connect(INPUT);
    expect('view' in plain && plain.view.notice).toBe('tls_failed');
    expect(saved()).toBeNull();
  });

  it('a remembered password that is refused is dropped', async () => {
    const { session, results, saved } = setup(STORED);
    results.push({ status: 'auth_failed' });
    const step = await session.connect({ ...INPUT, secret: '' });
    expect('view' in step && step.view.notice).toBe('auth_failed');
    expect(saved()?.secret).toBeNull();
  });

  it('remembers nothing without a real keychain, or when the box is off', async () => {
    const plain = setup(null, false);
    expect(plain.session.view().canRemember).toBe(false);
    await plain.session.connect(INPUT);
    expect(plain.saved()?.secret).toBeNull();

    const off = setup();
    await off.session.connect({ ...INPUT, remember: false });
    expect(off.saved()?.secret).toBeNull();
  });

  it('refuses a bad target, or no password, before connecting', async () => {
    const { session, upload } = setup();
    for (const change of [
      { host: 'a b' },
      { host: '-x' },
      { port: '0' },
      { port: '70000' },
      { username: 'a;b' },
      { username: 'a\r\nDELE x' },
      { remoteDir: '../www' },
      { remoteDir: 'a b' },
      { remoteDir: 'a\r\nDELE x' },
    ]) {
      const step = await session.connect({ ...INPUT, ...change });
      expect('view' in step && step.view.notice, JSON.stringify(change)).toBe(
        'target_invalid',
      );
    }
    const step = await session.connect({ ...INPUT, secret: '' });
    expect('view' in step && step.view.notice).toBe('secret_missing');
    expect(upload).not.toHaveBeenCalled();
  });
});
