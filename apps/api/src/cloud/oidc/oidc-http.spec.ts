import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LoggerService } from '@nestjs/common';
import { PLANTED_SECRETS } from '../../testing/planted-secrets';
import { CloudDatabase } from '../../persistence/cloud/cloud-database';
import { csrfTokenOf } from '../auth/domain/session';
import { type CloudHarness, startCloudHarness } from '../testing/cloud-harness';
import { FakeIdp } from '../testing/fake-idp';

/**
 * Single sign-on over HTTP against a provider on this machine (SEC-51, T-104 to T-106): the
 * whole way — start, provider, callback — with the real app and the real database.
 */
const PASSWORD = PLANTED_SECRETS[2];
const lines: string[] = [];
const logger: LoggerService = {
  log: (m: unknown) => void lines.push(String(m)),
  error: (m: unknown, ...rest: unknown[]) =>
    void lines.push(String(m), ...rest.map(String)),
  warn: (m: unknown) => void lines.push(String(m)),
};

const idp = new FakeIdp();
let cloud: CloudHarness;
let counter = 0;

beforeAll(async () => {
  await idp.start();
  cloud = await startCloudHarness(
    {
      MOAT_TRUST_PROXY: '1',
      MOAT_OIDC_PROVIDERS: JSON.stringify([idp.provider()]),
    },
    logger,
  );
}, 60_000);
afterAll(async () => {
  await cloud?.stop();
  await idp.stop();
});

const ip = () => ({
  'x-forwarded-for': `10.2.${Math.floor(counter / 250)}.${counter++ % 250}`,
});
const cookiePair = (setCookie: string | undefined) =>
  (setCookie ?? '').split(';')[0] ?? '';
const eml = () => `sso${counter++}@example.ch`;

/** Starts a sign-in; returns what a browser would hold and send on. */
async function begin(path = '/api/auth/oidc/fakeidp/start') {
  const started = await cloud.call('GET', path, { headers: ip() });
  expect(started.status).toBe(302);
  const location = String(started.headers['location']);
  return { location, cookie: cookiePair(started.setCookies[0]), started };
}

async function finish(
  cookie: string,
  query: { code: string; state: string },
  extraCookie = '',
) {
  return cloud.call(
    'GET',
    `/api/auth/oidc/callback?code=${encodeURIComponent(query.code)}&state=${encodeURIComponent(query.state)}&iss=ignored&scope=openid`,
    {
      headers: ip(),
      cookieHeader: [cookie, extraCookie].filter(Boolean).join('; '),
    },
  );
}

async function signInWith(claims: Record<string, unknown>) {
  const { location, cookie } = await begin();
  const issued = idp.issueCode(location, claims as never);
  return { reply: await finish(cookie, issued), issued, location, cookie };
}

