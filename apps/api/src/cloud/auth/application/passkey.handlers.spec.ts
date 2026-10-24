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
import { mailKit } from '../../testing/mail-kit';
import { PASSKEY_ORIGIN, passkeyKit } from '../../testing/passkey-kit';
import { SoftwarePasskey, b64 } from '../../testing/software-passkey';
import { relyingPartyOf } from '../domain/passkey';
import { sessionIdOf } from '../domain/session';
import {
  BeginPasskeyCommand,
  ConfirmTotpCommand,
  EnrolTotpCommand,
  FinishPasskeyCommand,
  ListPasskeysQuery,
  LoginCommand,
  PasskeyLoginChallengeCommand,
  RegisterCommand,
  RemovePasskeyCommand,
} from './auth.commands';
import {
  ConfirmTotpHandler,
  EnrolTotpHandler,
  GetMeHandler,
  LoginHandler,
  RegisterHandler,
} from './auth.handlers';
import { LoginGate } from './login-gate';
import {
  BeginPasskeyHandler,
  FinishPasskeyHandler,
  ListPasskeysHandler,
  PasskeyLoginChallengeHandler,
  RemovePasskeyHandler,
} from './passkey.handlers';
import { PasswordHasher } from './password-hasher';
import { RateLimiter } from './rate-limiter';
import { SecondFactor } from './second-factor';
import { SessionIssuer } from './session-issuer';
import { TotpVault } from './totp-vault';
import { hotp } from '../domain/totp';

const PASSWORD = PLANTED_SECRETS[2];
const EMAIL = 'eme@example.ch';
const IP = '1.1.1.1';
const RP = relyingPartyOf(PASSKEY_ORIGIN);
const fromB64 = (text: string) =>
  new Uint8Array(Buffer.from(text, 'base64url'));

let vault: TotpVault;
beforeAll(async () => {
  vault = await TotpVault.create('A'.repeat(43));
});

function setup(origin = PASSKEY_ORIGIN) {
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
  const kit = mailKit(false, accounts, organisations, clock, audit, rate);
  const pk = passkeyKit(clock, origin);
  const gate = new LoginGate(accounts, hasher, limiter, kit.mails);
  return {
    accounts,
    sessions,
    clock,
    pk,
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
      factor,
      issuer,
      clock,
      pk.passkeys,
      pk.service,
      gate,
      pk.oidc,
    ),
    challenge: new PasskeyLoginChallengeHandler(gate, pk.passkeys, pk.service),
    begin: new BeginPasskeyHandler(
      accounts,
      hasher,
      limiter,
      pk.passkeys,
      pk.service,
    ),
    finish: new FinishPasskeyHandler(pk.passkeys, pk.service, limiter, clock),
    list: new ListPasskeysHandler(pk.passkeys),
    remove: new RemovePasskeyHandler(
      accounts,
      hasher,
      limiter,
      pk.passkeys,
      sessions,
      clock,
    ),
    me: new GetMeHandler(accounts, pk.passkeys, pk.oidc),
    enrol: new EnrolTotpHandler(accounts, hasher, vault, limiter, clock),
    confirm: new ConfirmTotpHandler(accounts, factor, limiter, clock),
    issuer,
  };
}
type Ctx = ReturnType<typeof setup>;

async function account(ctx: Ctx, email = EMAIL): Promise<string> {
  await ctx.register.execute(new RegisterCommand(email, PASSWORD, IP));
  const found = await ctx.accounts.findByEmail(email);
  if (found === null) throw new Error('account');
  return found.id;
}

/** Registers a passkey the way a browser would; returns the device that holds it. */
async function enrolPasskey(
  ctx: Ctx,
  accountId: string,
  name = 'Laptop',
  device = new SoftwarePasskey({ rpId: RP.rpId, origin: RP.origin }),
) {
  const begun = await ctx.begin.execute(
    new BeginPasskeyCommand(accountId, PASSWORD),
  );
  if (begun.status !== 'ok') throw new Error(JSON.stringify(begun));
  const made = device.create(fromB64(begun.challenge));
  const done = await ctx.finish.execute(
    new FinishPasskeyCommand(
      accountId,
      name,
      made.attestationObject,
      made.clientDataJSON,
    ),
  );
  if (done.status !== 'ok') throw new Error(JSON.stringify(done));
  return { device, passkey: done.passkey };
}

