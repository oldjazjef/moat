import { isMap, parseDocument, YAMLMap, type Document } from 'yaml';
import { NAME } from './compiled';
import { loadMoatYaml } from './yaml';

/**
 * Small, targeted edits of moat.yaml through the `yaml` Document API, so comments, key order and
 * formatting stay as written (CLAUDE.md, YAML standards). Each edit loads the text strictly first
 * (loadMoatYaml), changes only the keys it names and loads the result again, so an edit can never
 * produce a file the loader refuses. Pure: text in, text out.
 */

export class ConfigEditError extends Error {
  override readonly name = 'ConfigEditError';

  constructor(
    readonly code:
      'name_invalid' | 'environment_unknown' | 'gate_in_other_environment',
    message: string,
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
  const text = doc.toString();
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
