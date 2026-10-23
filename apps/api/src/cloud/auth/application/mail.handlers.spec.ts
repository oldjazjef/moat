import { describe, expect, it } from 'vitest';
import { PLANTED_SECRETS } from '../../../testing/planted-secrets';
import { AuditTrail } from '../../audit/application/audit-trail';
import {
  AddMemberHandler,
  CreateOrganisationHandler,
} from '../../tenancy/application/tenancy.handlers';
import {
  AddMemberCommand,
  CreateOrganisationCommand,
} from '../../tenancy/application/tenancy.commands';
import { INVITATION_TTL_MS } from '../../tenancy/application/invitation-redeemer';
import {
  FixedClock,
  InMemoryAccounts,
  InMemoryAudit,
  InMemoryOrganisations,
  InMemoryRateLimit,
  InMemorySessions,
} from '../../testing/in-memory';
import { mailKit, tokenIn } from '../../testing/mail-kit';
import { passkeyKit } from '../../testing/passkey-kit';
import { LoginGate } from './login-gate';
import { SessionIssuer } from './session-issuer';
import {
  ChangePasswordCommand,
  ForgotPasswordCommand,
  LoginCommand,
  RegisterCommand,
  ResendVerificationCommand,
  ResetPasswordCommand,
  VerifyEmailCommand,
} from './auth.commands';
import {
  ChangePasswordHandler,
  LoginHandler,
  RegisterHandler,
} from './auth.handlers';
import {
  ForgotPasswordHandler,
  ResendVerificationHandler,
  ResetPasswordHandler,
  VerifyEmailHandler,
} from './mail.handlers';
import { PasswordHasher } from './password-hasher';
import { RateLimiter } from './rate-limiter';
import { SecondFactor } from './second-factor';
import { TotpVault } from './totp-vault';
import { RESET_TTL_MS, VERIFY_TTL_MS } from './account-mails';

const PASSWORD = PLANTED_SECRETS[2];
const NEW_PASSWORD = 'a completely different passphrase';
const IP = '1.1.1.1';