/** The assertion a browser would send for the challenge of a sign-in. */
async function assertion(
  ctx: Ctx,
  device: SoftwarePasskey,
  patch: Parameters<SoftwarePasskey['get']>[1] = {},
  email = EMAIL,
) {
  const asked = await ctx.challenge.execute(
    new PasskeyLoginChallengeCommand(email, PASSWORD, IP),
  );
  if (asked.status !== 'ok') throw new Error(JSON.stringify(asked));
  return { asked, assertion: device.get(fromB64(asked.challenge), patch) };
}

const signIn = (
  ctx: Ctx,
  passkey?: Awaited<ReturnType<typeof assertion>>['assertion'],
  email = EMAIL,
  code?: string,
) =>
  ctx.login.execute(new LoginCommand(email, PASSWORD, code, IP, null, passkey));

describe('registering a passkey (SEC-51, T-101)', () => {
  it('needs the password, makes a challenge for this account only and stores the public key', async () => {
    const ctx = setup();
    const id = await account(ctx);
    expect(
      await ctx.begin.execute(
        new BeginPasskeyCommand(id, 'not the password!!'),
      ),
    ).toEqual({ status: 'refused', code: 'invalid_credentials' });

    const begun = await ctx.begin.execute(
      new BeginPasskeyCommand(id, PASSWORD),
    );
    if (begun.status !== 'ok') throw new Error('begin');
    expect(begun.rp).toEqual({ id: 'moat.example.ch', name: 'Moat' });
    expect(begun.user.name).toBe(EMAIL);
    expect(begun.user.id).not.toContain('@');
    expect(fromB64(begun.challenge)).toHaveLength(32);

    const { device, passkey } = await enrolPasskey(ctx, id, '  Laptop  ');
    expect(passkey).toMatchObject({ name: 'Laptop', lastUsedAt: null });
    const stored = await ctx.pk.passkeys.list(id);
    expect(stored[0]?.credentialId).toBe(b64(device.credentialId));
    // Only public data: the key is a 65-byte point, there is nothing to open.
    expect(fromB64(stored[0]?.publicKey ?? '')).toHaveLength(65);
    expect(
      (await ctx.list.execute(new ListPasskeysQuery(id))).map((p) => p.name),
    ).toEqual(['Laptop']);
    expect(await ctx.me.execute({ accountId: id } as never)).toMatchObject({
      passkeyCount: 1,
    });
  });

  it('uses a challenge once, for the right account, before it expires', async () => {
    const ctx = setup();
    const id = await account(ctx);
    const other = await account(ctx, 'other@example.ch');
    const device = new SoftwarePasskey({ rpId: RP.rpId, origin: RP.origin });
    const begin = async (who: string) => {
      const b = await ctx.begin.execute(new BeginPasskeyCommand(who, PASSWORD));
      if (b.status !== 'ok') throw new Error('begin');
      return fromB64(b.challenge);
    };
    const finish = (who: string, challenge: Uint8Array) => {
      const made = device.create(challenge);
      return ctx.finish.execute(
        new FinishPasskeyCommand(
          who,
          'x',
          made.attestationObject,
          made.clientDataJSON,
        ),
      );
    };
    const mine = await begin(id);
    // Someone else's challenge does not work for another account.
    expect(await finish(other, mine)).toEqual({
      status: 'refused',
      code: 'challenge_invalid',
    });
    // A challenge the server never made.
    expect(await finish(id, new Uint8Array(32))).toEqual({
      status: 'refused',
      code: 'challenge_invalid',
    });
    expect((await finish(id, mine)).status).toBe('ok');
    // Used up.
    expect(await finish(id, mine)).toEqual({
      status: 'refused',
      code: 'challenge_invalid',
    });
    // Expired.
    const late = await begin(id);
    ctx.clock.advance(3 * 60 * 1000);
    expect(await finish(id, late)).toEqual({
      status: 'refused',
      code: 'challenge_invalid',
    });
  });

  it('refuses a ceremony for another relying party, another type, or without user verification', async () => {
    const ctx = setup();
    const id = await account(ctx);
    const device = new SoftwarePasskey({ rpId: RP.rpId, origin: RP.origin });
    const cases: [string, Parameters<SoftwarePasskey['create']>[1]][] = [
      ['rp', { rpId: 'evil.example' }],
      ['type', { clientType: 'webauthn.get' }],
      ['uv', { flags: 0x41 }],
    ];
    for (const [label, patch] of cases) {
      const b = await ctx.begin.execute(new BeginPasskeyCommand(id, PASSWORD));
      if (b.status !== 'ok') throw new Error('begin');
      const made = device.create(fromB64(b.challenge), patch);
      expect(
        await ctx.finish.execute(
          new FinishPasskeyCommand(
            id,
            'x',
            made.attestationObject,
            made.clientDataJSON,
          ),
        ),
        label,
      ).toEqual({ status: 'refused', code: 'passkey_invalid' });
    }
    expect(await ctx.pk.passkeys.list(id)).toHaveLength(0);
  });

  it('refuses a name that is empty, long or has control characters, and an unavailable installation', async () => {
    const ctx = setup();
    const id = await account(ctx);
    for (const name of ['  ', 'x'.repeat(61), 'a\nb']) {
      const b = await ctx.begin.execute(new BeginPasskeyCommand(id, PASSWORD));
      if (b.status !== 'ok') throw new Error('begin');
      const made = new SoftwarePasskey({
        rpId: RP.rpId,
        origin: RP.origin,
      }).create(fromB64(b.challenge));
      expect(
        await ctx.finish.execute(
          new FinishPasskeyCommand(
            id,
            name,
            made.attestationObject,
            made.clientDataJSON,
          ),
        ),
      ).toEqual({ status: 'refused', code: 'name_invalid' });
    }
    // http on a real host and an IP address are no places for passkeys.
    for (const origin of [
      'http://moat.example.ch',
      'https://10.0.0.5',
      'nonsense',
    ]) {
      const plain = setup(origin);
      const who = await account(plain);
      expect(
        await plain.begin.execute(new BeginPasskeyCommand(who, PASSWORD)),
      ).toEqual({ status: 'refused', code: 'passkey_unavailable' });
    }
    // http://localhost is allowed (development).
    const dev = setup('http://localhost:4200');
    const who = await account(dev);
    expect(
      (await dev.begin.execute(new BeginPasskeyCommand(who, PASSWORD))).status,
    ).toBe('ok');
  });

  it('takes at most ten passkeys and each credential once', async () => {
    const ctx = setup();
    const id = await account(ctx);
    const first = await enrolPasskey(ctx, id);
    const b = await ctx.begin.execute(new BeginPasskeyCommand(id, PASSWORD));
    if (b.status !== 'ok') throw new Error('begin');
    expect(b.excludeCredentials).toEqual([b64(first.device.credentialId)]);
    const again = first.device.create(fromB64(b.challenge));
    expect(
      await ctx.finish.execute(
        new FinishPasskeyCommand(
          id,
          'dup',
          again.attestationObject,
          again.clientDataJSON,
        ),
      ),
    ).toEqual({ status: 'refused', code: 'passkey_exists' });
    for (let i = 1; i < 10; i += 1) await enrolPasskey(ctx, id, `key ${i}`);
    expect(
      await ctx.begin.execute(new BeginPasskeyCommand(id, PASSWORD)),
    ).toEqual({ status: 'refused', code: 'passkey_limit' });
  });
});

