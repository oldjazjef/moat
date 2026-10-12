/**
 * Entry point of the API bundle Moat Desktop loads in-process (`webpack.config.js` →
 * `dist/apps/desktop-api/main.js`, a CommonJS library), as lazy-koins. It starts nothing on
 * import: the Electron main process sets the environment (AUTH_MODE=local, LOCAL_MODE=true,
 * MOAT_DATA_DIR), then `require`s this file and calls `bootstrap({ port: 0, accessToken })`.
 */
import type { RunningApi } from './bootstrap';
import {
  BundleSigningService,
  type PrepareBundleResult,
  type SignBundleResult,
} from './project/application/bundle-signing.service';
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
