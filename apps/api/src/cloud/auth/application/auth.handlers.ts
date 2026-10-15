import {
  CommandHandler,
  type ICommandHandler,
  type IQueryHandler,
  QueryHandler,
} from '@nestjs/cqrs';
import { Clock, iso, newId } from '../../common/clock';
import {
  normaliseEmail,
  PASSWORD_INPUT_MAX_BYTES,
  passwordProblem,
} from '../domain/credentials';
import {
  isSessionLive,
  SESSION_TOKEN,
  SESSION_TOUCH_MS,
  sessionIdOf,
} from '../domain/session';
import {
  base32Encode,
  hashRecoveryCode,
  newRecoveryCode,
  newTotpSecret,
  otpauthUri,
  parseRecoveryCode,
  RECOVERY_CODE_COUNT,
} from '../domain/totp';
import {
  AccountRepositoryPort,
  SessionRepositoryPort,
} from '../ports/auth.ports';
import {
  type AccountView,
  AuthenticateSessionQuery,
  ChangePasswordCommand,
  type ChangePasswordResult,
  ConfirmTotpCommand,
  type ConfirmTotpResult,
  DisableTotpCommand,
  type DisableTotpResult,
  EnrolTotpCommand,
  type EnrolTotpResult,
  GetMeQuery,
  LoginCommand,
  type LoginResult,
  LogoutCommand,
  type Principal,
  type RateLimited,
  RegisterCommand,
  type RegisterResult,
} from './auth.commands';
import { PasswordHasher } from './password-hasher';
import {
  LOGIN_FAILURES_PER_ACCOUNT,
  LOGIN_PER_IP,
  RateLimiter,
  REAUTH_FAILURES_PER_ACCOUNT,
  REGISTER_PER_IP,
} from './rate-limiter';
import { SecondFactor } from './second-factor';
import { SessionIssuer } from './session-issuer';
import { TotpVault } from './totp-vault';

/** The issuer name an authenticator app shows next to the address. */
export const TOTP_ISSUER = 'Moat';

function limited(retryAfterSeconds: number): RateLimited {
  return { status: 'refused', code: 'rate_limited', retryAfterSeconds };
}

/** A password that is far too long is never hashed: a request must not make the server work. */
function tooLarge(password: string): boolean {
  return Buffer.byteLength(password, 'utf8') > PASSWORD_INPUT_MAX_BYTES;
}

@CommandHandler(RegisterCommand)
export class RegisterHandler implements ICommandHandler<RegisterCommand> {
  constructor(
    private readonly accounts: AccountRepositoryPort,
    private readonly hasher: PasswordHasher,
    private readonly limiter: RateLimiter,
    private readonly clock: Clock,
  ) {}

  async execute(command: RegisterCommand): Promise<RegisterResult> {
    const wait = await this.limiter.retryAfter(REGISTER_PER_IP, command.ip);
    if (wait !== null) return limited(wait);
    await this.limiter.record(REGISTER_PER_IP, command.ip);

    const email = normaliseEmail(command.email);
    if (email === null) return { status: 'refused', code: 'email_invalid' };
    const problem = passwordProblem(command.password);
    if (problem !== null) return { status: 'refused', code: problem };

    // The hash is made whether or not the address is taken: the same work, the same answer.
    const passwordHash = await this.hasher.hash(command.password);
    const at = iso(this.clock.now());
    await this.accounts.create({
      id: newId(),
      email,
      passwordHash,
      passwordChangedAt: at,
      createdAt: at,
    });
    return { status: 'accepted' };
  }
}

@CommandHandler(LoginCommand)
export class LoginHandler implements ICommandHandler<LoginCommand> {
  constructor(
    private readonly accounts: AccountRepositoryPort,
    private readonly sessions: SessionRepositoryPort,
    private readonly hasher: PasswordHasher,
    private readonly limiter: RateLimiter,
    private readonly factor: SecondFactor,
    private readonly issuer: SessionIssuer,
    private readonly clock: Clock,
  ) {}

