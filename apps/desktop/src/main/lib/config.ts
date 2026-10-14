import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
  SFTP_DIR,
  SFTP_HOST,
  SFTP_HOST_KEY,
  SFTP_USER,
  type SftpTarget,
} from './sftp';

/** `<userData>/config.json`: what the desktop remembers between starts. */
export const CONFIG_FILE = 'config.json';

/** A key id as core hands it out (docs/CRYPTO.md §2: 16 bytes, base64url). */
const KID = /^[A-Za-z0-9_-]{22}$/;

export interface DesktopConfig {
  /**
   * The one project folder of the first desktop builds, before the project list. Moved into the
   * list on the next start, then cleared (see main.ts).
   */
  readonly projectDir: string | null;
  /** The `.moatkey` file chosen for signing bundles (the same file the CLI uses). */
  readonly keyFile: string | null;
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
}

export interface DeployedPackage {
  readonly gateId: string;
  readonly version: number;
}

export const EMPTY_CONFIG: DesktopConfig = {
  projectDir: null,
  keyFile: null,
  passphrases: {},
  deployed: {},
  sftpTargets: {},
};

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
    return {
      projectDir: absolute(value['projectDir']),
      keyFile: absolute(value['keyFile']),
      passphrases,
      deployed,
      sftpTargets,
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
    !(remoteDir === '.' || SFTP_DIR.test(remoteDir)) ||
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

function absolute(value: unknown): string | null {
  return typeof value === 'string' && isAbsolute(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
