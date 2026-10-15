import { verifyBundle } from '../bundle/bundle';
import { ConfigError, loadMoatYaml } from '../config/yaml';
import { sodium } from '../crypto/sodium';
import { fromBase64Url } from '../encoding/base64url';
import { utf8 } from '../encoding/utf8';
import { MoatRejection } from '../errors';
import {
  hasExactKeys,
  isJsonObject,
  parseStrictJson,
  type JsonValue,
} from '../json/strict-json';
import { SEALED_SECRET_ALG } from '../secrets/seal';
import { pinnedSignerOf, type PlanSigner } from './bundle-plan';
import {
  CONFIG_FILE,
  GATE_ID,
  jsonNames,
  MAX_LISTED,
  NAME_PATTERN,
} from './project';
import type { StoragePort } from './storage-port';

/**
 * A project folder against a shared backend (DT-03, DT-13): an external database that keeps a
 * copy of moat.yaml, the gates' public files, the sealed secrets and the signed bundles — and
 * nothing else. Ciphertext and signed bytes only: a plaintext secret, a key file or a passphrase
 * never leaves the desktop, because only files of exactly these shapes are read here.
 *
 * Optimistic locks (DT-13), nothing is ever overwritten that changed on the other side:
 *   moat.yaml       a revision number; replaced only when the other side still has the version
 *                   both sides last agreed on (`base`), otherwise a conflict
 *   gates           written only where missing; a different file is a conflict; a gate is never
 *                   pinned from the database (its box key must be compared first, SEC-32)
 *   sealed secrets  push: the higher secretVersion wins; pull: only a secret that is new here is
 *                   written (anonymous sealing cannot authenticate it, T-76), an existing file is
 *                   never replaced; the same version with other bytes is a conflict
 *   bundles         (gate, version) is the key and the lock: a bundle is never replaced, the same
 *                   version signed differently is a conflict, a higher version elsewhere is reported
 *
 * Pulled bundles are verified like an import (CRYPTO.md §4.3 against the person's own key, the
 * pinned gate id and the version) before anything is written. Pure: plans only.
 */

export interface SyncedConfig {
  readonly text: string;
  /** SHA-256 hex of the text (the API's configHash). */
  readonly hash: string;
}

export interface GateFile {
  readonly name: string;
  readonly gateId: string;
  readonly text: string;
}

export interface SecretFile {
  readonly gate: string;
  readonly name: string;
  readonly secretVersion: number;
  readonly text: string;
}

export interface BundleRef {
  readonly gate: string;
  readonly version: number;
  /** SHA-256 hex of the file's text. */
  readonly digest: string;
}

export interface BundleFile extends BundleRef {
  readonly text: string;
}

export interface LocalProject {
  readonly config: SyncedConfig | null;
  readonly gates: readonly GateFile[];
  readonly secrets: readonly SecretFile[];
  /** Only bundles signed with the person's key for the pinned gate (the rest: issues). */
  readonly bundles: readonly BundleFile[];
  readonly issues: readonly SyncIssue[];
}

export interface RemoteProject {
  readonly config: (SyncedConfig & { readonly revision: number }) | null;
  readonly gates: readonly { readonly name: string; readonly text: string }[];
  readonly secrets: readonly SecretFile[];
  readonly bundles: readonly BundleRef[];
}

export const SYNC_ISSUES = [
  /** Both sides changed moat.yaml since they last agreed: nothing was written. */
  'config_conflict',
  /** The moat.yaml on the other side does not load: not written. */
  'config_invalid',
  /** The gate's file differs between the two sides. */
  'gate_conflict',
  /** The database knows a gate this folder has not pinned: add it with its fingerprint. */
  'gate_not_pinned',
  /** The same secret version with other bytes. */
  'secret_conflict',
  /**
   * The database has other bytes for a secret that exists here: never overwritten (sealing is
   * anonymous, so a database writer could have substituted the ciphertext, T-76). Re-seal here.
   */
  'secret_unverified',
  /** A secret that was new here was copied from the database; it is not authenticated (T-76). */
  'secret_from_database',
  /** The database has a higher version of this secret (pull to get it). */
  'secret_newer_elsewhere',
  /** The same bundle version signed differently on both sides (DT-13). */
  'bundle_conflict',
  /** The database has a higher bundle version for this gate (pull to get it). */
  'bundle_newer_elsewhere',
  /** Not signed with this desktop's key for this gate and version: not copied. */
  'bundle_unverified',
] as const;
export type SyncIssueCode = (typeof SYNC_ISSUES)[number];

export interface SyncIssue {
  readonly code: SyncIssueCode;
  readonly gate: string | null;
  readonly name: string | null;
  readonly version: number | null;
}

