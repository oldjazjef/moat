import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import { type FtpsConnection, uploadPackage } from './ftps-client';
import {
  type TestCertificate,
  testCertificate,
  TestFtpsServer,
  type TestServerOptions,
} from './ftps-test-server';

/** TEST ONLY: a throwaway password for the local server below. */
const PASSWORD = 'TEST-ONLY-ftps-password';

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
    // Every byte value, CR and LF included: binary mode, nothing translated.
    data: new Uint8Array(Array.from({ length: 100_000 }, (_, i) => i % 256)),
  },
];

describe('uploadPackage (DT-05, T-69) against a local FTPS server', () => {
  let root: string;
  let cert: TestCertificate;
  let other: TestCertificate;
  const servers: TestFtpsServer[] = [];

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'moat-ftps-'));
    cert = testCertificate();
    other = testCertificate('impostor.test');
  });

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function serve(
    options: Partial<TestServerOptions> = {},
    certificate = cert,
  ): Promise<{
    server: TestFtpsServer;
    dir: string;
    connection: FtpsConnection;
  }> {
    const dir = mkdtempSync(join(root, 'uploads-'));
    const server = new TestFtpsServer(certificate, {
      root,
      password: PASSWORD,
      ...options,
    });
    servers.push(server);
    await server.listen();
    return {
      server,
      dir: dir.slice(root.length + 1),
      connection: {
        host: '127.0.0.1',
        port: server.port,
        username: 'eme',
        password: PASSWORD,
        mode: options.implicit ? 'implicit' : 'explicit',
      },
    };
  }

  /** No CA vouches for the test certificate, unless a test says so. */
  const upload = (
    connection: FtpsConnection,
    pinned: string | null,
    dir: string,
    cas: readonly string[] = [],
  ) => uploadPackage(connection, pinned, dir, FILES, cas);

  it('first contact: shows the certificate after the TLS handshake and sends no user or password', async () => {
    const { server, dir, connection } = await serve();
    const result = await upload(connection, null, dir);
    expect(result).toEqual({
      status: 'certificate_unknown',
      certificate: {
        fingerprint: cert.fingerprint,
        subject: 'CN=ftps.test',
        issuer: 'CN=ftps.test',
        validTo: expect.stringMatching(/GMT$/),
      },
    });
    expect(server.commands).toEqual(['AUTH TLS']);
    expect(readdirSync(join(root, dir))).toEqual([]);
  });

  it('another certificate than the pinned one: refused before USER and PASS', async () => {
    const { server, dir, connection } = await serve({}, other);
    const result = await upload(connection, cert.fingerprint, dir);
    expect(result).toMatchObject({
      status: 'certificate_changed',
      certificate: { fingerprint: other.fingerprint },
    });
    expect(server.commands).toEqual(['AUTH TLS']);
  });

  it('writes the package as a new folder, byte for byte, over protected data connections, and never replaces it', async () => {
    const { server, dir, connection } = await serve();
    expect(await upload(connection, cert.fingerprint, dir)).toEqual({
      status: 'uploaded',
    });
    const folder = join(root, dir, 'moat-www-v3');
    expect(readdirSync(folder).sort()).toEqual([
      'LIESMICH.txt',
      'bundle-v3.json',
      'policy.json',
    ]);
    for (const file of FILES)
      expect(readFileSync(join(root, dir, file.name))).toEqual(
        Buffer.from(file.data),
      );
    const verbs = server.commands.map((line) => line.split(' ')[0]);
    // TLS first, the password only on it, PROT P before any data connection.
    expect(verbs.slice(0, 6)).toEqual([
      'AUTH',
      'USER',
      'PASS',
      'TYPE',
      'PBSZ',
      'PROT',
    ]);
    expect(server.commands).toContain('PROT P');
    expect(verbs).not.toContain('DELE');
    expect(verbs).not.toContain('RNFR');
    expect(verbs).not.toContain('SITE');
    // Each data connection resumed the control connection's TLS session.
    expect(server.dataResumed).toHaveLength(3);
    expect(server.dataResumed.every(Boolean)).toBe(true);

    expect(await upload(connection, cert.fingerprint, dir)).toEqual({
      status: 'exists',
    });
    expect(readFileSync(join(folder, 'bundle-v3.json'), 'utf8')).toBe(
      '{"b":1}',
    );
  });

  it('implicit FTPS works the same', async () => {
    const { server, dir, connection } = await serve({ implicit: true });
    expect(await upload(connection, null, dir)).toMatchObject({
      status: 'certificate_unknown',
    });
    expect(server.commands).toEqual([]);
    expect(await upload(connection, cert.fingerprint, dir)).toEqual({
      status: 'uploaded',
    });
  });

  it('a certificate a trusted CA vouches for (and that names the host) needs no pin', async () => {
    const { dir, connection } = await serve();
    expect(await upload(connection, null, dir, [cert.cert])).toEqual({
      status: 'uploaded',
    });
    // Trusted, but naming another host than the one connected to: back to the pin.
    const unnamed = testCertificate('elsewhere.test', false);
    const misnamed = await serve({}, unnamed);
    expect(
      await upload(misnamed.connection, null, misnamed.dir, [unnamed.cert]),
    ).toMatchObject({ status: 'certificate_unknown' });
  });

  it('plain FTP is refused: no USER, no PASS, nothing written', async () => {
    const explicit = await serve({ plain: true });
    expect(
      await upload(explicit.connection, cert.fingerprint, explicit.dir),
    ).toEqual({
      status: 'tls_failed',
    });
    expect(explicit.server.commands).toEqual(['AUTH TLS']);

    // Implicit FTPS against a server that speaks plain FTP: the handshake fails.
    const plain = await serve({ plain: true });
    expect(
      await upload(
        { ...plain.connection, mode: 'implicit' },
        cert.fingerprint,
        plain.dir,
      ),
    ).toEqual({ status: 'tls_failed' });
    expect(plain.server.commands).not.toContain('PASS');
  });

  it('a server that refuses PROT P gets no file', async () => {
    const { dir, connection } = await serve({ noProt: true });
    expect(await upload(connection, cert.fingerprint, dir)).toEqual({
      status: 'tls_failed',
    });
    expect(readdirSync(join(root, dir))).toEqual([]);
  });

  it('ignores the address in a PASV answer: data goes to the control host only', async () => {
    const { server, dir, connection } = await serve({
      noEpsv: true,
      // Somewhere else entirely (TEST-NET-3): following it would be an FTP bounce.
      pasvAddress: '203.0.113.9',
    });
    expect(await upload(connection, cert.fingerprint, dir)).toEqual({
      status: 'uploaded',
    });
    expect(server.commands.filter((line) => line === 'PASV')).toHaveLength(3);
  });

  it('a data connection with another certificate is closed before a byte is written', async () => {
    const { server, dir, connection } = await serve();
    server.useOnData(other);
    expect(await upload(connection, cert.fingerprint, dir)).toEqual({
      status: 'partial',
    });
    expect(readdirSync(join(root, dir, 'moat-www-v3'))).toEqual([]);
  });

  it('without SIZE, the folder listing guards against replacing a file', async () => {
    const { server, dir, connection } = await serve({ noSize: true });
    expect(await upload(connection, cert.fingerprint, dir)).toEqual({
      status: 'uploaded',
    });
    expect(server.commands.some((line) => line.startsWith('LIST'))).toBe(true);
  });

  it('a failure after the folder was made is partial, never exists or upload_failed', async () => {
    const { server, dir, connection } = await serve();
    server.refuse.add('policy.json');
    expect(await upload(connection, cert.fingerprint, dir)).toEqual({
      status: 'partial',
    });
    expect(readdirSync(join(root, dir, 'moat-www-v3'))).toEqual([
      'bundle-v3.json',
    ]);
  });

  it('a wrong password is auth_failed; a missing folder upload_failed; no server connect_failed', async () => {
    const { dir, connection } = await serve();
    expect(
      await upload({ ...connection, password: 'wrong' }, cert.fingerprint, dir),
    ).toEqual({ status: 'auth_failed' });
    expect(
      await upload(connection, cert.fingerprint, 'missing/deeper'),
    ).toEqual({
      status: 'upload_failed',
    });
    expect(
      await upload({ ...connection, port: 1 }, cert.fingerprint, dir),
    ).toEqual({ status: 'connect_failed' });
  });

  it('a password with a line break never reaches the server (no command injection)', async () => {
    const { server, dir, connection } = await serve();
    expect(
      await upload(
        { ...connection, password: `x\r\nDELE y` },
        cert.fingerprint,
        dir,
      ),
    ).toEqual({ status: 'auth_failed' });
    expect(server.commands).toEqual([]);
  });
});
