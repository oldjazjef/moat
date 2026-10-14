import { createHash } from 'node:crypto';

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
  /** The URL the spec calls, when `path` has parameters (ids seeded by the spec). */
  readonly request?: string;
  /** A JSON body the spec sends with the request. */
  readonly body?: unknown;
  readonly expect: Readonly<Record<Identity, number>>;
}

const LOCAL_ONLY = {
  noToken: 403,
  wrongToken: 403,
  foreignHost: 403,
  desktop: 200,
} as const;

/** Projects the spec seeds into the project list before it boots the API. */
export const SEEDED_PROJECT = 'seededProject000000000';
export const SEEDED_REMOVABLE = 'seededRemovable0000000';
/** The seeded project's moat.yaml, and the hash an edit of it names as its base. */
export const SEEDED_CONFIG = `version: 1
upstreams:
  hubspot:
    origin: "https://api.hubapi.com"
routes:
  newsletter:
    method: POST
    path: "/newsletter"
    upstream: hubspot
    upstreamPath: "/contacts"
`;
const SEEDED_CONFIG_HASH = createHash('sha256')
  .update(SEEDED_CONFIG, 'utf8')
  .digest('hex');

/** A gate as `php moat-gate.php install` prints it (TEST ONLY values, no gate behind them). */
const SEEDED_GATE = {
  name: 'www',
  gateId: 'seededGate000000000000',
  boxKey: 'B'.repeat(42) + 'A',
};

export const AUTHZ_MATRIX: readonly AuthzEntry[] = [
  { method: 'GET', path: '/api/health', expect: LOCAL_ONLY },
  { method: 'GET', path: '/api/projects', expect: LOCAL_ONLY },
  {
    method: 'GET',
    path: '/api/projects/:id',
    request: `/api/projects/${SEEDED_PROJECT}`,
    expect: LOCAL_ONLY,
  },
  {
    // Only takes the project off the list; the desktop is the only caller that gets through.
    method: 'DELETE',
    path: '/api/projects/:id',
    request: `/api/projects/${SEEDED_REMOVABLE}`,
    expect: { ...LOCAL_ONLY, desktop: 204 },
  },
  {
    // Writes moat.yaml: the desktop only, and only through the closed list of edits.
    method: 'POST',
    path: '/api/projects/:id/config/edits',
    request: `/api/projects/${SEEDED_PROJECT}/config/edits`,
    body: {
      base: SEEDED_CONFIG_HASH,
      op: 'addEnvironment',
      environment: 'staging',
    },
    expect: LOCAL_ONLY,
  },
  {
    // Writes nothing: the gate with its fingerprint, for the person to compare (SEC-32).
    method: 'POST',
    path: '/api/projects/:id/gates/check',
    request: `/api/projects/${SEEDED_PROJECT}/gates/check`,
    body: SEEDED_GATE,
    expect: LOCAL_ONLY,
  },
  {
    // Pins a gate only with the fingerprint check showed; this one is wrong, so even the desktop
    // gets 422 `fingerprint_mismatch` and nothing is written.
    method: 'POST',
    path: '/api/projects/:id/gates',
    request: `/api/projects/${SEEDED_PROJECT}/gates`,
    body: { ...SEEDED_GATE, fingerprint: 'MOAT-AAAA' },
    expect: { ...LOCAL_ONLY, desktop: 422 },
  },
  { method: 'GET', path: '/api/recipes', expect: LOCAL_ONLY },
  {
    // Reads moat.yaml and proposes a policy (SEC-14); writes nothing.
    method: 'GET',
    path: '/api/projects/:id/policy',
    request: `/api/projects/${SEEDED_PROJECT}/policy`,
    expect: LOCAL_ONLY,
  },
  {
    // Calls out (T-59): the desktop only. Plain HTTP to another host is refused before anything
    // is sent, so even the desktop gets 422 `url_invalid` and the spec makes no request.
    method: 'POST',
    path: '/api/projects/:id/test-request',
    request: `/api/projects/${SEEDED_PROJECT}/test-request`,
    body: {
      url: 'http://www.example.ch/moat-gate.php',
      route: 'newsletter',
      body: '{}',
    },
    expect: { ...LOCAL_ONLY, desktop: 422 },
  },
  {
    // Calls out (DT-07, T-59): the desktop only. Plain HTTP to another host is refused before
    // anything is sent, so even the desktop gets 422 `url_invalid` and the spec makes no request.
    method: 'POST',
    path: '/api/projects/:id/hardening-check',
    request: `/api/projects/${SEEDED_PROJECT}/hardening-check`,
    body: {
      url: 'http://www.example.ch/moat-gate.php',
      dataFolder: `moat-data-${'0'.repeat(32)}`,
    },
    expect: { ...LOCAL_ONLY, desktop: 422 },
  },
  {
    // Sends nothing anywhere: the answer is worked out from the seeded moat.yaml (FR-42).
    method: 'POST',
    path: '/api/projects/:id/dry-run',
    request: `/api/projects/${SEEDED_PROJECT}/dry-run`,
    body: {
      method: 'POST',
      path: '/newsletter',
      contentType: 'application/json',
      body: '{}',
    },
    expect: LOCAL_ONLY,
  },
  { method: 'GET', path: '/api/setup', expect: LOCAL_ONLY },
  {
    method: 'PATCH',
    path: '/api/setup',
    body: {
      currentStep: 'summary',
      states: { language: 'done', project: 'done' },
    },
    expect: LOCAL_ONLY,
  },
  {
    // Order matters: after the PATCH above the required steps are done (the seeded projects
    // are listed), so the desktop gets 200.
    method: 'POST',
    path: '/api/setup/complete',
    expect: LOCAL_ONLY,
  },
];