export interface PushPlan {
  /** `expectedRevision` null: the database has no moat.yaml yet. */
  readonly config:
    (SyncedConfig & { readonly expectedRevision: number | null }) | null;
  readonly gates: readonly GateFile[];
  /** `expectedVersion` null: the database has no such secret yet. */
  readonly secrets: readonly (SecretFile & {
    readonly expectedVersion: number | null;
  })[];
  readonly bundles: readonly BundleFile[];
  readonly issues: readonly SyncIssue[];
}

export interface PullPlan {
  /** Replaces moat.yaml; null: nothing to write. */
  readonly config: SyncedConfig | null;
  /** Sealed secret files that do not exist here yet; an existing one is never replaced (T-76). */
  readonly secrets: readonly SecretFile[];
  /** Fetch, verify with verifyPulledBundle, then create (never replace). */
  readonly bundles: readonly BundleRef[];
  readonly issues: readonly SyncIssue[];
}

/** Larger than any bundle (MAX_ENVELOPE_BYTES) or sealed secret. */
const MAX_TEXT = 1024 * 1024;
const VERSION_FILE = /^([1-9][0-9]{0,8})\.json$/;

function issue(
  code: SyncIssueCode,
  gate: string | null = null,
  name: string | null = null,
  version: number | null = null,
): SyncIssue {
  return { code, gate, name, version };
}

export async function sha256Hex(text: string): Promise<string> {
  const na = await sodium();
  return na.to_hex(na.crypto_hash_sha256(utf8(text)));
}

/**
 * The project folder as it would go into the database: only well-formed files of the four kinds.
 * Bundles count only when `signer` signed them for the pinned gate under their file's version.
 */
export async function readLocalProject(
  storage: StoragePort,
  signer: PlanSigner,
): Promise<LocalProject> {
  const issues: SyncIssue[] = [];
  const configText = storage.read(CONFIG_FILE);
  const config =
    configText === null
      ? null
      : { text: configText, hash: await sha256Hex(configText) };
  const gates: GateFile[] = [];
  const secrets: SecretFile[] = [];
  const bundles: BundleFile[] = [];
  for (const name of jsonNames(storage, 'gates')) {
    const text = storage.read(`gates/${name}.json`);
    const gateId = text === null ? null : gateIdOf(text);
    if (text === null || gateId === null) continue;
    gates.push({ name, gateId, text });
    for (const secret of jsonNames(storage, `secrets/${name}`)) {
      const sealed = storage.read(`secrets/${name}/${secret}.json`);
      const secretVersion = sealed === null ? null : sealedVersionOf(sealed);
      if (sealed !== null && secretVersion !== null)
        secrets.push({ gate: name, name: secret, secretVersion, text: sealed });
    }
    const versions = storage
      .list(`bundles/${name}`)
      .map((file) => VERSION_FILE.exec(file)?.[1])
      .filter((version): version is string => version !== undefined)
      .map(Number)
      .sort((a, b) => a - b)
      .slice(-MAX_LISTED);
    for (const version of versions) {
      const bundle = storage.read(`bundles/${name}/${version}.json`);
      if (bundle === null) continue;
      if (await bundleSignedBy(bundle, gateId, version, signer))
        bundles.push({
          gate: name,
          version,
          digest: await sha256Hex(bundle),
          text: bundle,
        });
      else issues.push(issue('bundle_unverified', name, null, version));
    }
  }
  return { config, gates, secrets, bundles, issues };
}