describe('signing in with a passkey as the second factor (SEC-51, T-101)', () => {
  it('says nothing about passkeys until the password is right, then asks for a factor', async () => {
    const ctx = setup();
    const id = await account(ctx);
    await enrolPasskey(ctx, id);
    const wrong = await ctx.challenge.execute(
      new PasskeyLoginChallengeCommand(EMAIL, 'not the password!!', IP),
    );
    const unknown = await ctx.challenge.execute(
      new PasskeyLoginChallengeCommand('ghost@example.ch', PASSWORD, IP),
    );
    expect(wrong).toEqual({ status: 'refused', code: 'invalid_credentials' });
    expect(unknown).toEqual(wrong);
    expect(await signIn(ctx)).toEqual({
      status: 'refused',
      code: 'mfa_required',
      methods: ['passkey'],
    });
    // An account without a passkey is told so only after its password was right.
    await account(ctx, 'plain@example.ch');
    expect(
      await ctx.challenge.execute(
        new PasskeyLoginChallengeCommand('plain@example.ch', PASSWORD, IP),
      ),
    ).toEqual({ status: 'refused', code: 'no_passkey' });
  });

  it('signs in with a good assertion and starts a session', async () => {
    const ctx = setup();
    const id = await account(ctx);
    const { device } = await enrolPasskey(ctx, id);
    const { asked, assertion: a } = await assertion(ctx, device);
    expect(asked.credentialIds).toEqual([b64(device.credentialId)]);
    expect(asked.rpId).toBe('moat.example.ch');
    const result = await signIn(ctx, a);
    if (result.status !== 'ok') throw new Error(JSON.stringify(result));
    expect(result.account).toMatchObject({
      passkeyCount: 1,
      totpEnabled: false,
    });
    expect((await ctx.pk.passkeys.list(id))[0]?.lastUsedAt).not.toBeNull();
  });

  it('refuses a replayed assertion: the challenge is used up', async () => {
    const ctx = setup();
    const id = await account(ctx);
    const { device } = await enrolPasskey(ctx, id);
    const { assertion: a } = await assertion(ctx, device);
    expect((await signIn(ctx, a)).status).toBe('ok');
    expect(await signIn(ctx, a)).toEqual({
      status: 'refused',
      code: 'invalid_code',
    });
  });

  it('refuses every broken assertion with the same plain answer', async () => {
    const ctx = setup();
    const id = await account(ctx);
    const { device } = await enrolPasskey(ctx, id);
    const stranger = new SoftwarePasskey({ rpId: RP.rpId, origin: RP.origin });
    const patches: Parameters<SoftwarePasskey['get']>[1][] = [
      { forged: true },
      { origin: 'https://evil.example' },
      { rpId: 'evil.example' },
      { clientType: 'webauthn.create' },
      { flags: 0x01 },
    ];
    for (const patch of patches) {
      const { assertion: a } = await assertion(ctx, device, patch);
      expect(await signIn(ctx, a), JSON.stringify(patch)).toEqual({
        status: 'refused',
        code: 'invalid_code',
      });
    }
    // A credential the account does not have, a made-up challenge, and parts that are not base64url.
    const asked = await ctx.challenge.execute(
      new PasskeyLoginChallengeCommand(EMAIL, PASSWORD, IP),
    );
    if (asked.status !== 'ok') throw new Error('challenge');
    const foreign = stranger.get(fromB64(asked.challenge));
    expect(await signIn(ctx, foreign)).toMatchObject({ code: 'invalid_code' });
    const made = device.get(new Uint8Array(32));
    expect(await signIn(ctx, made)).toMatchObject({ code: 'invalid_code' });
    expect(await signIn(ctx, { ...made, signature: '***' })).toMatchObject({
      code: 'invalid_code',
    });
  });

  it("does not take another account's passkey, and counts failures towards the lock", async () => {
    const ctx = setup();
    const mine = await account(ctx);
    const other = await account(ctx, 'other@example.ch');
    const theirs = await enrolPasskey(ctx, other);
    await enrolPasskey(ctx, mine);
    const { assertion: a } = await assertion(ctx, theirs.device);
    expect(await signIn(ctx, a)).toMatchObject({ code: 'invalid_code' });
    for (let i = 0; i < 12; i += 1) {
      const result = await signIn(ctx, a);
      if (result.status === 'refused' && result.code === 'rate_limited') return;
    }
    throw new Error('never limited');
  });

  it('wants the counter to rise, but accepts an authenticator that keeps none', async () => {
    const ctx = setup();
    const id = await account(ctx);
    const { device } = await enrolPasskey(ctx, id);
    const use = async (signCount: number) =>
      signIn(ctx, (await assertion(ctx, device, { signCount })).assertion);
    expect((await use(5)).status).toBe('ok');
    // A counter that did not rise: a clone, or a replay.
    expect(await use(5)).toMatchObject({ code: 'invalid_code' });
    expect(await use(3)).toMatchObject({ code: 'invalid_code' });
    expect((await use(6)).status).toBe('ok');

    const plain = setup();
    const who = await account(plain);
    const zero = await enrolPasskey(plain, who);
    const again = async () =>
      signIn(
        plain,
        (await assertion(plain, zero.device, { signCount: 0 })).assertion,
      );
    expect((await again()).status).toBe('ok');
    expect((await again()).status).toBe('ok');
  });

  it('lets a challenge expire', async () => {
    const ctx = setup();
    const id = await account(ctx);
    const { device } = await enrolPasskey(ctx, id);
    const { assertion: a } = await assertion(ctx, device);
    ctx.clock.advance(3 * 60 * 1000);
    expect(await signIn(ctx, a)).toMatchObject({ code: 'invalid_code' });
  });

  it('keeps TOTP working next to a passkey and names both methods', async () => {
    const ctx = setup();
    const id = await account(ctx);
    const { device } = await enrolPasskey(ctx, id);
    const enrolled = await ctx.enrol.execute(
      new EnrolTotpCommand(id, PASSWORD),
    );
    if (enrolled.status !== 'ok') throw new Error('enrol');
    const secret = await vault.open(
      (await ctx.accounts.totp(id))?.sealedSecret ?? '',
      id,
    );
    if (secret === null) throw new Error('secret');
    const code = (step: number) =>
      hotp(secret, step).toString().padStart(6, '0');
    const step = Math.floor(ctx.clock.now().getTime() / 30_000);
    expect(
      (await ctx.confirm.execute(new ConfirmTotpCommand(id, code(step))))
        .status,
    ).toBe('ok');
    expect(await signIn(ctx)).toEqual({
      status: 'refused',
      code: 'mfa_required',
      methods: ['totp', 'passkey'],
    });
    const { assertion: a } = await assertion(ctx, device);
    expect((await signIn(ctx, a)).status).toBe('ok');
    // A wrong passkey assertion is not rescued by a right code in the same request.
    const { assertion: b } = await assertion(ctx, device, { forged: true });
    expect(await signIn(ctx, b, EMAIL, code(step + 1))).toMatchObject({
      code: 'invalid_code',
    });
  });

  it('fails closed when this installation can no longer check passkeys', async () => {
    const ctx = setup();
    const id = await account(ctx);
    const { device } = await enrolPasskey(ctx, id);
    const { assertion: a } = await assertion(ctx, device);
    // The same database, now behind an address that is no place for passkeys.
    const moved = setup('http://moat.example.ch');
    for (const [key, value] of ctx.accounts.accounts)
      moved.accounts.accounts.set(key, value);
    for (const p of await ctx.pk.passkeys.list(id))
      await moved.pk.passkeys.add(p);
    expect(await signIn(moved)).toEqual({
      status: 'refused',
      code: 'mfa_required',
      methods: [],
    });
    expect(await signIn(moved, a)).toMatchObject({ code: 'invalid_code' });
  });
});

