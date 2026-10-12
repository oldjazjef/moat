/**
 * The authorization matrix (SEC-70 ff., docs/SECURITY-TESTING.md): every API route with the
 * answer each identity must get. `authz-matrix.spec.ts` boots the real app, fails on a route
 * without an entry, and checks every cell. Never weaken an expectation to make it pass.
 *
 * Identities in local mode (Moat Desktop):
 *   noToken      no `x-moat-desktop` header — any other program or web page on this machine
 *   wrongToken   a token of the right length but not this launch's
 *   foreignHost  the right token, but a Host header other than 127.0.0.1:<port> (DNS rebinding, DT-16)
 *   desktop      the desktop shell itself (right token, right Host)
 *
 * The Cloud's identities (accounts, roles, release permission, other tenant = 404, API tokens,
 * gate credentials) join here with its auth.
 */
export const IDENTITIES = [
  'noToken',
  'wrongToken',
  'foreignHost',
  'desktop',
] as const;
export type Identity = (typeof IDENTITIES)[number];

export interface AuthzEntry {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** As registered, with the global prefix: `/api/project`. */
  readonly path: string;
  readonly expect: Readonly<Record<Identity, number>>;
}

const LOCAL_ONLY = {
  noToken: 403,
  wrongToken: 403,
  foreignHost: 403,
  desktop: 200,
} as const;

export const AUTHZ_MATRIX: readonly AuthzEntry[] = [
  { method: 'GET', path: '/api/health', expect: LOCAL_ONLY },
  { method: 'GET', path: '/api/project', expect: LOCAL_ONLY },
];