  async execute(command: LoginCommand): Promise<LoginResult> {
    const subject = command.email.trim().toLowerCase().slice(0, 254);
    const ipWait = await this.limiter.retryAfter(LOGIN_PER_IP, command.ip);
    if (ipWait !== null) return limited(ipWait);
    const accountWait = await this.limiter.retryAfter(
      LOGIN_FAILURES_PER_ACCOUNT,
      subject,
    );
    if (accountWait !== null) return limited(accountWait);
    await this.limiter.record(LOGIN_PER_IP, command.ip);

    const fail = async (): Promise<LoginResult> => {
      await this.limiter.record(LOGIN_FAILURES_PER_ACCOUNT, subject);
      return { status: 'refused', code: 'invalid_credentials' };
    };

    const email = normaliseEmail(command.email);
    const account =
      email === null || tooLarge(command.password)
        ? null
        : await this.accounts.findByEmail(email);
    if (account === null) {
      // An unknown address costs the same work as a known one (T-79).
      if (!tooLarge(command.password))
        await this.hasher.verifyUnknown(command.password);
      return fail();
    }
    if (!(await this.hasher.verify(account.passwordHash, command.password)))
      return fail();

    const totp = await this.accounts.totp(account.id);
    const enabled = totp !== null && totp.enabledAt !== null;
    if (enabled) {
      // The password was right, so saying that a code is needed tells nothing new.
      if (command.code === undefined || command.code === '')
        return { status: 'refused', code: 'mfa_required' };
      if (!(await this.factor.verify(account.id, totp, command.code))) {
        await this.limiter.record(LOGIN_FAILURES_PER_ACCOUNT, subject);
        return { status: 'refused', code: 'invalid_code' };
      }
    }

    if (await this.hasher.needsRehash(account.passwordHash))
      await this.accounts.rehashPassword(
        account.id,
        await this.hasher.hash(command.password),
      );
    // A session cookie that came with the request is ended, never adopted (fixation).
    if (
      command.previousToken !== null &&
      SESSION_TOKEN.test(command.previousToken)
    )
      await this.sessions.revoke(
        sessionIdOf(command.previousToken),
        iso(this.clock.now()),
      );
    const session = await this.issuer.issue(account.id);
    return {
      status: 'ok',
      account: view(account.id, account.email, account.createdAt, enabled),
      session,
    };
  }
}

@CommandHandler(LogoutCommand)
export class LogoutHandler implements ICommandHandler<LogoutCommand> {
  constructor(
    private readonly sessions: SessionRepositoryPort,
    private readonly clock: Clock,
  ) {}

  async execute(command: LogoutCommand): Promise<void> {
    await this.sessions.revoke(command.sessionId, iso(this.clock.now()));
  }
}

@QueryHandler(AuthenticateSessionQuery)
export class AuthenticateSessionHandler implements IQueryHandler<AuthenticateSessionQuery> {
  constructor(
    private readonly sessions: SessionRepositoryPort,
    private readonly clock: Clock,
  ) {}

  async execute(query: AuthenticateSessionQuery): Promise<Principal | null> {
    if (!SESSION_TOKEN.test(query.token)) return null;
    const id = sessionIdOf(query.token);
    const session = await this.sessions.find(id);
    const now = this.clock.now();
    if (session === null || !isSessionLive(session, now)) return null;
    if (now.getTime() - Date.parse(session.lastSeenAt) > SESSION_TOUCH_MS)
      await this.sessions.touch(id, iso(now));
    return {
      accountId: session.accountId,
      sessionId: id,
      sessionToken: query.token,
    };
  }
}

@QueryHandler(GetMeQuery)
export class GetMeHandler implements IQueryHandler<GetMeQuery> {
  constructor(private readonly accounts: AccountRepositoryPort) {}

  async execute(query: GetMeQuery): Promise<AccountView | null> {
    const account = await this.accounts.findById(query.accountId);
    if (account === null) return null;
    const totp = await this.accounts.totp(account.id);
    return view(
      account.id,
      account.email,
      account.createdAt,
      totp !== null && totp.enabledAt !== null,
    );
  }
}

@CommandHandler(ChangePasswordCommand)
export class ChangePasswordHandler implements ICommandHandler<ChangePasswordCommand> {
  constructor(
    private readonly accounts: AccountRepositoryPort,
    private readonly sessions: SessionRepositoryPort,
    private readonly hasher: PasswordHasher,
    private readonly limiter: RateLimiter,
    private readonly issuer: SessionIssuer,
    private readonly clock: Clock,
  ) {}

  async execute(command: ChangePasswordCommand): Promise<ChangePasswordResult> {
    const wait = await this.limiter.retryAfter(
      REAUTH_FAILURES_PER_ACCOUNT,
      command.accountId,
    );
    if (wait !== null) return limited(wait);
    const account = await this.accounts.findById(command.accountId);
    if (
      account === null ||
      tooLarge(command.currentPassword) ||
      !(await this.hasher.verify(account.passwordHash, command.currentPassword))
    ) {
      await this.limiter.record(REAUTH_FAILURES_PER_ACCOUNT, command.accountId);
      return { status: 'refused', code: 'invalid_credentials' };
    }
    const problem = passwordProblem(command.newPassword);
    if (problem !== null) return { status: 'refused', code: problem };
    if (command.newPassword === command.currentPassword)
      return { status: 'refused', code: 'password_unchanged' };

    const at = iso(this.clock.now());
    await this.accounts.changePassword(
      account.id,
      await this.hasher.hash(command.newPassword),
      at,
    );
    // Every session of the account ends, this one too (SEC-51); the person gets a fresh one.
    await this.sessions.revokeAllOf(account.id, at);
    return { status: 'ok', session: await this.issuer.issue(account.id) };
  }
}

@CommandHandler(EnrolTotpCommand)
export class EnrolTotpHandler implements ICommandHandler<EnrolTotpCommand> {
  constructor(
    private readonly accounts: AccountRepositoryPort,
    private readonly hasher: PasswordHasher,
    private readonly vault: TotpVault,
    private readonly limiter: RateLimiter,
    private readonly clock: Clock,
  ) {}

