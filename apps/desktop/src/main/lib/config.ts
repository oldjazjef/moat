import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { DATABASE_KEY, type DatabaseTarget } from './database';
import {
  SFTP_HOST,
  SFTP_HOST_KEY,
  SFTP_USER,
  type SftpTarget,
  isRemoteDir,
} from './sftp';
import type { FtpsTarget } from './ftps';
import { FTPS_FINGERPRINT } from './ftps-client';
import { passkeyRecordOf, type PasskeyRecord } from './passkey';

/** `<userData>/config.json`: what the desktop remembers between starts. */
export const CONFIG_FILE = 'config.json';

/** A key id as core hands it out (docs/CRYPTO.md §2: 16 bytes, base64url). */
const KID = /^[A-Za-z0-9_-]{22}$/;
/** An Ed25519 public key, base64url (32 bytes). */
const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;

export interface DesktopConfig {
  /**
   * The one project folder of the first desktop builds, before the project list. Moved into the
   * list on the next start, then cleared (see main.ts).
   */
  readonly projectDir: string | null;
  /**
   * The signing key per project id (DT-15): the `.moatkey` file the project's bundles are signed
   * with (the same file the CLI uses), and during a rotation the key it replaces. There is no
   * key for the whole desktop: a project without an entry has none.
   */
  readonly projectKeys: Readonly<Record<string, ProjectKey>>;
  /**
   * The one key of the builds before per-project keys. main.ts copies it to every listed project
   * that has none yet, once, and clears it.
   */
  readonly legacyKey: ProjectKey | null;
  /**
   * Passphrases the person asked to remember, by the key file's kid: encrypted with Electron
   * `safeStorage` (the OS keychain, DT-04), base64. Never plain text in this file.
   */
  readonly passphrases: Readonly<Record<string, string>>;
  /**
   * The last deploy package per `<projectId>/<gate>` (DT-05, T-66): kept here, outside the
   * project folder, so a changed folder cannot pass off another gate's or an older bundle.
   */
  readonly deployed: Readonly<Record<string, DeployedPackage>>;
  /**
   * The SFTP target per `<projectId>/<gate>` (DT-05): host, user, folder, the pinned host key,
   * and the password or passphrase only as keychain ciphertext (DT-04).
   */
  readonly sftpTargets: Readonly<Record<string, SftpTarget>>;
  /**
   * The Git working copy folder per `<projectId>/<gate>` (DT-05, T-68), chosen in the main
   * process's folder dialog; the page never learns it.
   */
  readonly gitTargets: Readonly<Record<string, string>>;
  /**
   * The FTPS target per `<projectId>/<gate>` (DT-05, T-69): host, user, folder, mode, the pinned
   * certificate, and the password only as keychain ciphertext (DT-04).
   */
  readonly ftpsTargets: Readonly<Record<string, FtpsTarget>>;

  /**
   * The external database per project id (DT-03): its key and label, and the connection string
   * only as keychain ciphertext (DT-04), or not at all.
   */
  readonly databaseTargets: Readonly<Record<string, DatabaseTarget>>;

  /**
   * The passkey of trust mode 2 (docs/CRYPTO.md §7): its credential id and public key, nothing
   * secret — the private key never leaves the authenticator.
   */
  readonly passkey: PasskeyRecord | null;
  /**
   * The gates (`<projectId>/<gate>`) the person set to sign with the passkey, because the gate
   * pins it (trust mode 2). A local setting; nothing from a project or the Cloud sets it.
   */
  readonly passkeyGates: readonly string[];
}

export interface ProjectKey {
  /** The `.moatkey` file (absolute path). */
  readonly keyFile: string;
  /**
   * SEC-08: the public key (base64url) of the key used before this one, while a key rotation is
   * not finished; the gates still pin it next to the new one. Public only.
   */
  readonly previousKey: string | null;
}

export interface DeployedPackage {
  readonly gateId: string;
  readonly version: number;
}

export const EMPTY_CONFIG: DesktopConfig = {
  projectDir: null,
  projectKeys: {},
  legacyKey: null,
  passphrases: {},
  deployed: {},
  sftpTargets: {},
  gitTargets: {},
  ftpsTargets: {},
  databaseTargets: {},
  passkey: null,
  passkeyGates: [],
};

const PROJECT_KEY = /^[A-Za-z0-9_-]{22}$/;
const DEPLOYED_KEY = /^[A-Za-z0-9_-]{22}\/[a-z][a-z0-9-]{0,62}$/;

