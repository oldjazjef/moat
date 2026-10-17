import { createServer, type Server } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { plantedIn, PLANTED_SECRETS } from '../../testing/planted-secrets';
import { csrfTokenOf } from '../auth/domain/session';
import { type CloudHarness, startCloudHarness } from '../testing/cloud-harness';

/**
 * The e-mail flows over HTTP, against the real app and a real SMTP socket on this machine
 * (docs/SECURITY-TESTING.md: A07, A04; T-96 – T-99). What matters here is what an outsider can
 * and cannot learn, and that a link works exactly once.
 */
const PASSWORD = PLANTED_SECRETS[2];
const NEW_PASSWORD = 'a completely different passphrase';
const SMTP_KEYS = [
  'MOAT_SMTP_HOST',
  'MOAT_SMTP_PORT',
  'MOAT_SMTP_SECURITY',
  'MOAT_MAIL_FROM',
] as const;

interface Received {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}
const inbox: Received[] = [];
let sink: Server;
let cloud: CloudHarness;
let counter = 0;

function startSink(): Promise<number> {
  sink = createServer((socket) => {
    socket.setEncoding('latin1');
    socket.on('error', () => undefined);
    let to = '';
    let buffer = '';
    let inData = false;
    socket.write('220 sink\r\n');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          const mail = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          const [head = '', body = ''] = mail.split('\r\n\r\n');
          inbox.push({
            to,
            subject: /^Subject: (.*)$/m.exec(head)?.[1] ?? '',
            text: Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString(
              'utf8',
            ),
          });
          socket.write('250 ok\r\n');
          continue;
        }
        const at = buffer.indexOf('\r\n');
        if (at < 0) return;
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        if (line.startsWith('EHLO')) socket.write('250 sink\r\n');
        else if (line.startsWith('RCPT TO:')) {
          to = line.slice(9, -1);
          socket.write('250 ok\r\n');
        } else if (line === 'DATA') {
          inData = true;
          socket.write('354 go\r\n');
        } else if (line === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('250 ok\r\n');
      }
    });
  });
  return new Promise((resolve) =>
    sink.listen(0, '127.0.0.1', () => {
      const address = sink.address();
      resolve(
        typeof address === 'object' && address !== null ? address.port : 0,
      );
    }),
  );
}

beforeAll(async () => {
  const port = await startSink();
  cloud = await startCloudHarness({
    MOAT_TRUST_PROXY: '1',
    MOAT_SMTP_HOST: '127.0.0.1',
    MOAT_SMTP_PORT: String(port),
    MOAT_SMTP_SECURITY: 'none',
    MOAT_MAIL_FROM: 'noreply@moat.example.org',
    MOAT_PUBLIC_ORIGIN: 'https://moat.example.org',
  });
}, 60_000);
afterAll(async () => {
  await cloud?.stop();
  sink?.close();
  for (const key of SMTP_KEYS) delete process.env[key];
});

const ip = () => ({ 'x-forwarded-for': `10.9.0.${(counter += 1) % 250}` });
const post = (path: string, body: unknown, token?: string) =>
  cloud.call('POST', path, {
    body,
    headers: ip(),
    ...(token === undefined ? {} : { token, csrf: csrfTokenOf(token) }),
  });

