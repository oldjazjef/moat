import { createHash } from 'node:crypto';
import { NEW_PROJECT_CONFIG } from '@moat/core';

/**
 * The authorization matrix of the Cloud (`AUTH_MODE=cloud`, SEC-50, SEC-52, SEC-70 ff.): every
 * route with the answer each identity must get. `authz-matrix-cloud.spec.ts` boots the real Cloud
 * app, fails on a route without an entry (or an entry without a route), and checks every cell.
 * The desktop's matrix is `authz-matrix.ts`. Never weaken an expectation to make it pass.
 *
 * Not listed, by design: `/healthz` and `/readyz` and the dashboard's files. They are plain Express
 * middleware in front of the router (`cloud-server/`), not API routes: public on purpose (a
 * container runtime and a load balancer have no session), GET/HEAD only, no input, a fixed body
 * (`ok` / `ready` / `unavailable`), no data. `cloud-server.spec.ts` attacks them (T-84); anything
 * under `/api` stays the router's and needs an entry here.
 *
 * Identities (the spec seeds them, fresh before every cell):
 *
 *   noCookie            no session cookie
 *   garbageCookie       a cookie that is no session token
 *   expiredSession      a session of ownerA's account past its absolute end
 *   revokedSession      a session of ownerA's account that was signed out
 *   ownerA … billingA   live sessions of members of organisation A, one per role; `editorA` holds
 *                       the separate release permission, `editorANoRelease` does not (SEC-52)
 *   ownerB              the Owner of another organisation: a foreign tenant → 404 (SEC-50)
 *   csrfMissing         ownerA's live session, no `x-moat-csrf` header
 *   csrfOfOtherSession  ownerA's live session with the CSRF token of another session
 *   crossOrigin         ownerA's live session and CSRF token, from `Origin: https://evil.example`
 */
export const CLOUD_IDENTITIES = [
  'noCookie',
  'garbageCookie',
  'expiredSession',
  'revokedSession',
  'ownerA',
  'adminA',
  'editorA',
  'editorANoRelease',
  'viewerA',
  'billingA',
  'ownerB',
  'csrfMissing',
  'csrfOfOtherSession',
  'crossOrigin',
] as const;
export type CloudIdentity = (typeof CLOUD_IDENTITIES)[number];

export interface CloudAuthzEntry {
  readonly name?: string;
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** As registered, with the global prefix. */
  readonly path: string;
  /** The URL the spec calls, when `path` has parameters. */
  readonly request?: string;
  readonly body?: unknown;
  readonly expect: Readonly<Record<CloudIdentity, number>>;
}

const pad = (name: string): string => name.padEnd(22, '0');
/** Fixed ids the matrix spec seeds. */
export const CLOUD_IDS = {
  orgA: pad('orgA'),
  orgB: pad('orgB'),
  projectA: pad('projectA'),
  projectB: pad('projectB'),
  /** A Viewer of organisation A that the member routes act on. */
  target: pad('targetViewer'),
} as const;
/**
 * The gate every cell finds in project A (managed, `site`), and the values a new gate is enrolled
 * with: `fingerprint` is the box key's `MOAT-…` (spec: `gates.handlers.spec.ts` recomputes it).
 */
export const CLOUD_GATE = {
  name: 'site',
  gateId: pad('gateSite'),
  boxKey: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc',
  fingerprint: 'MOAT-DBPU-7GD7-RRNX-PEUM-XXOL-6LU7-34',
} as const;
/** A sealed secret of the right shape (the Cloud cannot open it, so a fixed one will do). */
export const CLOUD_SEALED = {
  v: 1,
  alg: 'x25519-blake2b-xchacha20poly1305',
  secretVersion: 1,
  epk: 'B'.repeat(43),
  nonce: 'N'.repeat(32),
  ct: 'C'.repeat(40),
} as const;
/** The moat.yaml every cell finds in project A, and its hash (what an edit is based on). */
export const CLOUD_CONFIG_TEXT = NEW_PROJECT_CONFIG;
export const CLOUD_CONFIG_HASH = createHash('sha256')
  .update(CLOUD_CONFIG_TEXT, 'utf8')
  .digest('hex');
export const CLOUD_TARGET_EMAIL = 'target@example.ch';
export const CLOUD_MATRIX_PASSWORD = 'a perfectly long test password';

