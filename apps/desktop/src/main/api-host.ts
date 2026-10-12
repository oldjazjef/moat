import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { desktopApiEnv } from './lib/api-env';
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
}

export interface RunningApi {
  /** `http://127.0.0.1:<port>` */
  baseUrl: string;
  accessHeader: string;
  accessToken: string;
  /** In-process, never over HTTP: only the main process adds folders (DT-08). */
  addProject(folder: string): Promise<{ id: string }>;
  projectFolder(id: string): Promise<string | null>;
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
}): Promise<RunningApi> {
  delete process.env['MOAT_PROJECT_DIR'];
  Object.assign(process.env, desktopApiEnv(options.dataDir));

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
    projectFolder: (id) => api.projectFolder(running, id),
    prepareBundle: (id, gate, signer) =>
      api.prepareBundle(running, id, gate, signer),
    signBundle: (id, gate, digest, keyFile, passphrase) =>
      api.signBundle(running, id, gate, digest, keyFile, passphrase),
    prepareSeal: (id, gate, name) => api.prepareSeal(running, id, gate, name),
    sealSecret: (id, gate, name, digest, value) =>
      api.sealSecret(running, id, gate, name, digest, value),
    close: () => running.app.close(),
  };
}
