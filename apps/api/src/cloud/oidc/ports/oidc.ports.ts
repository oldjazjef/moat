export interface IdentityRecord {
  readonly id: string;
  readonly accountId: string;
  readonly provider: string;
  readonly subject: string;
  readonly createdAt: string;
  readonly lastLoginAt: string | null;
}

export type LoginPurpose = 'login' | 'link';

export interface OidcLoginRecord {
  /** SHA-256 hex of the `state`. */
  readonly id: string;
  readonly provider: string;
  readonly purpose: LoginPurpose;
  /** Set exactly for `link`. */
  readonly accountId: string | null;
  readonly nonce: string;
  readonly verifier: string;
  /** SHA-256 hex of the browser's secret cookie. */
  readonly browserHash: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

/** Identities at identity providers, and the sign-ins in progress. */
export abstract class OidcRepositoryPort {
  abstract findIdentity(
    provider: string,
    subject: string,
  ): Promise<IdentityRecord | null>;
  abstract identitiesOf(accountId: string): Promise<readonly IdentityRecord[]>;
  /** `taken` when the (provider, subject) pair belongs to an identity already. */
  abstract addIdentity(identity: IdentityRecord): Promise<'ok' | 'taken'>;
  abstract touchIdentity(id: string, at: string): Promise<void>;

  /** Stores a login in progress and drops the expired ones. */
  abstract issueLogin(login: OidcLoginRecord): Promise<void>;
  /** Compare-and-set: the login when it exists and has not expired — and it is used up by the same step. */
  abstract consumeLogin(
    id: string,
    now: string,
  ): Promise<OidcLoginRecord | null>;
}
