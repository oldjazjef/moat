import {
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  Scalar,
  YAMLMap,
  YAMLSeq,
  visit,
  type Document,
} from 'yaml';
import { MoatRejection } from '../errors';
import { compileConfig } from './compile';
import { LIMIT_SCOPES, METHODS, NAME, type QuotaPeriod } from './compiled';
import type { MoatConfig } from './schema';
import { parseDuration, parseSize } from './units';
import { ConfigError, loadMoatYaml } from './yaml';

/**
 * Small, targeted edits of moat.yaml through the `yaml` Document API, so comments, key order and
 * formatting stay as written (CLAUDE.md, YAML standards). Each edit loads the text strictly first
 * (loadMoatYaml), changes only the keys it names and loads the result again, so an edit can never
 * produce a file the loader refuses. Pure: text in, text out.
 */

export type ConfigEditCode =
  | 'name_invalid'
  | 'environment_unknown'
  | 'gate_in_other_environment'
  | 'route_exists'
  | 'route_unknown'
  | 'upstream_unknown'
  | 'route_conflict'
  | 'upstream_exists'
  | 'upstream_in_use'
  | 'value_invalid';

export class ConfigEditError extends Error {
  override readonly name = 'ConfigEditError';

  constructor(
    readonly code: ConfigEditCode,
    message: string,
    /**
     * For `value_invalid`: the route's or upstream's fields that were refused, e.g. `path`,
     * `origins.1`, `auth.name`. For `upstream_in_use`: the routes that call the upstream.
     */
    readonly fields: readonly string[] = [],
  ) {
    super(message);
  }
}

function document(text: string): Document {
  loadMoatYaml(text);
  return parseDocument(text, {
    version: '1.2',
    schema: 'core',
    uniqueKeys: true,
    merge: false,
    strict: true,
    prettyErrors: false,
  });
}

function checked(doc: Document): string {
  // `['a', 'b']` stays as written (and as Prettier writes it); the default would pad it to `[ 'a', 'b' ]`.
  const text = doc.toString({ flowCollectionPadding: false });
  loadMoatYaml(text);
  return text;
}

function checkName(kind: string, value: string): void {
  if (!NAME.test(value))
    throw new ConfigEditError(
      'name_invalid',
      `${kind} must match ${NAME.source}`,
    );
}

/** An empty map, written `{}` until it gets keys (see setIn). */
function emptyMap(): YAMLMap {
  const map = new YAMLMap();
  map.flow = true;
  return map;
}

/**
 * doc.setIn, but an empty `{}` it writes into turns into a block map first, so the new key goes on
 * its own line. A map the author wrote in flow style with keys stays as written.
 */
function setIn(doc: Document, path: string[], value: unknown): void {
  const parent = doc.getIn(path.slice(0, -1), true);
  if (isMap(parent) && parent.flow === true && parent.items.length === 0)
    parent.flow = false;
  doc.setIn(path, value);
}

/** doc.deleteIn, and a block map left empty is written `{}` again. */
function deleteIn(doc: Document, path: string[]): void {
  doc.deleteIn(path);
  const parent = doc.getIn(path.slice(0, -1), true);
  if (isMap(parent) && parent.items.length === 0) parent.flow = true;
}

/** Order of the top-level sections this module may create: right after `version`. */
const SECTIONS = ['version', 'environments', 'gates'];

/** Inserts `key: {}` under the top-level map `section`, creating the section in SECTIONS order. */
function ensureEntry(doc: Document, section: string, key: string): void {
  const root = doc.contents;
  if (!isMap(root)) throw new Error('moat.yaml is not a map');
  if (!doc.hasIn([section])) {
    const before = SECTIONS.slice(0, SECTIONS.indexOf(section));
    const at = root.items.reduce(
      (last, pair, index) => (before.includes(String(pair.key)) ? index : last),
      -1,
    );
    root.items.splice(at + 1, 0, doc.createPair(section, emptyMap()));
  }
  if (!doc.hasIn([section, key])) setIn(doc, [section, key], emptyMap());
}

function setEnabled(doc: Document, path: string[], enabled: boolean): void {
  // Enabled is the default: unlocking removes the key instead of writing `true`.
  if (enabled) deleteIn(doc, [...path, 'enabled']);
  else setIn(doc, [...path, 'enabled'], false);
}

function environments(text: string): Record<string, unknown> {
  return loadMoatYaml(text).environments ?? {};
}

/** `environments.<env>` exists afterwards. */
export function addEnvironment(text: string, environment: string): string {
  checkName('environment name', environment);
  const doc = document(text);
  ensureEntry(doc, 'environments', environment);
  return checked(doc);
}

