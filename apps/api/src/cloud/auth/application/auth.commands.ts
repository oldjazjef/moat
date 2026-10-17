import { Command, Query } from '@nestjs/cqrs';
import type { PasswordProblem } from '../domain/credentials';

/** Over a rate limit (T-79): the controller answers 429 with `Retry-After`. */
export interface RateLimited {
  readonly status: 'refused';
  readonly code: 'rate_limited';
  readonly retryAfterSeconds: number;
}

/** What a client may know of an account. Never the password hash, never the TOTP secret. */
export interface AccountView {
  readonly id: string;
  readonly email: string;
  readonly totpEnabled: boolean;
  readonly createdAt: string;
}

/** A new session: the cookie token (shown once, never stored) and its CSRF token. */
export interface SessionGrant {
  readonly token: string;
  readonly csrfToken: string;
  readonly maxAgeSeconds: number;
}

/** Who is calling, once the session cookie checked out. */
export interface Principal {
  readonly accountId: string;
  readonly sessionId: string;
  /** The raw cookie token, for the CSRF check only; never serialised. */
  readonly sessionToken: string;
}

// ── Register ───────────────────────────────────────────────────────────────────────────────

export type RegisterResult =
  | { readonly status: 'accepted' }
  | RateLimited
  | {
      readonly status: 'refused';
      readonly code: 'email_invalid' | PasswordProblem;
    };

/**
 * `accepted` is the answer whether the address was new or taken: nothing tells them apart
 * (T-79). The person signs in afterwards.
 */
export class RegisterCommand extends Command<RegisterResult> {
  constructor(
    readonly email: string,
    readonly password: string,
    readonly ip: string,
  ) {
    super();
  }
}

// ── Login / logout ─────────────────────────────────────────────────────────────────────────

export type LoginResult =
  | {
      readonly status: 'ok';
      readonly account: AccountView;
      readonly session: SessionGrant;
    }
  | RateLimited
  | {
      readonly status: 'refused';
      /**
       * `invalid_credentials`: unknown address or wrong password, indistinguishable.
       * `mfa_required`: the password was right, a TOTP or recovery code is needed.
       */
      readonly code:
        | 'invalid_credentials'
        | 'mfa_required'
        | 'invalid_code'
        | 'email_not_verified';
    };

export class LoginCommand extends Command<LoginResult> {
  constructor(
    readonly email: string,
    readonly password: string,
    readonly code: string | undefined,
    readonly ip: string,
    /** The session cookie the request came with, revoked when the sign-in succeeds. */
    readonly previousToken: string | null,
  ) {
    super();
  }
}

export class LogoutCommand extends Command<void> {
  constructor(readonly sessionId: string) {
    super();
  }
}

export class AuthenticateSessionQuery extends Query<Principal | null> {
  constructor(readonly token: string) {
    super();
  }
}

export class GetMeQuery extends Query<AccountView | null> {
  constructor(readonly accountId: string) {
    super();
  }
}

// ── Password ───────────────────────────────────────────────────────────────────────────────

export type ChangePasswordResult =
  | { readonly status: 'ok'; readonly session: SessionGrant }
  | RateLimited
  | {
      readonly status: 'refused';
      readonly code:
        'invalid_credentials' | 'password_unchanged' | PasswordProblem;
    };

/** Revokes every session of the account (also this one) and signs the person in again. */
export class ChangePasswordCommand extends Command<ChangePasswordResult> {
  constructor(
    readonly accountId: string,
    readonly currentPassword: string,
    readonly newPassword: string,
  ) {
    super();
  }
}

// ── TOTP ───────────────────────────────────────────────────────────────────────────────────

export type EnrolTotpResult =
  | {
      readonly status: 'ok';
      /** base32, shown once; the database only keeps the sealed secret. */
      readonly secret: string;
      readonly otpauthUri: string;
    }
  | RateLimited
  | {
      readonly status: 'refused';
      readonly code: 'invalid_credentials' | 'already_enabled';
    };

export class EnrolTotpCommand extends Command<EnrolTotpResult> {
  constructor(
    readonly accountId: string,
    readonly password: string,
  ) {
    super();
  }
}

export type ConfirmTotpResult =
  | {
      readonly status: 'ok';
      /** Shown once; the database only keeps their SHA-256. */
      readonly recoveryCodes: readonly string[];
    }
  | RateLimited
  | {
      readonly status: 'refused';
      readonly code: 'not_pending' | 'invalid_code';
    };

export class ConfirmTotpCommand extends Command<ConfirmTotpResult> {
  constructor(
    readonly accountId: string,
    readonly code: string,
  ) {
    super();
  }
}

export type DisableTotpResult =
  | { readonly status: 'ok' }
  | RateLimited
  | {
      readonly status: 'refused';
      readonly code: 'invalid_credentials' | 'invalid_code' | 'not_enabled';
    };

/** Needs the password and a current code (or a recovery code); ends the account's other sessions. */
export class DisableTotpCommand extends Command<DisableTotpResult> {
  constructor(
    readonly accountId: string,
    readonly sessionId: string,
    readonly password: string,
    readonly code: string,
  ) {
    super();
  }
}

// ── E-mail flows ───────────────────────────────────────────────────────────────────────────

export type VerifyEmailResult =
  | { readonly status: 'ok' }
  | RateLimited
  | { readonly status: 'refused'; readonly code: 'invalid_token' };

/** The token from the mailed link. One use; confirms the address and applies waiting invitations. */
export class VerifyEmailCommand extends Command<VerifyEmailResult> {
  constructor(
    readonly token: string,
    readonly ip: string,
  ) {
    super();
  }
}

export type AcceptedResult = { readonly status: 'accepted' } | RateLimited;

/** `accepted` whether or not the address has an account or a mail went out (T-79). */
export class ResendVerificationCommand extends Command<AcceptedResult> {
  constructor(
    readonly email: string,
    readonly ip: string,
  ) {
    super();
  }
}

export class ForgotPasswordCommand extends Command<AcceptedResult> {
  constructor(
    readonly email: string,
    readonly ip: string,
  ) {
    super();
  }
}

export type ResetPasswordResult =
  | { readonly status: 'ok' }
  | RateLimited
  | {
      readonly status: 'refused';
      readonly code: 'invalid_token' | PasswordProblem;
    };

/** Sets a new password from the mailed token and ends every session of the account. */
export class ResetPasswordCommand extends Command<ResetPasswordResult> {
  constructor(
    readonly token: string,
    readonly newPassword: string,
    readonly ip: string,
  ) {
    super();
  }
}