describe('single sign-on with OpenID Connect (SEC-51)', () => {
  it('lists the providers by id and name only', async () => {
    const reply = await cloud.call('GET', '/api/auth/oidc/providers');
    expect(reply.status).toBe(200);
    expect(reply.json()).toEqual({
      providers: [{ id: 'fakeidp', name: 'Fake IdP' }],
    });
    expect(reply.body).not.toContain(idp.clientSecret);
  });

  it('sends the browser to the provider with state, nonce and PKCE, and binds it with a cookie', async () => {
    const { location, started } = await begin();
    const url = new URL(location);
    expect(url.origin).toBe(idp.issuer);
    expect(url.pathname).toBe('/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe(idp.clientId);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe('openid email');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://app.moat.test/api/auth/oidc/callback',
    );
    for (const name of ['state', 'nonce', 'code_challenge'])
      expect(url.searchParams.get(name)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(started.setCookies[0]).toMatch(/HttpOnly/);
    expect(started.setCookies[0]).toMatch(/SameSite=Lax/);
    expect(started.headers['cache-control']).toBe('no-store');
    expect(idp.clientSecret).not.toContain(url.search);
    // Only a hash of the state is stored.
    const rows = await cloud.get(CloudDatabase).client.oidcLogin.findMany();
    expect(JSON.stringify(rows)).not.toContain(url.searchParams.get('state'));
    expect(JSON.stringify(rows)).not.toContain(
      cookiePair(started.setCookies[0]).split('=')[1],
    );
  });

  it('answers an unknown provider with a plain 404', async () => {
    const reply = await cloud.call('GET', '/api/auth/oidc/nope/start', {
      headers: ip(),
    });
    expect(reply.status).toBe(404);
  });

  it('creates an account for a new person with a verified address, and signs them in', async () => {
    const email = eml();
    const { reply } = await signInWith({
      sub: `sub-${email}`,
      email,
      email_verified: true,
    });
    expect(reply.status).toBe(302);
    expect(reply.headers['location']).toBe('/app');
    const session = reply.setCookies.find((c) => c.includes('moat_session'));
    expect(session).toBeDefined();
    const token = /=([A-Za-z0-9_-]{43});/.exec(session ?? '')?.[1] ?? '';
    const me = await cloud.call('GET', '/api/auth/me', { token });
    expect(me.status).toBe(200);
    expect(
      me.json<{ account: Record<string, unknown>; csrfToken: string }>(),
    ).toMatchObject({
      account: {
        email,
        hasPassword: false,
        identities: ['fakeidp'],
        totpEnabled: false,
      },
      csrfToken: csrfTokenOf(token),
    });
    // The account has no password hash: no password ever matches it.
    const row = await cloud
      .get(CloudDatabase)
      .client.account.findUniqueOrThrow({ where: { email } });
    expect(row.passwordHash).toBe('$argon2id$moat-sso-no-password');
    expect(row.emailVerifiedAt).not.toBeNull();
    const login = await cloud.call('POST', '/api/auth/login', {
      body: { email, password: PASSWORD },
      headers: ip(),
    });
    expect(login.status).toBe(401);
    // Signing in again finds the same account through the provider's `sub`, not the address.
    const again = await signInWith({
      sub: `sub-${email}`,
      email: 'other@example.ch',
      email_verified: false,
    });
    expect(again.reply.headers['location']).toBe('/app');
    expect(
      await cloud
        .get(CloudDatabase)
        .client.account.count({ where: { email: 'other@example.ch' } }),
    ).toBe(0);
  });

  it('refuses a new person whose address the provider did not verify', async () => {
    const email = eml();
    for (const claims of [
      { sub: `u-${email}`, email, email_verified: false },
      { sub: `u-${email}`, email },
      { sub: `u-${email}`, email: 'not-an-address', email_verified: true },
      { sub: `u-${email}`, email_verified: true },
    ]) {
      const { reply } = await signInWith(claims);
      expect(reply.headers['location']).toBe('/login?sso=email_unverified');
      expect(
        reply.setCookies.some(
          (c) => c.includes('moat_session=') && !c.includes('Max-Age=0'),
        ),
      ).toBe(false);
    }
    expect(
      await cloud.get(CloudDatabase).client.account.count({ where: { email } }),
    ).toBe(0);
  });

  it('never takes over an account that exists: the address alone is not a link', async () => {
    const email = eml();
    await cloud.call('POST', '/api/auth/register', {
      body: { email, password: PASSWORD },
      headers: ip(),
    });
    const { reply } = await signInWith({
      sub: `thief-${email}`,
      email,
      email_verified: true,
    });
    expect(reply.headers['location']).toBe('/login?sso=email_taken');
    expect(
      reply.setCookies.some((c) => /moat_session=[A-Za-z0-9_-]{43}/.test(c)),
    ).toBe(false);
    expect(
      await cloud
        .get(CloudDatabase)
        .client.accountIdentity.count({ where: { subject: `thief-${email}` } }),
    ).toBe(0);
  });

  it('links a provider to an account after the password, and then signs in through it', async () => {
    const email = eml();
    await cloud.call('POST', '/api/auth/register', {
      body: { email, password: PASSWORD },
      headers: ip(),
    });
    const login = await cloud.call('POST', '/api/auth/login', {
      body: { email, password: PASSWORD },
      headers: ip(),
    });
    const token =
      /=([A-Za-z0-9_-]{43});/.exec(login.setCookies[0] ?? '')?.[1] ?? '';
    const csrf = csrfTokenOf(token);
    const wrong = await cloud.call('POST', '/api/auth/oidc/fakeidp/link', {
      token,
      csrf,
      body: { password: 'not the password at all' },
    });
    expect(wrong.status).toBe(401);
    const started = await cloud.call('POST', '/api/auth/oidc/fakeidp/link', {
      token,
      csrf,
      body: { password: PASSWORD },
    });
    expect(started.status).toBe(200);
    const issued = idp.issueCode(started.json<{ url: string }>().url, {
      sub: `linked-${email}`,
      email: 'whatever@idp.example',
      email_verified: true,
    });
    const done = await finish(cookiePair(started.setCookies[0]), issued);
    expect(done.headers['location']).toBe('/app/account?sso=linked');
    const me = await cloud.call('GET', '/api/auth/me', { token });
    expect(
      me.json<{ account: { identities: string[]; hasPassword: boolean } }>()
        .account,
    ).toMatchObject({ identities: ['fakeidp'], hasPassword: true });
    // The same provider identity cannot be linked to a second account.
    const other = eml();
    await cloud.call('POST', '/api/auth/register', {
      body: { email: other, password: PASSWORD },
      headers: ip(),
    });
    const login2 = await cloud.call('POST', '/api/auth/login', {
      body: { email: other, password: PASSWORD },
      headers: ip(),
    });
    const token2 =
      /=([A-Za-z0-9_-]{43});/.exec(login2.setCookies[0] ?? '')?.[1] ?? '';
    const started2 = await cloud.call('POST', '/api/auth/oidc/fakeidp/link', {
      token: token2,
      csrf: csrfTokenOf(token2),
      body: { password: PASSWORD },
    });
    const issued2 = idp.issueCode(started2.json<{ url: string }>().url, {
      sub: `linked-${email}`,
      email: other,
      email_verified: true,
    });
    const refused = await finish(cookiePair(started2.setCookies[0]), issued2);
    expect(refused.headers['location']).toBe('/app/account?sso=identity_taken');
  });

  it('fails every callback that is not the one this browser started', async () => {
    const email = eml();
    const claims = { sub: `s-${email}`, email, email_verified: true };
    const failed = (reply: {
      headers: Record<string, unknown>;
      setCookies: string[];
    }) => {
      expect(reply.headers['location']).toBe('/login?sso=failed');
      expect(
        reply.setCookies.some((c) => /moat_session=[A-Za-z0-9_-]{43}/.test(c)),
      ).toBe(false);
    };
    // Another browser (no cookie, or a cookie of another sign-in): login CSRF.
    const mine = await begin();
    const issued = idp.issueCode(mine.location, claims);
    failed(await finish('', issued));
    // The state is used up by that try, even though it failed.
    failed(await finish(mine.cookie, issued));
    const first = await begin();
    const second = await begin();
    failed(await finish(second.cookie, idp.issueCode(first.location, claims)));
    // A state nobody made, a code the provider did not issue, and an error from the provider.
    failed(await finish(mine.cookie, { code: 'x', state: 'A'.repeat(43) }));
    const third = await begin();
    failed(
      await finish(third.cookie, {
        code: 'made-up',
        state: idp.issueCode(third.location, claims).state,
      }),
    );
    const errored = await cloud.call(
      'GET',
      '/api/auth/oidc/callback?error=access_denied',
      { headers: ip() },
    );
    failed(errored);
    // No account was made by any of it.
    expect(
      await cloud.get(CloudDatabase).client.account.count({ where: { email } }),
    ).toBe(0);
  });

  it('refuses a token for another audience, another nonce or another issuer, and one that expired', async () => {
    const email = eml();
    for (const overrides of [
      { aud: 'someone-else' },
      { nonce: 'a-different-nonce-value' },
      { iss: 'https://evil.example' },
      { exp: Math.floor(Date.now() / 1000) - 3600 },
    ]) {
      const { location, cookie } = await begin();
      const issued = idp.issueCode(
        location,
        { sub: `x-${email}`, email, email_verified: true },
        overrides,
      );
      const reply = await finish(cookie, issued);
      expect(reply.headers['location'], JSON.stringify(overrides)).toBe(
        '/login?sso=failed',
      );
    }
    expect(
      await cloud.get(CloudDatabase).client.account.count({ where: { email } }),
    ).toBe(0);
  });

  it('sends the client credentials only to the token endpoint and keeps them out of logs and answers', async () => {
    idp.tokenRequests.length = 0;
    const email = eml();
    const { reply } = await signInWith({
      sub: `c-${email}`,
      email,
      email_verified: true,
    });
    expect(reply.body).not.toContain(idp.clientSecret);
    const asked = idp.tokenRequests.at(-1);
    expect(asked?.authorization).toBe(
      `Basic ${Buffer.from(`${idp.clientId}:${idp.clientSecret}`).toString('base64')}`,
    );
    expect(asked?.body.get('client_secret')).toBeNull();
    expect(asked?.body.get('redirect_uri')).toBe(
      'https://app.moat.test/api/auth/oidc/callback',
    );
    expect(lines.join('\n')).not.toContain(idp.clientSecret);
  });
});