/** Locks (`enabled: false`) or unlocks an existing environment. */
export function setEnvironmentEnabled(
  text: string,
  environment: string,
  enabled: boolean,
): string {
  checkName('environment name', environment);
  if (!Object.hasOwn(environments(text), environment))
    throw new ConfigEditError(
      'environment_unknown',
      `no environment "${environment}" in moat.yaml`,
    );
  const doc = document(text);
  setEnabled(doc, ['environments', environment], enabled);
  return checked(doc);
}

/** Locks or unlocks one gate; creates its `gates.<gate>` entry when needed. */
export function setGateEnabled(
  text: string,
  gate: string,
  enabled: boolean,
): string {
  checkName('gate name', gate);
  const doc = document(text);
  if (!enabled) ensureEntry(doc, 'gates', gate);
  if (doc.hasIn(['gates', gate])) setEnabled(doc, ['gates', gate], enabled);
  return checked(doc);
}

/**
 * Puts a gate into an environment (created when missing). A gate belongs to at most one
 * environment: moving it out of another one is refused unless `move` is set.
 */
export function assignGate(
  text: string,
  gate: string,
  environment: string,
  move = false,
): string {
  checkName('gate name', gate);
  checkName('environment name', environment);
  const current = loadMoatYaml(text).gates?.[gate]?.environment;
  if (current !== undefined && current !== environment && !move)
    throw new ConfigEditError(
      'gate_in_other_environment',
      `gate "${gate}" is in environment "${current}"`,
    );
  const doc = document(text);
  ensureEntry(doc, 'environments', environment);
  ensureEntry(doc, 'gates', gate);
  setIn(doc, ['gates', gate, 'environment'], environment);
  return checked(doc);
}

/** A route as Moat Desktop edits it. `enabled` has its own edit (setRouteEnabled). */
export interface RouteInput {
  readonly method: (typeof METHODS)[number];
  readonly path: string;
  readonly upstream: string;
  readonly upstreamPath: string;
  /** e.g. "16KiB"; absent = the default (64 KiB), and the key is removed. */
  readonly maxBodySize?: string;
  /** Browser origins allowed to call the route; absent or empty = the key is removed. */
  readonly origins?: readonly string[];
  /** Absent = the key is removed (only the local policy's limits apply). */
  readonly rateLimit?: {
    readonly requests: number;
    readonly window: string;
    readonly per?: (typeof LIMIT_SCOPES)[number];
  };
  /** FR-31: requests per calendar day or month (UTC). Absent = the key is removed. */
  readonly quota?: {
    readonly requests: number;
    readonly period: QuotaPeriod;
  };
}

/** Same value as written, so the author's spelling ("10m" vs "600s") is kept. */
type Same = (written: unknown, value: unknown) => boolean;
const sameText: Same = (written, value) => written === value;
const sameDuration: Same = (written, value) =>
  typeof written === 'string' &&
  typeof value === 'string' &&
  parseDuration(written) !== null &&
  parseDuration(written) === parseDuration(value);
const sameSize: Same = (written, value) =>
  typeof written === 'string' &&
  typeof value === 'string' &&
  parseSize(written) !== null &&
  parseSize(written) === parseSize(value);

/** The quote style the author uses: that of the first quoted value in the file (default `"`). */
function quoteStyle(doc: Document): Scalar.Type {
  let style: Scalar.Type = Scalar.QUOTE_DOUBLE;
  visit(doc, {
    Scalar(_key, node) {
      if (
        node.type === Scalar.QUOTE_SINGLE ||
        node.type === Scalar.QUOTE_DOUBLE
      ) {
        style = node.type;
        return visit.BREAK;
      }
      return undefined;
    },
  });
  return style;
}

/**
 * Sets a scalar unless it already holds the same value. Strings that could read as another type
 * are quoted (CLAUDE.md, YAML standards), in the quote style already used at that key.
 */
function setScalar(
  doc: Document,
  path: string[],
  value: string | number,
  quoted: boolean,
  same: Same = sameText,
): void {
  const node = doc.getIn(path, true);
  if (isScalar(node) && same(node.value, value)) return;
  if (isScalar(node) && typeof node.value === typeof value) {
    // Changed in place: the comment next to it and its quote style stay.
    node.value = value;
    if (quoted && node.type !== Scalar.QUOTE_SINGLE)
      node.type = Scalar.QUOTE_DOUBLE;
    return;
  }
  const scalar = new Scalar(value);
  if (quoted) scalar.type = quoteStyle(doc);
  setIn(doc, path, scalar);
}

