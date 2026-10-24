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
  /** How many passkeys the account has (a second factor next to TOTP). */
  readonly passkeyCount: number;
  /** False for an account made by single sign-on that never set a password. */
  readonly hasPassword: boolean;
  /** The single sign-on providers linked to the account (ids, in the order linked). */
  readonly identities: readonly string[];
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
       * `mfa_required`: the password was right, a second factor is needed (`methods` says which).
       */
      readonly code:
        | 'invalid_credentials'
        | 'mfa_required'
        | 'invalid_code'
        | 'email_not_verified';
      /** For `mfa_required` only, after the password was right: the factors that would do. */
      readonly methods?: readonly MfaMethod[];
    };

export type MfaMethod = 'totp' | 'passkey';

/** What `navigator.credentials.get` returned, each part as base64url. */
export interface PasskeyAssertionInput {
  readonly credentialId: string;
  readonly authenticatorData: string;
  readonly clientDataJSON: string;
  readonly signature: string;
}

export class LoginCommand extends Command<LoginResult> {
  constructor(
    readonly email: string,
    readonly password: string,
    readonly code: string | undefined,
    readonly ip: string,
    /** The session cookie the request came with, revoked when the sign-in succeeds. */
    readonly previousToken: string | null,
    /** A passkey assertion as the second factor, instead of `code`. */
    readonly passkey?: PasskeyAssertionInput,
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

// ── Passkeys ───────────────────────────────────────────────────────────────────────────────

export interface PasskeyView {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

export type PasskeyLoginChallengeResult =
  | {
      readonly status: 'ok';
      /** base64url of the 32-byte challenge. */
      readonly challenge: string;
      readonly rpId: string;
      /** base64url credential ids the account has: what `allowCredentials` should list. */
      readonly credentialIds: readonly string[];
      readonly timeoutMs: number;
    }
  | RateLimited
  | {
      readonly status: 'refused';
      readonly code:
        | 'invalid_credentials'
        | 'email_not_verified'
        | 'passkey_unavailable'
        | 'no_passkey';
    };

/**
 * First half of a sign-in with a passkey: the password is checked as `login` does (same limits),
 * and only then is a challenge made. Nothing is revealed before the password is right.
 */
export class PasskeyLoginChallengeCommand extends Command<PasskeyLoginChallengeResult> {
  constructor(
    readonly email: string,
    readonly password: string,
    readonly ip: string,
  ) {
    super();
  }
}

export type BeginPasskeyResult =
  | {
      readonly status: 'ok';
      readonly challenge: string;
      readonly rp: { readonly id: string; readonly name: string };
      readonly user: {
        /** base64url of the account id (an opaque handle, no address). */
        readonly id: string;
        readonly name: string;
        readonly displayName: string;
      };
      readonly excludeCredentials: readonly string[];
      readonly timeoutMs: number;
    }
  | RateLimited
  | {
      readonly status: 'refused';
      readonly code:
        'invalid_credentials' | 'passkey_unavailable' | 'passkey_limit';
    };

/** Asks for the password again, then makes the challenge of a registration. */
export class BeginPasskeyCommand extends Command<BeginPasskeyResult> {
  constructor(
    readonly accountId: string,
    readonly password: string,
  ) {
    super();
  }
}

export type FinishPasskeyResult =
  | { readonly status: 'ok'; readonly passkey: PasskeyView }
  | RateLimited
  | {
      readonly status: 'refused';
      readonly code:
        | 'name_invalid'
        | 'challenge_invalid'
        | 'passkey_invalid'
        | 'passkey_exists'
        | 'passkey_limit'
        | 'passkey_unavailable';
    };

export class FinishPasskeyCommand extends Command<FinishPasskeyResult> {
  constructor(
    readonly accountId: string,
    readonly name: string,
    readonly attestationObject: string,
    readonly clientDataJSON: string,
  ) {
    super();
  }
}

export class ListPasskeysQuery extends Query<readonly PasskeyView[]> {
  constructor(readonly accountId: string) {
    super();
  }
}

export type RemovePasskeyResult =
  | { readonly status: 'ok' }
  | RateLimited
  | {
      readonly status: 'refused';
      readonly code: 'invalid_credentials' | 'not_found';
    };

/** Needs the password; ends the account's other sessions. */
export class RemovePasskeyCommand extends Command<RemovePasskeyResult> {
  constructor(
    readonly accountId: string,
    readonly sessionId: string,
    readonly password: string,
    readonly id: string,
  ) {
    super();
  }
}
