import { beforeAll, describe, expect, it } from 'vitest';
import { PLANTED_SECRETS } from '../../../testing/planted-secrets';
import { AuditTrail } from '../../audit/application/audit-trail';
import {
  FixedClock,
  InMemoryAccounts,
  InMemoryAudit,
  InMemoryOrganisations,
  InMemoryRateLimit,
  InMemorySessions,
} from '../../testing/in-memory';
import { passkeyKit } from '../../testing/passkey-kit';
import { mailKit } from '../../testing/mail-kit';
import { SESSION_IDLE_MS, sessionIdOf } from '../domain/session';
import { hotp } from '../domain/totp';
import {
  AuthenticateSessionQuery,
  ChangePasswordCommand,
  ConfirmTotpCommand,
  DisableTotpCommand,
  EnrolTotpCommand,
  GetMeQuery,
  LoginCommand,
  LogoutCommand,
  RegisterCommand,
} from './auth.commands';
import {
  AuthenticateSessionHandler,
  ChangePasswordHandler,
  ConfirmTotpHandler,
  DisableTotpHandler,
  EnrolTotpHandler,
  GetMeHandler,
  LoginHandler,
  LogoutHandler,
  RegisterHandler,
} from './auth.handlers';
import { LoginGate } from './login-gate';
import { PasswordHasher } from './password-hasher';
import { RateLimiter } from './rate-limiter';
import { SecondFactor } from './second-factor';
import { SessionIssuer } from './session-issuer';
import { TotpVault } from './totp-vault';

const PASSWORD = PLANTED_SECRETS[2]; // 28 characters
const KEY = 'A'.repeat(43);

let vault: TotpVault;
beforeAll(async () => {
  vault = await TotpVault.create(KEY);
});

function setup(mailEnabled = false) {
  const accounts = new InMemoryAccounts();
  const sessions = new InMemorySessions();
  const rate = new InMemoryRateLimit();
  const clock = new FixedClock();
  const hasher = new PasswordHasher('fast');
  const limiter = new RateLimiter(rate, clock);
  const factor = new SecondFactor(accounts, vault, clock);
  const issuer = new SessionIssuer(sessions, clock);
  const organisations = new InMemoryOrganisations(accounts);
  const audit = new AuditTrail(new InMemoryAudit(), clock);
  const kit = mailKit(mailEnabled, accounts, organisations, clock, audit, rate);
  const pk = passkeyKit(clock);
  return {
    kit,
    organisations,
    accounts,
    sessions,
    rate,
    clock,
    hasher,
    register: new RegisterHandler(
      accounts,
      hasher,
      limiter,
      clock,
      kit.mails,
      kit.redeemer,
    ),
    passkeyKit: pk,
    login: new LoginHandler(
      accounts,
      sessions,
      hasher,
      factor,
      issuer,
      clock,
      pk.passkeys,
      pk.service,
      new LoginGate(accounts, hasher, limiter, kit.mails),
    ),
    logout: new LogoutHandler(sessions, clock),
    authenticate: new AuthenticateSessionHandler(sessions, clock),
    me: new GetMeHandler(accounts, pk.passkeys),
    change: new ChangePasswordHandler(
      accounts,
      sessions,
      hasher,
      limiter,
      issuer,
      clock,
      kit.tokens,
    ),
    enrol: new EnrolTotpHandler(accounts, hasher, vault, limiter, clock),
    confirm: new ConfirmTotpHandler(accounts, factor, limiter, clock),
    disable: new DisableTotpHandler(
      accounts,
      sessions,
      hasher,
      factor,
      limiter,
      clock,
    ),
  };
}
type Ctx = ReturnType<typeof setup>;

