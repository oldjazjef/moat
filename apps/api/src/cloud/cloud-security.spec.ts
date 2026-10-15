import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LoggerService } from '@nestjs/common';
import { PLANTED_SECRETS } from '../testing/planted-secrets';
import { CloudDatabase } from '../persistence/cloud/cloud-database';
import { csrfTokenOf } from './auth/domain/session';
import { hotp } from './auth/domain/totp';
import { TotpVault } from './auth/application/totp-vault';
import {
  type CloudHarness,
  type Reply,
  startCloudHarness,
  TEST_ACCOUNT_KEY,
  TEST_ORIGIN,
} from './testing/cloud-harness';

/**
 * The Cloud's accounts attacked over HTTP (docs/SECURITY-TESTING.md: A01, A07, API2, API5). The
 * authorization matrix covers every route × identity; these are the flows and the attacks that
 * need more than one request.
 */
const PASSWORD = PLANTED_SECRETS[2];
const lines: string[] = [];
const logger: LoggerService = {
  log: (m: unknown) => void lines.push(String(m)),
  error: (m: unknown, ...rest: unknown[]) =>
    void lines.push(String(m), ...rest.map(String)),
  warn: (m: unknown) => void lines.push(String(m)),
};

let cloud: CloudHarness;
let counter = 0;

beforeAll(async () => {
  cloud = await startCloudHarness({ MOAT_TRUST_PROXY: '1' }, logger);
}, 60_000);
afterAll(async () => {
  await cloud?.stop();
});

const next = () => `user${counter++}@example.ch`;
/** Each request from its own address, so the per-address limits do not interfere. */
const ip = () => ({
  'x-forwarded-for': `10.1.${Math.floor(counter / 250)}.${counter % 250}`,
});

async function signUp(email = next(), password: string = PASSWORD) {
  const registered = await cloud.call('POST', '/api/auth/register', {
    body: { email, password },
    headers: ip(),
  });
  expect(registered.status).toBe(202);
  return signIn(email, password);
}
async function signIn(
  email: string,
  password: string = PASSWORD,
  code?: string,
  token?: string,
) {
  const reply = await cloud.call('POST', '/api/auth/login', {
    body: { email, password, ...(code === undefined ? {} : { code }) },
    headers: ip(),
    ...(token === undefined ? {} : { token }),
  });
  return { email, reply, ...sessionOf(reply) };
}
function sessionOf(reply: Reply) {
  const cookie = reply.setCookies[0] ?? '';
  const token = /=([A-Za-z0-9_-]{43});/.exec(cookie)?.[1] ?? '';
  return { cookie, token, csrf: token === '' ? '' : csrfTokenOf(token) };
}
const write = (s: { token: string; csrf: string }) => ({
  token: s.token,
  csrf: s.csrf,
});

describe('user enumeration (SEC-51, T-79)', () => {
  it('answers register for a new and a taken address with the same status and body', async () => {
    const email = next();
    const a = await cloud.call('POST', '/api/auth/register', {
      body: { email, password: PASSWORD },
      headers: ip(),
    });
    const b = await cloud.call('POST', '/api/auth/register', {
      body: { email: email.toUpperCase(), password: PASSWORD },
      headers: ip(),
    });
    expect([b.status, b.body]).toEqual([a.status, a.body]);
    expect(a.setCookies).toEqual([]);
    expect(b.setCookies).toEqual([]);
  });

  it('answers login for an unknown address, a wrong password and a malformed address alike', async () => {
    const known = await signUp();
    const replies = await Promise.all(
      [
        { email: known.email, password: 'definitely not the password' },
        { email: 'nobody-here@example.ch', password: PASSWORD },
        { email: 'not an address', password: PASSWORD },
      ].map((body) =>
        cloud.call('POST', '/api/auth/login', { body, headers: ip() }),
      ),
    );
    expect(new Set(replies.map((r) => r.status))).toEqual(new Set([401]));
    expect(new Set(replies.map((r) => r.body)).size).toBe(1);
    for (const r of replies) expect(r.setCookies).toEqual([]);
  });

  it('answers adding a member the same for an unknown address (the invitation comes later)', async () => {
    const owner = await signUp();
    const org = (
      await cloud.call('POST', '/api/orgs', {
        ...write(owner),
        body: { name: 'Enum Org' },
      })
    ).json<{ organisation: { id: string } }>().organisation.id;
    const other = await signUp();
    const add = (email: string) =>
      cloud.call('POST', `/api/orgs/${org}/members`, {
        ...write(owner),
        body: { email, role: 'viewer' },
      });
    const known = await add(other.email);
    const unknown = await add('ghost@example.ch');
    expect([unknown.status, unknown.body]).toEqual([known.status, known.body]);
  });
});

