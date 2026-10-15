import { usedSecrets } from '../config/secrets';
import { verifyBundle, type PinnedSigner } from '../bundle/bundle';
import { WEBAUTHN_ALG } from '../crypto/webauthn';
import { canonicalJson } from '../canonical/jcs';
import { compileConfig } from '../config/compile';
import type { CompiledConfig } from '../config/compiled';
import { gateLockState } from '../config/lock';
import type { MoatConfig } from '../config/schema';
import { ConfigError, loadMoatYaml } from '../config/yaml';
import { MoatRejection } from '../errors';
import type { JsonValue } from '../json/strict-json';
import type { SealedSecret } from '../secrets/seal';
import {
  CONFIG_FILE,
  GATE_ID,
  isRecord,
  jsonNames,
  latestBundle,
  NAME_PATTERN,
  parseJson,
} from './project';
import type { StoragePort } from './storage-port';

/**
 * What the next bundle of a gate would be, before anything is signed: the compiled config, the
 * sealed secrets it carries, its version, and what changes against the latest bundle built.
 * Moat Desktop shows the changes in its signing dialog (DT-15); the CLI signs the same input.
 * Pure: reads the project through the StoragePort only, opens no secret, signs nothing.
 */

/** One difference against the latest bundle. Never a secret: sealed secrets show their version only. */
export interface BundleChange {
  readonly kind: 'route' | 'upstream' | 'secret' | 'lock';
  /** Route, upstream or secret name; the gate's name for `lock`. */
  readonly name: string;
  /** For `lock`: `added` = the bundle locks the gate, `removed` = it unlocks it. */
  readonly change: 'added' | 'removed' | 'changed';
  /** What differs, field by field (`rateLimit.requests`, `origin`, …); empty for `lock`. */
  readonly fields: readonly FieldChange[];
}

export interface FieldChange {
  readonly field: string;
  /** The value as text (strings as they are, the rest as JSON); null when absent. */
  readonly before: string | null;
  readonly after: string | null;
}

/** Longer values are cut (the dialog shows them, the digest covers them in full). */
export const MAX_FIELD_TEXT = 200;
/**
 * The signer whose earlier bundles count for the comparison (and which verifies a bundle on
 * import and deploy). Ed25519 by default; with `passkey` it is a pinned WebAuthn ES256 passkey
 * (trust mode 2, docs/CRYPTO.md §7.1) — `publicKey` is then the 65-byte point.
 */
export interface PlanSigner {
  readonly kid: string;
  readonly publicKey: Uint8Array;
  readonly passkey?: {
    readonly rpId: string;
    readonly origins: readonly string[];
  };
}

/** The pinned key a gate would hold for this signer (what verifyBundle checks against). */
export function pinnedSignerOf(signer: PlanSigner): PinnedSigner {
  return signer.passkey === undefined
    ? { kid: signer.kid, alg: 'ed25519', publicKey: signer.publicKey }
    : {
        kid: signer.kid,
        alg: WEBAUTHN_ALG,
        publicKey: signer.publicKey,
        rpId: signer.passkey.rpId,
        origins: signer.passkey.origins,
      };
}

export interface BundlePlan {
  readonly gate: string;
  readonly gateId: string;
  /** The latest version built + 1. */
  readonly version: number;
  /** 0 when this is the gate's first bundle. */
  readonly previousVersion: number;
  /** The bundle locks the gate (moat.yaml `enabled: false` on it or its environment). */
  readonly locked: boolean;
  readonly config: CompiledConfig;
  /** moat.yaml as loaded: what buildBundle compiles and signs (giving `config` again). */
  readonly source: MoatConfig;
  /** The sealed secrets the config uses, by name (ciphertext only, SEC-31). */
  readonly secrets: Readonly<Record<string, SealedSecret>>;
  /**
   * Against the latest bundle; every route, upstream and secret as added when there is none, or
   * when it is not signed by the signer (a bundle file planted in the folder must not hide a
   * change, T-53).
   */
  readonly changes: readonly BundleChange[];
  /** `unverified`: there is a latest bundle, but not one this signer signed for this gate. */
  readonly previous: 'none' | 'verified' | 'unverified';
}

export type BundlePlanErrorCode =
  'config_missing' | 'config_invalid' | 'gate_unknown' | 'secrets_missing';