async function setup(mailEnabled: boolean) {
  const accounts = new InMemoryAccounts();
  const sessions = new InMemorySessions();
  const rate = new InMemoryRateLimit();
  const clock = new FixedClock();
  const organisations = new InMemoryOrganisations(accounts);
  const auditLog = new InMemoryAudit();
  const audit = new AuditTrail(auditLog, clock);
  const kit = mailKit(mailEnabled, accounts, organisations, clock, audit, rate);
  const hasher = new PasswordHasher('fast');
  const limiter = new RateLimiter(rate, clock);
  const vault = await TotpVault.create('A'.repeat(43));
  const issuer = new SessionIssuer(sessions, clock);
  const pk = passkeyKit(clock);
  return {
    ...kit,
    sessions,
    clock,
    organisations,
    auditLog,
    audit,
    register: new RegisterHandler(
      accounts,
      hasher,
      limiter,
      clock,
      kit.mails,
      kit.redeemer,
    ),
    login: new LoginHandler(
      accounts,
      sessions,
      hasher,
      new SecondFactor(accounts, vault, clock),
      issuer,
      clock,
      pk.passkeys,
      pk.service,
      new LoginGate(accounts, hasher, limiter, kit.mails),
    ),
    change: new ChangePasswordHandler(
      accounts,
      sessions,
      hasher,
      limiter,
      issuer,
      clock,
      kit.tokens,
    ),
    verify: new VerifyEmailHandler(
      accounts,
      kit.tokens,
      limiter,
      kit.redeemer,
      clock,
    ),
    resend: new ResendVerificationHandler(accounts, limiter, kit.mails),
    forgot: new ForgotPasswordHandler(accounts, limiter, kit.mails),
    reset: new ResetPasswordHandler(
      accounts,
      sessions,
      kit.tokens,
      hasher,
      limiter,
      kit.redeemer,
      clock,
    ),
    addMember: new AddMemberHandler(
      organisations,
      clock,
      audit,
      kit.invitations,
      kit.outbox,
      limiter,
      kit.links,
    ),
    createOrg: new CreateOrganisationHandler(organisations, clock, audit),
  };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

async function signUp(ctx: Ctx, email = 'eme@example.ch') {
  const result = await ctx.register.execute(
    new RegisterCommand(email, PASSWORD, IP),
  );
  await ctx.outbox.drain();
  return result;
}
const idOf = async (ctx: Ctx, email: string) =>
  (await ctx.accounts.findByEmail(email))?.id ?? '';
const login = (
  ctx: Ctx,
  email = 'eme@example.ch',
  password: string = PASSWORD,
) => ctx.login.execute(new LoginCommand(email, password, undefined, IP, null));

describe('e-mail verification (T-96)', () => {
  it('registers unverified, mails a link, and the link verifies once', async () => {
    const ctx = await setup(true);
    expect(await signUp(ctx)).toEqual({ status: 'accepted' });
    expect(
      (await ctx.accounts.findByEmail('eme@example.ch'))?.emailVerifiedAt,
    ).toBeNull();
    expect(ctx.mailer.sent).toHaveLength(1);
    expect(ctx.mailer.sent[0]?.to).toBe('eme@example.ch');
    const token = tokenIn(ctx.mailer.sent[0]);

    expect(await ctx.verify.execute(new VerifyEmailCommand(token, IP))).toEqual(
      {
        status: 'ok',
      },
    );
    expect(
      (await ctx.accounts.findByEmail('eme@example.ch'))?.emailVerifiedAt,
    ).not.toBeNull();
    // Used up: the same link is now just "invalid".
    expect(await ctx.verify.execute(new VerifyEmailCommand(token, IP))).toEqual(
      {
        status: 'refused',
        code: 'invalid_token',
      },
    );
  });

  it('stores only the SHA-256 of the token, never the token', async () => {
    const ctx = await setup(true);
    await signUp(ctx);
    const token = tokenIn(ctx.mailer.sent[0]);
    expect(ctx.tokens.tokens).toHaveLength(1);
    expect(ctx.tokens.tokens[0]?.id).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(ctx.tokens.tokens)).not.toContain(token);
  });

  it('puts the token in the fragment, so it reaches no log and no Referer', async () => {
    const ctx = await setup(true);
    await signUp(ctx);
    const text = ctx.mailer.sent[0]?.text ?? '';
    expect(text).toContain('https://moat.example.org/verify-email#token=');
    expect(text).not.toMatch(/\?token=/);
  });

  it('refuses an expired, a malformed and a wrong-purpose token alike', async () => {
    const ctx = await setup(true);
    await signUp(ctx);
    const token = tokenIn(ctx.mailer.sent[0]);
    ctx.clock.advance(VERIFY_TTL_MS + 1000);
    expect(await ctx.verify.execute(new VerifyEmailCommand(token, IP))).toEqual(
      {
        status: 'refused',
        code: 'invalid_token',
      },
    );
    expect(
      await ctx.verify.execute(new VerifyEmailCommand('short', IP)),
    ).toEqual({
      status: 'refused',
      code: 'invalid_token',
    });
    // A reset token does not verify an address, and the other way round.
    await ctx.forgot.execute(new ForgotPasswordCommand('eme@example.ch', IP));
    await ctx.outbox.drain();
    const reset = tokenIn(ctx.mailer.sent.at(-1));
    expect(await ctx.verify.execute(new VerifyEmailCommand(reset, IP))).toEqual(
      {
        status: 'refused',
        code: 'invalid_token',
      },
    );
  });

  it('keeps an unverified account from signing in, after the password is right', async () => {
    const ctx = await setup(true);
    await signUp(ctx);
    expect(await login(ctx)).toEqual({
      status: 'refused',
      code: 'email_not_verified',
    });
    // A wrong password still says only "invalid credentials": nothing about the address.
    expect(
      await login(ctx, 'eme@example.ch', 'wrong password entirely'),
    ).toEqual({
      status: 'refused',
      code: 'invalid_credentials',
    });
    expect(await login(ctx, 'nobody@example.ch')).toEqual({
      status: 'refused',
      code: 'invalid_credentials',
    });
    await ctx.verify.execute(
      new VerifyEmailCommand(tokenIn(ctx.mailer.sent[0]), IP),
    );
    expect((await login(ctx)).status).toBe('ok');
  });

  it('answers a second registration the same and tells the owner of the address', async () => {
    const ctx = await setup(true);
    await signUp(ctx);
    const again = await signUp(ctx);
    expect(again).toEqual({ status: 'accepted' });
    expect(ctx.mailer.sent).toHaveLength(2);
    expect(ctx.mailer.sent[1]?.subject).toContain('schon ein Konto');
    expect(ctx.mailer.sent[1]?.text).not.toMatch(/#token=/);
    expect(ctx.accounts.accounts.size).toBe(1);
  });

  it('resends only for an unverified account, and answers every address the same', async () => {
    const ctx = await setup(true);
    await signUp(ctx);
    const before = ctx.mailer.sent.length;
    for (const email of [
      'eme@example.ch',
      'nobody@example.ch',
      'not an address',
    ])
      expect(
        await ctx.resend.execute(new ResendVerificationCommand(email, IP)),
      ).toEqual({
        status: 'accepted',
      });
    await ctx.outbox.drain();
    expect(ctx.mailer.sent.length).toBe(before + 1);
    // The newer link ends the older one.
    const older = tokenIn(ctx.mailer.sent[0]);
    const newer = tokenIn(ctx.mailer.sent.at(-1));
    expect(
      (await ctx.verify.execute(new VerifyEmailCommand(older, IP))).status,
    ).toBe('refused');
    expect(
      (await ctx.verify.execute(new VerifyEmailCommand(newer, IP))).status,
    ).toBe('ok');
    // Verified now: no further mail.
    await ctx.resend.execute(
      new ResendVerificationCommand('eme@example.ch', IP),
    );
    await ctx.outbox.drain();
    expect(ctx.mailer.sent.length).toBe(before + 1);
  });

  it('sends at most three mails per mailbox an hour, and says nothing about it', async () => {
    const ctx = await setup(true);
    await signUp(ctx);
    for (let i = 0; i < 6; i++)
      expect(
        (
          await ctx.resend.execute(
            new ResendVerificationCommand('eme@example.ch', IP),
          )
        ).status,
      ).toBe('accepted');
    await ctx.outbox.drain();
    expect(ctx.mailer.sent).toHaveLength(3);
    ctx.clock.advance(61 * 60 * 1000);
    await ctx.resend.execute(
      new ResendVerificationCommand('eme@example.ch', IP),
    );
    await ctx.outbox.drain();
    expect(ctx.mailer.sent).toHaveLength(4);
  });

  it('limits redeeming per address of the internet', async () => {
    const ctx = await setup(true);
    let last = '';
    for (let i = 0; i < 31; i++)
      last = (
        await ctx.verify.execute(new VerifyEmailCommand('A'.repeat(43), IP))
      ).status;
    expect(last).toBe('refused');
    const over = await ctx.verify.execute(
      new VerifyEmailCommand('A'.repeat(43), IP),
    );
    expect(over).toMatchObject({ code: 'rate_limited' });
  });

  it('does not fail a request when the mail server is down', async () => {
    const ctx = await setup(true);
    ctx.mailer.failing = true;
    expect(await signUp(ctx)).toEqual({ status: 'accepted' });
    expect(ctx.mailer.sent).toHaveLength(0);
  });

  it('without a mail server accounts count as verified and nothing is sent', async () => {
    const ctx = await setup(false);
    await signUp(ctx);
    expect((await login(ctx)).status).toBe('ok');
    await ctx.forgot.execute(new ForgotPasswordCommand('eme@example.ch', IP));
    await ctx.resend.execute(
      new ResendVerificationCommand('eme@example.ch', IP),
    );
    await ctx.outbox.drain();
    expect(ctx.mailer.sent).toHaveLength(0);
  });
});

describe('password reset (T-96)', () => {
  async function verifiedAccount(ctx: Ctx) {
    await signUp(ctx);
    await ctx.verify.execute(
      new VerifyEmailCommand(tokenIn(ctx.mailer.sent[0]), IP),
    );
  }
  const reset = async (ctx: Ctx) => {
    await ctx.forgot.execute(new ForgotPasswordCommand('eme@example.ch', IP));
    await ctx.outbox.drain();
    return tokenIn(ctx.mailer.sent.at(-1));
  };

  it('mails a link for a known address and nothing for an unknown one, with one answer', async () => {
    const ctx = await setup(true);
    await verifiedAccount(ctx);
    const before = ctx.mailer.sent.length;
    const known = await ctx.forgot.execute(
      new ForgotPasswordCommand('eme@example.ch', IP),
    );
    const unknown = await ctx.forgot.execute(
      new ForgotPasswordCommand('nobody@example.ch', IP),
    );
    const junk = await ctx.forgot.execute(new ForgotPasswordCommand('???', IP));
    await ctx.outbox.drain();
    expect([known, unknown, junk]).toEqual([
      { status: 'accepted' },
      { status: 'accepted' },
      { status: 'accepted' },
    ]);
    expect(ctx.mailer.sent.length).toBe(before + 1);
  });

  it('sets the password once, ends every session and signs nobody in', async () => {
    const ctx = await setup(true);
    await verifiedAccount(ctx);
    const first = await login(ctx);
    if (first.status !== 'ok') throw new Error('login');
    const token = await reset(ctx);

    expect(
      await ctx.reset.execute(
        new ResetPasswordCommand(token, NEW_PASSWORD, IP),
      ),
    ).toEqual({
      status: 'ok',
    });
    expect(
      [...ctx.sessions.sessions.values()].every((s) => s.revokedAt !== null),
    ).toBe(true);
    expect((await login(ctx)).status).toBe('refused');
    expect((await login(ctx, 'eme@example.ch', NEW_PASSWORD)).status).toBe(
      'ok',
    );
    // One use.
    expect(
      await ctx.reset.execute(
        new ResetPasswordCommand(token, 'yet another passphrase!', IP),
      ),
    ).toEqual({
      status: 'refused',
      code: 'invalid_token',
    });
  });

  it('does not use the token up on a password that is refused', async () => {
    const ctx = await setup(true);
    await verifiedAccount(ctx);
    const token = await reset(ctx);
    expect(
      await ctx.reset.execute(new ResetPasswordCommand(token, 'short', IP)),
    ).toEqual({
      status: 'refused',
      code: 'password_too_short',
    });
    expect(
      (
        await ctx.reset.execute(
          new ResetPasswordCommand(token, NEW_PASSWORD, IP),
        )
      ).status,
    ).toBe('ok');
  });

  it('expires after an hour', async () => {
    const ctx = await setup(true);
    await verifiedAccount(ctx);
    const token = await reset(ctx);
    ctx.clock.advance(RESET_TTL_MS + 1000);
    expect(
      (
        await ctx.reset.execute(
          new ResetPasswordCommand(token, NEW_PASSWORD, IP),
        )
      ).status,
    ).toBe('refused');
  });

  it('is ended by a password change, and a newer link ends the older', async () => {
    const ctx = await setup(true);
    await verifiedAccount(ctx);
    const old = await reset(ctx);
    const newer = await reset(ctx);
    expect(
      (await ctx.reset.execute(new ResetPasswordCommand(old, NEW_PASSWORD, IP)))
        .status,
    ).toBe('refused');
    const account = await ctx.accounts.findByEmail('eme@example.ch');
    await ctx.change.execute(
      new ChangePasswordCommand(
        account?.id ?? '',
        PASSWORD,
        'the changed passphrase 1',
      ),
    );
    expect(
      (
        await ctx.reset.execute(
          new ResetPasswordCommand(newer, NEW_PASSWORD, IP),
        )
      ).status,
    ).toBe('refused');
  });

  it('proves the mailbox, so it also verifies the address', async () => {
    const ctx = await setup(true);
    await signUp(ctx);
    const token = await reset(ctx);
    await ctx.reset.execute(new ResetPasswordCommand(token, NEW_PASSWORD, IP));
    expect((await login(ctx, 'eme@example.ch', NEW_PASSWORD)).status).toBe(
      'ok',
    );
  });
});

describe('invitations to addresses without a verified account (T-96, T-98)', () => {
  async function organisation(ctx: Ctx) {
    await signUp(ctx, 'owner@example.ch');
    await ctx.verify.execute(
      new VerifyEmailCommand(tokenIn(ctx.mailer.sent[0]), IP),
    );
    const ownerId = await idOf(ctx, 'owner@example.ch');
    const made = await ctx.createOrg.execute(
      new CreateOrganisationCommand(ownerId, 'Acme AG'),
    );
    if (made.status !== 'ok') throw new Error('org');
    ctx.mailer.sent.length = 0;
    return { ownerId, org: made.organisation.id };
  }

  it('keeps an invitation for an unknown address, mails it, and applies it on verification', async () => {
    const ctx = await setup(true);
    const { ownerId, org } = await organisation(ctx);
    expect(
      await ctx.addMember.execute(
        new AddMemberCommand(ownerId, org, 'new@example.ch', 'editor'),
      ),
    ).toEqual({ status: 'ok' });
    await ctx.outbox.drain();
    expect(ctx.mailer.sent).toHaveLength(1);
    // Nothing a person typed is in the mail: not the organisation, not the inviting address.
    expect(ctx.mailer.sent[0]?.text).not.toContain('Acme');
    expect(ctx.mailer.sent[0]?.text).not.toContain('owner@example.ch');

    await signUp(ctx, 'new@example.ch');
    const newId = await idOf(ctx, 'new@example.ch');
    // Registering alone is no proof of the address: no membership yet.
    expect(await ctx.organisations.membership(org, newId)).toBeNull();
    await ctx.verify.execute(
      new VerifyEmailCommand(tokenIn(ctx.mailer.sent.at(-1)), IP),
    );
    expect(await ctx.organisations.membership(org, newId)).toMatchObject({
      role: 'editor',
      releaseGranted: false,
    });
    expect(ctx.auditLog.rows.some((r) => r.action === 'member.join')).toBe(
      true,
    );
    // Taken once.
    expect(ctx.invitations.rows).toHaveLength(0);
  });

  it('does not add an account whose address was never confirmed', async () => {
    const ctx = await setup(true);
    const { ownerId, org } = await organisation(ctx);
    await signUp(ctx, 'squatter@example.ch');
    const squatter = await idOf(ctx, 'squatter@example.ch');
    await ctx.addMember.execute(
      new AddMemberCommand(ownerId, org, 'squatter@example.ch', 'admin'),
    );
    expect(await ctx.organisations.membership(org, squatter)).toBeNull();
    expect(ctx.invitations.rows).toHaveLength(1);
  });

  it('adds a verified account at once, as before', async () => {
    const ctx = await setup(true);
    const { ownerId, org } = await organisation(ctx);
    await signUp(ctx, 'known@example.ch');
    await ctx.verify.execute(
      new VerifyEmailCommand(tokenIn(ctx.mailer.sent.at(-1)), IP),
    );
    await ctx.addMember.execute(
      new AddMemberCommand(ownerId, org, 'known@example.ch', 'viewer'),
    );
    expect(
      await ctx.organisations.membership(
        org,
        await idOf(ctx, 'known@example.ch'),
      ),
    ).toMatchObject({
      role: 'viewer',
    });
    expect(ctx.invitations.rows).toHaveLength(0);
  });

  it('lets an invitation lapse after fourteen days', async () => {
    const ctx = await setup(true);
    const { ownerId, org } = await organisation(ctx);
    await ctx.addMember.execute(
      new AddMemberCommand(ownerId, org, 'late@example.ch', 'viewer'),
    );
    ctx.clock.advance(INVITATION_TTL_MS + 1000);
    await signUp(ctx, 'late@example.ch');
    await ctx.verify.execute(
      new VerifyEmailCommand(tokenIn(ctx.mailer.sent.at(-1)), IP),
    );
    expect(
      await ctx.organisations.membership(
        org,
        await idOf(ctx, 'late@example.ch'),
      ),
    ).toBeNull();
  });

  it('mails an address at most three times a day, however many invite it', async () => {
    const ctx = await setup(true);
    const { ownerId, org } = await organisation(ctx);
    for (let i = 0; i < 5; i++)
      await ctx.addMember.execute(
        new AddMemberCommand(ownerId, org, 'victim@example.ch', 'viewer'),
      );
    await ctx.outbox.drain();
    expect(ctx.mailer.sent).toHaveLength(3);
    // Still one waiting invitation: replacing, not piling up.
    expect(ctx.invitations.rows).toHaveLength(1);
  });

  it('without a mail server an invitation is applied when the person registers', async () => {
    const ctx = await setup(false);
    await signUp(ctx, 'owner@example.ch');
    const ownerId = await idOf(ctx, 'owner@example.ch');
    const made = await ctx.createOrg.execute(
      new CreateOrganisationCommand(ownerId, 'Acme AG'),
    );
    if (made.status !== 'ok') throw new Error('org');
    await ctx.addMember.execute(
      new AddMemberCommand(
        ownerId,
        made.organisation.id,
        'new@example.ch',
        'billing',
      ),
    );
    await signUp(ctx, 'new@example.ch');
    expect(
      await ctx.organisations.membership(
        made.organisation.id,
        await idOf(ctx, 'new@example.ch'),
      ),
    ).toMatchObject({ role: 'billing' });
    expect(ctx.mailer.sent).toHaveLength(0);
  });
});
