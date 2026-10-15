import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Clock } from '../../common/clock';
import { RateLimitPort } from '../ports/auth.ports';

/**
 * The limits on the endpoints that take a password or a code (SEC-51, T-79). A fixed window per
 * key; the key is a SHA-256 of "scope:subject", so no address sits in the table.
 */
export interface Policy {
  readonly scope: string;
  readonly limit: number;
  readonly windowMs: number;
}

const MINUTE = 60_000;

/** Every sign-in attempt from one address, wherever it points. */
export const LOGIN_PER_IP: Policy = {
  scope: 'login-ip',
  limit: 60,
  windowMs: 15 * MINUTE,
};
/**
 * Failed sign-ins for one e-mail address (an unknown address counts the same, so the limit does
 * not tell them apart). The cost: someone can lock a victim out for the window; the account is
 * not opened by it.
 */
export const LOGIN_FAILURES_PER_ACCOUNT: Policy = {
  scope: 'login-account',
  limit: 10,
  windowMs: 15 * MINUTE,
};
export const REGISTER_PER_IP: Policy = {
  scope: 'register-ip',
  limit: 10,
  windowMs: 60 * MINUTE,
};
/** Failed password/code checks of a signed-in account (change password, TOTP). */
export const REAUTH_FAILURES_PER_ACCOUNT: Policy = {
  scope: 'reauth-account',
  limit: 10,
  windowMs: 15 * MINUTE,
};

@Injectable()
export class RateLimiter {
  constructor(
    private readonly store: RateLimitPort,
    private readonly clock: Clock,
  ) {}

  /** Seconds until the window ends when `subject` is over the limit, else null. */
  async retryAfter(policy: Policy, subject: string): Promise<number | null> {
    const now = this.clock.now();
    const key = keyOf(policy, subject);
    if ((await this.store.count(key, now)) < policy.limit) return null;
    const end = await this.store.windowEnd(key, now);
    return end === null
      ? 1
      : Math.max(1, Math.ceil((end.getTime() - now.getTime()) / 1000));
  }

  async record(policy: Policy, subject: string): Promise<void> {
    await this.store.increment(
      keyOf(policy, subject),
      policy.windowMs,
      this.clock.now(),
    );
  }
}

function keyOf(policy: Policy, subject: string): string {
  return createHash('sha256')
    .update(`${policy.scope}:${subject}`, 'utf8')
    .digest('hex');
}