describe('sessions (SEC-51, T-80)', () => {
  it('sets an HttpOnly, Secure, SameSite=Lax host-prefixed cookie and no Domain', async () => {
    const { cookie } = await signUp();
    expect(cookie).toMatch(/^__Host-moat_session=[A-Za-z0-9_-]{43};/);
    for (const flag of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax'])
      expect(cookie).toContain(flag);
    expect(cookie).not.toMatch(/Domain=/i);
    expect(cookie).toMatch(/Max-Age=\d+/);
  });

  it('keeps the session token out of the response body and the database', async () => {
    const s = await signUp();
    expect(s.reply.body).not.toContain(s.token);
    const rows = await cloud.get(CloudDatabase).client.session.findMany();
    expect(JSON.stringify(rows)).not.toContain(s.token);
  });

  it('refuses a session cookie after logout, also when it is replayed', async () => {
    const s = await signUp();
    expect(
      (await cloud.call('GET', '/api/auth/me', { token: s.token })).status,
    ).toBe(200);
    const out = await cloud.call('POST', '/api/auth/logout', write(s));
    expect(out.status).toBe(204);
    expect(out.setCookies[0]).toContain('Max-Age=0');
    for (let i = 0; i < 2; i++) {
      expect(
        (await cloud.call('GET', '/api/auth/me', { token: s.token })).status,
      ).toBe(401);
      expect(
        (await cloud.call('POST', '/api/auth/logout', write(s))).status,
      ).toBe(401);
    }
  });

  it('does not adopt a session token the client chose, and ends the one it sent (fixation)', async () => {
    const victim = await signUp();
    const fixed = 'F'.repeat(43);
    const login = await cloud.call('POST', '/api/auth/login', {
      body: { email: victim.email, password: PASSWORD },
      cookieHeader: `__Host-moat_session=${fixed}`,
      headers: ip(),
    });
    expect(login.status).toBe(200);
    expect(sessionOf(login).token).not.toBe(fixed);
    expect(
      (await cloud.call('GET', '/api/auth/me', { token: fixed })).status,
    ).toBe(401);
  });

  it('ends the previous session when a new sign-in presents it', async () => {
    const first = await signUp();
    const second = await signIn(first.email, PASSWORD, undefined, first.token);
    expect(second.token).not.toBe(first.token);
    expect(
      (await cloud.call('GET', '/api/auth/me', { token: first.token })).status,
    ).toBe(401);
    expect(
      (await cloud.call('GET', '/api/auth/me', { token: second.token })).status,
    ).toBe(200);
  });

  it('revokes every session on a password change and signs the changing device in again', async () => {
    const a = await signUp();
    const b = await signIn(a.email);
    const change = await cloud.call('POST', '/api/auth/password', {
      ...write(a),
      body: { currentPassword: PASSWORD, newPassword: `${PASSWORD} (changed)` },
    });
    expect(change.status).toBe(200);
    const fresh = sessionOf(change);
    expect(fresh.token).not.toBe(a.token);
    for (const old of [a, b])
      expect(
        (await cloud.call('GET', '/api/auth/me', { token: old.token })).status,
      ).toBe(401);
    expect(
      (await cloud.call('GET', '/api/auth/me', { token: fresh.token })).status,
    ).toBe(200);
    expect((await signIn(a.email, PASSWORD)).reply.status).toBe(401);
    expect((await signIn(a.email, `${PASSWORD} (changed)`)).reply.status).toBe(
      200,
    );
  });

  it('shows the CSRF token of the session on /me, and nothing secret', async () => {
    const s = await signUp();
    const me = (
      await cloud.call('GET', '/api/auth/me', { token: s.token })
    ).json<{ account: Record<string, unknown>; csrfToken: string }>();
    expect(me.csrfToken).toBe(s.csrf);
    expect(Object.keys(me.account).sort()).toEqual([
      'createdAt',
      'email',
      'id',
      'totpEnabled',
    ]);
  });

  it('marks every answer no-store and sends security headers', async () => {
    const reply = await cloud.call('GET', '/api/health');
    expect(reply.headers['cache-control']).toBe('no-store');
    expect(reply.headers['x-powered-by']).toBeUndefined();
    expect(reply.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('CSRF and cross-site requests (T-78)', () => {
  it('refuses a state-changing request without, with a wrong, or with another session’s token', async () => {
    const mine = await signUp();
    const theirs = await signUp();
    const orgBody = { name: 'CSRF Org' };
    for (const csrf of [undefined, '', 'x', theirs.csrf, mine.csrf.slice(1)]) {
      const reply = await cloud.call('POST', '/api/orgs', {
        token: mine.token,
        ...(csrf === undefined ? {} : { csrf }),
        body: orgBody,
      });
      expect(reply.status).toBe(403);
      expect(reply.json()).toEqual({ statusCode: 403, error: 'csrf_invalid' });
    }
    expect(
      (await cloud.call('POST', '/api/orgs', { ...write(mine), body: orgBody }))
        .status,
    ).toBe(201);
    const list = (
      await cloud.call('GET', '/api/orgs', { token: mine.token })
    ).json<unknown[]>();
    expect(list).toHaveLength(1);
  });

  it('refuses a foreign Origin on every unsafe request, login included, and lets the own one through', async () => {
    const s = await signUp();
    const evil = 'https://evil.example';
    expect(
      (
        await cloud.call('POST', '/api/auth/login', {
          origin: evil,
          body: { email: s.email, password: PASSWORD },
          headers: ip(),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await cloud.call('POST', '/api/auth/register', {
          origin: evil,
          body: { email: next(), password: PASSWORD },
          headers: ip(),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await cloud.call('POST', '/api/orgs', {
          ...write(s),
          origin: evil,
          body: { name: 'x' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await cloud.call('POST', '/api/orgs', {
          ...write(s),
          origin: 'null',
          body: { name: 'x' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await cloud.call('POST', '/api/orgs', {
          ...write(s),
          headers: { 'sec-fetch-site': 'cross-site' },
          body: { name: 'x' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await cloud.call('POST', '/api/orgs', {
          ...write(s),
          origin: TEST_ORIGIN,
          headers: { 'sec-fetch-site': 'same-origin' },
          body: { name: 'x' },
        })
      ).status,
    ).toBe(201);
  });

  it('does not accept the form encodings a cross-site form can send', async () => {
    const s = await signUp();
    const reply = await cloud.call('POST', '/api/orgs', {
      ...write(s),
      headers: { 'content-type': 'text/plain' },
      cookieHeader: `__Host-moat_session=${s.token}`,
    });
    expect(reply.status).toBe(400);
  });
});

describe('brute force (SEC-51, T-79)', () => {
  it('answers 429 with Retry-After after ten failures for an address, from any number of addresses', async () => {
    const victim = await signUp();
    for (let i = 0; i < 10; i++) {
      const r = await cloud.call('POST', '/api/auth/login', {
        body: { email: victim.email, password: `guess number ${i} here` },
        headers: ip(),
      });
      expect(r.status).toBe(401);
    }
    const locked = await cloud.call('POST', '/api/auth/login', {
      body: { email: victim.email, password: PASSWORD },
      headers: ip(),
    });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    expect(locked.json()).toEqual({ statusCode: 429, error: 'rate_limited' });
    expect(locked.setCookies).toEqual([]);
  });

  it('limits sign-in attempts and registrations per origin address', async () => {
    const fixed = { 'x-forwarded-for': '203.0.113.7' };
    let status = 0;
    for (let i = 0; i < 61; i++)
      status = (
        await cloud.call('POST', '/api/auth/login', {
          body: { email: `n${i}@example.ch`, password: 'x'.repeat(14) },
          headers: fixed,
        })
      ).status;
    expect(status).toBe(429);
    const reg = { 'x-forwarded-for': '203.0.113.8' };
    for (let i = 0; i < 10; i++)
      expect(
        (
          await cloud.call('POST', '/api/auth/register', {
            body: { email: `r${i}@example.ch`, password: PASSWORD },
            headers: reg,
          })
        ).status,
      ).toBe(202);
    expect(
      (
        await cloud.call('POST', '/api/auth/register', {
          body: { email: 'r11@example.ch', password: PASSWORD },
          headers: reg,
        })
      ).status,
    ).toBe(429);
  });

  it('keeps the rate-limit table free of addresses and e-mails', async () => {
    const rows = await cloud.get(CloudDatabase).client.rateLimit.findMany();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.key).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('TOTP over HTTP (SEC-51)', () => {
  it('enrols, shows secret and recovery codes once, asks for a code, and takes each once', async () => {
    const s = await signUp();
    const enrol = await cloud.call('POST', '/api/auth/totp/enrol', {
      ...write(s),
      body: { password: PASSWORD },
    });
    expect(enrol.status).toBe(200);
    const { secret } = enrol.json<{ secret: string; otpauthUri: string }>();
    expect(secret).toMatch(/^[a-z2-7]{32}$/);
    // The secret is sealed in the database, and /me never shows it.
    const row = await cloud
      .get(CloudDatabase)
      .client.accountTotp.findFirstOrThrow();
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(
      (await cloud.call('GET', '/api/auth/me', { token: s.token })).body,
    ).not.toContain(secret);
    const opened = await (
      await TotpVault.create(TEST_ACCOUNT_KEY)
    ).open(row.sealedSecret, row.accountId);
    expect(opened).not.toBeNull();
    // Sealed for this account only: another account id does not open it.
    expect(
      await (
        await TotpVault.create(TEST_ACCOUNT_KEY)
      ).open(row.sealedSecret, 'x'.repeat(22)),
    ).toBeNull();

    const step = () => Math.floor(Date.now() / 30_000);
    const confirm = await cloud.call('POST', '/api/auth/totp/confirm', {
      ...write(s),
      body: { code: hotp(opened as Uint8Array, step()) },
    });
    expect(confirm.status).toBe(200);
    const { recoveryCodes } = confirm.json<{ recoveryCodes: string[] }>();
    expect(recoveryCodes).toHaveLength(10);
    const stored = JSON.stringify(
      await cloud.get(CloudDatabase).client.recoveryCode.findMany(),
    );
    for (const code of recoveryCodes)
      expect(stored).not.toContain(code.replaceAll('-', ''));

    const need = await signIn(s.email);
    expect(need.reply.status).toBe(401);
    expect(need.reply.json()).toEqual({
      statusCode: 401,
      error: 'mfa_required',
    });
    expect(need.reply.setCookies).toEqual([]);
    // The code used to confirm is spent; the next step's works once.
    const used = await signIn(
      s.email,
      PASSWORD,
      hotp(opened as Uint8Array, step()),
    );
    expect(used.reply.status).toBe(401);
    const code = hotp(opened as Uint8Array, step() + 1);
    expect((await signIn(s.email, PASSWORD, code)).reply.status).toBe(200);
    expect((await signIn(s.email, PASSWORD, code)).reply.status).toBe(401);
    const recovery = await signIn(s.email, PASSWORD, recoveryCodes[0]);
    expect(recovery.reply.status).toBe(200);
    expect(
      (await signIn(s.email, PASSWORD, recoveryCodes[0])).reply.status,
    ).toBe(401);

    // Disabling needs password and code; other sessions end, this one stays.
    const other = recovery;
    const disable = await cloud.call('POST', '/api/auth/totp/disable', {
      ...write(s),
      body: { password: PASSWORD, code: recoveryCodes[1] },
    });
    expect(disable.status).toBe(204);
    expect(
      (await cloud.call('GET', '/api/auth/me', { token: other.token })).status,
    ).toBe(401);
    expect(
      (await cloud.call('GET', '/api/auth/me', { token: s.token })).status,
    ).toBe(200);
    expect((await signIn(s.email)).reply.status).toBe(200);
  });
});

describe('organisations over HTTP (SEC-50, SEC-52)', () => {
  it('keeps tenants apart end to end, and lets an Editor neither grant release nor promote', async () => {
    const owner = await signUp();
    const editor = await signUp();
    const stranger = await signUp();
    const org = (
      await cloud.call('POST', '/api/orgs', {
        ...write(owner),
        body: { name: 'Acme' },
      })
    ).json<{ organisation: { id: string } }>().organisation.id;
    expect(
      (
        await cloud.call('POST', `/api/orgs/${org}/members`, {
          ...write(owner),
          body: { email: editor.email, role: 'editor' },
        })
      ).status,
    ).toBe(204);
    const project = (
      await cloud.call('POST', `/api/orgs/${org}/projects`, {
        ...write(editor),
        body: { name: 'Shop' },
      })
    ).json<{ project: { id: string } }>().project.id;
    const editorId = (
      await cloud.call('GET', '/api/auth/me', { token: editor.token })
    ).json<{ account: { id: string } }>().account.id;

    for (const body of [
      { releaseGranted: true },
      { role: 'owner' },
      { role: 'admin', releaseGranted: true },
    ]) {
      const reply = await cloud.call(
        'PATCH',
        `/api/orgs/${org}/members/${editorId}`,
        { ...write(editor), body },
      );
      expect(reply.status).toBe(403);
    }
    const mine = (
      await cloud.call('GET', `/api/orgs/${org}`, { token: editor.token })
    ).json<{
      access: { role: string; releaseGranted: boolean; permissions: string[] };
    }>();
    expect(mine.access.role).toBe('editor');
    expect(mine.access.releaseGranted).toBe(false);
    expect(mine.access.permissions).not.toContain('release');

    // The Owner grants it; only then does the Editor hold it.
    const granted = await cloud.call(
      'PATCH',
      `/api/orgs/${org}/members/${editorId}`,
      { ...write(owner), body: { releaseGranted: true } },
    );
    expect(granted.status).toBe(200);
    const after = (
      await cloud.call('GET', `/api/orgs/${org}`, { token: editor.token })
    ).json<{ access: { permissions: string[] } }>();
    expect(after.access.permissions).toContain('release');

    // The stranger sees nothing of it: every path is a 404, with the same body as an unknown id.
    const unknown = await cloud.call('GET', `/api/orgs/${'z'.repeat(22)}`, {
      token: stranger.token,
    });
    for (const [method, path] of [
      ['GET', `/api/orgs/${org}`],
      ['GET', `/api/orgs/${org}/members`],
      ['GET', `/api/orgs/${org}/projects`],
      ['GET', `/api/orgs/${org}/projects/${project}`],
    ] as const) {
      const reply = await cloud.call(method, path, { token: stranger.token });
      expect([reply.status, reply.body]).toEqual([404, unknown.body]);
    }
    expect(
      (
        await cloud.call(
          'DELETE',
          `/api/orgs/${org}/projects/${project}`,
          write(stranger),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await cloud.call(
          'DELETE',
          `/api/orgs/${org}/members/${editorId}`,
          write(stranger),
        )
      ).status,
    ).toBe(404);
    expect(
      (await cloud.call('GET', '/api/orgs', { token: stranger.token })).json<
        unknown[]
      >(),
    ).toEqual([]);
    // Nothing was changed by the attempts.
    const list = await cloud.call('GET', `/api/orgs/${org}/projects`, {
      token: owner.token,
    });
    expect(list.json<{ projects: unknown[] }>().projects).toHaveLength(1);
  });

  it('refuses unknown fields (mass assignment) and malformed input', async () => {
    const s = await signUp();
    for (const body of [
      { name: 'x', role: 'owner' },
      { name: 5 },
      {},
      { name: 'a'.repeat(401) },
    ])
      expect(
        (await cloud.call('POST', '/api/orgs', { ...write(s), body })).status,
      ).toBe(400);
    expect(
      (
        await cloud.call('POST', '/api/orgs', {
          ...write(s),
          body: { name: 'bad\u0000name' },
        })
      ).status,
    ).toBe(422);
    const org = (
      await cloud.call('POST', '/api/orgs', {
        ...write(s),
        body: { name: 'Ok' },
      })
    ).json<{ organisation: { id: string } }>().organisation.id;
    const meId = (
      await cloud.call('GET', '/api/auth/me', { token: s.token })
    ).json<{ account: { id: string } }>().account.id;
    expect(
      (
        await cloud.call('PATCH', `/api/orgs/${org}/members/${meId}`, {
          ...write(s),
          body: {},
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await cloud.call('PATCH', `/api/orgs/${org}/members/${meId}`, {
          ...write(s),
          body: { role: 'root' },
        })
      ).status,
    ).toBe(400);
    // The last Owner stays.
    expect(
      (
        await cloud.call('PATCH', `/api/orgs/${org}/members/${meId}`, {
          ...write(s),
          body: { role: 'viewer' },
        })
      ).json(),
    ).toEqual({ statusCode: 422, error: 'last_owner' });
    expect(
      (await cloud.call('DELETE', `/api/orgs/${org}/members/${meId}`, write(s)))
        .status,
    ).toBe(422);
  });
});

describe('secrets never leave (SEC-34, SEC-31)', () => {
  it('has no password, hash, session token or TOTP secret in any answer, log or error', async () => {
    const s = await signUp(next(), PASSWORD);
    const secretAnswer = (
      await cloud.call('POST', '/api/auth/totp/enrol', {
        ...write(s),
        body: { password: PASSWORD },
      })
    ).body;
    const hash = (
      await cloud
        .get(CloudDatabase)
        .client.account.findFirstOrThrow({ where: { email: s.email } })
    ).passwordHash;
    const replies = [
      s.reply,
      await cloud.call('GET', '/api/auth/me', { token: s.token }),
      await cloud.call('POST', '/api/auth/login', {
        body: { email: s.email, password: `${PASSWORD} wrong` },
        headers: ip(),
      }),
      await cloud.call('POST', '/api/auth/password', {
        ...write(s),
        body: { currentPassword: 'wrong wrong wrong', newPassword: PASSWORD },
      }),
      await cloud.call('POST', '/api/auth/login', {
        body: { email: s.email },
        headers: ip(),
      }),
      await cloud.call('POST', '/api/auth/register', {
        body: { email: s.email, password: 'tiny' },
        headers: ip(),
      }),
      await cloud.call('POST', '/api/orgs', {
        token: s.token,
        csrf: 'bad',
        body: { name: PASSWORD },
      }),
    ];
    const everything = [...replies.map((r) => r.body), ...lines].join('\n');
    expect(everything).not.toContain(hash);
    expect(everything).not.toContain('$argon2id$');
    expect(everything).not.toContain(PASSWORD);
    for (const planted of PLANTED_SECRETS)
      expect(everything).not.toContain(planted);
    expect(everything).not.toContain(s.token);
    // The TOTP secret appears only in its own enrolment answer.
    const totp = secretAnswer.match(/"secret":"([a-z2-7]{32})"/)?.[1] ?? '';
    expect(totp).not.toBe('');
    expect(everything).not.toContain(totp);
  });

  it('answers a server error with a generic body, never a stack or a message', async () => {
    const reply = await cloud.call('POST', '/api/auth/login', {
      body: '{"email":' as unknown as object,
      headers: ip(),
    });
    expect([400, 500]).toContain(reply.status);
    expect(reply.body).not.toMatch(/at .*\.ts|node_modules|Prisma|SQLITE/);
  });
});
