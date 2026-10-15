/**
 * Entry point of the API bundle Moat Desktop loads in-process (`webpack.config.js` →
 * `dist/apps/desktop-api/main.js`, a CommonJS library), as lazy-koins. It starts nothing on
 * import: the Electron main process sets the environment (AUTH_MODE=local, LOCAL_MODE=true,
 * MOAT_DATA_DIR), then `require`s this file and calls `bootstrap({ port: 0, accessToken })`.
 */
import {
  createKeyFile,
  DEPLOY_TARGET_KINDS,
  type DeployTargetKind,
  fingerprint,
  fromBase64UrlLength,
  isPasskeyPoint,
  keyId,
  PASSKEY_POINT_LENGTH,
  WEBAUTHN_ALG,
  storedZip,
  type ZipEntry,
} from '@moat/core';
import type { RunningApi } from './bootstrap';
import {
  BundleSigningService,
  type PasskeyAsserter,
  type PasskeyPlanSigner,
  type PrepareBundleResult,
  type SignBundleResult,
} from './project/application/bundle-signing.service';
import {
  SecretSealingService,
  type PrepareSealResult,
  type SealResult,
} from './project/application/secret-sealing.service';
import {
  DeployPackageService,
  type PrepareDeployResult,
} from './project/application/deploy-package.service';
import {
  BundleImportService,
  type BundleImportResult,
  type ImportInput,
} from './project/application/bundle-import.service';
import { MainProcessConfirmation } from './gate-test/ports/gate-test-confirmation.port';
import {
  DatabaseSyncService,
  type DatabaseSyncResult,
  type SyncDirection,
} from './project/application/database-sync.service';
import { HistoryService } from './project/application/history.service';
import { parseDatabaseUrl } from './persistence/database/database-url';
import { ProjectService } from './project/project.service';
import {
  requestLogView,
  type RequestLogViewResult,
} from './gate-log/request-log-view';

export {
  bootstrap,
  type BootstrapOptions,
  DESKTOP_ACCESS_HEADER,
  type RunningApi,
} from './bootstrap';

/**
 * Adds a project folder to the list. Called only by the main process, after its own folder
 * dialog (DT-08) — the reason this is a function and not an HTTP route.
 */
export async function addProject(
  api: RunningApi,
  folder: string,
): Promise<{ id: string }> {
  const entry = await api.app.get(ProjectService).add(folder);
  return { id: entry.id };
}

/**
 * «Neues Projekt» (FR-73): writes the moat.yaml of a new project into the folder (never over an
 * existing one, `created: false` then) and adds it to the list. Called only by the main process,
 * after its own folder dialog (DT-08).
 */
export async function createProject(
  api: RunningApi,
  folder: string,
): Promise<{ id: string; created: boolean }> {
  const { entry, created } = await api.app.get(ProjectService).create(folder);
  return { id: entry.id, created };
}

/** The public half of a signing key, as the page may see it. */
export interface SigningKeyInfo {
  readonly kid: string;
  /** base64url, what `php moat-gate.php install --signer=` takes. */
  readonly publicKey: string;
  /** `MOAT-…`, what the gate prints as "Signer". */
  readonly fingerprint: string;
}

/**
 * A new signing key (trust mode 1, docs/CRYPTO.md §6) as key file text, for the main process's
 * key window: the passphrase was typed there, the main process writes the file. Argon2id at the
 * write floor (KEYFILE_WRITE_MIN); the seed never leaves core's createKeyFile unencrypted.
 */
export async function createSigningKey(
  passphrase: string,
): Promise<{ text: string; key: SigningKeyInfo }> {
  const file = await createKeyFile(passphrase);
  const info = await signingKeyInfo(file.pk);
  if (info === null || info.kid !== file.kid)
    throw new Error('createKeyFile gave an inconsistent key file');
  return { text: `${JSON.stringify(file, null, 2)}\n`, key: info };
}