interface RoleAnswers {
  readonly owner: number;
  readonly admin: number;
  readonly editor: number;
  readonly viewer: number;
  readonly billing: number;
  readonly foreign: number;
}

/**
 * A route behind the session: no cookie, a bad, expired or revoked session → 401; a state-changing
 * request without the session's CSRF token or from another origin → 403 whoever sends it; the
 * rest by role (the foreign tenant's Owner included). An Editor answers the same with or without
 * the release permission unless a route says otherwise.
 */
function guarded(
  answers: RoleAnswers,
  unsafe: boolean,
): CloudAuthzEntry['expect'] {
  const blocked = unsafe ? 403 : answers.owner;
  return {
    noCookie: 401,
    garbageCookie: 401,
    expiredSession: 401,
    revokedSession: 401,
    ownerA: answers.owner,
    adminA: answers.admin,
    editorA: answers.editor,
    editorANoRelease: answers.editor,
    viewerA: answers.viewer,
    billingA: answers.billing,
    ownerB: answers.foreign,
    csrfMissing: blocked,
    csrfOfOtherSession: blocked,
    crossOrigin: blocked,
  };
}

/** Every signed-in account gets the same answer (account routes). */
function accountRoute(
  status: number,
  unsafe: boolean,
): CloudAuthzEntry['expect'] {
  return guarded(
    {
      owner: status,
      admin: status,
      editor: status,
      viewer: status,
      billing: status,
      foreign: status,
    },
    unsafe,
  );
}

/** A route without a session. Only the origin check can refuse (unsafe methods, crossOrigin). */
function open(status: number, unsafe: boolean): CloudAuthzEntry['expect'] {
  return {
    noCookie: status,
    garbageCookie: status,
    expiredSession: status,
    revokedSession: status,
    ownerA: status,
    adminA: status,
    editorA: status,
    editorANoRelease: status,
    viewerA: status,
    billingA: status,
    ownerB: status,
    csrfMissing: status,
    csrfOfOtherSession: status,
    crossOrigin: unsafe ? 403 : status,
  };
}

const ORG = `/api/orgs/${CLOUD_IDS.orgA}`;
const MEMBER = `${ORG}/members/${CLOUD_IDS.target}`;
const PROJECT = `${ORG}/projects/${CLOUD_IDS.projectA}`;
const GATE = `${PROJECT}/gates/${CLOUD_GATE.name}`;