export class BundlePlanError extends Error {
  override readonly name = 'BundlePlanError';

  constructor(
    readonly code: BundlePlanErrorCode,
    /** For `secrets_missing`: the secrets not sealed for this gate yet. */
    readonly secrets: readonly string[] = [],
  ) {
    super(code);
  }
}

/**
 * `signer`: the key the person signs with. Only a latest bundle that verifies against it (as the
 * gate would, CRYPTO.md §4.3) is compared with; null when no key is chosen yet.
 */
export async function planBundle(
  storage: StoragePort,
  gate: string,
  signer: PlanSigner | null,
): Promise<BundlePlan> {
  if (!NAME_PATTERN.test(gate)) throw new BundlePlanError('gate_unknown');
  const gateId = readGateId(storage, gate);
  const text = storage.read(CONFIG_FILE);
  if (text === null) throw new BundlePlanError('config_missing');
  let parsed: MoatConfig;
  try {
    parsed = loadMoatYaml(text);
  } catch (error) {
    if (error instanceof ConfigError || error instanceof MoatRejection)
      throw new BundlePlanError('config_invalid');
    throw error;
  }
  const used = usedSecrets(parsed);
  const sealed = readSealed(storage, gate);
  const missing = used.filter((name) => !Object.hasOwn(sealed, name));
  if (missing.length > 0) throw new BundlePlanError('secrets_missing', missing);
  // Only what the config uses goes into the bundle (as buildBundle does).
  const secrets: Record<string, SealedSecret> = {};
  for (const name of used) secrets[name] = sealed[name] as SealedSecret;
  let config: CompiledConfig;
  try {
    config = compileConfig(parsed, used, gate);
  } catch (error) {
    if (error instanceof MoatRejection)
      throw new BundlePlanError('config_invalid');
    throw error;
  }
  const previousVersion = latestBundle(storage, gate);
  const previous =
    previousVersion === 0 || signer === null
      ? null
      : await readPayload(storage, gate, previousVersion, gateId, signer);
  return {
    gate,
    gateId,
    version: previousVersion + 1,
    previousVersion,
    locked: !gateLockState(parsed, gate).enabled,
    config,
    source: parsed,
    secrets,
    changes: diff(gate, previous, config, secrets),
    previous:
      previousVersion === 0
        ? 'none'
        : previous === null
          ? 'unverified'
          : 'verified',
  };
}

/** The gate id pinned in `gates/<gate>.json`; BundlePlanError `gate_unknown` when there is none. */
export function readGateId(storage: StoragePort, gate: string): string {
  const file = parseJson(storage.read(`gates/${gate}.json`));
  if (
    !isRecord(file) ||
    file['moat'] !== 'gate' ||
    file['v'] !== 1 ||
    typeof file['gateId'] !== 'string' ||
    !GATE_ID.test(file['gateId'])
  )
    throw new BundlePlanError('gate_unknown');
  return file['gateId'];
}

/** The well-formed sealed secrets of a gate; a damaged file counts as not sealed. */
export function readSealed(
  storage: StoragePort,
  gate: string,
): Record<string, SealedSecret> {
  const result: Record<string, SealedSecret> = {};
  for (const name of jsonNames(storage, `secrets/${gate}`)) {
    const value = parseJson(storage.read(`secrets/${gate}/${name}.json`));
    if (
      isRecord(value) &&
      value['v'] === 1 &&
      typeof value['alg'] === 'string' &&
      typeof value['secretVersion'] === 'number' &&
      Number.isSafeInteger(value['secretVersion']) &&
      typeof value['epk'] === 'string' &&
      typeof value['nonce'] === 'string' &&
      typeof value['ct'] === 'string'
    )
      result[name] = value as unknown as SealedSecret;
  }
  return result;
}

interface PreviousPayload {
  readonly config: Record<string, unknown>;
  readonly secrets: Record<string, unknown>;
}