/** Key id and fingerprint of an Ed25519 public key (base64url); null when it is not one. */
export async function signingKeyInfo(
  publicKey: string,
): Promise<SigningKeyInfo | null> {
  let bytes: Uint8Array;
  try {
    bytes = fromBase64UrlLength(publicKey, 32);
  } catch {
    return null;
  }
  return {
    kid: await keyId('ed25519', bytes),
    publicKey,
    fingerprint: await fingerprint('ed25519', bytes),
  };
}

/**
 * Key id and fingerprint of a passkey's public key, the 65-byte uncompressed P-256 point as
 * base64url (87 characters); null when it is not one (shape only — the curve check is the
 * enrollment's, desktop/src/main/lib/passkey.ts).
 */
export async function passkeyKeyInfo(
  point: string,
): Promise<{ kid: string; publicKey: string; fingerprint: string } | null> {
  let bytes: Uint8Array;
  try {
    bytes = fromBase64UrlLength(point, PASSKEY_POINT_LENGTH);
  } catch {
    return null;
  }
  if (!isPasskeyPoint(bytes)) return null;
  return {
    kid: await keyId(WEBAUTHN_ALG, bytes),
    publicKey: point,
    fingerprint: await fingerprint(WEBAUTHN_ALG, bytes),
  };
}

/** The folder of a listed project (for "Im Ordner zeigen"), or null for an unknown id. */
export async function projectFolder(
  api: RunningApi,
  id: string,
): Promise<string | null> {
  return (await api.app.get(ProjectService).get(id))?.folder ?? null;
}

export type {
  BundlePreview,
  PrepareBundleResult,
  SignBundleResult,
} from './project/application/bundle-signing.service';

/**
 * What the next bundle of a gate would be, for the main process's signing dialog (DT-15). Never
 * an HTTP route: the page cannot start signing past the dialog.
 */
export function prepareBundle(
  api: RunningApi,
  id: string,
  gate: string,
  signer: { kid: string; publicKey: Uint8Array } | null,
): Promise<PrepareBundleResult> {
  return api.app.get(BundleSigningService).prepare(id, gate, signer);
}

/**
 * Signs the bundle the person confirmed (`digest` from prepareBundle) with the key file's text
 * and passphrase, which the main process read and asked for itself. Writes
 * `bundles/<gate>/<version>.json`; the secret key is zeroed right after signing (SEC-37).
 */
export function signBundle(
  api: RunningApi,
  id: string,
  gate: string,
  digest: string,
  keyFile: string,
  passphrase: string,
): Promise<SignBundleResult> {
  return api.app
    .get(BundleSigningService)
    .sign(id, gate, digest, keyFile, passphrase, Math.floor(Date.now() / 1000));
}

/**
 * Trust mode 2: signs the bundle the person confirmed with their passkey. `assert` gets the
 * WebAuthn challenge (`webauthnChallenge` of the payload) and asks the passkey in the main
 * process's own window; the result is verified as the gate would before `bundles/<gate>/<n>.json`
 * is written. In-process only, like signBundle: the page has no way to sign.
 */
export function signBundleWithPasskey(
  api: RunningApi,
  id: string,
  gate: string,
  digest: string,
  signer: PasskeyPlanSigner,
  assert: PasskeyAsserter,
): Promise<SignBundleResult> {
  return api.app
    .get(BundleSigningService)
    .signWithPasskey(
      id,
      gate,
      digest,
      signer,
      assert,
      Math.floor(Date.now() / 1000),
    );
}

export type {
  PrepareSealResult,
  SealPreview,
  SealResult,
} from './project/application/secret-sealing.service';

/** What sealing `name` for `gate` would do, for the main process's seal window. Never HTTP. */
export function prepareSeal(
  api: RunningApi,
  id: string,
  gate: string,
  name: string,
): Promise<PrepareSealResult> {
  return api.app.get(SecretSealingService).prepare(id, gate, name);
}

/**
 * Seals the value typed in the main process's seal window (never in the page) for the gate and
 * version the person confirmed (`digest`). Writes ciphertext only; `value` is zeroed (SEC-31).
 */
