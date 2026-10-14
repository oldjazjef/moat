import { describe, expect, it, vi } from 'vitest';
import type { DeployPackage } from './deploy';
import { MESSAGES } from './messages';
import { isRemoteDir, type SftpTarget, SftpSession } from './sftp';
import type { UploadResult } from './sftp-client';

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
const PIN = `ssh-ed25519 SHA256:${'k'.repeat(43)}`;
/** TEST ONLY */
const PASSWORD = 'TEST-ONLY-password';
const INPUT = {
  host: 'sftp.example.ch',
  port: '22',
  username: 'eme',
  remoteDir: 'moat-uploads',
  auth: 'password' as const,
  secret: PASSWORD,
  remember: true,
};

function setup(stored: SftpTarget | null = null, available = true) {
  let target = stored;
  const results: UploadResult[] = [];
  const upload = vi.fn((): Promise<UploadResult> =>
    Promise.resolve(results.shift() ?? { status: 'uploaded' }),
  );
  const session = new SftpSession({
    texts: MESSAGES['de-CH'].sftpDialog,
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
    chooseKeyFile: () => Promise.resolve('/home/eme/.ssh/id_ed25519'),
    readPrivateKey: () => Buffer.from('KEY'),
    upload,
  });
  return { session, upload, results, saved: () => target };
}

