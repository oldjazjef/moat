/** The Cloud API's views (`apps/api/src/cloud`); mirrors, not imports — the web app is separate. */
export interface AccountView {
  readonly id: string;
  readonly email: string;
  readonly totpEnabled: boolean;
  readonly passkeyCount: number;
  /** False for an account made by single sign-on that never set a password. */
  readonly hasPassword: boolean;
  /** Provider ids linked to the account. */
  readonly identities: readonly string[];
  readonly createdAt: string;
}

export interface SessionAnswer {
  readonly account: AccountView;
  readonly csrfToken: string;
}

export const ROLES = ['owner', 'admin', 'editor', 'viewer', 'billing'] as const;
export type Role = (typeof ROLES)[number];

/** The roles that may hold the separate release permission (SEC-52); the API decides in the end. */
export const RELEASE_ROLES: readonly Role[] = ['owner', 'admin', 'editor'];

export type Action =
  | 'org:read'
  | 'members:read'
  | 'members:manage'
  | 'release:grant'
  | 'project:read'
  | 'project:create'
  | 'project:delete'
  | 'billing:manage'
  | 'audit:read'
  | 'config:read'
  | 'config:write'
  | 'gate:manage'
  | 'secret:write'
  | 'release';

export interface OrganisationView {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}

export interface MyAccess {
  readonly role: Role;
  readonly releaseGranted: boolean;
  readonly permissions: readonly Action[];
}

export interface OrganisationEntry {
  readonly organisation: OrganisationView;
  readonly access: MyAccess;
}

export interface MemberView {
  readonly accountId: string;
  readonly email: string;
  readonly role: Role;
  readonly releaseGranted: boolean;
  readonly createdAt: string;
}

export interface OrgProjectView {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}

/** One row of an organisation's audit log (`GET /orgs/:id/audit`, SEC-53). */
export interface AuditEntryView {
  readonly seq: number;
  readonly at: string;
  readonly actor: string;
  readonly action: string;
  readonly target: string | null;
  /** The details as canonical JSON, a closed list per action. */
  readonly details: string;
  readonly hash: string;
}

/** The answer of `GET /orgs/:id/audit/verify`. */
export interface AuditVerification {
  readonly check:
    | { readonly status: 'intact'; readonly entries: number }
    | {
        readonly status: 'broken';
        readonly entries: number;
        readonly seq: number | null;
        readonly reason: string;
      };
  readonly head: { readonly seq: number; readonly hash: string } | null;
}

/** A passkey of the account, as the API lists it (no key material). */
export interface PasskeyView {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

export type MfaMethod = 'totp' | 'passkey';

/** A single sign-on provider an operator configured: id and button text only. */
export interface OidcProviderView {
  readonly id: string;
  readonly name: string;
}

/** The codes the way back from a provider puts in `?sso=`; anything else is ignored. */
export const SSO_RESULTS = [
  'failed',
  'email_unverified',
  'email_taken',
  'identity_taken',
  'linked',
] as const;
export type SsoResult = (typeof SSO_RESULTS)[number];

export function ssoResultOf(value: unknown): SsoResult | null {
  return SSO_RESULTS.find((code) => code === value) ?? null;
}
