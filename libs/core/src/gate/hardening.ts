/**
 * The hardening check (SEC-49, SEC-49a): from what a gate knows about its own hosting, the
 * hardening level that is actually in force plus the findings behind it. Pure: the facts are
 * collected by the gate (its web process and its CLI), this only classifies them, the same in
 * every implementation (conformance/vectors/gate/hardening.json).
 *
 * Honesty rule (ANFORDERUNGEN.md §1.5, §2.9): the level is never stronger than what was checked.
 * Without fresh facts of the web process, a clear process user and a passed check from outside
 * (tied to this gate) there is no level at all;
 * H2 and H3 are not claimed, because no gate stores its keys outside the webroot yet.
 */

/** The levels a check can report: H1 «Basis», H1 with a shared user «Unsicher für Secrets». */
export const HARDENING_LEVELS = ['unsafe', 'h1'] as const;
export type HardeningLevel = (typeof HARDENING_LEVELS)[number];

export const FINDING_SEVERITIES = ['unsafe', 'warn', 'info'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/** The closed list of findings, in the order a report lists them, each with its severity. */
export const HARDENING_FINDINGS = {
  /** SEC-49a, T-41: other websites on the server run as the same user and nothing fences PHP in. */
  shared_user: 'unsafe',
  /** SEC-49: a data file (or the folder listing) can be fetched from outside. */
  data_reachable: 'unsafe',
  /** The local policy has a `testing` block (loopback upstreams, an extra CA). */
  policy_testing: 'unsafe',
  /** No request has reached the gate yet, so its web process is unknown. */
  web_not_seen: 'info',
  /** The web process's facts are older than WEB_FACTS_STALE_SECONDS. */
  web_facts_stale: 'warn',
  /** A generic web server user, but open_basedir fences PHP in (other languages are not). */
  shared_user_basedir: 'warn',
  /** Not clear whether the process user is this site's own (unknown name, or not the owner). */
  user_unclear: 'warn',
  /** The check from outside was not run (no URL given). */
  external_not_checked: 'warn',
  /** The check from outside could not reach the gate. */
  external_failed: 'warn',
  /** The URL does not answer like this gate, so the check from outside proves nothing. */
  external_not_gate: 'warn',
  /** The data folder or a data file can be read by the group or by everyone. */
  data_permissions_open: 'warn',
  /** The web process may overwrite the gate's own code file. */
  code_writable: 'warn',
  /** PHP may include code from URLs (`allow_url_include`). */
  url_include: 'warn',
  /** No local policy yet: the gate serves nothing. */
  policy_missing: 'info',
  /** H1: keys and policy live in the webroot, behind access rules only (H2 is not supported yet). */
  data_in_webroot: 'info',
} as const satisfies Record<string, FindingSeverity>;
export type HardeningFinding = keyof typeof HARDENING_FINDINGS;

/** Findings that leave too much unchecked to claim any level (besides every `unsafe` one). */
export const BLOCKS_LEVEL: readonly HardeningFinding[] = [
  'web_not_seen',
  'web_facts_stale',
  'user_unclear',
  'external_not_checked',
  'external_failed',
  'external_not_gate',
];

/** Users that web servers run as for every site on a host (Debian, RHEL, SUSE, BSD, macOS, …). */
export const GENERIC_WEB_USERS = [
  'apache',
  'apache2',
  'daemon',
  'http',
  'httpd',
  'lighttpd',
  'nginx',
  'nobody',
  'www',
  'www-data',
  'wwwrun',
  '_www',
] as const;

/** After a week the web process's facts are reported as old (the gate refreshes them daily). */
export const WEB_FACTS_STALE_SECONDS = 7 * 24 * 60 * 60;

/** What the gate's web process saw of itself on its last recorded request. */
export interface WebFacts {
  /** Unix time of the observation. */
  at: number;
  /** The process user's name; null when the host does not say (no posix extension). */
  user: string | null;
  /** Whether the process user owns the gate file (a per-site user); null when unknown. */
  ownsFiles: boolean | null;
  openBasedir: boolean;
  codeWritable: boolean;
  allowUrlInclude: boolean;
}

export const EXTERNAL_RESULTS = [
  'not_checked',
  'failed',
  'not_gate',
  'blocked',
  'reachable',
] as const;
export type ExternalResult = (typeof EXTERNAL_RESULTS)[number];

export interface HardeningFacts {
  now: number;
  /** null: no request has reached the gate since it was installed. */
  web: WebFacts | null;
  /** Group or other permission bits on the data folder or a data file. */
  dataPermissionsOpen: boolean;
  policy: 'missing' | 'installed' | 'testing';
  external: ExternalResult;
}

export interface HardeningReport {
  /** null: not enough was checked to claim any level. */
  level: HardeningLevel | null;
  findings: HardeningFinding[];
}

export type WebUser = 'per_site' | 'shared' | 'unclear';

/**
 * Whose user the web process runs as. A generic web server name is shared, whoever owns the gate
 * file (an uploader running as www-data owns it too). Per-site only when the name is known, not
 * generic, and the process owns the gate file. An unknown name is shared unless the process owns
 * the file, then unclear.
 */
export function webUser(web: WebFacts): WebUser {
  if (web.user === null) return web.ownsFiles === true ? 'unclear' : 'shared';
  if ((GENERIC_WEB_USERS as readonly string[]).includes(web.user))
    return 'shared';
  return web.ownsFiles === true ? 'per_site' : 'unclear';
}

export function classifyHardening(facts: HardeningFacts): HardeningReport {
  const found = new Set<HardeningFinding>();
  const web = facts.web;
  if (web === null) {
    found.add('web_not_seen');
  } else {
    if (facts.now - web.at > WEB_FACTS_STALE_SECONDS)
      found.add('web_facts_stale');
    const user = webUser(web);
    if (user === 'shared')
      found.add(web.openBasedir ? 'shared_user_basedir' : 'shared_user');
    if (user === 'unclear') found.add('user_unclear');
    if (web.codeWritable) found.add('code_writable');
    if (web.allowUrlInclude) found.add('url_include');
  }
  if (facts.external === 'reachable') found.add('data_reachable');
  else if (facts.external !== 'blocked')
    found.add(`external_${facts.external}`);
  if (facts.policy === 'testing') found.add('policy_testing');
  if (facts.policy === 'missing') found.add('policy_missing');
  if (facts.dataPermissionsOpen) found.add('data_permissions_open');
  found.add('data_in_webroot');

  const findings = (
    Object.keys(HARDENING_FINDINGS) as HardeningFinding[]
  ).filter((code) => found.has(code));
  const level: HardeningLevel | null = findings.some(
    (code) => HARDENING_FINDINGS[code] === 'unsafe',
  )
    ? 'unsafe'
    : findings.some((code) => BLOCKS_LEVEL.includes(code))
      ? null
      : 'h1';
  return { level, findings };
}
