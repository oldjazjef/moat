/**
 * Roles and permissions of an organisation (SEC-52). Pure code, one table, exhaustively tested
 * (`permissions.spec.ts`: every role × release flag × action).
 *
 * The sign/release permission is **separate from the role**: it is a flag on the membership. A role
 * can allow it (`Owner`, `Admin`, `Editor`); only an Owner can set it; nobody gets it from their
 * role alone. `Viewer` and `Billing` can never hold it (a CHECK in the database says the same).
 */

export const ROLES = ['owner', 'admin', 'editor', 'viewer', 'billing'] as const;
export type Role = (typeof ROLES)[number];

export const ACTIONS = [
  'org:read',
  'members:read',
  'members:manage',
  'release:grant',
  'project:read',
  'project:create',
  'project:delete',
  'billing:manage',
  'audit:read',
  'config:read',
  'config:write',
  'gate:manage',
  'secret:write',
  'release',
] as const;
export type Action = (typeof ACTIONS)[number];

/** What each role may do without the release flag. */
const BY_ROLE: Readonly<Record<Role, ReadonlySet<Action>>> = {
  owner: new Set<Action>([
    'org:read',
    'members:read',
    'members:manage',
    'release:grant',
    'project:read',
    'project:create',
    'project:delete',
    'billing:manage',
    'audit:read',
    'config:read',
    'config:write',
    'gate:manage',
    'secret:write',
  ]),
  admin: new Set<Action>([
    'org:read',
    'members:read',
    'members:manage',
    'project:read',
    'project:create',
    'project:delete',
    'audit:read',
    'config:read',
    'config:write',
    'gate:manage',
    'secret:write',
  ]),
  editor: new Set<Action>([
    'org:read',
    'members:read',
    'project:read',
    'project:create',
    'config:read',
    'config:write',
    'secret:write',
  ]),
  viewer: new Set<Action>([
    'org:read',
    'members:read',
    'project:read',
    'config:read',
  ]),
  billing: new Set<Action>(['org:read', 'billing:manage']),
};

/** The roles that may hold the release flag at all. */
const RELEASE_ROLES: ReadonlySet<Role> = new Set<Role>([
  'owner',
  'admin',
  'editor',
]);

export function canHoldRelease(role: Role): boolean {
  return RELEASE_ROLES.has(role);
}

/** May `role` (with or without the release flag) do `action`? Anything unknown: no. */
export function can(
  role: Role,
  releaseGranted: boolean,
  action: Action,
): boolean {
  if (action === 'release') return releaseGranted && RELEASE_ROLES.has(role);
  return BY_ROLE[role]?.has(action) === true;
}

export function permissionsOf(role: Role, releaseGranted: boolean): Action[] {
  return ACTIONS.filter((action) => can(role, releaseGranted, action));
}

export function isRole(value: unknown): value is Role {
  return (
    typeof value === 'string' && (ROLES as readonly string[]).includes(value)
  );
}

/** Roles an Admin may hand out or change: never Owner or Admin (no peer or upward changes). */
const ADMIN_MANAGES: ReadonlySet<Role> = new Set<Role>([
  'editor',
  'viewer',
  'billing',
]);

/**
 * May `actor` change a member from `from` to `to` (adding is `from = null`, removing is
 * `to = null`)? An Owner may do anything to anybody; an Admin only among Editor, Viewer and
 * Billing, never to themselves (they could not be demoted by a peer, nor promote themselves);
 * everybody else nothing. The "last Owner stays" rule is the handler's, it needs the count.
 */
export function canChangeRole(
  actor: Role,
  from: Role | null,
  to: Role | null,
): boolean {
  if (actor === 'owner') return true;
  if (actor !== 'admin') return false;
  return (
    (from === null || ADMIN_MANAGES.has(from)) &&
    (to === null || ADMIN_MANAGES.has(to))
  );
}