export function sealSecret(
  api: RunningApi,
  id: string,
  gate: string,
  name: string,
  digest: string,
  value: Uint8Array,
): Promise<SealResult> {
  return api.app.get(SecretSealingService).seal(id, gate, name, digest, value);
}

export type {
  DeployPackage,
  PrepareDeployResult,
} from './project/application/deploy-package.service';

/**
 * A gate's deploy package (DT-05): its latest bundle signed with `signer`, and the policy for it.
 * Never an HTTP route: the main process asks where to save it in its own dialog and writes it.
 */
export function prepareDeploy(
  api: RunningApi,
  id: string,
  gate: string,
  signer: { kid: string; publicKey: Uint8Array },
): Promise<PrepareDeployResult> {
  return api.app.get(DeployPackageService).prepare(id, gate, signer);
}

/** The deploy package as a ZIP (stored, reproducible: core storedZip). */
export function zipFiles(entries: readonly ZipEntry[]): Uint8Array {
  return storedZip(entries);
}

export type {
  BundleImportResult,
  ImportInput,
} from './project/application/bundle-import.service';

/**
 * Imports a bundle file, a deploy package folder or its ZIP (FR-45, DT-17) that the main process
 * read after its own dialog: checked as the gate would against `signer`, then written as
 * `bundles/<gate>/<version>.json` byte for byte. Never an HTTP route: the page cannot name a file.
 */
export function importBundle(
  api: RunningApi,
  id: string,
  gate: string,
  signer: { kid: string; publicKey: Uint8Array },
  input: ImportInput,
): Promise<BundleImportResult> {
  return api.app.get(BundleImportService).import(id, gate, signer, input);
}

export type {
  RequestLogView,
  RequestLogViewResult,
} from './gate-log/request-log-view';

/**
 * A gate's request log (FR-50, DT-12) from the text of the files the person chose in the main
 * process's dialog: summary and newest entries, read with core parseRequestLog. Never HTTP.
 */
export function readRequestLog(texts: readonly string[]): RequestLogViewResult {
  return requestLogView(texts);
}

/**
 * Registers the main process's confirmation for «Testen» (T-59): `ask` shows the address in a
 * dialog of its own and answers whether the person agreed. Without it, every test is refused.
 */
export function setGateTestConfirmation(
  api: RunningApi,
  ask: (target: string, locale: string) => Promise<boolean>,
): void {
  api.app.get(MainProcessConfirmation).register(ask);
}

export type {
  DatabaseSyncResult,
  SyncDirection,
} from './project/application/database-sync.service';

/**
 * «Externe Datenbank» (DT-03, DT-13): push the project folder into a PostgreSQL database or pull
 * the database's newer files into it. Called only by the main process's database window: the
 * connection string is typed there (or opened from the keychain there) and never reaches the page.
 */
export function syncDatabase(
  api: RunningApi,
  id: string,
  input: {
    url: string;
    key: string;
    direction: SyncDirection;
    signer: { kid: string; publicKey: Uint8Array };
  },
): Promise<DatabaseSyncResult> {
  return api.app.get(DatabaseSyncService).sync(id, input);
}

/**
 * What the database window may show of a connection string (never the password), or why Moat
 * refuses it (`url_invalid`, `tls_required`) before anything connects.
 */
export function databaseLabel(
  url: string,
):
  | { status: 'ok'; label: string }
  | { status: 'refused'; code: 'url_invalid' | 'tls_required' } {
  const parsed = parseDatabaseUrl(url);
  return parsed.status === 'ok'
    ? { status: 'ok', label: parsed.label }
    : parsed;
}

/** Records a deploy the main process finished (DT-05) in the project's history, if it has one. */
export async function recordDeploy(
  api: RunningApi,
  id: string,
  deploy: {
    gate: string;
    version: number;
    target: DeployTargetKind;
    sha256: string;
  },
): Promise<void> {
  if (!DEPLOY_TARGET_KINDS.includes(deploy.target)) return;
  await api.app
    .get(HistoryService)
    .record(id, { kind: 'deploy', details: { ...deploy } });
}