/** What a push writes into the database, given what both sides last agreed on (`base`). */
export function planPush(
  local: LocalProject,
  remote: RemoteProject,
  base: string | null,
): PushPlan {
  const issues: SyncIssue[] = [...local.issues];

  let config: PushPlan['config'] = null;
  if (local.config !== null && local.config.hash !== remote.config?.hash) {
    if (!configLoads(local.config.text)) issues.push(issue('config_invalid'));
    else if (remote.config === null)
      config = { ...local.config, expectedRevision: null };
    else if (remote.config.hash === base)
      config = { ...local.config, expectedRevision: remote.config.revision };
    else issues.push(issue('config_conflict'));
  }

  const remoteGates = new Map(remote.gates.map((gate) => [gate.name, gate]));
  const gates: GateFile[] = [];
  for (const gate of local.gates) {
    const there = remoteGates.get(gate.name);
    if (there === undefined) gates.push(gate);
    else if (there.text !== gate.text)
      issues.push(issue('gate_conflict', gate.name));
  }
  const conflictingGates = new Set(
    issues.filter((i) => i.code === 'gate_conflict').map((i) => i.gate),
  );

  const remoteSecrets = new Map(
    remote.secrets.map((secret) => [`${secret.gate}/${secret.name}`, secret]),
  );
  const secrets: PushPlan['secrets'][number][] = [];
  for (const secret of local.secrets) {
    if (conflictingGates.has(secret.gate)) continue;
    const there = remoteSecrets.get(`${secret.gate}/${secret.name}`);
    if (there === undefined) secrets.push({ ...secret, expectedVersion: null });
    else if (there.secretVersion < secret.secretVersion)
      secrets.push({ ...secret, expectedVersion: there.secretVersion });
    else if (there.secretVersion > secret.secretVersion)
      issues.push(
        issue(
          'secret_newer_elsewhere',
          secret.gate,
          secret.name,
          there.secretVersion,
        ),
      );
    else if (there.text !== secret.text)
      issues.push(
        issue(
          'secret_conflict',
          secret.gate,
          secret.name,
          secret.secretVersion,
        ),
      );
  }

  const remoteBundles = new Map(
    remote.bundles.map((bundle) => [
      `${bundle.gate}/${bundle.version}`,
      bundle,
    ]),
  );
  const bundles: BundleFile[] = [];
  /** A gate whose bundles diverged: nothing after the fork is pushed (it builds on the fork). */
  const forked = new Set<string>();
  for (const bundle of [...local.bundles].sort(
    (a, b) => a.version - b.version,
  )) {
    if (conflictingGates.has(bundle.gate) || forked.has(bundle.gate)) continue;
    const there = remoteBundles.get(`${bundle.gate}/${bundle.version}`);
    if (there === undefined) bundles.push(bundle);
    else if (there.digest !== bundle.digest) {
      issues.push(issue('bundle_conflict', bundle.gate, null, bundle.version));
      forked.add(bundle.gate);
    }
  }
  issues.push(...newerElsewhere(local, remote));
  return { config, gates, secrets, bundles, issues };
}

/** What a pull writes into the project folder, given what both sides last agreed on (`base`). */
export function planPull(
  local: LocalProject,
  remote: RemoteProject,
  base: string | null,
): PullPlan {
  const issues: SyncIssue[] = [];

  let config: SyncedConfig | null = null;
  if (remote.config !== null && remote.config.hash !== local.config?.hash) {
    if (!configLoads(remote.config.text)) issues.push(issue('config_invalid'));
    else if (local.config === null || local.config.hash === base)
      config = { text: remote.config.text, hash: remote.config.hash };
    else issues.push(issue('config_conflict'));
  }

  const localGates = new Map(local.gates.map((gate) => [gate.name, gate]));
  const usable = new Set<string>();
  for (const gate of remote.gates) {
    const here = localGates.get(gate.name);
    if (here === undefined) issues.push(issue('gate_not_pinned', gate.name));
    else if (here.text !== gate.text)
      issues.push(issue('gate_conflict', gate.name));
    else usable.add(gate.name);
  }

  const localSecrets = new Map(
    local.secrets.map((secret) => [`${secret.gate}/${secret.name}`, secret]),
  );
  const secrets: SecretFile[] = [];
  for (const secret of remote.secrets) {
    if (!usable.has(secret.gate) || !NAME_PATTERN.test(secret.name)) continue;
    if (sealedVersionOf(secret.text) !== secret.secretVersion) continue;
    const here = localSecrets.get(`${secret.gate}/${secret.name}`);
    if (here === undefined) {
      secrets.push(secret);
      issues.push(
        issue(
          'secret_from_database',
          secret.gate,
          secret.name,
          secret.secretVersion,
        ),
      );
    } else if (here.secretVersion < secret.secretVersion)
      issues.push(
        issue(
          'secret_unverified',
          secret.gate,
          secret.name,
          secret.secretVersion,
        ),
      );
    else if (
      here.secretVersion === secret.secretVersion &&
      here.text !== secret.text
    )
      issues.push(
        issue(
          'secret_conflict',
          secret.gate,
          secret.name,
          secret.secretVersion,
        ),
      );
  }

  const localBundles = new Map(
    local.bundles.map((bundle) => [`${bundle.gate}/${bundle.version}`, bundle]),
  );
  const unverifiedHere = new Set(
    local.issues
      .filter((i) => i.code === 'bundle_unverified')
      .map((i) => `${i.gate}/${i.version}`),
  );
  const bundles: BundleRef[] = [];
  for (const bundle of remote.bundles) {
    if (!usable.has(bundle.gate)) continue;
    const key = `${bundle.gate}/${bundle.version}`;
    const here = localBundles.get(key);
    // A file of that version is here but not one of ours: never replaced, reported as a conflict.
    if (here === undefined && unverifiedHere.has(key))
      issues.push(issue('bundle_conflict', bundle.gate, null, bundle.version));
    else if (here === undefined) bundles.push(bundle);
    else if (here.digest !== bundle.digest)
      issues.push(issue('bundle_conflict', bundle.gate, null, bundle.version));
  }
  return { config, secrets, bundles, issues };
}

