/** The Cloud API's views (`apps/api/src/cloud`); mirrors, not imports — the web app is separate. */
export interface AccountView {
  readonly id: string;
  readonly email: string;
  readonly totpEnabled: boolean;
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
