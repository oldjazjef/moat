import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Connection,
  type ParsedKey,
  Server,
  type SFTPWrapper,
  utils,
} from 'ssh2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hostKeyFingerprint, uploadPackage } from './sftp-client';

/** TEST ONLY: a throwaway password and host key for the local server below. */
const PASSWORD = 'TEST-ONLY-sftp-password';
const HOST_KEY = utils.generateKeyPairSync('ed25519').private;
const OTHER_PIN = `ssh-ed25519 SHA256:${'A'.repeat(43)}`;

const FILES = [
  {
    name: 'moat-www-v3/bundle-v3.json',
    data: new TextEncoder().encode('{"b":1}'),
  },
  {
    name: 'moat-www-v3/policy.json',
    data: new TextEncoder().encode('{"p":1}'),
  },
  {
    name: 'moat-www-v3/LIESMICH.txt',
    data: new TextEncoder().encode('x'.repeat(100_000)),
  },
];

const { OK, FAILURE, NO_SUCH_FILE } = utils.sftp.STATUS_CODE;
/** Files the server refuses to create, to break an upload halfway. */
const refuse = new Set<string>();
const { CREAT, EXCL, WRITE } = utils.sftp.OPEN_MODE;

/** A minimal SFTP server over a temp folder: mkdir, stat, exclusive create, write, close. */
function serveSftp(sftp: SFTPWrapper, root: string): void {
  const inside = (path: string) => join(root, path.replace(/^\/+/, ''));
  const handles = new Map<number, number>();
  let next = 0;
  sftp.on('MKDIR', (id, path) => {
    try {
      mkdirSync(inside(path));
      sftp.status(id, OK);
    } catch {
      sftp.status(id, FAILURE);
    }
  });
  sftp.on('STAT', (id, path) => {
    if (!existsSync(inside(path))) return sftp.status(id, NO_SUCH_FILE);
    const stat = statSync(inside(path));
    sftp.attrs(id, {
      mode: stat.mode,
      uid: 0,
      gid: 0,
      size: stat.size,
      atime: 0,
      mtime: 0,
    });
  });
  sftp.on('OPEN', (id, path, flags) => {
    if ((flags & (CREAT | EXCL | WRITE)) !== (CREAT | EXCL | WRITE))
      return sftp.status(id, FAILURE);
    if (refuse.has(path.split('/').pop() ?? ''))
      return sftp.status(id, FAILURE);
    try {
      const fd = openSync(inside(path), 'wx');
      const handle = Buffer.alloc(4);
      handle.writeUInt32BE(next, 0);
      handles.set(next++, fd);
      sftp.handle(id, handle);
    } catch {
      sftp.status(id, FAILURE);
    }
  });
  sftp.on('WRITE', (id, handle, offset, data) => {
    const fd = handles.get(handle.readUInt32BE(0));
    if (fd === undefined) return sftp.status(id, FAILURE);
    writeSync(fd, data, 0, data.length, offset);
    sftp.status(id, OK);
  });
  sftp.on('CLOSE', (id, handle) => {
    const fd = handles.get(handle.readUInt32BE(0));
    if (fd !== undefined) closeSync(fd);
    sftp.status(id, OK);
  });
}

describe('uploadPackage (DT-05, T-67) against a local SFTP server', () => {
  let root: string;
  let server: Server;
  let port: number;
  let pin: string;
  const authAttempts: string[] = [];
  const execs: string[] = [];

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'moat-sftp-'));
    mkdirSync(join(root, 'uploads'));
    pin = hostKeyFingerprint(
      (utils.parseKey(HOST_KEY) as ParsedKey).getPublicSSH(),
    );
    server = new Server({ hostKeys: [HOST_KEY] }, (client: Connection) => {
      client.on('authentication', (context) => {
        authAttempts.push(context.method);
        if (
          context.method === 'password' &&
          context.username === 'eme' &&
          context.password === PASSWORD
        )
          return context.accept();
        context.reject(['password']);
      });
      client.on('ready', () => {
        client.on('session', (accept) => {
          const session = accept();
          session.on('exec', (_accept, _reject, info) =>
            execs.push(info.command),
          );
          session.on('sftp', (acceptSftp) => serveSftp(acceptSftp(), root));
        });
      });
      client.on('error', () => undefined);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    port = (server.address() as AddressInfo).port;
  });

  afterAll(() => {
    server.close();
    rmSync(root, { recursive: true, force: true });
  });

  const connection = (password = PASSWORD) => ({
    host: '127.0.0.1',
    port,
    username: 'eme',
    password,
  });

  it('first contact: learns the host key and sends no credentials', async () => {
    authAttempts.length = 0;
    expect(await uploadPackage(connection(), null, 'uploads', FILES)).toEqual({
      status: 'hostkey_unknown',
      hostKey: pin,
    });
    expect(authAttempts).toEqual([]);
    expect(readdirSync(join(root, 'uploads'))).toEqual([]);
  });

  it('another host key than the pinned one: refused before signing in', async () => {
    authAttempts.length = 0;
    expect(
      await uploadPackage(connection(), OTHER_PIN, 'uploads', FILES),
    ).toEqual({ status: 'hostkey_changed', hostKey: pin });
    expect(authAttempts).toEqual([]);
  });

  it('a wrong password is auth_failed', async () => {
    expect(
      await uploadPackage(connection('wrong'), pin, 'uploads', FILES),
    ).toEqual({ status: 'auth_failed' });
  });

  it('writes the package as a new folder, byte for byte, and never replaces it', async () => {
    expect(await uploadPackage(connection(), pin, 'uploads', FILES)).toEqual({
      status: 'uploaded',
    });
    const folder = join(root, 'uploads', 'moat-www-v3');
    expect(readdirSync(folder).sort()).toEqual([
      'LIESMICH.txt',
      'bundle-v3.json',
      'policy.json',
    ]);
    expect(readFileSync(join(folder, 'LIESMICH.txt'), 'utf8')).toBe(
      'x'.repeat(100_000),
    );
    expect(await uploadPackage(connection(), pin, 'uploads', FILES)).toEqual({
      status: 'exists',
    });
    expect(readFileSync(join(folder, 'bundle-v3.json'), 'utf8')).toBe(
      '{"b":1}',
    );
    // SFTP only: no command ever runs on the server.
    expect(execs).toEqual([]);
  });

  it('a failure after the folder was made is partial, never exists or upload_failed', async () => {
    mkdirSync(join(root, 'half'));
    refuse.add('policy.json');
    try {
      expect(await uploadPackage(connection(), pin, 'half', FILES)).toEqual({
        status: 'partial',
      });
    } finally {
      refuse.clear();
    }
    expect(readdirSync(join(root, 'half', 'moat-www-v3'))).toEqual([
      'bundle-v3.json',
    ]);
  });

  it('the fingerprint names the key type, as ssh-keygen -lf does', () => {
    expect(pin).toMatch(/^ssh-ed25519 SHA256:[A-Za-z0-9+/]{43}$/);
    expect(hostKeyFingerprint(Buffer.from([0, 0, 0, 200, 1]))).toMatch(
      /^unknown SHA256:/,
    );
  });

  it('a missing remote folder is upload_failed, an unreachable server connect_failed', async () => {
    expect(await uploadPackage(connection(), pin, 'missing', FILES)).toEqual({
      status: 'upload_failed',
    });
    expect(
      await uploadPackage({ ...connection(), port: 1 }, pin, 'uploads', FILES),
    ).toEqual({ status: 'connect_failed' });
  });
});
