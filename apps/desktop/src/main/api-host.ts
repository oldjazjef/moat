import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { desktopApiEnv } from './lib/api-env';
import type { SigningKeyInfo } from '../shared/bridge';
import type { PrepareDeployResult } from './lib/deploy';
import type { PrepareSealResult, SealResult } from './lib/sealing';
import type { PlanSigner, PrepareResult, SignResult } from './lib/signing';

interface ApiHandle {
  app: { close(): Promise<void> };
  port: number;
  host: string;
}

/** What `dist/apps/desktop-api/main.js` (apps/api/src/desktop.ts) exports. */
interface ApiBundle {
  DESKTOP_ACCESS_HEADER: string;
  bootstrap(options: {
    port: number;
    accessToken: string;
    logger?: string[] | false;
  }): Promise<ApiHandle>;
  addProject(api: ApiHandle, folder: string): Promise<{ id: string }>;
  createProject(
    api: ApiHandle,
    folder: string,
  ): Promise<{ id: string; created: boolean }>;
  createSigningKey(
    passphrase: string,
  ): Promise<{ text: string; key: SigningKeyInfo }>;
  signingKeyInfo(publicKey: string): Promise<SigningKeyInfo | null>;
  projectFolder(api: ApiHandle, id: string): Promise<string | null>;
  prepareBundle(
    api: ApiHandle,
    id: string,
    gate: string,
    signer: PlanSigner | null,
  ): Promise<PrepareResult>;
  signBundle(
    api: ApiHandle,
    id: string,
    gate: string,
    digest: string,
    keyFile: string,
    passphrase: string,
  ): Promise<SignResult>;
  prepareSeal(
    api: ApiHandle,
    id: string,
    gate: string,
    name: string,
  ): Promise<PrepareSealResult>;
  sealSecret(
    api: ApiHandle,
    id: string,
    gate: string,
    name: string,
    digest: string,
    value: Uint8Array,
  ): Promise<SealResult>;
  setGateTestConfirmation(
    api: ApiHandle,
    ask: (target: string, locale: string) => Promise<boolean>,
  ): void;
  prepareDeploy(
    api: ApiHandle,
    id: string,
    gate: string,
    signer: PlanSigner,
  ): Promise<PrepareDeployResult>;
  zipFiles(entries: readonly { name: string; data: Uint8Array }[]): Uint8Array;
}

export interface RunningApi {
  /** `http://127.0.0.1:<port>` */
  baseUrl: string;
  accessHeader: string;
  accessToken: string;
  /** In-process, never over HTTP: only the main process adds folders (DT-08). */
  addProject(folder: string): Promise<{ id: string }>;
  /** In-process, like addProject: «Neues Projekt» after the main process's folder dialog. */
  createProject(folder: string): Promise<{ id: string; created: boolean }>;
  /** In-process: the passphrase comes from the key window only, the file text goes to disk. */
  createSigningKey(
    passphrase: string,
  ): Promise<{ text: string; key: SigningKeyInfo }>;
  signingKeyInfo(publicKey: string): Promise<SigningKeyInfo | null>;
  projectFolder(id: string): Promise<string | null>;
  /** «Testen» (T-59): the main process confirms each new address in its own dialog. */
  setGateTestConfirmation(
    ask: (target: string, locale: string) => Promise<boolean>,
  ): void;
  /** In-process only, for the signing dialog (DT-15): the page has no way to sign. */
  prepareBundle(
    id: string,
    gate: string,
    signer: PlanSigner | null,
  ): Promise<PrepareResult>;
  signBundle(
    id: string,
    gate: string,
    digest: string,
    keyFile: string,
    passphrase: string,
  ): Promise<SignResult>;
  /** In-process only, for the seal window: the page never sees a secret's value. */
  prepareSeal(
    id: string,
    gate: string,
    name: string,
  ): Promise<PrepareSealResult>;
  sealSecret(
    id: string,
    gate: string,
    name: string,
    digest: string,
    value: Uint8Array,
  ): Promise<SealResult>;
  /** In-process only (DT-05): the main process asks where the package goes and writes it. */
  prepareDeploy(
    id: string,
    gate: string,
    signer: PlanSigner,
  ): Promise<PrepareDeployResult>;
  zipFiles(entries: readonly { name: string; data: Uint8Array }[]): Uint8Array;
  close(): Promise<void>;
}

/**
 * Starts the NestJS API in this process, on 127.0.0.1 and a port the OS picks (as lazy-koins).
 * Called once per process: the API's ConfigModule reads the environment when its bundle is
 * loaded.
 */
export async function startApi(options: {
  appDir: string;
  dataDir: string;
  packaged: boolean;
}): Promise<RunningApi> {
  delete process.env['MOAT_PROJECT_DIR'];
  Object.assign(process.env, desktopApiEnv(options.dataDir, options.packaged));

  // Loaded only now: its ConfigModule validates process.env at load time.
  const api = require(join(options.appDir, 'api', 'main.js')) as ApiBundle;
  // Per launch, known only to this process and the API (CLAUDE.md, Desktop).
  const accessToken = randomBytes(32).toString('hex');
  const running = await api.bootstrap({
    port: 0,
    accessToken,
    logger: ['error', 'warn'],
  });
  return {
    baseUrl: `http://127.0.0.1:${running.port}`,
    accessHeader: api.DESKTOP_ACCESS_HEADER,
    accessToken,
    addProject: (folder) => api.addProject(running, folder),
    createProject: (folder) => api.createProject(running, folder),
    createSigningKey: (passphrase) => api.createSigningKey(passphrase),
    signingKeyInfo: (publicKey) => api.signingKeyInfo(publicKey),
    setGateTestConfirmation: (ask) => api.setGateTestConfirmation(running, ask),
    projectFolder: (id) => api.projectFolder(running, id),
    prepareBundle: (id, gate, signer) =>
      api.prepareBundle(running, id, gate, signer),
    signBundle: (id, gate, digest, keyFile, passphrase) =>
      api.signBundle(running, id, gate, digest, keyFile, passphrase),
    prepareSeal: (id, gate, name) => api.prepareSeal(running, id, gate, name),
    sealSecret: (id, gate, name, digest, value) =>
      api.sealSecret(running, id, gate, name, digest, value),
    prepareDeploy: (id, gate, signer) =>
      api.prepareDeploy(running, id, gate, signer),
    zipFiles: (entries) => api.zipFiles(entries),
    close: () => running.app.close(),
  };
}