/** The stored config; a missing or damaged file is an empty one (the user chooses again). */
export function readConfig(userData: string): DesktopConfig {
  try {
    const value = JSON.parse(
      readFileSync(join(userData, CONFIG_FILE), 'utf8'),
    ) as unknown;
    if (!isRecord(value)) return EMPTY_CONFIG;
    const passphrases: Record<string, string> = {};
    const stored = value['passphrases'];
    if (isRecord(stored)) {
      for (const [kid, sealed] of Object.entries(stored)) {
        if (KID.test(kid) && typeof sealed === 'string' && sealed !== '')
          passphrases[kid] = sealed;
      }
    }
    const deployed: Record<string, DeployedPackage> = {};
    const packages = value['deployed'];
    if (isRecord(packages)) {
      for (const [key, entry] of Object.entries(packages)) {
        if (
          DEPLOYED_KEY.test(key) &&
          isRecord(entry) &&
          typeof entry['gateId'] === 'string' &&
          KID.test(entry['gateId']) &&
          typeof entry['version'] === 'number' &&
          Number.isSafeInteger(entry['version']) &&
          entry['version'] >= 1
        )
          deployed[key] = {
            gateId: entry['gateId'],
            version: entry['version'],
          };
      }
    }
    const sftpTargets: Record<string, SftpTarget> = {};
    const targets = value['sftpTargets'];
    if (isRecord(targets)) {
      for (const [key, entry] of Object.entries(targets)) {
        const target = DEPLOYED_KEY.test(key) ? sftpTargetOf(entry) : null;
        if (target !== null) sftpTargets[key] = target;
      }
    }
    const gitTargets: Record<string, string> = {};
    const folders = value['gitTargets'];
    if (isRecord(folders)) {
      for (const [key, entry] of Object.entries(folders)) {
        const dir = absolute(entry);
        if (DEPLOYED_KEY.test(key) && dir !== null) gitTargets[key] = dir;
      }
    }
    const ftpsTargets: Record<string, FtpsTarget> = {};
    const ftps = value['ftpsTargets'];
    if (isRecord(ftps)) {
      for (const [key, entry] of Object.entries(ftps)) {
        const target = DEPLOYED_KEY.test(key) ? ftpsTargetOf(entry) : null;
        if (target !== null) ftpsTargets[key] = target;
      }
    }
    const databaseTargets: Record<string, DatabaseTarget> = {};
    const databases = value['databaseTargets'];
    if (isRecord(databases)) {
      for (const [id, entry] of Object.entries(databases)) {
        const target = PROJECT_KEY.test(id) ? databaseTargetOf(entry) : null;
        if (target !== null) databaseTargets[id] = target;
      }
    }
    const projectKeys: Record<string, ProjectKey> = {};
    const keys = value['projectKeys'];
    if (isRecord(keys)) {
      for (const [id, entry] of Object.entries(keys)) {
        const key = PROJECT_KEY.test(id) ? projectKeyOf(entry) : null;
        if (key !== null) projectKeys[id] = key;
      }
    }
    // Builds before per-project keys wrote `keyFile` and `previousKey` at the top level.
    const legacyKey =
      projectKeyOf(value['legacyKey']) ??
      projectKeyOf({
        keyFile: value['keyFile'],
        previousKey: value['previousKey'] ?? null,
      });
    const passkeyGates: string[] = [];
    const marked = value['passkeyGates'];
    if (Array.isArray(marked)) {
      for (const key of marked) {
        if (typeof key === 'string' && DEPLOYED_KEY.test(key))
          passkeyGates.push(key);
      }
    }
    return {
      projectDir: absolute(value['projectDir']),
      projectKeys,
      legacyKey,
      passphrases,
      deployed,
      sftpTargets,
      gitTargets,
      ftpsTargets,
      databaseTargets,
      passkey: passkeyRecordOf(value['passkey']),
      passkeyGates: [...new Set(passkeyGates)].sort(),
    };
  } catch {
    return EMPTY_CONFIG;
  }
}

/** Changes some fields and keeps the rest (read, merge, atomic write). */
export function updateConfig(
  userData: string,
  change: Partial<DesktopConfig>,
): DesktopConfig {
  const next = { ...readConfig(userData), ...change };
  writeConfig(userData, next);
  return next;
}