/**
 * A bundle fetched from the database, checked before it is written: the digest it was listed
 * with, then the signature of the person's key over the exact bytes, the pinned gate id and the
 * version of its file name (CRYPTO.md §4.3, as an import).
 */
export async function verifyPulledBundle(
  text: string,
  ref: BundleRef,
  gateId: string,
  signer: PlanSigner,
): Promise<boolean> {
  if (text.length > MAX_TEXT || (await sha256Hex(text)) !== ref.digest)
    return false;
  return bundleSignedBy(text, gateId, ref.version, signer);
}

/** The gate id of a well-formed `gates/<name>.json`, otherwise null. */
export function gateIdOf(text: string): string | null {
  const value = strictJson(text);
  if (
    !isJsonObject(value) ||
    !hasExactKeys(value, ['moat', 'v', 'gateId', 'boxKey']) ||
    value['moat'] !== 'gate' ||
    value['v'] !== 1 ||
    typeof value['gateId'] !== 'string' ||
    !GATE_ID.test(value['gateId']) ||
    typeof value['boxKey'] !== 'string' ||
    decodedLength(value['boxKey']) !== 32
  )
    return null;
  return value['gateId'];
}

/**
 * The secretVersion of a sealed secret file (docs/CRYPTO.md §5: exactly these keys, the one
 * algorithm, an X25519 key, an XChaCha20 nonce, a ciphertext with its tag), otherwise null. A
 * plaintext value never has this shape, so it can never pass as one (SEC-31).
 */
export function sealedVersionOf(text: string): number | null {
  const value = strictJson(text);
  if (
    !isJsonObject(value) ||
    !hasExactKeys(value, ['v', 'alg', 'secretVersion', 'epk', 'nonce', 'ct']) ||
    value['v'] !== 1 ||
    value['alg'] !== SEALED_SECRET_ALG ||
    typeof value['secretVersion'] !== 'number' ||
    !Number.isSafeInteger(value['secretVersion']) ||
    value['secretVersion'] < 1 ||
    typeof value['epk'] !== 'string' ||
    decodedLength(value['epk']) !== 32 ||
    typeof value['nonce'] !== 'string' ||
    decodedLength(value['nonce']) !== 24 ||
    typeof value['ct'] !== 'string' ||
    (decodedLength(value['ct']) ?? 0) < 16
  )
    return null;
  return value['secretVersion'];
}

function newerElsewhere(
  local: LocalProject,
  remote: RemoteProject,
): SyncIssue[] {
  const latest = new Map<string, number>();
  for (const bundle of local.bundles)
    latest.set(
      bundle.gate,
      Math.max(latest.get(bundle.gate) ?? 0, bundle.version),
    );
  const issues: SyncIssue[] = [];
  const reported = new Set<string>();
  const remoteLatest = new Map<string, number>();
  for (const bundle of remote.bundles)
    remoteLatest.set(
      bundle.gate,
      Math.max(remoteLatest.get(bundle.gate) ?? 0, bundle.version),
    );
  for (const [gate, version] of remoteLatest) {
    if (!local.gates.some((g) => g.name === gate) || reported.has(gate))
      continue;
    if (version > (latest.get(gate) ?? 0)) {
      reported.add(gate);
      issues.push(issue('bundle_newer_elsewhere', gate, null, version));
    }
  }
  return issues;
}

async function bundleSignedBy(
  text: string,
  gateId: string,
  version: number,
  signer: PlanSigner,
): Promise<boolean> {
  try {
    const { payload } = await verifyBundle(utf8(text), {
      gateId,
      signers: [pinnedSignerOf(signer)],
      threshold: 1,
      currentVersion: version - 1,
      now: 0,
      expiryEnabled: false,
    });
    return payload.version === version;
  } catch (error) {
    if (error instanceof MoatRejection) return false;
    throw error;
  }
}

function configLoads(text: string): boolean {
  try {
    loadMoatYaml(text);
    return true;
  } catch (error) {
    if (error instanceof ConfigError || error instanceof MoatRejection)
      return false;
    throw error;
  }
}

function strictJson(text: string): JsonValue | null {
  if (text.length > MAX_TEXT) return null;
  try {
    return parseStrictJson(utf8(text));
  } catch {
    return null;
  }
}

function decodedLength(value: string): number | null {
  try {
    return fromBase64Url(value).length;
  } catch {
    return null;
  }
}
