import { MAX_ENVELOPE_BYTES, verifyBundle } from '../bundle/bundle';
import { validateCompiledConfig } from '../config/compiled';
import { fromUtf8 } from '../encoding/utf8';
import { MoatRejection } from '../errors';
import { isJsonObject, type JsonValue } from '../json/strict-json';
import { SEALED_SECRET_ALG } from '../secrets/seal';
import { readZip, ZipReadError, type Inflate } from '../package/unzip';
import { BundlePlanError, readGateId, type PlanSigner } from './bundle-plan';
import { latestBundle, NAME_PATTERN } from './project';
import type { StoragePort } from './storage-port';

/**
 * Manual import of a signed bundle into the project (FR-45, DT-17, T-50): a `bundle-v<n>.json`,
 * a deploy package folder, or its ZIP — say one made on another machine with the same key. The
 * bundle is checked exactly as the gate would accept it (CRYPTO.md §4.3, steps 1–9): signed by
 * the person's own key (the only signer a gate of this project pins), for this gate's id, a
 * version above the project's latest bundle, strict JSON, a valid config. On top, the import
 * hardening of DT-17: no `__proto__`/`constructor`/`prototype` key anywhere, a strict ZIP reader
 * (Zip-Slip, links, duplicates, limits) and only the file names a package has. The policy and
 * the instructions in a package are ignored: the local policy is the gate's business (SEC-10).
 *
 * Pure: reads the project through the StoragePort and returns the exact bytes (as text) to write
 * to `bundles/<gate>/<version>.json` — never re-serialised.
 */

export type ImportSource =
  /** A single file the person chose (a `bundle-v<n>.json`, whatever it is called now). */
  | { readonly kind: 'bundle'; readonly bytes: Uint8Array }
  /** The bundle file of a package folder, chosen by packageBundleName. */
  | {
      readonly kind: 'package';
      readonly name: string;
      readonly bytes: Uint8Array;
    }
  /** A deploy package ZIP. Deflate entries only with `inflate` (core has no zlib). */
  | {
      readonly kind: 'zip';
      readonly bytes: Uint8Array;
      readonly inflate?: Inflate;
    };

export interface ImportPlan {
  readonly gate: string;
  readonly gateId: string;
  readonly version: number;
  /** The project's latest bundle before the import, 0 when none. */
  readonly previousVersion: number;
  /** The bundle locks the gate (`enabled: false`). */
  readonly locked: boolean;
  /** The bundle file exactly as received. */
  readonly bundle: string;
}

export type ImportPlanErrorCode =
  | 'gate_unknown'
  | 'too_large'
  | 'package_invalid'
  | 'bundle_invalid'
  | 'signature_invalid'
  | 'gate_mismatch'
  | 'version_not_newer'
  | 'config_invalid';

export class ImportPlanError extends Error {
  override readonly name = 'ImportPlanError';
  constructor(readonly code: ImportPlanErrorCode) {
    super(code);
  }
}

/** A package ZIP: a few small files (CRYPTO.md §4.3: a bundle is at most 1 MiB). */
export const IMPORT_ZIP_LIMITS = {
  maxBytes: 4 * 1024 * 1024,
  maxEntries: 8,
  maxEntryBytes: MAX_ENVELOPE_BYTES,
  maxTotalBytes: 4 * 1024 * 1024,
} as const;
/** A package folder holds at most this many entries. */
export const MAX_PACKAGE_ENTRIES = 8;
/** What a bundle file may be at most: CRYPTO.md §4.3 step 1. */
export const MAX_IMPORT_BUNDLE_BYTES = MAX_ENVELOPE_BYTES;
/** Bundle versions the project folder can list (`bundles/<gate>/<n>.json`, project.ts). */
const MAX_VERSION = 999_999_999;

