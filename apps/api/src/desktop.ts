/**
 * Entry point of the API bundle Moat Desktop loads in-process (`webpack.config.js` →
 * `dist/apps/desktop-api/main.js`, a CommonJS library), as lazy-koins. It starts nothing on
 * import: the Electron main process sets the environment (AUTH_MODE=local, LOCAL_MODE=true,
 * MOAT_DATA_DIR), then `require`s this file and calls `bootstrap({ port: 0, accessToken })`.
 */
import {
  createKeyFile,
  fingerprint,
  fromBase64UrlLength,
  keyId,
} from '@moat/core';
import type { RunningApi } from './bootstrap';
import {
  BundleSigningService,
  type PrepareBundleResult,
  type SignBundleResult,
} from './project/application/bundle-signing.service';
import {
  SecretSealingService,
  type PrepareSealResult,
  type SealResult,
} from './project/application/secret-sealing.service';
import { MainProcessConfirmation } from './gate-test/ports/gate-test-confirmation.port';
import { ProjectService } from './project/project.service';

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