async function registered(ctx: Ctx, email = 'eme@example.ch') {
  await ctx.register.execute(new RegisterCommand(email, PASSWORD, '1.1.1.1'));
}
async function loggedIn(ctx: Ctx, email = 'eme@example.ch', code?: string) {
  const result = await ctx.login.execute(
    new LoginCommand(email, PASSWORD, code, '1.1.1.1', null),
  );
  if (result.status !== 'ok')
    throw new Error(`login: ${JSON.stringify(result)}`);
  return result;
}
/** The TOTP secret of the account, opened with the test's vault. */
async function secretOf(ctx: Ctx, accountId: string): Promise<Uint8Array> {
  const t = await ctx.accounts.totp(accountId);
  const secret = await vault.open(t?.sealedSecret ?? '', accountId);
  if (secret === null) throw new Error('no secret');
  return secret;
}
async function enableTotp(ctx: Ctx, accountId: string) {
  await ctx.enrol.execute(new EnrolTotpCommand(accountId, PASSWORD));
  const secret = await secretOf(ctx, accountId);
  ctx.clock.advance(30_000);
  const code = hotp(secret, Math.floor(ctx.clock.now().getTime() / 30_000));
  const result = await ctx.confirm.execute(
    new ConfirmTotpCommand(accountId, code),
  );
  if (result.status !== 'ok') throw new Error('confirm failed');
  return { secret, recoveryCodes: result.recoveryCodes };
}
const codeAt = (ctx: Ctx, secret: Uint8Array) =>
  hotp(secret, Math.floor(ctx.clock.now().getTime() / 30_000));