const BUNDLE_FILE = /^bundle-v([1-9][0-9]{0,8})\.json$/;
/** What a deploy package holds besides the bundle (apps/desktop/src/main/lib/deploy.ts). */
const OTHER_FILES = new Set(['policy.json', 'LIESMICH.txt', 'README.txt']);
/** The folder a package ZIP keeps its files in: `moat-<gate>-v<n>`. */
const PACKAGE_FOLDER = /^moat-[a-z][a-z0-9-]{0,62}-v([1-9][0-9]{0,8})$/;
/** Keys that change an ordinary object's prototype or reach its constructor (DT-17). */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface PackageEntry {
  readonly name: string;
  /** Only regular files count; a link, a folder or anything else refuses the package. */
  readonly kind: 'file' | 'other';
}

/**
 * The bundle file among a package folder's entries: exactly one `bundle-v<n>.json`, nothing but
 * the files a package has, no link and no subfolder. Throws `package_invalid`.
 */
export function packageBundleName(entries: readonly PackageEntry[]): string {
  if (entries.length === 0 || entries.length > MAX_PACKAGE_ENTRIES)
    throw new ImportPlanError('package_invalid');
  const bundles: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== 'file') throw new ImportPlanError('package_invalid');
    const key = entry.name.toLowerCase();
    if (seen.has(key)) throw new ImportPlanError('package_invalid');
    seen.add(key);
    if (BUNDLE_FILE.test(entry.name)) bundles.push(entry.name);
    else if (!OTHER_FILES.has(entry.name))
      throw new ImportPlanError('package_invalid');
  }
  const [bundle] = bundles;
  if (bundle === undefined || bundles.length !== 1)
    throw new ImportPlanError('package_invalid');
  return bundle;
}

/** The bundle of a package ZIP: its files at the top or in one `moat-<gate>-v<n>/` folder. */
export function zipBundle(
  bytes: Uint8Array,
  inflate?: Inflate,
): { readonly name: string; readonly bytes: Uint8Array } {
  let contents;
  try {
    contents = readZip(bytes, IMPORT_ZIP_LIMITS, inflate);
  } catch (error) {
    if (error instanceof ZipReadError)
      throw new ImportPlanError(
        error.code === 'too_large' ? 'too_large' : 'package_invalid',
      );
    throw error;
  }
  const tops = new Set(
    [...contents.files.map((file) => file.name), ...contents.folders].map(
      (name) => name.split('/')[0] as string,
    ),
  );
  let prefix = '';
  let folderVersion: string | null = null;
  if (
    contents.folders.length > 0 ||
    contents.files.some((f) => f.name.includes('/'))
  ) {
    const [top] = tops;
    const match = top === undefined ? null : PACKAGE_FOLDER.exec(top);
    if (tops.size !== 1 || match === null)
      throw new ImportPlanError('package_invalid');
    if (contents.folders.some((folder) => folder !== top))
      throw new ImportPlanError('package_invalid');
    prefix = `${top}/`;
    folderVersion = match[1] as string;
  }
  const entries = contents.files.map((file) => {
    if (!file.name.startsWith(prefix))
      throw new ImportPlanError('package_invalid');
    const name = file.name.slice(prefix.length);
    if (name.includes('/')) throw new ImportPlanError('package_invalid');
    return { name, data: file.data };
  });
  const name = packageBundleName(
    entries.map((entry) => ({ name: entry.name, kind: 'file' as const })),
  );
  if (folderVersion !== null && BUNDLE_FILE.exec(name)?.[1] !== folderVersion)
    throw new ImportPlanError('package_invalid');
  const bundle = entries.find((entry) => entry.name === name);
  if (bundle === undefined) throw new ImportPlanError('package_invalid');
  return { name, bytes: bundle.data };
}