/** The previous bundle's config and secrets, when it verifies against the signer; else null. */
async function readPayload(
  storage: StoragePort,
  gate: string,
  version: number,
  gateId: string,
  signer: PlanSigner,
): Promise<PreviousPayload | null> {
  const text = storage.read(`bundles/${gate}/${version}.json`);
  if (text === null) return null;
  let payload;
  try {
    ({ payload } = await verifyBundle(new TextEncoder().encode(text), {
      gateId,
      signers: [pinnedSignerOf(signer)],
      threshold: 1,
      currentVersion: version - 1,
      now: 0,
      expiryEnabled: false,
    }));
  } catch (error) {
    if (error instanceof MoatRejection) return null;
    throw error;
  }
  if (payload.version !== version) return null;
  const config = payload.config as unknown;
  const secrets = payload.secrets as unknown;
  if (!isRecord(config)) return null;
  return { config, secrets: isRecord(secrets) ? secrets : {} };
}

/** Bundle payloads are JCS (sorted keys); the compiled config is not: compare canonically. */
function same(a: unknown, b: unknown): boolean {
  try {
    return canonicalJson(a as JsonValue) === canonicalJson(b as JsonValue);
  } catch {
    // The previous bundle holds something JCS refuses: it differs from anything compiled now.
    return false;
  }
}

function changesOf(
  kind: BundleChange['kind'],
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fieldsOf: (before: unknown, after: unknown) => FieldChange[] = fieldChanges,
): BundleChange[] {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return names.sort().flatMap((name): BundleChange[] => {
    const had = Object.hasOwn(before, name);
    const has = Object.hasOwn(after, name);
    const fields = fieldsOf(
      had ? before[name] : undefined,
      has ? after[name] : undefined,
    );
    if (!had) return [{ kind, name, change: 'added', fields }];
    if (!has) return [{ kind, name, change: 'removed', fields }];
    return fields.length === 0
      ? []
      : [{ kind, name, change: 'changed', fields }];
  });
}

/** Leaf by leaf (`rateLimit.requests`); arrays count as one value. */
function leaves(value: unknown, prefix = ''): Map<string, unknown> {
  const result = new Map<string, unknown>();
  if (isRecord(value)) {
    for (const key of Object.keys(value).sort()) {
      for (const [path, leaf] of leaves(
        value[key],
        prefix === '' ? key : `${prefix}.${key}`,
      ))
        result.set(path, leaf);
    }
  } else if (value !== undefined && prefix !== '') {
    result.set(prefix, value);
  }
  return result;
}

function fieldChanges(before: unknown, after: unknown): FieldChange[] {
  const a = leaves(before);
  const b = leaves(after);
  const fields = [...new Set([...a.keys(), ...b.keys()])].sort();
  return fields.flatMap((field): FieldChange[] => {
    const old = a.get(field);
    const now = b.get(field);
    return same(old, now)
      ? []
      : [{ field, before: text(old), after: text(now) }];
  });
}

function text(value: unknown): string | null {
  if (value === undefined) return null;
  let result: string;
  try {
    result =
      typeof value === 'string' ? value : canonicalJson(value as JsonValue);
  } catch {
    result = '?';
  }
  return result.length > MAX_FIELD_TEXT
    ? `${result.slice(0, MAX_FIELD_TEXT)}…`
    : result;
}

/**
 * A sealed secret shows only its version (never ciphertext); new ciphertext under the same
 * version still counts as a change.
 */
function secretFields(before: unknown, after: unknown): FieldChange[] {
  const version = (value: unknown) =>
    isRecord(value) ? text(value['secretVersion']) : null;
  const ct = (value: unknown) => (isRecord(value) ? value['ct'] : undefined);
  if (
    before !== undefined &&
    after !== undefined &&
    version(before) === version(after) &&
    ct(before) === ct(after)
  )
    return [];
  return [
    { field: 'secretVersion', before: version(before), after: version(after) },
  ];
}

function diff(
  gate: string,
  previous: PreviousPayload | null,
  config: CompiledConfig,
  secrets: Record<string, SealedSecret>,
): BundleChange[] {
  const before = previous?.config ?? {};
  const record = (value: unknown) => (isRecord(value) ? value : {});
  const wasLocked = before['enabled'] === false;
  const isLocked = config.enabled === false;
  return [
    ...(wasLocked === isLocked
      ? []
      : [
          {
            kind: 'lock',
            name: gate,
            change: isLocked ? 'added' : 'removed',
            fields: [],
          } as const,
        ]),
    ...changesOf('route', record(before['routes']), config.routes),
    ...changesOf('upstream', record(before['upstreams']), config.upstreams),
    ...changesOf('secret', previous?.secrets ?? {}, secrets, secretFields),
  ];
}