  async execute(command: EnrolTotpCommand): Promise<EnrolTotpResult> {
    const wait = await this.limiter.retryAfter(
      REAUTH_FAILURES_PER_ACCOUNT,
      command.accountId,
    );
    if (wait !== null) return limited(wait);
    const account = await this.accounts.findById(command.accountId);
    if (
      account === null ||
      tooLarge(command.password) ||
      !(await this.hasher.verify(account.passwordHash, command.password))
    ) {
      await this.limiter.record(REAUTH_FAILURES_PER_ACCOUNT, command.accountId);
      return { status: 'refused', code: 'invalid_credentials' };
    }
    const existing = await this.accounts.totp(account.id);
    if (existing !== null && existing.enabledAt !== null)
      return { status: 'refused', code: 'already_enabled' };

    const secret = newTotpSecret();
    try {
      const saved = await this.accounts.savePendingTotp(
        account.id,
        await this.vault.seal(secret, account.id),
        iso(this.clock.now()),
      );
      if (!saved) return { status: 'refused', code: 'already_enabled' };
      return {
        status: 'ok',
        secret: base32Encode(secret),
        otpauthUri: otpauthUri(TOTP_ISSUER, account.email, secret),
      };
    } finally {
      secret.fill(0);
    }
  }
}

@CommandHandler(ConfirmTotpCommand)
export class ConfirmTotpHandler implements ICommandHandler<ConfirmTotpCommand> {
  constructor(
    private readonly accounts: AccountRepositoryPort,
    private readonly factor: SecondFactor,
    private readonly limiter: RateLimiter,
    private readonly clock: Clock,
  ) {}

  async execute(command: ConfirmTotpCommand): Promise<ConfirmTotpResult> {
    const wait = await this.limiter.retryAfter(
      REAUTH_FAILURES_PER_ACCOUNT,
      command.accountId,
    );
    if (wait !== null) return limited(wait);
    const totp = await this.accounts.totp(command.accountId);
    if (totp === null || totp.enabledAt !== null)
      return { status: 'refused', code: 'not_pending' };
    // A recovery code cannot confirm an enrolment: only a code from the app proves it works.
    const step =
      parseRecoveryCode(command.code) === null
        ? await this.factor.stepOf(command.accountId, totp, command.code)
        : null;
    if (step === null) {
      await this.limiter.record(REAUTH_FAILURES_PER_ACCOUNT, command.accountId);
      return { status: 'refused', code: 'invalid_code' };
    }
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () =>
      newRecoveryCode(),
    );
    const enabled = await this.accounts.enableTotp(
      command.accountId,
      step,
      iso(this.clock.now()),
      codes.map((code) => ({
        id: newId(),
        hash: hashRecoveryCode(code.replaceAll('-', '')),
      })),
    );
    if (!enabled) return { status: 'refused', code: 'not_pending' };
    return { status: 'ok', recoveryCodes: codes };
  }
}

@CommandHandler(DisableTotpCommand)
export class DisableTotpHandler implements ICommandHandler<DisableTotpCommand> {
  constructor(
    private readonly accounts: AccountRepositoryPort,
    private readonly sessions: SessionRepositoryPort,
    private readonly hasher: PasswordHasher,
    private readonly factor: SecondFactor,
    private readonly limiter: RateLimiter,
    private readonly clock: Clock,
  ) {}

  async execute(command: DisableTotpCommand): Promise<DisableTotpResult> {
    const wait = await this.limiter.retryAfter(
      REAUTH_FAILURES_PER_ACCOUNT,
      command.accountId,
    );
    if (wait !== null) return limited(wait);
    const fail = async (
      code: 'invalid_credentials' | 'invalid_code',
    ): Promise<DisableTotpResult> => {
      await this.limiter.record(REAUTH_FAILURES_PER_ACCOUNT, command.accountId);
      return { status: 'refused', code };
    };
    const account = await this.accounts.findById(command.accountId);
    if (
      account === null ||
      tooLarge(command.password) ||
      !(await this.hasher.verify(account.passwordHash, command.password))
    )
      return fail('invalid_credentials');
    const totp = await this.accounts.totp(account.id);
    if (totp === null || totp.enabledAt === null)
      return { status: 'refused', code: 'not_enabled' };
    if (!(await this.factor.verify(account.id, totp, command.code)))
      return fail('invalid_code');

    await this.accounts.removeTotp(account.id);
    // Other devices must sign in again; this one stays.
    await this.sessions.revokeAllOf(
      account.id,
      iso(this.clock.now()),
      command.sessionId,
    );
    return { status: 'ok' };
  }
}

function view(
  id: string,
  email: string,
  createdAt: string,
  totpEnabled: boolean,
): AccountView {
  return { id, email, totpEnabled, createdAt };
}

export const AUTH_HANDLERS = [
  RegisterHandler,
  LoginHandler,
  LogoutHandler,
  AuthenticateSessionHandler,
  GetMeHandler,
  ChangePasswordHandler,
  EnrolTotpHandler,
  ConfirmTotpHandler,
  DisableTotpHandler,
];