/** Waits for the background outbox: the mail is on its way after the request has answered. */
async function mailTo(email: string, count = 1): Promise<Received[]> {
  for (let i = 0; i < 100; i++) {
    const mine = inbox.filter((m) => m.to === email);
    if (mine.length >= count) return mine;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return inbox.filter((m) => m.to === email);
}
const tokenOf = (mail: Received | undefined) =>
  /#token=([A-Za-z0-9_-]{43})/.exec(mail?.text ?? '')?.[1] ?? '';

describe('registration and verification over HTTP', () => {
  it('mails a link, refuses sign-in until it is used, and the link works once', async () => {
    const email = `new${(counter += 1)}@example.ch`;
    const registered = await post('/api/auth/register', {
      email,
      password: PASSWORD,
    });
    expect(registered.status).toBe(202);

    const blocked = await post('/api/auth/login', {
      email,
      password: PASSWORD,
    });
    expect(blocked.status).toBe(403);
    expect(blocked.json()).toMatchObject({ error: 'email_not_verified' });
    expect(blocked.setCookies).toHaveLength(0);

    const [mail] = await mailTo(email);
    expect(mail?.text).toContain(
      'https://moat.example.org/verify-email#token=',
    );
    const token = tokenOf(mail);

    const verified = await post('/api/auth/verify-email', { token });
    expect(verified.status).toBe(200);
    expect(
      (await post('/api/auth/login', { email, password: PASSWORD })).status,
    ).toBe(200);

    const again = await post('/api/auth/verify-email', { token });
    expect(again.status).toBe(422);
    expect(again.json()).toEqual({ statusCode: 422, error: 'invalid_token' });
  });

  it('answers a token that never existed exactly like one that was used', async () => {
    const never = await post('/api/auth/verify-email', {
      token: 'Z'.repeat(43),
    });
    const junk = await post('/api/auth/verify-email', { token: 'not a token' });
    expect(never.status).toBe(422);
    expect(junk.status).toBe(422);
    expect(never.body).toBe(junk.body);
  });

  it('answers a second registration like the first, and mails the owner a notice', async () => {
    const email = `twice${(counter += 1)}@example.ch`;
    const first = await post('/api/auth/register', {
      email,
      password: PASSWORD,
    });
    const second = await post('/api/auth/register', {
      email,
      password: PASSWORD,
    });
    expect(second.status).toBe(first.status);
    expect(second.body).toBe(first.body);
    const mails = await mailTo(email, 2);
    expect(mails).toHaveLength(2);
    expect(mails[1]?.text).not.toMatch(/#token=/);
  });
});

describe('password reset over HTTP', () => {
  async function verified(): Promise<string> {
    const email = `reset${(counter += 1)}@example.ch`;
    await post('/api/auth/register', { email, password: PASSWORD });
    const [mail] = await mailTo(email);
    await post('/api/auth/verify-email', { token: tokenOf(mail) });
    return email;
  }

  it('does not tell a known address from an unknown one', async () => {
    const email = await verified();
    const known = await post('/api/auth/forgot-password', { email });
    const unknown = await post('/api/auth/forgot-password', {
      email: `ghost${(counter += 1)}@example.ch`,
    });
    const malformed = await post('/api/auth/forgot-password', { email: '???' });
    expect([known.status, unknown.status, malformed.status]).toEqual([
      202, 202, 202,
    ]);
    expect(known.body).toBe(unknown.body);
    expect(known.body).toBe(malformed.body);
    expect(known.headers['content-length']).toBe(
      unknown.headers['content-length'],
    );
    expect(await mailTo(email, 2)).toHaveLength(2);
  });

  it('resets once, ends the open sessions and never mails a password', async () => {
    const email = await verified();
    const login = await post('/api/auth/login', { email, password: PASSWORD });
    const session =
      /=([A-Za-z0-9_-]{43});/.exec(login.setCookies[0] ?? '')?.[1] ?? '';
    expect(
      (await cloud.call('GET', '/api/auth/me', { token: session })).status,
    ).toBe(200);

    await post('/api/auth/forgot-password', { email });
    const mails = await mailTo(email, 2);
    const token = tokenOf(mails.at(-1));

    const weak = await post('/api/auth/reset-password', {
      token,
      newPassword: 'short',
    });
    expect(weak.status).toBe(422);
    expect(weak.json()).toMatchObject({ error: 'password_too_short' });

    const done = await post('/api/auth/reset-password', {
      token,
      newPassword: NEW_PASSWORD,
    });
    expect(done.status).toBe(200);
    expect(
      (await cloud.call('GET', '/api/auth/me', { token: session })).status,
    ).toBe(401);
    expect(
      (await post('/api/auth/login', { email, password: PASSWORD })).status,
    ).toBe(401);
    expect(
      (await post('/api/auth/login', { email, password: NEW_PASSWORD })).status,
    ).toBe(200);
    expect(
      (
        await post('/api/auth/reset-password', {
          token,
          newPassword: 'one more passphrase',
        })
      ).status,
    ).toBe(422);

    const everything = JSON.stringify(inbox);
    expect(plantedIn(everything)).toEqual([]);
    expect(everything).not.toContain(NEW_PASSWORD);
  });
});

describe('invitations over HTTP', () => {
  it('invites an unknown address by mail without naming the organisation, and joins on verification', async () => {
    const owner = `owner${(counter += 1)}@example.ch`;
    await post('/api/auth/register', { email: owner, password: PASSWORD });
    await post('/api/auth/verify-email', {
      token: tokenOf((await mailTo(owner))[0]),
    });
    const login = await post('/api/auth/login', {
      email: owner,
      password: PASSWORD,
    });
    const session =
      /=([A-Za-z0-9_-]{43});/.exec(login.setCookies[0] ?? '')?.[1] ?? '';
    const made = await post('/api/orgs', { name: 'Secret Org Name' }, session);
    const org = made.json<{ organisation: { id: string } }>().organisation.id;

    const guest = `guest${(counter += 1)}@example.ch`;
    const added = await post(
      `/api/orgs/${org}/members`,
      { email: guest, role: 'viewer' },
      session,
    );
    expect(added.status).toBeLessThan(300);
    const [invite] = await mailTo(guest);
    expect(invite?.subject).toContain('Einladung');
    expect(invite?.text).not.toContain('Secret Org Name');

    await post('/api/auth/register', { email: guest, password: PASSWORD });
    const [, verify] = await mailTo(guest, 2);
    await post('/api/auth/verify-email', { token: tokenOf(verify) });
    const guestLogin = await post('/api/auth/login', {
      email: guest,
      password: PASSWORD,
    });
    const guestSession =
      /=([A-Za-z0-9_-]{43});/.exec(guestLogin.setCookies[0] ?? '')?.[1] ?? '';
    const mine = await cloud.call('GET', '/api/orgs', { token: guestSession });
    expect(
      mine
        .json<{ organisation: { id: string } }[]>()
        .map((o) => o.organisation.id),
    ).toContain(org);
  });
});