/** A list of quoted strings, in the style (flow or block) already used at that key. */
function setList(doc: Document, path: string[], values: readonly string[]) {
  const node = doc.getIn(path, true);
  if (
    isSeq(node) &&
    node.items.length === values.length &&
    node.items.every(
      (item, index) => isScalar(item) && item.value === values[index],
    )
  )
    return;
  const seq = new YAMLSeq();
  seq.flow = isSeq(node) ? node.flow === true : true;
  const style = quoteStyle(doc);
  for (const value of values) {
    const scalar = new Scalar(value);
    scalar.type = style;
    seq.items.push(scalar);
  }
  setIn(doc, path, seq);
}

/** Every secret the upstreams use: what a bundle of this config must carry. */
function secretsOf(config: MoatConfig): string[] {
  return Object.values(config.upstreams).flatMap((upstream) =>
    upstream.auth === undefined || upstream.auth === null
      ? []
      : [upstream.auth.secret],
  );
}

/**
 * The text of an edited route or upstream, checked like readProject checks it: the loader (field by
 * field, reported as `value_invalid` with the entry's fields), then the compiled config a bundle
 * would carry.
 */
function checkedEntry(
  doc: Document,
  section: 'routes' | 'upstreams',
  name: string,
): string {
  const what = `${section === 'routes' ? 'route' : 'upstream'} "${name}"`;
  let config: MoatConfig;
  let text: string;
  try {
    text = checked(doc);
    config = loadMoatYaml(text);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    const fields = error.issues
      .filter((issue) => issue.path[0] === section && issue.path[1] === name)
      .map((issue) => issue.path.slice(2).join('.'))
      .filter((field) => field !== '');
    throw new ConfigEditError(
      'value_invalid',
      `${what}: ${error.message}`,
      fields,
    );
  }
  try {
    compileConfig(config, secretsOf(config));
  } catch (error) {
    if (!(error instanceof MoatRejection)) throw error;
    throw new ConfigEditError('value_invalid', `${what} is invalid`);
  }
  return text;
}

/**
 * Adds the route `route` (`create`) or changes an existing one. Only the keys whose value changes
 * are written, so comments and the author's spelling of unchanged values stay; `contentTypes`,
 * `responseContentTypes` and `enabled` are left as they are.
 */
export function setRoute(
  text: string,
  route: string,
  input: RouteInput,
  mode: 'create' | 'update',
): string {
  checkName('route name', route);
  checkName('upstream name', input.upstream);
  const config = loadMoatYaml(text);
  const exists = Object.hasOwn(config.routes, route);
  if (mode === 'create' && exists)
    throw new ConfigEditError('route_exists', `route "${route}" exists`);
  if (mode === 'update' && !exists)
    throw new ConfigEditError('route_unknown', `no route "${route}"`);
  if (!Object.hasOwn(config.upstreams, input.upstream))
    throw new ConfigEditError(
      'upstream_unknown',
      `no upstream "${input.upstream}"`,
    );
  const clash = Object.entries(config.routes).find(
    ([name, other]) =>
      name !== route &&
      other.method === input.method &&
      other.path === input.path,
  );
  if (clash !== undefined)
    throw new ConfigEditError(
      'route_conflict',
      `route "${clash[0]}" already answers ${input.method} ${input.path}`,
    );

  const doc = document(text);
  const at = (...keys: string[]) => ['routes', route, ...keys];
  if (!exists) setIn(doc, at(), emptyMap());
  setScalar(doc, at('method'), input.method, false);
  setScalar(doc, at('path'), input.path, true);
  setScalar(doc, at('upstream'), input.upstream, false);
  setScalar(doc, at('upstreamPath'), input.upstreamPath, true);
  if (input.maxBodySize === undefined) deleteIn(doc, at('maxBodySize'));
  else setScalar(doc, at('maxBodySize'), input.maxBodySize, true, sameSize);
  const limit = input.rateLimit;
  if (limit === undefined) deleteIn(doc, at('rateLimit'));
  else {
    if (!isMap(doc.getIn(at('rateLimit'), true)))
      setIn(doc, at('rateLimit'), emptyMap());
    setScalar(doc, at('rateLimit', 'requests'), limit.requests, false);
    setScalar(doc, at('rateLimit', 'window'), limit.window, true, sameDuration);
    // "ip" is the default: written only when the author wrote `per` already.
    if (limit.per === 'route' || doc.hasIn(at('rateLimit', 'per')))
      setScalar(doc, at('rateLimit', 'per'), limit.per ?? 'ip', false);
  }
  const quota = input.quota;
  if (quota === undefined) deleteIn(doc, at('quota'));
  else {
    if (!isMap(doc.getIn(at('quota'), true)))
      setIn(doc, at('quota'), emptyMap());
    setScalar(doc, at('quota', 'requests'), quota.requests, false);
    setScalar(doc, at('quota', 'period'), quota.period, false);
  }
  if (input.origins === undefined || input.origins.length === 0)
    deleteIn(doc, at('origins'));
  else setList(doc, at('origins'), input.origins);
  return checkedEntry(doc, 'routes', route);
}

