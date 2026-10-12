import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

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
}

export const EMPTY_CONFIG: DesktopConfig = {
  projectDir: null,
  keyFile: null,
  passphrases: {},
};

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
    return {
      projectDir: absolute(value['projectDir']),
      keyFile: absolute(value['keyFile']),
      passphrases,
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

function absolute(value: unknown): string | null {
  return typeof value === 'string' && isAbsolute(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
