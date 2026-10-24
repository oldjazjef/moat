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
/** Starting and finishing a single sign-in from one address (each costs a call to the provider). */
export const OIDC_PER_IP: Policy = {
  scope: 'oidc-ip',
  limit: 60,
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

const HOUR = 60 * MINUTE;
/** Link and reset requests from one address of the internet. */
export const MAIL_FLOW_PER_IP: Policy = {
  scope: 'mail-flow-ip',
  limit: 20,
  windowMs: HOUR,
};
/** Redeeming a link token: a 256-bit token cannot be guessed, this only bounds the work. */
export const TOKEN_REDEEM_PER_IP: Policy = {
  scope: 'token-ip',
  limit: 30,
  windowMs: 15 * MINUTE,
};
/** Mails to one mailbox: past this a mail is not sent, and nobody is told (T-79, T-97). */
export const MAIL_VERIFY_PER_ADDRESS: Policy = {
  scope: 'mail-verify-address',
  limit: 3,
  windowMs: HOUR,
};
export const MAIL_RESET_PER_ADDRESS: Policy = {
  scope: 'mail-reset-address',
  limit: 3,
  windowMs: HOUR,
};
export const MAIL_EXISTS_PER_ADDRESS: Policy = {
  scope: 'mail-exists-address',
  limit: 1,
  windowMs: 24 * HOUR,
};
export const MAIL_INVITE_PER_ADDRESS: Policy = {
  scope: 'mail-invite-address',
  limit: 3,
  windowMs: 24 * HOUR,
};
/** Invitations one account may send per hour (each may cost a mail to a stranger). */
export const MAIL_INVITE_PER_ACTOR: Policy = {
  scope: 'mail-invite-actor',
  limit: 30,
  windowMs: HOUR,
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