describe('SftpSession (DT-05, T-67)', () => {
  it('first upload: shows the host key, uploads only after the person trusts it, then pins it', async () => {
    const { session, upload, results, saved } = setup();
    results.push({ status: 'hostkey_unknown', hostKey: PIN });
    const first = await session.connect(INPUT);
    if (!('view' in first)) throw new Error('expected a view');
    expect(first.view.step).toBe('hostkey');
    expect(first.view.hostKey).toBe(PIN);
    expect(upload).toHaveBeenLastCalledWith(
      expect.objectContaining({ password: PASSWORD }),
      null,
      'moat-uploads',
      FILES,
    );
    expect(saved()).toBeNull();
    // The view never carries the password.
    expect(JSON.stringify(first.view)).not.toContain(PASSWORD);

    expect(await session.trustHostKey()).toEqual({
      done: { status: 'exported', target: 'sftp', version: 3 },
    });
    expect(upload).toHaveBeenLastCalledWith(
      expect.anything(),
      PIN,
      'moat-uploads',
      FILES,
    );
    expect(saved()).toEqual({
      host: 'sftp.example.ch',
      port: 22,
      username: 'eme',
      remoteDir: 'moat-uploads',
      auth: 'password',
      keyFile: null,
      hostKey: PIN,
      secret: `sealed:${PASSWORD}`,
    });
  });

  it('next time: the pinned key and the remembered password, nothing typed', async () => {
    const stored: SftpTarget = {
      host: 'sftp.example.ch',
      port: 22,
      username: 'eme',
      remoteDir: 'moat-uploads',
      auth: 'password',
      keyFile: null,
      hostKey: PIN,
      secret: `sealed:${PASSWORD}`,
    };
    const { session, upload } = setup(stored);
    expect(session.view().target).toMatchObject({
      host: 'sftp.example.ch',
      secretRemembered: true,
      hostKey: PIN,
    });
    expect(await session.connect({ ...INPUT, secret: '' })).toEqual({
      done: { status: 'exported', target: 'sftp', version: 3 },
    });
    expect(upload).toHaveBeenCalledWith(
      expect.objectContaining({ password: PASSWORD }),
      PIN,
      'moat-uploads',
      FILES,
    );
  });

  it('a changed host key stops the upload; only «Ziel entfernen» lets a new one be confirmed', async () => {
    const stored: SftpTarget = {
      host: 'sftp.example.ch',
      port: 22,
      username: 'eme',
      remoteDir: 'moat-uploads',
      auth: 'password',
      keyFile: null,
      hostKey: PIN,
      secret: null,
    };
    const { session, results, saved } = setup(stored);
    results.push({
      status: 'hostkey_changed',
      hostKey: `ssh-ed25519 SHA256:${'z'.repeat(43)}`,
    });
    const step = await session.connect(INPUT);
    expect('view' in step && step.view.notice).toBe('hostkey_changed');
    expect(saved()?.hostKey).toBe(PIN);
    expect(session.forget().notice).toBe('forgotten');
    expect(saved()).toBeNull();
  });

  it('the pin belongs to host and port: another user or sign-in keeps it, the secret does not', async () => {
    const stored: SftpTarget = {
      host: 'sftp.example.ch',
      port: 22,
      username: 'eme',
      remoteDir: 'moat-uploads',
      auth: 'password',
      keyFile: null,
      hostKey: PIN,
      secret: 'sealed:old',
    };
    const { session, upload, results } = setup(stored);
    results.push({ status: 'hostkey_changed', hostKey: PIN });
    const step = await session.connect({
      ...INPUT,
      username: 'other',
      secret: 'typed',
    });
    expect(upload).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'other', password: 'typed' }),
      PIN,
      'moat-uploads',
      FILES,
    );
    expect('view' in step && step.view).toMatchObject({
      notice: 'hostkey_changed',
      target: { hostKey: PIN, secretRemembered: false },
    });
  });

  it('a package folder left incomplete says so', async () => {
    const { session, results, saved } = setup();
    results.push({ status: 'hostkey_unknown', hostKey: PIN });
    await session.connect(INPUT);
    results.push({ status: 'partial' });
    const step = await session.trustHostKey();
    expect('view' in step && step.view.notice).toBe('partial');
    expect(saved()).toBeNull();
  });

  it('a remembered password that is refused is dropped', async () => {
    const stored: SftpTarget = {
      host: 'sftp.example.ch',
      port: 22,
      username: 'eme',
      remoteDir: 'moat-uploads',
      auth: 'password',
      keyFile: null,
      hostKey: PIN,
      secret: 'sealed:old',
    };
    const { session, results, saved } = setup(stored);
    results.push({ status: 'auth_failed' });
    const step = await session.connect({ ...INPUT, secret: '' });
    expect('view' in step && step.view.notice).toBe('auth_failed');
    expect(saved()?.secret).toBeNull();
  });

  it('remembers nothing without a real keychain, or when the box is off', async () => {
    const plain = setup(null, false);
    plain.results.push({ status: 'hostkey_unknown', hostKey: PIN });
    await plain.session.connect(INPUT);
    expect(plain.session.view().canRemember).toBe(false);
    await plain.session.trustHostKey();
    expect(plain.saved()?.secret).toBeNull();

    const off = setup();
    off.results.push({ status: 'hostkey_unknown', hostKey: PIN });
    await off.session.connect({ ...INPUT, remember: false });
    await off.session.trustHostKey();
    expect(off.saved()?.secret).toBeNull();
  });

  it('refuses a bad target before connecting', async () => {
    const { session, upload } = setup();
    for (const change of [
      { host: 'a b' },
      { host: '-x' },
      { port: '0' },
      { port: '70000' },
      { username: 'a;b' },
      { remoteDir: '../www' },
      { remoteDir: 'a/./b' },
      { remoteDir: 'a b' },
      { remoteDir: 'a//b' },
      { remoteDir: `${'a/'.repeat(17)}` },
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

  it('a key file: chosen in the main process, only its name in the view', async () => {
    const { session, upload } = setup();
    const keyless = await session.connect({
      ...INPUT,
      auth: 'key',
      secret: '',
    });
    expect('view' in keyless && keyless.view.notice).toBe('key_missing');
    const view = await session.chooseKey();
    expect(view.target).toMatchObject({ auth: 'key', keyName: 'id_ed25519' });
    expect(JSON.stringify(view)).not.toContain('/home/eme');
    await session.connect({ ...INPUT, auth: 'key', secret: '' });
    expect(upload).toHaveBeenCalledWith(
      expect.objectContaining({ privateKey: Buffer.from('KEY') }),
      null,
      'moat-uploads',
      FILES,
    );
  });
});

describe('isRemoteDir', () => {
  it('takes plain relative and absolute paths, refuses . and .. and empty parts', () => {
    for (const ok of ['', '/', 'www', '/var/www/', 'a/b_c/~d', 'x.y-z'])
      expect(isRemoteDir(ok), ok).toBe(true);
    for (const bad of ['.', '..', 'a/../b', '//', 'a//b', '.x', 'a b', 'ä'])
      expect(isRemoteDir(bad), bad).toBe(false);
  });

  it('answers at once on a long near-match (no catastrophic backtracking)', () => {
    const started = performance.now();
    for (const input of [`${'a'.repeat(32)}!`, `${'a.'.repeat(2000)}!`])
      expect(isRemoteDir(input)).toBe(false);
    expect(performance.now() - started).toBeLessThan(50);
  });
});