/** Atomic write (temp file + rename), as everywhere in Moat; only this user may read it. */
export function writeConfig(userData: string, config: DesktopConfig): void {
  mkdirSync(userData, { recursive: true });
  const target = join(userData, CONFIG_FILE);
  const temp = `${target}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, target);
}

/** A project's signing key as stored; anything else is dropped. */
function projectKeyOf(value: unknown): ProjectKey | null {
  if (!isRecord(value)) return null;
  const keyFile = absolute(value['keyFile']);
  if (keyFile === null) return null;
  const previous = value['previousKey'];
  return {
    keyFile,
    previousKey:
      typeof previous === 'string' && PUBLIC_KEY.test(previous)
        ? previous
        : null,
  };
}

/** The projectKeys map with `id`'s key replaced (or removed with null). */
export function withProjectKey(
  config: DesktopConfig,
  id: string,
  key: ProjectKey | null,
): Readonly<Record<string, ProjectKey>> {
  const { [id]: _dropped, ...rest } = config.projectKeys;
  return key === null ? rest : { ...rest, [id]: key };
}

/**
 * The change that moves the old desktop-wide key into every listed project without a key of its
 * own, and clears it; null when there is nothing to move.
 */
export function legacyKeyMigration(
  config: DesktopConfig,
  projectIds: readonly string[],
): Pick<DesktopConfig, 'projectKeys' | 'legacyKey'> | null {
  const legacy = config.legacyKey;
  if (legacy === null) return null;
  const projectKeys: Record<string, ProjectKey> = { ...config.projectKeys };
  for (const id of projectIds)
    if (PROJECT_KEY.test(id) && projectKeys[id] === undefined)
      projectKeys[id] = legacy;
  return { projectKeys, legacyKey: null };
}

/** A stored SFTP target as the SFTP window writes it; anything else is dropped. */
function sftpTargetOf(value: unknown): SftpTarget | null {
  if (!isRecord(value)) return null;
  const { host, port, username, remoteDir, auth, keyFile, hostKey, secret } =
    value;
  if (
    typeof host !== 'string' ||
    !SFTP_HOST.test(host) ||
    typeof port !== 'number' ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    typeof username !== 'string' ||
    !SFTP_USER.test(username) ||
    typeof remoteDir !== 'string' ||
    !(remoteDir === '.' || (remoteDir !== '' && isRemoteDir(remoteDir))) ||
    (auth !== 'password' && auth !== 'key') ||
    !(keyFile === null || absolute(keyFile) !== null) ||
    !(
      hostKey === null ||
      (typeof hostKey === 'string' && SFTP_HOST_KEY.test(hostKey))
    ) ||
    !(secret === null || (typeof secret === 'string' && secret !== ''))
  )
    return null;
  return {
    host,
    port,
    username,
    remoteDir,
    auth,
    keyFile: keyFile === null ? null : absolute(keyFile),
    hostKey: hostKey as string | null,
    secret: secret as string | null,
  };
}

/** A stored FTPS target as the FTPS window writes it; anything else is dropped. */
function ftpsTargetOf(value: unknown): FtpsTarget | null {
  if (!isRecord(value)) return null;
  const { host, port, username, remoteDir, mode, certificate, secret } = value;
  if (
    typeof host !== 'string' ||
    !SFTP_HOST.test(host) ||
    typeof port !== 'number' ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    typeof username !== 'string' ||
    !SFTP_USER.test(username) ||
    typeof remoteDir !== 'string' ||
    !(remoteDir === '.' || (remoteDir !== '' && isRemoteDir(remoteDir))) ||
    (mode !== 'explicit' && mode !== 'implicit') ||
    !(
      certificate === null ||
      (typeof certificate === 'string' && FTPS_FINGERPRINT.test(certificate))
    ) ||
    !(secret === null || (typeof secret === 'string' && secret !== ''))
  )
    return null;
  return {
    host,
    port,
    username,
    remoteDir,
    mode,
    certificate: certificate as string | null,
    secret: secret as string | null,
  };
}

/** A stored database target as the database window writes it; anything else is dropped. */
function databaseTargetOf(value: unknown): DatabaseTarget | null {
  if (!isRecord(value)) return null;
  const { key, label, url } = value;
  if (
    typeof key !== 'string' ||
    !DATABASE_KEY.test(key) ||
    typeof label !== 'string' ||
    label.length > 600 ||
    !label.startsWith('postgresql://') ||
    !(url === null || (typeof url === 'string' && url !== ''))
  )
    return null;
  return { key, label, url: url as string | null };
}

function absolute(value: unknown): string | null {
  return typeof value === 'string' && isAbsolute(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