export const CLOUD_AUTHZ_MATRIX: readonly CloudAuthzEntry[] = [
  { method: 'GET', path: '/api/health', expect: open(200, false) },
  {
    // The same 202 whether the address is new or taken (T-79).
    method: 'POST',
    path: '/api/auth/register',
    body: { email: 'newcomer@example.ch', password: 'a long enough password' },
    expect: open(202, true),
  },
  {
    // A token that was never issued: the same plain 422 for everybody (expired and used look alike).
    method: 'POST',
    path: '/api/auth/verify-email',
    body: { token: 'A'.repeat(43) },
    expect: open(422, true),
  },
  {
    // 202 whether or not the address has an account (T-79).
    method: 'POST',
    path: '/api/auth/resend-verification',
    body: { email: 'nobody@example.ch' },
    expect: open(202, true),
  },
  {
    method: 'POST',
    path: '/api/auth/forgot-password',
    body: { email: 'nobody@example.ch' },
    expect: open(202, true),
  },
  {
    method: 'POST',
    path: '/api/auth/reset-password',
    body: { token: 'A'.repeat(43), newPassword: 'a long enough password' },
    expect: open(422, true),
  },
  {
    // ownerA's own credentials: anybody may try to sign in; a cookie that came along is ended.
    method: 'POST',
    path: '/api/auth/login',
    body: { email: 'ownera@example.ch', password: CLOUD_MATRIX_PASSWORD },
    expect: open(200, true),
  },
  { method: 'POST', path: '/api/auth/logout', expect: accountRoute(204, true) },
  { method: 'GET', path: '/api/auth/me', expect: accountRoute(200, false) },
  {
    method: 'POST',
    path: '/api/auth/password',
    body: {
      currentPassword: CLOUD_MATRIX_PASSWORD,
      newPassword: 'another perfectly long password',
    },
    expect: accountRoute(200, true),
  },
  {
    method: 'POST',
    path: '/api/auth/totp/enrol',
    body: { password: CLOUD_MATRIX_PASSWORD },
    expect: accountRoute(200, true),
  },
  {
    // Nothing pending (the spec resets TOTP): 409 `not_pending` for every signed-in account.
    method: 'POST',
    path: '/api/auth/totp/confirm',
    body: { code: '000000' },
    expect: accountRoute(409, true),
  },
  {
    // TOTP is not enabled: 409 `not_enabled` once the password checked out.
    method: 'POST',
    path: '/api/auth/totp/disable',
    body: { password: CLOUD_MATRIX_PASSWORD, code: '000000' },
    expect: accountRoute(409, true),
  },
  { method: 'GET', path: '/api/orgs', expect: accountRoute(200, false) },
  {
    method: 'POST',
    path: '/api/orgs',
    body: { name: 'A new organisation' },
    expect: accountRoute(201, true),
  },
  {
    method: 'GET',
    path: '/api/orgs/:orgId',
    request: ORG,
    expect: guarded(
      {
        owner: 200,
        admin: 200,
        editor: 200,
        viewer: 200,
        billing: 200,
        foreign: 404,
      },
      false,
    ),
  },
  {
    method: 'GET',
    path: '/api/orgs/:orgId/members',
    request: `${ORG}/members`,
    expect: guarded(
      {
        owner: 200,
        admin: 200,
        editor: 200,
        viewer: 200,
        billing: 403,
        foreign: 404,
      },
      false,
    ),
  },
  {
    // The audit log (SEC-53): Owner and Admin only.
    method: 'GET',
    path: '/api/orgs/:orgId/audit',
    request: `${ORG}/audit`,
    expect: guarded(
      {
        owner: 200,
        admin: 200,
        editor: 403,
        viewer: 403,
        billing: 403,
        foreign: 404,
      },
      false,
    ),
  },
  {
    // The audit log (SEC-53): Owner and Admin only.
    method: 'GET',
    path: '/api/orgs/:orgId/audit/verify',
    request: `${ORG}/audit/verify`,
    expect: guarded(
      {
        owner: 200,
        admin: 200,
        editor: 403,
        viewer: 403,
        billing: 403,
        foreign: 404,
      },
      false,
    ),
  },
  {
    // The audit log (SEC-53): Owner and Admin only.
    method: 'GET',
    path: '/api/orgs/:orgId/audit/export',
    request: `${ORG}/audit/export`,
    expect: guarded(
      {
        owner: 200,
        admin: 200,
        editor: 403,
        viewer: 403,
        billing: 403,
        foreign: 404,
      },
      false,
    ),
  },
  {
    // Owner and Admin only; the answer is 204 even for an unknown address (T-79).
    method: 'POST',
    path: '/api/orgs/:orgId/members',
    request: `${ORG}/members`,
    body: { email: CLOUD_TARGET_EMAIL, role: 'viewer' },
    expect: guarded(
      {
        owner: 204,
        admin: 204,
        editor: 403,
        viewer: 403,
        billing: 403,
        foreign: 404,
      },
      true,
    ),
  },
  {
    // Role change among the lower roles: an Admin may, nobody below.
    name: 'change role',
    method: 'PATCH',
    path: '/api/orgs/:orgId/members/:accountId',
    request: MEMBER,
    body: { role: 'editor' },
    expect: guarded(
      {
        owner: 200,
        admin: 200,
        editor: 403,
        viewer: 403,
        billing: 403,
        foreign: 404,
      },
      true,
    ),
  },
  {
    // The release permission is an Owner's alone (SEC-52): an Admin who may change the role may
    // not grant it, an Editor (with or without it) may not grant it to anybody.
    name: 'grant release',
    method: 'PATCH',
    path: '/api/orgs/:orgId/members/:accountId',
    request: MEMBER,
    body: { role: 'editor', releaseGranted: true },
    expect: guarded(
      {
        owner: 200,
        admin: 403,
        editor: 403,
        viewer: 403,
        billing: 403,
        foreign: 404,
      },
      true,
    ),
  },
  {
    // Role escalation: nobody but an Owner makes an Owner.
    name: 'make owner',
    method: 'PATCH',
    path: '/api/orgs/:orgId/members/:accountId',
    request: MEMBER,
    body: { role: 'owner' },
    expect: guarded(
      {
        owner: 200,
        admin: 403,
        editor: 403,
        viewer: 403,
        billing: 403,
        foreign: 404,
      },
      true,
    ),
  },
  {
    method: 'DELETE',
    path: '/api/orgs/:orgId/members/:accountId',
    request: MEMBER,
    expect: guarded(
      {
        owner: 204,
        admin: 204,
        editor: 403,
        viewer: 403,
        billing: 403,
        foreign: 404,
      },
      true,
    ),
  },
  {
    method: 'GET',
    path: '/api/orgs/:orgId/projects',
    request: `${ORG}/projects`,
    expect: guarded(
      {
        owner: 200,
        admin: 200,
        editor: 200,
        viewer: 200,
        billing: 403,
        foreign: 404,
      },
      false,
    ),
  },
  {
    method: 'POST',
    path: '/api/orgs/:orgId/projects',
    request: `${ORG}/projects`,
    body: { name: 'Shop' },
    expect: guarded(
      {
        owner: 201,
        admin: 201,
        editor: 201,
        viewer: 403,
        billing: 403,
        foreign: 404,
      },
      true,
    ),
  },
  {
    method: 'GET',
    path: '/api/orgs/:orgId/projects/:projectId',
    request: `${ORG}/projects/${CLOUD_IDS.projectA}`,
    expect: guarded(
      {
        owner: 200,
        admin: 200,
        editor: 200,
        viewer: 200,
        billing: 403,
        foreign: 404,
      },
      false,
    ),
  },
  {
    // IDOR: organisation B's project through A's path is not found by A's members.
    name: 'project of another organisation',
    method: 'GET',
    path: '/api/orgs/:orgId/projects/:projectId',
    request: `${ORG}/projects/${CLOUD_IDS.projectB}`,
    expect: guarded(
      {
        owner: 404,
        admin: 404,
        editor: 404,
        viewer: 404,
        billing: 403,
        foreign: 404,
      },
      false,
    ),
  },
  {
    // … and A's project through B's path is not found by B's Owner, nor by A's members.
    name: 'project of A through B',
    method: 'GET',
    path: '/api/orgs/:orgId/projects/:projectId',
    request: `/api/orgs/${CLOUD_IDS.orgB}/projects/${CLOUD_IDS.projectA}`,
    expect: guarded(
      {
        owner: 404,
        admin: 404,
        editor: 404,
        viewer: 404,
        billing: 404,
        foreign: 404,
      },
      false,
    ),
  },
  {
    method: 'DELETE',
    path: '/api/orgs/:orgId/projects/:projectId',
    request: `${ORG}/projects/${CLOUD_IDS.projectA}`,
    expect: guarded(
      {
        owner: 204,
        admin: 204,
        editor: 403,
        viewer: 403,
        billing: 403,
        foreign: 404,
      },
      true,
    ),
  },
  {
    name: 'delete project of another organisation',
    method: 'DELETE',
    path: '/api/orgs/:orgId/projects/:projectId',
    request: `${ORG}/projects/${CLOUD_IDS.projectB}`,
    expect: guarded(
      {
        owner: 404,
        admin: 404,
        editor: 403,
        viewer: 403,
        billing: 403,
        foreign: 404,
      },
      true,
    ),
  },
  {
    method: 'GET',
    path: '/api/orgs/:orgId/projects/:projectId/config',
    request: `${PROJECT}/config`,
    expect: guarded(
      {
        owner: 200,
        admin: 200,
        editor: 200,
        viewer: 200,
        billing: 403,
        foreign: 404,
      },
      false,
    ),
  },
  {
    name: 'replace moat.yaml',
    method: 'PUT',
    path: '/api/orgs/:orgId/projects/:projectId/config',
    request: `${PROJECT}/config`,
    body: { text: `${CLOUD_CONFIG_TEXT}# changed\n`, base: CLOUD_CONFIG_HASH },
    expect: guarded(
      {
        owner: 200,
        admin: 200,
        editor: 200,
        viewer: 403,
        billing: 403,
        foreign: 404,
      },
      true,
    ),
  },
  {
    method: 'POST',
    path: '/api/orgs/:orgId/projects/:projectId/config/edits',
    request: `${PROJECT}/config/edits`,
    body: {
      base: CLOUD_CONFIG_HASH,
      op: 'addEnvironment',
      environment: 'staging',
    },
    expect: guarded(
      {
        owner: 200,
        admin: 200,
        editor: 200,
        viewer: 403,
        billing: 403,
        foreign: 404,
      },
      true,
    ),
  },
  {
    method: 'GET',
    path: '/api/orgs/:orgId/projects/:projectId/gates',
    request: `${PROJECT}/gates`,
    expect: guarded(
      {
        owner: 200,
        admin: 200,
        editor: 200,
        viewer: 200,
        billing: 403,
        foreign: 404,
      },
      false,
    ),
  },
  {
    name: 'enrol a gate: Owner and Admin only',
    method: 'POST',
    path: '/api/orgs/:orgId/projects/:projectId/gates',
    request: `${PROJECT}/gates`,
    body: {
      name: 'shop',
      gateId: pad('gateShop'),
      boxKey: CLOUD_GATE.boxKey,
      fingerprint: CLOUD_GATE.fingerprint,
    },
    expect: guarded(
      {
        owner: 201,
        admin: 201,
        editor: 403,
        viewer: 403,
        billing: 403,
        foreign: 404,
      },
      true,
    ),
  },
  {
    name: 'delete a gate: Owner and Admin only',
    method: 'DELETE',
    path: '/api/orgs/:orgId/projects/:projectId/gates/:gate',
    request: GATE,
    expect: guarded(
      {
        owner: 204,
        admin: 204,
        editor: 403,
        viewer: 403,
        billing: 403,
        foreign: 404,
      },
      true,
    ),
  },
  {
    method: 'POST',
    path: '/api/orgs/:orgId/projects/:projectId/gates/:gate/pull-address',
    request: `${GATE}/pull-address`,
    expect: guarded(
      {
        owner: 201,
        admin: 201,
        editor: 403,
        viewer: 403,
        billing: 403,
        foreign: 404,
      },
      true,
    ),
  },
  {
    method: 'GET',
    path: '/api/orgs/:orgId/projects/:projectId/gates/:gate/secrets',
    request: `${GATE}/secrets`,
    expect: guarded(
      {
        owner: 200,
        admin: 200,
        editor: 200,
        viewer: 200,
        billing: 403,
        foreign: 404,
      },
      false,
    ),
  },
  {
    method: 'PUT',
    path: '/api/orgs/:orgId/projects/:projectId/gates/:gate/secrets/:name',
    request: `${GATE}/secrets/api-key`,
    body: { sealed: CLOUD_SEALED },
    expect: guarded(
      {
        owner: 200,
        admin: 200,
        editor: 200,
        viewer: 403,
        billing: 403,
        foreign: 404,
      },
      true,
    ),
  },
  {
    name: 'preview',
    method: 'GET',
    path: '/api/orgs/:orgId/projects/:projectId/gates/:gate/release',
    request: `${GATE}/release`,
    expect: guarded(
      {
        owner: 200,
        admin: 200,
        editor: 200,
        viewer: 200,
        billing: 403,
        foreign: 404,
      },
      false,
    ),
  },
  {
    // The separate sign/release permission (SEC-52): a role is not enough, the flag decides. A wrong
    // digest answers 409 to whoever may sign (nothing is signed), 403 to everybody else.
    name: 'sign the next bundle: needs the release permission',
    method: 'POST',
    path: '/api/orgs/:orgId/projects/:projectId/gates/:gate/releases',
    request: `${GATE}/releases`,
    body: { digest: '0'.repeat(64) },
    expect: {
      ...guarded(
        {
          owner: 409,
          admin: 403,
          editor: 409,
          viewer: 403,
          billing: 403,
          foreign: 404,
        },
        true,
      ),
      editorANoRelease: 403,
    },
  },
  {
    // A bundle for a gate whose customer holds the key is uploaded, never signed here: this gate is
    // managed, so whoever may release gets 422 `not_signed`.
    name: 'upload a bundle: needs the release permission',
    method: 'POST',
    path: '/api/orgs/:orgId/projects/:projectId/gates/:gate/bundles',
    request: `${GATE}/bundles`,
    body: { envelope: '{}' },
    expect: {
      ...guarded(
        {
          owner: 422,
          admin: 403,
          editor: 422,
          viewer: 403,
          billing: 403,
          foreign: 404,
        },
        true,
      ),
      editorANoRelease: 403,
    },
  },
  {
    // A gate's pull: no session, the address is the credential. An unknown token is a 404 for all.
    method: 'GET',
    path: '/api/pull/:token',
    request: `/api/pull/${'T'.repeat(43)}`,
    expect: open(404, false),
  },
];