/** Removes a route. */
export function removeRoute(text: string, route: string): string {
  checkName('route name', route);
  if (!Object.hasOwn(loadMoatYaml(text).routes, route))
    throw new ConfigEditError('route_unknown', `no route "${route}"`);
  const doc = document(text);
  deleteIn(doc, ['routes', route]);
  return checked(doc);
}

/** Switches a route off (`enabled: false`, the gate answers it like an unknown path) or on. */
export function setRouteEnabled(
  text: string,
  route: string,
  enabled: boolean,
): string {
  checkName('route name', route);
  if (!Object.hasOwn(loadMoatYaml(text).routes, route))
    throw new ConfigEditError('route_unknown', `no route "${route}"`);
  const doc = document(text);
  setEnabled(doc, ['routes', route], enabled);
  return checked(doc);
}

/** How the gate authenticates to an upstream; `secret` names a sealed secret, never a value. */
export type UpstreamAuthInput =
  | { readonly type: 'bearer'; readonly secret: string }
  | { readonly type: 'header'; readonly name: string; readonly secret: string }
  | { readonly type: 'query'; readonly param: string; readonly secret: string };

/** An upstream as Moat Desktop edits it. */
export interface UpstreamInput {
  /** `https://host[:port]`, no path. */
  readonly origin: string;
  /** Absent = the key is removed (the gate calls the API without credentials). */
  readonly auth?: UpstreamAuthInput;
  /** e.g. "10s"; absent = the default, and the key is removed. */
  readonly timeout?: string;
}

/** The keys of each auth type, in the order they are written. */
const AUTH_KEYS = {
  bearer: ['secret'],
  header: ['name', 'secret'],
  query: ['param', 'secret'],
} as const;

/**
 * Adds the upstream `upstream` (`create`) or changes an existing one. As setRoute, only changed
 * values are written. The secret is a name only: sealing it stays with the CLI (SEC-37).
 */
export function setUpstream(
  text: string,
  upstream: string,
  input: UpstreamInput,
  mode: 'create' | 'update',
): string {
  checkName('upstream name', upstream);
  if (input.auth !== undefined) checkName('secret name', input.auth.secret);
  const exists = Object.hasOwn(loadMoatYaml(text).upstreams, upstream);
  if (mode === 'create' && exists)
    throw new ConfigEditError(
      'upstream_exists',
      `upstream "${upstream}" exists`,
    );
  if (mode === 'update' && !exists)
    throw new ConfigEditError('upstream_unknown', `no upstream "${upstream}"`);

  const doc = document(text);
  const at = (...keys: string[]) => ['upstreams', upstream, ...keys];
  if (!exists) setIn(doc, at(), emptyMap());
  setScalar(doc, at('origin'), input.origin, true);
  const auth = input.auth;
  if (auth === undefined) deleteIn(doc, at('auth'));
  else {
    const written = doc.getIn(at('auth', 'type'));
    if (written !== auth.type || !isMap(doc.getIn(at('auth'), true)))
      setIn(doc, at('auth'), emptyMap());
    setScalar(doc, at('auth', 'type'), auth.type, false);
    for (const key of AUTH_KEYS[auth.type])
      setScalar(
        doc,
        at('auth', key),
        (auth as Record<string, string>)[key] ?? '',
        false,
      );
  }
  if (input.timeout === undefined) deleteIn(doc, at('timeout'));
  else setScalar(doc, at('timeout'), input.timeout, true, sameDuration);
  return checkedEntry(doc, 'upstreams', upstream);
}

/** Removes an upstream no route calls any more. */
export function removeUpstream(text: string, upstream: string): string {
  checkName('upstream name', upstream);
  const config = loadMoatYaml(text);
  if (!Object.hasOwn(config.upstreams, upstream))
    throw new ConfigEditError('upstream_unknown', `no upstream "${upstream}"`);
  const callers = Object.entries(config.routes)
    .filter(([, route]) => route.upstream === upstream)
    .map(([name]) => name);
  if (callers.length > 0)
    throw new ConfigEditError(
      'upstream_in_use',
      `upstream "${upstream}" is called by route ${callers.join(', ')}`,
      callers,
    );
  const doc = document(text);
  deleteIn(doc, ['upstreams', upstream]);
  return checked(doc);
}
