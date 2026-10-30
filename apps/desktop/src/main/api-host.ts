import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { desktopApiEnv } from './lib/api-env';
import type { SigningKeyInfo } from '../shared/bridge';
import type { PrepareDeployResult } from './lib/deploy';
import type { BundleImportResult, ImportInput } from './lib/import';
import type { RequestLogApiResult } from './lib/request-log';
import type { SyncAnswer } from './lib/database';
import type { PrepareSealResult, SealResult } from './lib/sealing';
import type { PlanSigner, PrepareResult, SignResult } from './lib/signing';
import type { PasskeyPlanSigner } from './lib/passkey';
import type { Assertion } from './lib/passkey-signing';

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
  projectIds(api: ApiHandle): Promise<string[]>;
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
  passkeyKeyInfo(
    point: string,
  ): Promise<{ kid: string; publicKey: string; fingerprint: string } | null>;
  signBundleWithPasskey(
    api: ApiHandle,
    id: string,
    gate: string,
    digest: string,
    signer: PasskeyPlanSigner,
    assert: (challenge: Uint8Array) => Promise<Assertion | null>,
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
  importBundle(
    api: ApiHandle,
    id: string,
    gate: string,
    signer: PlanSigner,
    input: ImportInput,
  ): Promise<BundleImportResult>;
  readRequestLog(texts: readonly string[]): RequestLogApiResult;
  syncDatabase(
    api: ApiHandle,
    id: string,
    input: {
      url: string;
      key: string;
      direction: 'push' | 'pull';
      signer: PlanSigner;
    },
  ): Promise<SyncAnswer>;
  databaseLabel(
    url: string,
  ):
    | { status: 'ok'; label: string }
    | { status: 'refused'; code: 'url_invalid' | 'tls_required' };
  recordDeploy(
    api: ApiHandle,
    id: string,
    deploy: {
      gate: string;
      version: number;
      target: 'zip' | 'folder' | 'sftp' | 'ftps' | 'git';
      sha256: string;
    },
  ): Promise<void>;
  setAssistantConnection(
    api: ApiHandle,
    supplier: {
      summary(): AiProviderSummary | null;
      open(): Promise<AiProviderConnection | null>;
    },
  ): void;
  handleMcp(
    api: ApiHandle,
    message: unknown,
    version: string,
  ): Promise<McpAnswer>;
}

/** What the page may know about the assistant's provider (never the key). */
export interface AiProviderSummary {
  readonly kind: 'anthropic' | 'openai_compatible';
  readonly baseUrl: string;
  readonly model: string;
  readonly hasKey: boolean;
}

export interface AiProviderConnection {
  readonly kind: 'anthropic' | 'openai_compatible';
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey?: string;
}

export type McpAnswer =
  | { readonly kind: 'none' }
  | { readonly kind: 'message'; readonly body: Record<string, unknown> };

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
  projectIds(): Promise<string[]>;
  /** «Testen» (T-59): the main process confirms each new address in its own dialog. */
  setGateTestConfirmation(
    ask: (target: string, locale: string) => Promise<boolean>,
  ): void;
  /** The assistant's provider (T-108): the token is opened only for one call. */
  setAssistantConnection(supplier: {
    summary(): AiProviderSummary | null;
    open(): Promise<AiProviderConnection | null>;
  }): void;
  /** One MCP message, after the listener checked token, Host and Origin (T-109). */
  handleMcp(message: unknown, version: string): Promise<McpAnswer>;
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
  /** The key id and fingerprint of a passkey's public key (trust mode 2); null: not a point. */
  passkeyKeyInfo(
    point: string,
  ): Promise<{ kid: string; publicKey: string; fingerprint: string } | null>;
  /**
   * In-process only (trust mode 2): signs the confirmed bundle with the passkey; `assert` asks
   * it in the main process's own window. Written only when the assertion verifies as the gate
   * would verify it.
   */
  signBundleWithPasskey(
    id: string,
    gate: string,
    digest: string,
    signer: PasskeyPlanSigner,
    assert: (challenge: Uint8Array) => Promise<Assertion | null>,
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
  /** In-process only (FR-45): the main process chose and read the file in its own dialog. */
  importBundle(
    id: string,
    gate: string,
    signer: PlanSigner,
    input: ImportInput,
  ): Promise<BundleImportResult>;
  /** In-process only (DT-12): the text of the log files the person chose in its own dialog. */
  readRequestLog(texts: readonly string[]): RequestLogApiResult;
  /** In-process only (DT-03): the connection string comes from the database window. */
  syncDatabase(
    id: string,
    url: string,
    key: string,
    direction: 'push' | 'pull',
    signer: PlanSigner,
  ): Promise<SyncAnswer>;
  databaseLabel: ApiBundle['databaseLabel'];
  /** A finished deploy (DT-05) into the project's history, if it keeps one. */
  recordDeploy(
    id: string,
    deploy: Parameters<ApiBundle['recordDeploy']>[2],
  ): Promise<void>;
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
    setAssistantConnection: (supplier) =>
      api.setAssistantConnection(running, supplier),
    handleMcp: (message, version) => api.handleMcp(running, message, version),
    projectFolder: (id) => api.projectFolder(running, id),
    projectIds: () => api.projectIds(running),
    prepareBundle: (id, gate, signer) =>
      api.prepareBundle(running, id, gate, signer),
    signBundle: (id, gate, digest, keyFile, passphrase) =>
      api.signBundle(running, id, gate, digest, keyFile, passphrase),
    passkeyKeyInfo: (point) => api.passkeyKeyInfo(point),
    signBundleWithPasskey: (id, gate, digest, signer, assert) =>
      api.signBundleWithPasskey(running, id, gate, digest, signer, assert),
    prepareSeal: (id, gate, name) => api.prepareSeal(running, id, gate, name),
    sealSecret: (id, gate, name, digest, value) =>
      api.sealSecret(running, id, gate, name, digest, value),
    prepareDeploy: (id, gate, signer) =>
      api.prepareDeploy(running, id, gate, signer),
    zipFiles: (entries) => api.zipFiles(entries),
    importBundle: (id, gate, signer, input) =>
      api.importBundle(running, id, gate, signer, input),
    readRequestLog: (texts) => api.readRequestLog(texts),
    syncDatabase: (id, url, key, direction, signer) =>
      api.syncDatabase(running, id, { url, key, direction, signer }),
    databaseLabel: (url) => api.databaseLabel(url),
    recordDeploy: (id, deploy) => api.recordDeploy(running, id, deploy),
    close: () => running.app.close(),
  };
}