describe('register (SEC-51)', () => {
  it('stores an Argon2id hash, never the password', async () => {
    const ctx = setup();
    await registered(ctx);
    const [account] = [...ctx.accounts.accounts.values()];
    expect(account?.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(JSON.stringify([...ctx.accounts.accounts.values()])).not.toContain(
      PASSWORD,
    );
  });

  it('answers the same for a new and a taken address, and keeps the first account', async () => {
    const ctx = setup();
    const first = await ctx.register.execute(
      new RegisterCommand('a@example.ch', PASSWORD, '1.1.1.1'),
    );
    const again = await ctx.register.execute(
      new RegisterCommand('A@Example.ch', `${PASSWORD} other`, '1.1.1.1'),
    );
    expect(again).toEqual(first);
    expect(ctx.accounts.accounts.size).toBe(1);
    expect(
      await ctx.login.execute(
        new LoginCommand('a@example.ch', PASSWORD, undefined, '1.1.1.1', null),
      ),
    ).toMatchObject({ status: 'ok' });
  });

  it('refuses a short or long password and a bad address', async () => {
    const ctx = setup();
    const run = (email: string, password: string) =>
      ctx.register.execute(new RegisterCommand(email, password, '2.2.2.2'));
    expect(await run('a@example.ch', 'short')).toEqual({
      status: 'refused',
      code: 'password_too_short',
    });
    expect(await run('a@example.ch', 'x'.repeat(257))).toEqual({
      status: 'refused',
      code: 'password_too_long',
    });
    expect(await run('nope', PASSWORD)).toEqual({
      status: 'refused',
      code: 'email_invalid',
    });
    expect(ctx.accounts.accounts.size).toBe(0);
  });

  it('limits registrations per address, per window (T-79)', async () => {
    const ctx = setup();
    for (let i = 0; i < 10; i++)
      await ctx.register.execute(
        new RegisterCommand(`u${i}@example.ch`, PASSWORD, '3.3.3.3'),
      );
    const blocked = await ctx.register.execute(
      new RegisterCommand('u11@example.ch', PASSWORD, '3.3.3.3'),
    );
    expect(blocked).toMatchObject({ status: 'refused', code: 'rate_limited' });
    expect(ctx.accounts.accounts.size).toBe(10);
    ctx.clock.advance(61 * 60_000);
    expect(
      await ctx.register.execute(
        new RegisterCommand('u11@example.ch', PASSWORD, '3.3.3.3'),
      ),
    ).toEqual({ status: 'accepted' });
  });
});

describe('login (SEC-51, T-79)', () => {
  it('gives an unknown address and a wrong password the same answer', async () => {
    const ctx = setup();
    await registered(ctx);
    const unknown = await ctx.login.execute(
      new LoginCommand(
        'nobody@example.ch',
        PASSWORD,
        undefined,
        '1.1.1.1',
        null,
      ),
    );
    const wrong = await ctx.login.execute(
      new LoginCommand(
        'eme@example.ch',
        'wrong password!!',
        undefined,
        '1.1.1.1',
        null,
      ),
    );
    const malformed = await ctx.login.execute(
      new LoginCommand('???', PASSWORD, undefined, '1.1.1.1', null),
    );
    expect(unknown).toEqual({ status: 'refused', code: 'invalid_credentials' });
    expect(wrong).toEqual(unknown);
    expect(malformed).toEqual(unknown);
  });

  it('starts a session whose token is never stored (only its SHA-256)', async () => {
    const ctx = setup();
    await registered(ctx);
    const result = await loggedIn(ctx);
    expect(ctx.sessions.sessions.has(sessionIdOf(result.session.token))).toBe(
      true,
    );
    expect(JSON.stringify([...ctx.sessions.sessions.values()])).not.toContain(
      result.session.token,
    );
    expect(JSON.stringify(result.account)).not.toContain('argon2');
    expect(Object.keys(result.account).sort()).toEqual([
      'createdAt',
      'email',
      'id',
      'passkeyCount',
      'totpEnabled',
    ]);
  });

  it('locks an address after ten failures, for the window, without opening the account', async () => {
    const ctx = setup();
    await registered(ctx);
    for (let i = 0; i < 10; i++)
      await ctx.login.execute(
        new LoginCommand(
          'eme@example.ch',
          `bad password ${i}!!`,
          undefined,
          `9.9.9.${i}`,
          null,
        ),
      );
    const locked = await ctx.login.execute(
      new LoginCommand('eme@example.ch', PASSWORD, undefined, '9.9.9.99', null),
    );
    expect(locked).toMatchObject({ status: 'refused', code: 'rate_limited' });
    expect(
      (locked as { retryAfterSeconds: number }).retryAfterSeconds,
    ).toBeGreaterThan(0);
    ctx.clock.advance(16 * 60_000);
    expect(
      await ctx.login.execute(
        new LoginCommand(
          'eme@example.ch',
          PASSWORD,
          undefined,
          '9.9.9.99',
          null,
        ),
      ),
    ).toMatchObject({ status: 'ok' });
  });

  it('counts an unknown address like a known one', async () => {
    const ctx = setup();
    for (let i = 0; i < 10; i++)
      await ctx.login.execute(
        new LoginCommand(
          'ghost@example.ch',
          'x'.repeat(14),
          undefined,
          `8.8.8.${i}`,
          null,
        ),
      );
    expect(
      await ctx.login.execute(
        new LoginCommand(
          'ghost@example.ch',
          'x'.repeat(14),
          undefined,
          '8.8.8.99',
          null,
        ),
      ),
    ).toMatchObject({ code: 'rate_limited' });
  });

  it('limits one address of origin across all names', async () => {
    const ctx = setup();
    for (let i = 0; i < 60; i++)
      await ctx.login.execute(
        new LoginCommand(
          `n${i}@example.ch`,
          'x'.repeat(14),
          undefined,
          '7.7.7.7',
          null,
        ),
      );
    expect(
      await ctx.login.execute(
        new LoginCommand(
          'n99@example.ch',
          'x'.repeat(14),
          undefined,
          '7.7.7.7',
          null,
        ),
      ),
    ).toMatchObject({ code: 'rate_limited' });
  });

  it('ends a session cookie that came with the request instead of adopting it (fixation)', async () => {
    const ctx = setup();
    await registered(ctx);
    const first = await loggedIn(ctx);
    const second = await ctx.login.execute(
      new LoginCommand(
        'eme@example.ch',
        PASSWORD,
        undefined,
        '1.1.1.1',
        first.session.token,
      ),
    );
    if (second.status !== 'ok') throw new Error('login');
    expect(second.session.token).not.toBe(first.session.token);
    expect(
      await ctx.authenticate.execute(
        new AuthenticateSessionQuery(first.session.token),
      ),
    ).toBeNull();
    expect(
      await ctx.authenticate.execute(
        new AuthenticateSessionQuery(second.session.token),
      ),
    ).not.toBeNull();
  });
});

describe('sessions (idle and absolute expiry, revocation)', () => {
  it('authenticates a live session, and not after logout', async () => {
    const ctx = setup();
    await registered(ctx);
    const { session, account } = await loggedIn(ctx);
    const principal = await ctx.authenticate.execute(
      new AuthenticateSessionQuery(session.token),
    );
    expect(principal).toMatchObject({ accountId: account.id });
    await ctx.logout.execute(new LogoutCommand(principal?.sessionId ?? ''));
    expect(
      await ctx.authenticate.execute(
        new AuthenticateSessionQuery(session.token),
      ),
    ).toBeNull();
  });

  it('refuses malformed and unknown tokens without touching storage', async () => {
    const ctx = setup();
    for (const token of ['', 'x', 'a'.repeat(43), '../'.repeat(20)])
      expect(
        await ctx.authenticate.execute(new AuthenticateSessionQuery(token)),
      ).toBeNull();
  });

  it('expires after idle time, but a used session slides', async () => {
    const ctx = setup();
    await registered(ctx);
    const { session } = await loggedIn(ctx);
    for (let i = 0; i < 4; i++) {
      ctx.clock.advance(SESSION_IDLE_MS - 60_000);
      expect(
        await ctx.authenticate.execute(
          new AuthenticateSessionQuery(session.token),
        ),
      ).not.toBeNull();
    }
    ctx.clock.advance(SESSION_IDLE_MS + 1);
    expect(
      await ctx.authenticate.execute(
        new AuthenticateSessionQuery(session.token),
      ),
    ).toBeNull();
  });

  it('expires at the absolute end however busy it was', async () => {
    const ctx = setup();
    await registered(ctx);
    const { session } = await loggedIn(ctx);
    for (let step = 0; step < 30; step++) {
      ctx.clock.advance(11 * 3600_000);
      expect(
        await ctx.authenticate.execute(
          new AuthenticateSessionQuery(session.token),
        ),
      ).not.toBeNull();
    }
    ctx.clock.advance(11 * 3600_000);
    expect(
      await ctx.authenticate.execute(
        new AuthenticateSessionQuery(session.token),
      ),
    ).toBeNull();
  });
});

describe('change password', () => {
  it('revokes every session and issues a fresh one', async () => {
    const ctx = setup();
    await registered(ctx);
    const a = await loggedIn(ctx);
    const b = await loggedIn(ctx);
    const result = await ctx.change.execute(
      new ChangePasswordCommand(a.account.id, PASSWORD, `${PASSWORD} new`),
    );
    if (result.status !== 'ok') throw new Error('change');
    for (const old of [a, b])
      expect(
        await ctx.authenticate.execute(
          new AuthenticateSessionQuery(old.session.token),
        ),
      ).toBeNull();
    expect(
      await ctx.authenticate.execute(
        new AuthenticateSessionQuery(result.session.token),
      ),
    ).not.toBeNull();
    const again = await ctx.login.execute(
      new LoginCommand('eme@example.ch', PASSWORD, undefined, '1.1.1.1', null),
    );
    expect(again).toMatchObject({ code: 'invalid_credentials' });
  });

  it('needs the current password, a valid new one, and is limited', async () => {
    const ctx = setup();
    await registered(ctx);
    const { account } = await loggedIn(ctx);
    expect(
      await ctx.change.execute(
        new ChangePasswordCommand(
          account.id,
          'not the one!!!',
          `${PASSWORD} new`,
        ),
      ),
    ).toEqual({ status: 'refused', code: 'invalid_credentials' });
    expect(
      await ctx.change.execute(
        new ChangePasswordCommand(account.id, PASSWORD, 'short'),
      ),
    ).toEqual({ status: 'refused', code: 'password_too_short' });
    expect(
      await ctx.change.execute(
        new ChangePasswordCommand(account.id, PASSWORD, PASSWORD),
      ),
    ).toEqual({ status: 'refused', code: 'password_unchanged' });
    for (let i = 0; i < 10; i++)
      await ctx.change.execute(
        new ChangePasswordCommand(
          account.id,
          'not the one!!!',
          `${PASSWORD} new`,
        ),
      );
    expect(
      await ctx.change.execute(
        new ChangePasswordCommand(account.id, PASSWORD, `${PASSWORD} new`),
      ),
    ).toMatchObject({ code: 'rate_limited' });
  });
});

describe('TOTP and recovery codes (SEC-51)', () => {
  it('enrols behind the password, confirms with a code, and shows codes once', async () => {
    const ctx = setup();
    await registered(ctx);
    const { account } = await loggedIn(ctx);
    expect(
      await ctx.enrol.execute(
        new EnrolTotpCommand(account.id, 'not the one!!!'),
      ),
    ).toEqual({ status: 'refused', code: 'invalid_credentials' });
    const enrolled = await ctx.enrol.execute(
      new EnrolTotpCommand(account.id, PASSWORD),
    );
    if (enrolled.status !== 'ok') throw new Error('enrol');
    expect(enrolled.secret).toMatch(/^[a-z2-7]{32}$/);
    // The secret is sealed in storage: the base32 text is nowhere in it.
    const stored = JSON.stringify([...ctx.accounts.totps.values()]);
    expect(stored).not.toContain(enrolled.secret);
    expect(
      (await ctx.me.execute(new GetMeQuery(account.id)))?.totpEnabled,
    ).toBe(false);

    expect(
      await ctx.confirm.execute(new ConfirmTotpCommand(account.id, '000000')),
    ).toEqual({ status: 'refused', code: 'invalid_code' });
    const secret = await secretOf(ctx, account.id);
    const done = await ctx.confirm.execute(
      new ConfirmTotpCommand(account.id, codeAt(ctx, secret)),
    );
    if (done.status !== 'ok') throw new Error('confirm');
    expect(done.recoveryCodes).toHaveLength(10);
    const storedCodes = JSON.stringify(ctx.accounts.codes);
    for (const code of done.recoveryCodes)
      expect(storedCodes).not.toContain(code.replaceAll('-', ''));
    expect(
      (await ctx.me.execute(new GetMeQuery(account.id)))?.totpEnabled,
    ).toBe(true);
    expect(
      await ctx.enrol.execute(new EnrolTotpCommand(account.id, PASSWORD)),
    ).toEqual({ status: 'refused', code: 'already_enabled' });
    expect(
      await ctx.confirm.execute(
        new ConfirmTotpCommand(account.id, codeAt(ctx, secret)),
      ),
    ).toEqual({ status: 'refused', code: 'not_pending' });
  });

  it('asks for the code at login, once per code, and takes a recovery code once', async () => {
    const ctx = setup();
    await registered(ctx);
    const { account } = await loggedIn(ctx);
    const { secret, recoveryCodes } = await enableTotp(ctx, account.id);

    const none = await ctx.login.execute(
      new LoginCommand('eme@example.ch', PASSWORD, undefined, '1.1.1.1', null),
    );
    expect(none).toEqual({
      status: 'refused',
      code: 'mfa_required',
      methods: ['totp'],
    });
    expect(
      await ctx.login.execute(
        new LoginCommand('eme@example.ch', PASSWORD, '000000', '1.1.1.1', null),
      ),
    ).toEqual({ status: 'refused', code: 'invalid_code' });

    ctx.clock.advance(30_000);
    const code = codeAt(ctx, secret);
    expect(
      (await loggedIn(ctx, 'eme@example.ch', code)).account.totpEnabled,
    ).toBe(true);
    // The same code does not work twice (replay, T-79).
    expect(
      await ctx.login.execute(
        new LoginCommand('eme@example.ch', PASSWORD, code, '1.1.1.1', null),
      ),
    ).toEqual({ status: 'refused', code: 'invalid_code' });

    const recovery = recoveryCodes[0] ?? '';
    expect(
      (await loggedIn(ctx, 'eme@example.ch', recovery.toUpperCase())).session
        .token,
    ).toBeTruthy();
    expect(
      await ctx.login.execute(
        new LoginCommand('eme@example.ch', PASSWORD, recovery, '1.1.1.1', null),
      ),
    ).toEqual({ status: 'refused', code: 'invalid_code' });
  });

  it('does not say a code is needed before the password was right', async () => {
    const ctx = setup();
    await registered(ctx);
    const { account } = await loggedIn(ctx);
    await enableTotp(ctx, account.id);
    expect(
      await ctx.login.execute(
        new LoginCommand(
          'eme@example.ch',
          'wrong password!!',
          undefined,
          '1.1.1.1',
          null,
        ),
      ),
    ).toEqual({ status: 'refused', code: 'invalid_credentials' });
    expect(
      await ctx.login.execute(
        new LoginCommand(
          'nobody@example.ch',
          PASSWORD,
          undefined,
          '1.1.1.1',
          null,
        ),
      ),
    ).toEqual({ status: 'refused', code: 'invalid_credentials' });
  });

  it('limits wrong codes like wrong passwords', async () => {
    const ctx = setup();
    await registered(ctx);
    const { account } = await loggedIn(ctx);
    await enableTotp(ctx, account.id);
    for (let i = 0; i < 10; i++)
      await ctx.login.execute(
        new LoginCommand('eme@example.ch', PASSWORD, '000000', '1.1.1.1', null),
      );
    expect(
      await ctx.login.execute(
        new LoginCommand('eme@example.ch', PASSWORD, '000000', '1.1.1.1', null),
      ),
    ).toMatchObject({ code: 'rate_limited' });
  });

  it('disables only with password and a code, ends other sessions, drops the recovery codes', async () => {
    const ctx = setup();
    await registered(ctx);
    const here = await loggedIn(ctx);
    const other = await loggedIn(ctx);
    const { secret } = await enableTotp(ctx, here.account.id);
    ctx.clock.advance(30_000);
    const run = (password: string, code: string) =>
      ctx.disable.execute(
        new DisableTotpCommand(
          here.account.id,
          sessionIdOf(here.session.token),
          password,
          code,
        ),
      );
    expect(await run('not the one!!!', codeAt(ctx, secret))).toEqual({
      status: 'refused',
      code: 'invalid_credentials',
    });
    expect(await run(PASSWORD, '000000')).toEqual({
      status: 'refused',
      code: 'invalid_code',
    });
    expect(await run(PASSWORD, codeAt(ctx, secret))).toEqual({ status: 'ok' });
    expect(ctx.accounts.codes).toHaveLength(0);
    expect(
      await ctx.authenticate.execute(
        new AuthenticateSessionQuery(other.session.token),
      ),
    ).toBeNull();
    expect(
      await ctx.authenticate.execute(
        new AuthenticateSessionQuery(here.session.token),
      ),
    ).not.toBeNull();
    expect(await run(PASSWORD, '000000')).toEqual({
      status: 'refused',
      code: 'not_enabled',
    });
  });
});

describe('secrets in results and storage (SEC-34, SEC-31)', () => {
  it('never carries the password or its hash in anything a handler returns', async () => {
    const ctx = setup();
    const results: unknown[] = [];
    results.push(
      await ctx.register.execute(
        new RegisterCommand('eme@example.ch', PASSWORD, '1.1.1.1'),
      ),
    );
    const login = await loggedIn(ctx);
    results.push(login, await ctx.me.execute(new GetMeQuery(login.account.id)));
    results.push(
      await ctx.login.execute(
        new LoginCommand(
          'eme@example.ch',
          'wrong password!!',
          undefined,
          '1.1.1.1',
          null,
        ),
      ),
    );
    const text = JSON.stringify(results);
    const hash = [...ctx.accounts.accounts.values()][0]?.passwordHash ?? '';
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(hash);
    expect(text).not.toContain('argon2id');
  });
});
