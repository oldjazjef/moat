import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createTlsServer, TLSSocket } from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MailError } from './mail.ports';
import { sendSmtp } from './smtp-client';

/**
 * TLS is verified against the system's certificate authorities and cannot be switched off: a
 * server with a self-signed certificate is refused before anything is said to it (T-97).
 */
let folder: string;
let key: string;
let cert: string;
const servers: Server[] = [];
const seen: string[] = [];

beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), 'moat-smtp-tls-'));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost',
      '-keyout',
      join(folder, 'key.pem'),
      '-out',
      join(folder, 'cert.pem'),
    ],
    { stdio: 'ignore' },
  );
  key = readFileSync(join(folder, 'key.pem'), 'utf8');
  cert = readFileSync(join(folder, 'cert.pem'), 'utf8');
});
afterAll(() => {
  for (const s of servers) s.close();
  rmSync(folder, { recursive: true, force: true });
});

const listen = async (server: Server): Promise<number> => {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('port');
  return address.port;
};
const MESSAGE = { to: 'person@example.ch', subject: 'x', text: 'x' };
const settings = (port: number, security: 'tls' | 'starttls') => ({
  host: 'localhost',
  port,
  security,
  from: 'noreply@moat.example.org',
  timeoutMs: 2000,
  user: 'u',
  password: 'secret-pw',
});
const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error instanceof MailError ? error.failure : String(error);
  }
  return 'sent';
};

describe('SMTP over TLS', () => {
  it('refuses an implicit-TLS server whose certificate no authority signed', async () => {
    const server = createTlsServer({ key, cert }, (socket) => {
      socket.on('data', (d) => seen.push(String(d)));
      socket.on('error', () => undefined);
      socket.write('220 hi\r\n');
    });
    server.on('tlsClientError', () => undefined);
    const port = await listen(server);
    expect(await failure(sendSmtp(settings(port, 'tls'), MESSAGE))).toBe(
      'connect',
    );
    expect(seen.join('')).not.toContain('secret-pw');
  });

  it('refuses a STARTTLS upgrade to such a certificate before sending the password', async () => {
    const plain = createServer((socket) => {
      socket.setEncoding('latin1');
      socket.on('error', () => undefined);
      socket.write('220 hi\r\n');
      socket.on('data', (chunk: string) => {
        seen.push(chunk);
        if (chunk.startsWith('EHLO'))
          socket.write('250-hi\r\n250 STARTTLS\r\n');
        else if (chunk.startsWith('STARTTLS')) {
          socket.write('220 go\r\n');
          socket.removeAllListeners('data');
          const secure = new TLSSocket(socket, { isServer: true, key, cert });
          secure.on('error', () => undefined);
          secure.on('data', (d) => seen.push(String(d)));
        }
      });
    });
    const port = await listen(plain);
    expect(await failure(sendSmtp(settings(port, 'starttls'), MESSAGE))).toBe(
      'connect',
    );
    expect(seen.join('')).not.toContain('secret-pw');
    expect(seen.join('')).not.toContain('AUTH');
  });
});