export async function planImport(
  storage: StoragePort,
  gate: string,
  signer: PlanSigner,
  source: ImportSource,
): Promise<ImportPlan> {
  if (!NAME_PATTERN.test(gate)) throw new ImportPlanError('gate_unknown');
  let gateId: string;
  try {
    gateId = readGateId(storage, gate);
  } catch (error) {
    if (error instanceof BundlePlanError)
      throw new ImportPlanError('gate_unknown');
    throw error;
  }

  let bytes: Uint8Array;
  let named: number | null = null;
  if (source.kind === 'zip') {
    const found = zipBundle(source.bytes, source.inflate);
    bytes = found.bytes;
    named = Number(BUNDLE_FILE.exec(found.name)?.[1]);
  } else if (source.kind === 'package') {
    const match = BUNDLE_FILE.exec(source.name);
    if (match === null) throw new ImportPlanError('package_invalid');
    bytes = source.bytes;
    named = Number(match[1]);
  } else {
    bytes = source.bytes;
  }
  if (bytes.length > MAX_IMPORT_BUNDLE_BYTES)
    throw new ImportPlanError('too_large');

  // The exact text that goes to disk: strict UTF-8 (the verification below parses it the same way).
  let text: string;
  try {
    text = fromUtf8(bytes);
  } catch {
    throw new ImportPlanError('bundle_invalid');
  }

  const previousVersion = latestBundle(storage, gate);
  let payload;
  try {
    ({ payload } = await verifyBundle(bytes, {
      gateId,
      signers: [
        { kid: signer.kid, alg: 'ed25519', publicKey: signer.publicKey },
      ],
      threshold: 1,
      currentVersion: previousVersion,
      now: 0,
      expiryEnabled: false,
    }));
  } catch (error) {
    if (error instanceof MoatRejection) {
      switch (error.code) {
        case 'too_large':
          throw new ImportPlanError('too_large');
        case 'signature_invalid':
        case 'threshold_not_met':
          throw new ImportPlanError('signature_invalid');
        case 'gate_mismatch':
          throw new ImportPlanError('gate_mismatch');
        case 'version_not_newer':
          throw new ImportPlanError('version_not_newer');
        default:
          throw new ImportPlanError('bundle_invalid');
      }
    }
    throw error;
  }

  if (hasForbiddenKey(payload as unknown as JsonValue))
    throw new ImportPlanError('bundle_invalid');
  if (payload.version > MAX_VERSION)
    throw new ImportPlanError('bundle_invalid');
  if (named !== null && named !== payload.version)
    throw new ImportPlanError('bundle_invalid');
  for (const [name, sealed] of Object.entries(payload.secrets)) {
    if (!NAME_PATTERN.test(name) || !isSealedSecret(sealed))
      throw new ImportPlanError('bundle_invalid');
  }

  let locked: boolean;
  try {
    const config = validateCompiledConfig(
      payload.config,
      Object.keys(payload.secrets),
    );
    locked = config.enabled === false;
  } catch (error) {
    if (error instanceof MoatRejection)
      throw new ImportPlanError('config_invalid');
    throw error;
  }

  return {
    gate,
    gateId,
    version: payload.version,
    previousVersion,
    locked,
    bundle: text,
  };
}

/** True when any object in the value has a `__proto__`, `constructor` or `prototype` key. */
export function hasForbiddenKey(value: JsonValue): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasForbiddenKey);
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) return true;
    if (hasForbiddenKey(value[key] as JsonValue)) return true;
  }
  return false;
}

const SEALED_KEYS = ['v', 'alg', 'secretVersion', 'epk', 'nonce', 'ct'];

function isSealedSecret(value: JsonValue): boolean {
  return (
    isJsonObject(value) &&
    Object.keys(value).length === SEALED_KEYS.length &&
    SEALED_KEYS.every((key) => Object.hasOwn(value, key)) &&
    value['v'] === 1 &&
    value['alg'] === SEALED_SECRET_ALG &&
    typeof value['secretVersion'] === 'number' &&
    Number.isSafeInteger(value['secretVersion']) &&
    value['secretVersion'] >= 1 &&
    typeof value['epk'] === 'string' &&
    typeof value['nonce'] === 'string' &&
    typeof value['ct'] === 'string'
  );
}
