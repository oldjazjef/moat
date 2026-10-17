import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { Clock, iso } from '../../common/clock';
import {
  alreadyRegisteredMail,
  resetPasswordMail,
  verifyEmailMail,
} from '../../mail/mail-templates';
import { MailLinks } from '../../mail/mail.ports';
import { MailOutbox } from '../../mail/smtp-mailer';
import {
  AccountTokenPort,
  type AccountTokenPurpose,
} from '../ports/auth.ports';
import {
  MAIL_EXISTS_PER_ADDRESS,
  MAIL_RESET_PER_ADDRESS,
  MAIL_VERIFY_PER_ADDRESS,
  RateLimiter,
} from './rate-limiter';

export const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
export const RESET_TTL_MS = 60 * 60 * 1000;
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** The id a token is stored under: its SHA-256. A copy of the table opens no link. */
export function tokenId(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * The mails of the account flows. Each one is skipped silently once an address has had its share
 * in the window (nobody can use this to flood a mailbox), and none of them tells the caller
 * whether the address exists (T-79): the caller always answers the same.
 */
@Injectable()
export class AccountMails {
  constructor(
    private readonly outbox: MailOutbox,
    private readonly tokens: AccountTokenPort,
    private readonly limiter: RateLimiter,
    private readonly clock: Clock,
    private readonly links: MailLinks,
  ) {}

  get enabled(): boolean {
    return this.outbox.enabled;
  }

  async sendVerification(account: {
    id: string;
    email: string;
  }): Promise<void> {
    if (!this.enabled) return;
    if (await this.spent(MAIL_VERIFY_PER_ADDRESS, account.email)) return;
    const token = await this.issue(account.id, 'verify_email', VERIFY_TTL_MS);
    this.outbox.enqueue(verifyEmailMail(account.email, this.links, token));
  }

  async sendReset(account: { id: string; email: string }): Promise<void> {
    if (!this.enabled) return;
    if (await this.spent(MAIL_RESET_PER_ADDRESS, account.email)) return;
    const token = await this.issue(account.id, 'reset_password', RESET_TTL_MS);
    this.outbox.enqueue(resetPasswordMail(account.email, this.links, token));
  }

  async sendAlreadyRegistered(email: string): Promise<void> {
    if (!this.enabled) return;
    if (await this.spent(MAIL_EXISTS_PER_ADDRESS, email)) return;
    this.outbox.enqueue(alreadyRegisteredMail(email, this.links));
  }

  private async spent(
    policy: Parameters<RateLimiter['record']>[0],
    address: string,
  ): Promise<boolean> {
    if ((await this.limiter.retryAfter(policy, address)) !== null) return true;
    await this.limiter.record(policy, address);
    return false;
  }

  private async issue(
    accountId: string,
    purpose: AccountTokenPurpose,
    ttlMs: number,
  ): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    const now = this.clock.now();
    await this.tokens.issue({
      id: tokenId(token),
      accountId,
      purpose,
      createdAt: iso(now),
      expiresAt: iso(new Date(now.getTime() + ttlMs)),
    });
    return token;
  }
}
