import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { Clock, iso } from '../../common/clock';
import { InvitationRedeemer } from '../../tenancy/application/invitation-redeemer';
import { normaliseEmail, passwordProblem } from '../domain/credentials';
import {
  AccountRepositoryPort,
  AccountTokenPort,
  SessionRepositoryPort,
} from '../ports/auth.ports';
import { AccountMails, TOKEN_PATTERN, tokenId } from './account-mails';
import {
  type AcceptedResult,
  ForgotPasswordCommand,
  type RateLimited,
  ResendVerificationCommand,
  ResetPasswordCommand,
  type ResetPasswordResult,
  VerifyEmailCommand,
  type VerifyEmailResult,
} from './auth.commands';
import { PasswordHasher } from './password-hasher';
import {
  MAIL_FLOW_PER_IP,
  RateLimiter,
  TOKEN_REDEEM_PER_IP,
} from './rate-limiter';

function limited(retryAfterSeconds: number): RateLimited {
  return { status: 'refused', code: 'rate_limited', retryAfterSeconds };
}

@CommandHandler(VerifyEmailCommand)
export class VerifyEmailHandler implements ICommandHandler<VerifyEmailCommand> {
  constructor(
    private readonly accounts: AccountRepositoryPort,
    private readonly tokens: AccountTokenPort,
    private readonly limiter: RateLimiter,
    private readonly redeemer: InvitationRedeemer,
    private readonly clock: Clock,
  ) {}

  async execute(command: VerifyEmailCommand): Promise<VerifyEmailResult> {
    const wait = await this.limiter.retryAfter(TOKEN_REDEEM_PER_IP, command.ip);
    if (wait !== null) return limited(wait);
    await this.limiter.record(TOKEN_REDEEM_PER_IP, command.ip);
    if (!TOKEN_PATTERN.test(command.token))
      return { status: 'refused', code: 'invalid_token' };
    const now = iso(this.clock.now());
    const accountId = await this.tokens.consume(
      tokenId(command.token),
      'verify_email',
      now,
    );
    const account =
      accountId === null ? null : await this.accounts.findById(accountId);
    if (account === null) return { status: 'refused', code: 'invalid_token' };
    await this.accounts.markEmailVerified(account.id, now);
    await this.redeemer.redeem(account.id, account.email);
    return { status: 'ok' };
  }
}

@CommandHandler(ResendVerificationCommand)
export class ResendVerificationHandler implements ICommandHandler<ResendVerificationCommand> {
  constructor(
    private readonly accounts: AccountRepositoryPort,
    private readonly limiter: RateLimiter,
    private readonly mails: AccountMails,
  ) {}

  async execute(command: ResendVerificationCommand): Promise<AcceptedResult> {
    const wait = await this.limiter.retryAfter(MAIL_FLOW_PER_IP, command.ip);
    if (wait !== null) return limited(wait);
    await this.limiter.record(MAIL_FLOW_PER_IP, command.ip);
    const email = normaliseEmail(command.email);
    const account =
      email === null ? null : await this.accounts.findByEmail(email);
    if (account !== null && account.emailVerifiedAt === null)
      await this.mails.sendVerification(account);
    return { status: 'accepted' };
  }
}

@CommandHandler(ForgotPasswordCommand)
export class ForgotPasswordHandler implements ICommandHandler<ForgotPasswordCommand> {
  constructor(
    private readonly accounts: AccountRepositoryPort,
    private readonly limiter: RateLimiter,
    private readonly mails: AccountMails,
  ) {}

  async execute(command: ForgotPasswordCommand): Promise<AcceptedResult> {
    const wait = await this.limiter.retryAfter(MAIL_FLOW_PER_IP, command.ip);
    if (wait !== null) return limited(wait);
    await this.limiter.record(MAIL_FLOW_PER_IP, command.ip);
    const email = normaliseEmail(command.email);
    const account =
      email === null ? null : await this.accounts.findByEmail(email);
    if (account !== null) await this.mails.sendReset(account);
    return { status: 'accepted' };
  }
}

@CommandHandler(ResetPasswordCommand)
export class ResetPasswordHandler implements ICommandHandler<ResetPasswordCommand> {
  constructor(
    private readonly accounts: AccountRepositoryPort,
    private readonly sessions: SessionRepositoryPort,
    private readonly tokens: AccountTokenPort,
    private readonly hasher: PasswordHasher,
    private readonly limiter: RateLimiter,
    private readonly redeemer: InvitationRedeemer,
    private readonly clock: Clock,
  ) {}

  async execute(command: ResetPasswordCommand): Promise<ResetPasswordResult> {
    const wait = await this.limiter.retryAfter(TOKEN_REDEEM_PER_IP, command.ip);
    if (wait !== null) return limited(wait);
    await this.limiter.record(TOKEN_REDEEM_PER_IP, command.ip);
    // A password that would be refused does not use the token up: the person can try again.
    const problem = passwordProblem(command.newPassword);
    if (problem !== null) return { status: 'refused', code: problem };
    if (!TOKEN_PATTERN.test(command.token))
      return { status: 'refused', code: 'invalid_token' };
    const at = iso(this.clock.now());
    const accountId = await this.tokens.consume(
      tokenId(command.token),
      'reset_password',
      at,
    );
    const account =
      accountId === null ? null : await this.accounts.findById(accountId);
    if (account === null) return { status: 'refused', code: 'invalid_token' };

    await this.accounts.changePassword(
      account.id,
      await this.hasher.hash(command.newPassword),
      at,
    );
    // Every session ends (SEC-51); nobody is signed in by a reset, the person signs in afterwards.
    await this.sessions.revokeAllOf(account.id, at);
    await this.tokens.revokeAll(account.id, 'reset_password', at);
    // The link came from the mailbox, so the address is confirmed as well.
    await this.accounts.markEmailVerified(account.id, at);
    await this.redeemer.redeem(account.id, account.email);
    return { status: 'ok' };
  }
}

export const MAIL_HANDLERS = [
  VerifyEmailHandler,
  ResendVerificationHandler,
  ForgotPasswordHandler,
  ResetPasswordHandler,
];