describe('removing a passkey', () => {
  it('needs the password, ends the other sessions and keeps this one', async () => {
    const ctx = setup();
    const id = await account(ctx);
    const { passkey } = await enrolPasskey(ctx, id);
    const mine = sessionIdOf((await ctx.issuer.issue(id)).token);
    const other = sessionIdOf((await ctx.issuer.issue(id)).token);
    expect(
      await ctx.remove.execute(
        new RemovePasskeyCommand(id, mine, 'not the password!!', passkey.id),
      ),
    ).toEqual({ status: 'refused', code: 'invalid_credentials' });
    expect(await ctx.pk.passkeys.list(id)).toHaveLength(1);
    expect((await ctx.sessions.find(other))?.revokedAt).toBeNull();

    expect(
      await ctx.remove.execute(
        new RemovePasskeyCommand(id, mine, PASSWORD, passkey.id),
      ),
    ).toEqual({ status: 'ok' });
    expect(await ctx.pk.passkeys.list(id)).toHaveLength(0);
    expect((await ctx.sessions.find(other))?.revokedAt).not.toBeNull();
    expect((await ctx.sessions.find(mine))?.revokedAt).toBeNull();
    expect(
      await ctx.remove.execute(
        new RemovePasskeyCommand(id, mine, PASSWORD, passkey.id),
      ),
    ).toEqual({ status: 'refused', code: 'not_found' });
  });

  it("cannot remove another account's passkey", async () => {
    const ctx = setup();
    const id = await account(ctx);
    const other = await account(ctx, 'other@example.ch');
    const theirs = await enrolPasskey(ctx, other);
    expect(
      await ctx.remove.execute(
        new RemovePasskeyCommand(
          id,
          'x'.repeat(64),
          PASSWORD,
          theirs.passkey.id,
        ),
      ),
    ).toEqual({ status: 'refused', code: 'not_found' });
    expect(await ctx.pk.passkeys.list(other)).toHaveLength(1);
  });
});
