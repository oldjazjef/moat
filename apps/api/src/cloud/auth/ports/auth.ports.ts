/** What the auth handlers need of storage (Handler → Repository Port → Prisma adapter). */

export interface AccountRecord {
  readonly id: string;
  /** Normalised (lower case). */
  readonly email: string;
  /** libsodium `crypto_pwhash_str` output. Never leaves the auth handlers. */
  readonly passwordHash: string;
  readonly passwordChangedAt: string;
  readonly createdAt: string;
  /** null = the address was never confirmed by a link (see `isVerified`). */
  readonly emailVerifiedAt: string | null;
}

export interface TotpRecord {
  readonly accountId: string;
  /** base64url(nonce ‖ AEAD ciphertext), see TotpVault. */
  readonly sealedSecret: string;
  /** null while the enrolment has not been confirmed. */
  readonly enabledAt: string | null;
  readonly lastStep: number;
}

export interface SessionRecord {
  /** SHA-256 hex of the cookie token. */
  readonly id: string;
  readonly accountId: string;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

export abstract class AccountRepositoryPort {
  abstract findByEmail(email: string): Promise<AccountRecord | null>;
  abstract findById(id: string): Promise<AccountRecord | null>;
  /** `email_taken` when the (unique) address exists already; nothing is written then. */
  abstract create(account: AccountRecord): Promise<'created' | 'email_taken'>;
  abstract changePassword(
    id: string,
    passwordHash: string,
    at: string,
  ): Promise<void>;

  /** Stamps the address as confirmed (a link was opened from that mailbox). Keeps an earlier stamp. */
  abstract markEmailVerified(id: string, at: string): Promise<void>;

  /** A cheaper or dearer hash of the same password (parameters changed): no password change. */
  abstract rehashPassword(id: string, passwordHash: string): Promise<void>;

  abstract totp(accountId: string): Promise<TotpRecord | null>;
  /**
   * Stores a pending (unconfirmed) secret, replacing an earlier pending one. `false` when TOTP is
   * enabled already: an enabled secret is never replaced from here.
   */
  abstract savePendingTotp(
    accountId: string,
    sealedSecret: string,
    at: string,
  ): Promise<boolean>;
  /**
   * Confirms the pending secret in one step: enabled, `lastStep` set, and the recovery codes
   * (hashes) replace any earlier ones. `false` when nothing was pending.
   */
  abstract enableTotp(
    accountId: string,
    step: number,
    at: string,
    recoveryCodes: readonly { id: string; hash: string }[],
  ): Promise<boolean>;
  /** Compare-and-set: `lastStep` moves to `step` only when it is lower. `false` = replay. */
  abstract advanceTotpStep(accountId: string, step: number): Promise<boolean>;
  /** TOTP and its recovery codes go. */
  abstract removeTotp(accountId: string): Promise<void>;
  /** Marks the code used; `false` when it is unknown or was used already. */
  abstract useRecoveryCode(
    accountId: string,
    hash: string,
    at: string,
  ): Promise<boolean>;
}

export abstract class SessionRepositoryPort {
  abstract create(session: SessionRecord): Promise<void>;
  abstract find(id: string): Promise<SessionRecord | null>;
  abstract touch(id: string, lastSeenAt: string): Promise<void>;
  abstract revoke(id: string, at: string): Promise<void>;
  /** Every live session of the account, except `exceptId`. */
  abstract revokeAllOf(
    accountId: string,
    at: string,
    exceptId?: string,
  ): Promise<void>;
}

/** A fixed window counter (login, register): bounded, no personal data in the key. */
export abstract class RateLimitPort {
  /** The count in the current window, 0 when there is none. */
  abstract count(key: string, now: Date): Promise<number>;
  /** +1 in the current window (a new window starts when the last one ended); the new count. */
  abstract increment(key: string, windowMs: number, now: Date): Promise<number>;
  /** When the current window ends, or null. */
  abstract windowEnd(key: string, now: Date): Promise<Date | null>;
}

export type AccountTokenPurpose = 'verify_email' | 'reset_password';

export interface AccountTokenRecord {
  /** SHA-256 hex of the token that went into the link; the token itself is never stored. */
  readonly id: string;
  readonly accountId: string;
  readonly purpose: AccountTokenPurpose;
  readonly createdAt: string;
  readonly expiresAt: string;
}

/** One-time link tokens: verify an address, reset a password. */
export abstract class AccountTokenPort {
  /** Stores the token and ends every earlier unused one of the same account and purpose. */
  abstract issue(token: AccountTokenRecord): Promise<void>;
  /**
   * Compare-and-set: the account id when the token exists, has this purpose, is unused and not
   * expired — and it is used up by the same step. Anything else is null (and changes nothing).
   */
  abstract consume(
    id: string,
    purpose: AccountTokenPurpose,
    now: string,
  ): Promise<string | null>;
  /** Ends every unused token of the account and purpose (a password was reset or changed). */
  abstract revokeAll(
    accountId: string,
    purpose: AccountTokenPurpose,
    at: string,
  ): Promise<void>;
}
