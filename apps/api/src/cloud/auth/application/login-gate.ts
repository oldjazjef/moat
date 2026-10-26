import { Injectable } from '@nestjs/common';
import {
  normaliseEmail,
  PASSWORD_INPUT_MAX_BYTES,
} from '../domain/credentials';
import { AccountRepositoryPort, type AccountRecord } from '../ports/auth.ports';
import type { RateLimited } from './auth.commands';
import { AccountMails } from './account-mails';
import { PasswordHasher } from './password-hasher';
import {
  LOGIN_FAILURES_PER_ACCOUNT,
  LOGIN_PER_IP,
  RateLimiter,
} from './rate-limiter';

export type LoginCheck =
  | {
      readonly status: 'ok';
      readonly account: AccountRecord;
      /** The key the failure counter of this sign-in name uses. */
      readonly subject: string;
    }
  | RateLimited
  | {
      readonly status: 'refused';
      readonly code: 'invalid_credentials' | 'email_not_verified';
    };

/** A password that is far too long is never hashed: a request must not make the server work. */
function tooLarge(password: string): boolean {
  return Buffer.byteLength(password, 'utf8') > PASSWORD_INPUT_MAX_BYTES;
}

/**
 * The first half of every sign-in: the limits, then address and password (T-79). Used by `login`
 * and by the challenge of a passkey sign-in, so both cost an attacker the same and tell nothing
 * until the password is right. An unknown address costs the same work as a known one.
 */
@Injectable()
export class LoginGate {
  constructor(
    private readonly accounts: AccountRepositoryPort,
    private readonly hasher: PasswordHasher,
    private readonly limiter: RateLimiter,
    private readonly mails: AccountMails,
  ) {}

  async check(
    emailInput: string,
    password: string,
    ip: string,
  ): Promise<LoginCheck> {
    const subject = emailInput.trim().toLowerCase().slice(0, 254);
    const ipWait = await this.limiter.retryAfter(LOGIN_PER_IP, ip);
    if (ipWait !== null) return this.limited(ipWait);
    const accountWait = await this.limiter.retryAfter(
      LOGIN_FAILURES_PER_ACCOUNT,
      subject,
    );
    if (accountWait !== null) return this.limited(accountWait);
    await this.limiter.record(LOGIN_PER_IP, ip);

    const fail = async (): Promise<LoginCheck> => {
      await this.failed(subject);
      return { status: 'refused', code: 'invalid_credentials' };
    };
    const email = normaliseEmail(emailInput);
    const account =
      email === null || tooLarge(password)
        ? null
        : await this.accounts.findByEmail(email);
    if (account === null) {
      if (!tooLarge(password)) await this.hasher.verifyUnknown(password);
      return fail();
    }
    if (!(await this.hasher.verify(account.passwordHash, password)))
      return fail();
    // The password was right, so saying that the address still needs its link tells nothing new.
    if (this.mails.enabled && account.emailVerifiedAt === null)
      return { status: 'refused', code: 'email_not_verified' };
    return { status: 'ok', account, subject };
  }

  /** One more failed attempt for this sign-in name. */
  failed(subject: string): Promise<void> {
    return this.limiter.record(LOGIN_FAILURES_PER_ACCOUNT, subject);
  }

  private limited(retryAfterSeconds: number): RateLimited {
    return { status: 'refused', code: 'rate_limited', retryAfterSeconds };
  }
}
