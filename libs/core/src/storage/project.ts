import { compileConfig } from '../config/compile';
import type { CompiledConfig } from '../config/compiled';
import { ConfigError, loadMoatYaml, type ConfigIssue } from '../config/yaml';
import { keyId, fingerprint } from '../crypto/kid';
import { fromBase64Url } from '../encoding/base64url';
import { MoatRejection } from '../errors';
import type { StoragePort } from './storage-port';

/**
 * The project folder (DT-14), as the CLI writes it — plain files that live well in Git:
 *
 *   moat.yaml                         the config (no secrets)
 *   gates/<gate>.json                 a gate's public identity, pinned after comparing fingerprints
 *   secrets/<gate>/<name>.json        secrets sealed for that gate (ciphertext only, SEC-31)
 *   bundles/<gate>/<version>.json     signed bundles, ready to deploy
 *
 * `readProject` turns it into what the desktop shows. It never opens a secret and never returns
 * ciphertext: a sealed secret is reported by name and version only.
 */
export const CONFIG_FILE = 'moat.yaml';
export const NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const GATE_ID = /^[A-Za-z0-9_-]{22}$/;
/** More gates, secrets or bundles than any real project has: the rest is not listed. */
export const MAX_LISTED = 500;

/**
 * The trust mode of a gate fed from this project (§2.9). Moat Desktop and the CLI only ever
 * produce bundles signed with a key file, and a gate accepts those only after pinning that key,
 * so a gate of a project folder is always "Signiert" (FR-46, DT-01). Mode 2 joins once passkey
 * signing exists; this is never a stronger claim than what the gate enforces (§1.5).
 */
export type TrustMode = 'signed';

export type ConfigState =
  | { readonly status: 'missing' }
  | { readonly status: 'invalid'; readonly issues: readonly ConfigIssue[] }
  | {
      readonly status: 'valid';
      readonly config: CompiledConfig;
      /** Every secret the upstreams use, sorted. */
      readonly secretNames: readonly string[];
    };

export interface SealedSecretInfo {
  readonly name: string;
  readonly secretVersion: number;
}

export type GateState =
  | {
      readonly name: string;
      readonly status: 'invalid';
    }
  | {
      readonly name: string;
      readonly status: 'valid';
      readonly gateId: string;
      readonly trustMode: TrustMode;
      /** Key id and human fingerprint of the gate's box key (SEC-32). */
      readonly boxKeyId: string;
      readonly boxKeyFingerprint: string;
      readonly secrets: readonly SealedSecretInfo[];
      /** Secrets the config uses that are not sealed for this gate yet. */
      readonly missingSecrets: readonly string[];
      /** Highest bundle version built, 0 when none. */
      readonly latestBundle: number;
    };

export interface ProjectState {
  readonly config: ConfigState;
  readonly gates: readonly GateState[];
}

export async function readProject(storage: StoragePort): Promise<ProjectState> {
  const config = readConfig(storage);
  const used = config.status === 'valid' ? config.secretNames : [];
  const gates: GateState[] = [];
  for (const name of jsonNames(storage, 'gates')) {
    gates.push(await readGate(storage, name, used));
  }
  return { config, gates };
}

function readConfig(storage: StoragePort): ConfigState {
  const text = storage.read(CONFIG_FILE);
  if (text === null) return { status: 'missing' };
  try {
    const parsed = loadMoatYaml(text);
    const secretNames = [
      ...new Set(
        Object.values(parsed.upstreams).flatMap((upstream) =>
          upstream.auth ? [upstream.auth.secret] : [],
        ),
      ),
    ].sort();
    return {
      status: 'valid',
      config: compileConfig(parsed, secretNames),
      secretNames,
    };
  } catch (error) {
    if (error instanceof ConfigError)
      return { status: 'invalid', issues: error.issues };
    if (error instanceof MoatRejection)
      return {
        status: 'invalid',
        issues: [{ code: 'schema', path: [], message: error.code }],
      };
    throw error;
  }
}

async function readGate(
  storage: StoragePort,
  name: string,
  used: readonly string[],
): Promise<GateState> {
  const file = parseJson(storage.read(`gates/${name}.json`));
  const boxPublicKey =
    isRecord(file) && typeof file['boxKey'] === 'string'
      ? decode(file['boxKey'])
      : null;
  if (
    !isRecord(file) ||
    file['moat'] !== 'gate' ||
    file['v'] !== 1 ||
    typeof file['gateId'] !== 'string' ||
    !GATE_ID.test(file['gateId']) ||
    boxPublicKey?.length !== 32
  ) {
    return { name, status: 'invalid' };
  }
  const secrets = readSecrets(storage, name);
  const sealed = new Set(secrets.map((secret) => secret.name));
  return {
    name,
    status: 'valid',
    gateId: file['gateId'],
    trustMode: 'signed',
    boxKeyId: await keyId('x25519', boxPublicKey),
    boxKeyFingerprint: await fingerprint('x25519', boxPublicKey),
    secrets,
    missingSecrets: used.filter((secret) => !sealed.has(secret)),
    latestBundle: latestBundle(storage, name),
  };
}

function readSecrets(storage: StoragePort, gate: string): SealedSecretInfo[] {
  return jsonNames(storage, `secrets/${gate}`).flatMap((name) => {
    const sealed = parseJson(storage.read(`secrets/${gate}/${name}.json`));
    const version = isRecord(sealed) ? sealed['secretVersion'] : undefined;
    return typeof version === 'number' && Number.isSafeInteger(version)
      ? [{ name, secretVersion: version }]
      : [];
  });
}

function latestBundle(storage: StoragePort, gate: string): number {
  return storage
    .list(`bundles/${gate}`)
    .map((file) => /^([1-9][0-9]{0,8})\.json$/.exec(file)?.[1])
    .filter((version): version is string => version !== undefined)
    .reduce((max, version) => Math.max(max, Number(version)), 0);
}

/** `<name>.json` entries with a valid name, sorted, at most MAX_LISTED. */
function jsonNames(storage: StoragePort, dir: string): string[] {
  return storage
    .list(dir)
    .map((file) => /^(.+)\.json$/.exec(file)?.[1])
    .filter(
      (name): name is string => name !== undefined && NAME_PATTERN.test(name),
    )
    .sort()
    .slice(0, MAX_LISTED);
}

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function decode(value: string): Uint8Array | null {
  try {
    return fromBase64Url(value);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
